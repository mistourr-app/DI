// ============================================================
// Общий протокол main <-> FluidWorker.
// Импортируется ОБОИМИ сторонами — единая физика без расхождений.
// Чистый TS, без Phaser.
// ============================================================

/** Ёмкость SoA-массивов симуляции (стресс-тесты до 20k на экране) */
export const MAX_AGENTS = 20000;

/** Фиксированный подшаг интеграции внутри воркера */
export const SUBSTEP_DT = 1 / 60;

/** Максимум подшагов за один кадр (защита от спирали смерти при лагах) */
export const MAX_SUBSTEPS = 3;

/** Шаг выходного буфера позиций: [id, x, y] на агента */
export const OUT_STRIDE = 3;

// ------------------------------------------------------------
// Spatial hash: linked-cell, ноль аллокаций в steady-state
// ------------------------------------------------------------

/**
 * Равномерная сетка по агентам для поиска соседей.
 * Ячейка = радиус взаимодействия, поиск пар — своя ячейка + 8 соседних.
 * Покрывает y от -topMargin (зона спавна над полем) до height.
 */
export class SpatialGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly rowOffset: number;
  /** cell -> слот первого агента в списке (-1 = пусто) */
  readonly head: Int32Array;
  /** slot -> следующий слот в той же ячейке */
  readonly next: Int32Array;

  constructor(cellSize: number, width: number, height: number, topMargin: number, capacity: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rowOffset = Math.max(1, Math.ceil(topMargin / cellSize));
    this.rows = this.rowOffset + Math.max(1, Math.ceil(height / cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(capacity);
  }

  /** Сброс перед новой сборкой (единственная работа на кадр — fill) */
  clear(): void {
    this.head.fill(-1);
  }

  /** Индекс ячейки или -1, если точка вне покрытия сетки */
  cellIndex(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize) + this.rowOffset;
    if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  insert(slot: number, x: number, y: number): void {
    const c = this.cellIndex(x, y);
    if (c < 0) return;
    this.next[slot] = this.head[c];
    this.head[c] = slot;
  }
}

// ------------------------------------------------------------
// Силы жидкости (SPH-lite/boids гибрид поверх moveDownStep)
// ------------------------------------------------------------

/** SoA-состояние агентов, видимое чистой функции сил (ссылки воркера) */
export interface FluidWorld {
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  rad: Float32Array;
  alive: Uint8Array;
  grid: SpatialGrid | null;
  /** Квадрат радиуса взаимодействия */
  interactionR2: number;
  params: FluidParams;
  /** Максимальное смещение от сил за подшаг, px */
  maxDisp: number;
}

/** Выходной контейнер смещения (переиспользуется, без аллокаций) */
export interface DispOut { x: number; y: number; }

/**
 * Смещение агента s от сил жидкости за один подшаг -> out (px).
 *
 * Чистая функция без аллокаций. Базовое движение (moveDownStep) не трогает:
 * силы только модулируют траекторию поверх потока «строго вниз».
 */
export function fluidDisplacement(w: FluidWorld, s: number, out: DispOut): void {
  out.x = 0;
  out.y = 0;
  const grid = w.grid;
  if (!grid) return;

  const { px, py, vx, vy } = w;
  const x = px[s];
  const y = py[s];

  // Сбор соседей из своей ячейки и 8 соседних
  let sepX = 0, sepY = 0;      // сумма (dx/d^2, dy/d^2)
  let avgVX = 0, avgVY = 0;    // средняя скорость соседей (viscosity/alignment)
  let cenX = 0, cenY = 0;      // центроид соседей (pressure/cohesion)
  let n = 0;

  const cs = grid.cellSize;
  const cx0 = Math.floor(x / cs);
  const cy0 = Math.floor(y / cs);
  const r2 = w.interactionR2;
  const { head, next, cols, rows, rowOffset } = grid;

  for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
    const row = gy + rowOffset;
    if (row < 0 || row >= rows) continue;
    for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
      if (gx < 0 || gx >= cols) continue;
      let j = head[row * cols + gx];
      while (j !== -1) {
        if (j !== s && w.alive[j]) {
          const dx = x - px[j];
          const dy = y - py[j];
          const d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            cenX += px[j]; cenY += py[j];
            avgVX += vx[j]; avgVY += vy[j];
            n++;
            if (d2 >= FLUID_TUNING.SEP_MIN_D2) {
              const inv = 1 / d2;
              sepX += dx * inv;
              sepY += dy * inv;
            } else {
              // Почти совпавшие агенты: направление (dx,dy) ненадёжно —
              // гарантированный разворот в случайную сторону
              const ang = Math.random() * TWO_PI;
              sepX += Math.cos(ang);
              sepY += Math.sin(ang);
            }
          }
        }
        j = next[j];
      }
    }
  }

  if (n === 0) return;
  const invN = 1 / n;
  avgVX *= invN; avgVY *= invN;
  cenX *= invN; cenY *= invN;

  const p = w.params;
  const t = FLUID_TUNING;

  // Separation — сильнейший вклад: расталкивание при сближении
  let fx = sepX * t.SEP_SCALE * p.separation;
  let fy = sepY * t.SEP_SCALE * p.separation;

  // Pressure — перегруженная локальная плотность выталкивает из центра масс
  if (n > t.DENSITY_MAX) {
    const overload = Math.min(1, (n - t.DENSITY_MAX) / t.DENSITY_MAX);
    let ax = x - cenX;
    let ay = y - cenY;
    const len = Math.sqrt(ax * ax + ay * ay);
    if (len > 0.001) {
      const k = (overload * t.PRESS_SCALE * p.pressure) / len;
      fx += ax * k;
      fy += ay * k;
    }
  }

  // Viscosity (+alignment) — релаксация к средней скорости соседей,
  // сглаживает поток и убирает дёрганье
  const kv = Math.min(1, t.VISC_SCALE * p.viscosity);
  fx += (avgVX - vx[s]) * kv;
  fy += (avgVY - vy[s]) * kv;

  // Cohesion — слабая подтяжка к центроиду: рукава держатся вместе
  let hx = cenX - x;
  let hy = cenY - y;
  const hlen = Math.sqrt(hx * hx + hy * hy);
  if (hlen > 0.001) {
    const kc = t.COH_SCALE * p.cohesion;
    fx += (hx / hlen) * kc;
    fy += (hy / hlen) * kc;
  }

  // Клэмп итогового смещения за подшаг: базовый поток всегда сильнее сил
  const flen = Math.sqrt(fx * fx + fy * fy);
  if (flen > w.maxDisp) {
    const k = w.maxDisp / flen;
    fx *= k;
    fy *= k;
  }
  out.x = fx;
  out.y = fy;
}

// ------------------------------------------------------------
// Тюнинг сил жидкости (стартовые значения; сессия тюнинга — Фаза 2.3)
// ------------------------------------------------------------

const TWO_PI = Math.PI * 2;

export const FLUID_TUNING = {
  /** Радиус взаимодействия соседей, px: минимум */
  INTERACTION_RADIUS_MIN: 20,
  /** Радиус взаимодействия: добавка на каждый px радиуса агента */
  INTERACTION_RADIUS_PER_R: 3.5,
  /** Порог локальной плотности для давления (соседей в радиусе) */
  DENSITY_MAX: 8,
  /** Минимальная d^2 для веса separation 1/d^2; ниже — случайный разворот */
  SEP_MIN_D2: 1,
  /** Масштаб вклада separation (px смещения за подшаг на единицу суммы d/d^2) */
  SEP_SCALE: 6,
  /** Масштаб вклада pressure (px/подшаг при полной перегрузке density) */
  PRESS_SCALE: 1.2,
  /** Коэффициент релаксации скорости к средней по соседям (до клэмпа 0..1) */
  VISC_SCALE: 20,
  /** Масштаб слабой cohesion (px/подшаг к центроиду соседей) */
  COH_SCALE: 0.15,
  /** Максимальное смещение от сил за подшаг, доля targetSpeed */
  MAX_FORCE_DISP_RATIO: 0.75
};

/** Параметры симуляции (форвардятся из GameConfig/GameScene) */
export interface FluidParams {
  /** Базовая скорость движения к базе (px/подшаг-единицы текущей игры) */
  targetSpeed: number;
  /** Визуальный радиус монстра в пикселях */
  enemyRadius: number;
  // Константы сил жидкости — задействуются с Фазы 2
  density: number;
  pressure: number;
  viscosity: number;
  separation: number;
  cohesion: number;
  alignment: number;
  // Эффекты стихий (Итерация 4)
  waterSlowFactor: number; // доля скорости агента в зоне воды (0..1)
  airPushStrength: number; // сила отброса воздуха, px/подшаг
  wetDuration: number;     // секунд «мокрый» (и замедление) после выхода из воды
  airDuration: number;     // секунд «сдутый» после выхода из воздуха
}

export function defaultFluidParams(): FluidParams {
  return {
    targetSpeed: 0.5,
    enemyRadius: 5,
    density: 1.0,
    pressure: 0.1,
    viscosity: 0.01,
    separation: 1.5,
    cohesion: 0.5,
    alignment: 0.3,
    waterSlowFactor: 0.5,
    airPushStrength: 1.5,
    wetDuration: 5,
    airDuration: 5
  };
}

/** Копия коллизионной сетки уровня (локальные координаты поля боя) */
export interface CollisionField {
  cols: number;
  rows: number;
  cellSize: number;
  blocked: Uint8Array; // 1 = занято препятствием; вне сетки = свободно
  /** Реальная ширина поля боя в px (может быть меньше cols*cellSize) */
  widthPx?: number;
  /** Земля-барьер (Итерация 2): 1 = ячейка земли; обновляется set_earth */
  earth?: Uint8Array;
  /** Эффект воды (Итерация 4): 1 = ячейка замедления; обновляется set_effects */
  water?: Uint8Array;
  /** Эффект воздуха (Итерация 4): направление отброса по ячейке (0 = нет) */
  airX?: Float32Array;
  airY?: Float32Array;
}

// ------------------------------------------------------------
// Сообщения main -> worker
// ------------------------------------------------------------

export interface InitMsg {
  type: 'init';
  width: number;   // ширина поля боя (локальные координаты)
  height: number;  // высота поля боя; y > height => агент достиг базы
  baseX: number;   // база (цель), локальные координаты
  baseY: number;
  maxAgents: number;
  params: FluidParams;
}

export interface SetLevelMsg {
  type: 'set_level';
  cols: number;
  rows: number;
  cellSize: number;
  blocked: ArrayBuffer; // передаётся как transferable
  /** Реальная ширина поля в px (для корректной границы движения) */
  widthPx?: number;
}

export interface AddAgentMsg {
  type: 'add';
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface RemoveAgentMsg {
  type: 'remove';
  id: number;
}

/** Полный сброс агентов воркера (смена уровня): очищает all слоты,
 *  счётчики и аккумулятор. Поле/сетка остаются. После reset id
 *  можно переиспользовать с нуля — состояние main обнуляется вместе */
export interface ResetAgentsMsg {
  type: 'reset_agents';
}

export interface StepMsg {
  type: 'step';
  dt: number;
  outData: ArrayBuffer;      // Float32Array(OUT_STRIDE * maxAgents), transferable
  outArrived: ArrayBuffer;   // Int32Array(maxAgents), transferable
  outAttacks: ArrayBuffer;   // Int32Array(maxAgents), transferable (Итерация 2)
}

export interface SetParamsMsg {
  type: 'params';
  params: FluidParams;
}

export interface SetEarthMsg {
  type: 'set_earth';
  cells: ArrayBuffer; // Int32Array(flat cell indices), transferable
  value: 0 | 1;       // 1 = добавить землю, 0 = убрать
}

/** Эффекты стихий-физики (Итерация 4): вода-замедление, воздух-отброс */
export interface SetEffectsMsg {
  type: 'set_effects';
  effect: 'water' | 'air';
  cells: ArrayBuffer; // Int32Array(flat cell indices), transferable
  value: 0 | 1;       // 1 = включить эффект, 0 = выключить
  dirX?: number;      // воздух: направление отброса (нормализованное)
  dirY?: number;
}

export type WorkerCommand =
  | InitMsg
  | SetLevelMsg
  | AddAgentMsg
  | RemoveAgentMsg
  | ResetAgentsMsg
  | StepMsg
  | SetParamsMsg
  | SetEarthMsg
  | SetEffectsMsg;

// ------------------------------------------------------------
// Сообщения worker -> main
// ------------------------------------------------------------

export interface ReadyMsg {
  type: 'ready';
}

export interface FrameMsg {
  type: 'frame';
  count: number;        // число активных агентов в буфере
  arrivedCount: number; // число достигших базы за этот кадр
  data: ArrayBuffer;    // Float32Array(OUT_STRIDE * count) [id, x, y]...
  arrived: ArrayBuffer; // Int32Array(arrivedCount) — id достигших
  attacks: ArrayBuffer; // Int32Array(attackCount) — id атакующих землю (Итерация 2)
  attackCount: number;
  stepMs: number;       // длительность расчёта шага (для дебаг-метрики)
}

export type WorkerResponse = ReadyMsg | FrameMsg;

// ------------------------------------------------------------
// Чистые функции физики (общие для воркера и fallback-пути)
// ------------------------------------------------------------

/** Занята ли точка в локальных координатах. Вне сетки — свободно. */
export function blockedAt(field: CollisionField, lx: number, ly: number): boolean {
  const cx = Math.floor(lx / field.cellSize);
  const cy = Math.floor(ly / field.cellSize);
  if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return false;
  // Фантомная полоса справа: сетка шире реального поля (cols*cell > widthPx).
  // Препятствия там невидимы для игрока — коллизией не считаем
  if (field.widthPx !== undefined && lx >= field.widthPx) return false;
  if (field.blocked[cy * field.cols + cx] === 1) return true;
  // Земля-барьер (Итерация 2) тоже непроходима
  if (field.earth && field.earth[cy * field.cols + cx] === 1) return true;
  return false;
}

/** Земля ли в точке (Итерация 2). Вне сетки — нет. */
export function earthAt(field: CollisionField, lx: number, ly: number): boolean {
  if (!field.earth) return false;
  const cx = Math.floor(lx / field.cellSize);
  const cy = Math.floor(ly / field.cellSize);
  if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return false;
  if (field.widthPx !== undefined && lx >= field.widthPx) return false;
  return field.earth[cy * field.cols + cx] === 1;
}

/**
 * Занята ли точка ПРЕПЯТСТВИЕМ УРОВНЯ (без земли). Вне сетки — свободно.
 * Для «телепорта на спавн» при регенерации: земля (барьер игрока) не должна
 * телепортировать монстров — накрытые землёй гибнут, грызя ячейки.
 */
export function blockedByLevel(field: CollisionField, lx: number, ly: number): boolean {
  const cx = Math.floor(lx / field.cellSize);
  const cy = Math.floor(ly / field.cellSize);
  if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return false;
  if (field.widthPx !== undefined && lx >= field.widthPx) return false;
  return field.blocked[cy * field.cols + cx] === 1;
}

/** Касается ли прямоугольник вокруг точки земли (4 угла) */
export function isBoxEarth(field: CollisionField, lx: number, ly: number, r: number): boolean {
  return (
    earthAt(field, lx - r, ly - r) ||
    earthAt(field, lx + r, ly - r) ||
    earthAt(field, lx - r, ly + r) ||
    earthAt(field, lx + r, ly + r)
  );
}

/**
 * Касание земли С ЛЮБОЙ стороны: текущая позиция или упреждение по осям
 * (вверх/вниз/влево/вправо на look). Монстры грызут землю при касании,
 * а не только подходя сверху. Диагональное касание срабатывает на один-два
 * подшага позже — когда хитбокс войдёт в zona текущего прямоугольника
 */
export function isBoxEarthAnySide(
  field: CollisionField,
  lx: number,
  ly: number,
  r: number,
  look: number
): boolean {
  return (
    isBoxEarth(field, lx, ly, r) ||
    isBoxEarth(field, lx, ly + look, r) ||
    isBoxEarth(field, lx, ly - look, r) ||
    isBoxEarth(field, lx + look, ly, r) ||
    isBoxEarth(field, lx - look, ly, r)
  );
}

/** Эффект воды: замедляет ли точка (Итерация 4). Вне сетки — нет. */
export function waterAt(field: CollisionField, lx: number, ly: number): boolean {
  if (!field.water) return false;
  const cx = Math.floor(lx / field.cellSize);
  const cy = Math.floor(ly / field.cellSize);
  if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return false;
  if (field.widthPx !== undefined && lx >= field.widthPx) return false;
  return field.water[cy * field.cols + cx] === 1;
}

/** Эффект воздуха: направление отброса в точке, или null вне зоны (Итерация 4) */
export function airAt(
  field: CollisionField,
  lx: number,
  ly: number
): { x: number; y: number } | null {
  if (!field.airX || !field.airY) return null;
  const cx = Math.floor(lx / field.cellSize);
  const cy = Math.floor(ly / field.cellSize);
  if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) return null;
  if (field.widthPx !== undefined && lx >= field.widthPx) return null;
  const i = cy * field.cols + cx;
  const x = field.airX[i];
  const y = field.airY[i];
  if (x === 0 && y === 0) return null;
  return { x, y };
}

/** Хитбокс-прямоугольник из 4 углов вокруг центра */
export function isBoxBlocked(field: CollisionField, lx: number, ly: number, r: number): boolean {
  return (
    blockedAt(field, lx - r, ly - r) ||
    blockedAt(field, lx + r, ly - r) ||
    blockedAt(field, lx - r, ly + r) ||
    blockedAt(field, lx + r, ly + r)
  );
}

function rand(amt: number): number {
  return (Math.random() * 2 - 1) * amt;
}

/**
 * Подряд закрыты все ходы, прежде чем включать спасательный хоп. В плотной
 * толпе боковые ходы часто блокируют СОСЕДИ (а не стены) — давка
 * разбирается сама за доли секунды, и хоп ей не нужен. 24 подшага = 0.4 сек:
 * настоящие ловушки за это время никуда не деваются.
 */
const TRAP_STREAK = 24;
/**
 * Непробиваемая боковая граница поля, px. Должна совпадать с внешним
 * клэмпом воркера/сцены: иначе агент скользит в буферную зону между
 * границами, внешний клэмп возвращает его обратно, «успешное» скольжение
 * сбрасывает failStreak — и хоп не включается никогда.
 */
const EDGE_MARGIN = 10;

/** Горизонтальный ход за границу поля запрещён */
function outOfFieldX(x: number, fieldW: number): boolean {
  return x < EDGE_MARGIN || x > fieldW - EDGE_MARGIN;
}

/** Держим центр агента в коридоре поля при любом движении по Y */
function clampX(x: number, fieldW: number): number {
  return x < EDGE_MARGIN ? EDGE_MARGIN : x > fieldW - EDGE_MARGIN ? fieldW - EDGE_MARGIN : x;
}

/**
 * Спасательный «хоп»: МГНОВЕННЫЙ (невидимый) перенос агента на свободную
 * позицию над ловушкой, где вбок есть выход. Это эквивалент результата
 * долгого подъёма вдоль стены, но БЕЗ видимого лазанья вверх — раньше
 * монстры «ползли вверх» по стенам/краям поля до самого верха.
 *
 * Скан идёт по сетке вверх от позиции агента (до ESCAPE_HOP_CELLS клеток):
 * первая свободная клетка, где слева ИЛИ справа свободно — точка посадки
 * (агент сваливается в поток). Если выхода нет — false: агент стоит,
 * а фейлсейф воркера (нет прогресса вниз STALL_SUBSTEPS) вернёт его на спавн.
 */
const ESCAPE_HOP_CELLS = 10;

function escapeHop(field: CollisionField, p: { x: number; y: number }, r: number): boolean {
  const cs = field.cellSize;
  const probe = Math.max(r * 4, 24);
  const yCell = Math.floor(p.y / cs);
  for (let dy = 0; dy <= ESCAPE_HOP_CELLS; dy++) {
    const py = (yCell - dy) * cs + cs / 2;
    if (py < -cs * 2) break; // выше верхней кромки — дальше искать нечего
    if (isBoxBlocked(field, p.x, py, r)) continue; // занято — ищем выше
    const leftFree = !isBoxBlocked(field, p.x - probe, py, r);
    const rightFree = !isBoxBlocked(field, p.x + probe, py, r);
    if (leftFree || rightFree) {
      p.y = py;
      return true;
    }
  }
  return false;
}

/**
 * Шаг агента «строго вниз» с обходом препятствий по касательной.
 *
 * Пока путь вниз свободен — движение вертикальное с микро-шумом.
 * Если вертикаль заблокирована (агент упёрся в блоб): выбирается сторона
 * обхода (по свободному месту слева/справа, при неоднозначности случайно),
 * сторона запоминается в avoid.value до возобновления вертикали, и агент
 * идёт вбок ПОЛНОЙ скоростью — так поток обтекает препятствие, как вода.
 *
 * Если закрыты И вертикаль, И обе стороны подряд (дно выемки/полости или
 * сплошная плита у кромки), агент делает спасательный «хоп» (escapeHop):
 * мгновенный перенос на свободную позицию над ловушкой — никакого видимого
 * лазанья вверх. Гарантия выхода: над кромкой поля всё свободно. Вместе с
 * заливкой недренируемых карманов на генерации это обеспечивает прибытие
 * 100% агентов к базе.
 *
 * Мутирует p и v. Вызывается из воркера И из legacy main-пути — паритет.
 */
export function moveDownStep(
  field: CollisionField,
  p: { x: number; y: number },
  v: { x: number; y: number },
  r: number,
  avoid: { value: number; failStreak: number; sweep: number; hover: number },
  targetSpeed: number
): void {
  const nvx = rand(0.01);
  const nvy = targetSpeed + rand(0.01);

  const nx = p.x + nvx;
  const ny = p.y + nvy;

  const fieldW = field.widthPx ?? field.cols * field.cellSize;

  // --- Вертикаль свободна: обычное падение (спасательный полёт отменён) ---
  if (!isBoxBlocked(field, nx, ny, r)) {
    p.x = clampX(nx, fieldW);
    p.y = ny;
    v.x = nvx;
    v.y = nvy;
    avoid.value = 0;
    avoid.failStreak = 0;
    avoid.hover = 0;
    return;
  }

  // --- Вертикаль заблокирована ---
  avoid.hover = 0;

  // Обычное скольжение по поверхности: выбор стороны (один раз на контакт)
  if (avoid.value === 0) {
    const probe = Math.max(r * 4, 24);
    const leftFree = !isBoxBlocked(field, p.x - probe, p.y + probe, r);
    const rightFree = !isBoxBlocked(field, p.x + probe, p.y + probe, r);
    avoid.value =
      leftFree && !rightFree ? -1 :
      rightFree && !leftFree ? 1 :
      (Math.random() < 0.5 ? -1 : 1);
  }

  // Горизонтальный сдвиг полной скоростью в выбранную сторону.
  // Граница поля по X — как стенка (EDGE_MARGIN = внешнему клэмпу)
  const sx = p.x + avoid.value * targetSpeed;
  const outOfField = outOfFieldX(sx, fieldW);
  if (!outOfField && !isBoxBlocked(field, sx, p.y, r)) {
    p.x = sx;
    v.x = avoid.value * targetSpeed;
    avoid.failStreak = 0;
  } else {
    // Ход в выбранную сторону закрыт (стенка выемки/уступ/край поля):
    // разворачиваемся — слив может быть с другой стороны
    avoid.value = -avoid.value;
    avoid.failStreak++;
    if (avoid.failStreak >= TRAP_STREAK) {
      // Устойчивая ловушка: спасательный ХОП вместо лазанья вверх.
      // Мгновенный перенос над ловушкой, где вбок свободно — никакого
      // видимого «ползания по стене» до верха экрана.
      avoid.failStreak = 0;
      avoid.value = 0;
      if (escapeHop(field, p, r)) {
        v.x = 0;
        v.y = 0;
        return; // следующий подшаг — свободное падение с новой высоты
      }
      v.x = 0;
      v.y = 0;
      return; // выхода нет — фейлсейф воркера вернёт на спавн
    }
    v.x = 0;
  }
  v.y = 0;
}
