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
    alignment: 0.3
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

export interface StepMsg {
  type: 'step';
  dt: number;
  outData: ArrayBuffer;      // Float32Array(OUT_STRIDE * maxAgents), transferable
  outArrived: ArrayBuffer;   // Int32Array(maxAgents), transferable
}

export interface SetParamsMsg {
  type: 'params';
  params: FluidParams;
}

export type WorkerCommand =
  | InitMsg
  | SetLevelMsg
  | AddAgentMsg
  | RemoveAgentMsg
  | StepMsg
  | SetParamsMsg;

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
  return field.blocked[cy * field.cols + cx] === 1;
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

/** Бюджет бокового дрейфа после всплытия, подшагов (~500px обхода) */
const ESCAPE_SWEEP = 1000;
/** Подшагов свободной вертикали подряд, прежде чем сваливаться в просвет */
const HOVER_STEPS = 4;
/**
 * Требуемый просвет ПОД точкой приземления при выходе из полёта, px.
 * Без этой проверки агент, едва сместившись от стены, приземляется
 * обратно на неё — и цикл «всплытие-падение» повторяется у края.
 */
const HOVER_DEPTH_CLEAR = 10;
/**
 * Подряд закрыты все ходы, прежде чем включать всплытие. В плотной толпе
 * боковые ходы часто блокируют СОСЕДИ (а не стены) — давка разбирается
 * сама за доли секунды, и карабканье ей не нужно. 24 подшага = 0.4 сек:
 * настоящие ловушки за это время никуда не деваются.
 */
const TRAP_STREAK = 24;
/**
 * Непробиваемая боковая граница поля, px. Должна совпадать с внешним
 * клэмпом воркера/сцены: иначе агент скользит в буферную зону между
 * границами, внешний клэмп возвращает его обратно, «успешное» скольжение
 * сбрасывает failStreak — и всплытие не включается никогда.
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
 * Подъём на один шаг ВВЕРХ с проверкой коллизии.
 * Сквозь препятствия карабкаться нельзя — иначе монстры «плывут» сквозь
 * блобы у краёв поля. Если выше занято — стоим этот подшаг (соседние
 * ветки продолжат искать ход вбок, а фейлсейф воркера страхует).
 */
function climbStep(
  field: CollisionField,
  p: { x: number; y: number },
  r: number,
  speed: number
): boolean {
  const ny = p.y - speed;
  if (isBoxBlocked(field, p.x, ny, r)) return false;
  p.y = ny;
  return true;
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
 * сплошная плита у кромки), агент «всплывает» и переходит в спасательный
 * полёт (sweep): держит высоту над препятствием и летит вбок, пока под
 * собой не подтвердится настоящий просвет глубиной HOVER_STEPS подшагов —
 * тогда сваливается в него и возвращается к обычному поведению. Гарантия
 * выхода: над кромкой поля всё свободно. Вместе с заливкой недренируемых
 * карманов на генерации это обеспечивает прибытие 100% агентов к базе.
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
  const flying = avoid.sweep > 0 && avoid.value !== 0;

  // --- Вертикаль свободна ---
  if (!isBoxBlocked(field, nx, ny, r)) {
    if (!flying) {
      p.x = clampX(nx, fieldW);
      p.y = ny;
      v.x = nvx;
      v.y = nvy;
      avoid.value = 0;
      avoid.failStreak = 0;
      avoid.hover = 0;
      return;
    }

    // Спасательный полёт: держим высоту, летим вбок
    const tx = p.x + avoid.value * targetSpeed;
    if (!outOfFieldX(tx, fieldW) && !isBoxBlocked(field, tx, p.y, r)) {
      // Уровень впереди свободен: копим подтверждение глубины под собой
      avoid.hover++;
      avoid.sweep--;
      const deepEnough =
        avoid.hover >= HOVER_STEPS &&
        !isBoxBlocked(field, nx, ny + HOVER_DEPTH_CLEAR, r);
      if (deepEnough) {
        // Просвет настоящий — сваливаемся и возвращаемся к обычному режиму
        p.x = clampX(nx, fieldW);
        p.y = ny;
        v.x = nvx;
        v.y = nvy;
        avoid.value = 0;
        avoid.failStreak = 0;
        avoid.sweep = 0;
        avoid.hover = 0;
        return;
      }
      p.x = tx;
      v.x = avoid.value * targetSpeed;
      v.y = 0;
      return;
    }
    // Впереди стена или край поля: подъём ВДОЛЬ стены (с коллизией!)
    avoid.hover = 0;
    avoid.sweep--;
    if (outOfFieldX(tx, fieldW)) {
      avoid.value = -avoid.value;
    }
    if (!climbStep(field, p, r, targetSpeed)) {
      v.x = 0;
      v.y = 0;
      return;
    }
    v.x = 0;
    v.y = -targetSpeed;
    return;
  }

  // --- Вертикаль заблокирована ---
  avoid.hover = 0;

  if (flying) {
    // Летим на текущей высоте: уровень впереди свободен?
    avoid.sweep--;
    const tx = p.x + avoid.value * targetSpeed;
    const outOfField = outOfFieldX(tx, fieldW);
    if (!outOfField && !isBoxBlocked(field, tx, p.y, r)) {
      p.x = tx;
      v.x = avoid.value * targetSpeed;
      v.y = 0;
      return;
    }
    if (outOfField) {
      // Край поля — разворачиваемся
      avoid.value = -avoid.value;
    }
    // Впереди стена выше текущей высоты — всплываем вдоль неё (с коллизией)
    if (!climbStep(field, p, r, targetSpeed)) {
      v.x = 0;
      v.y = 0;
      return;
    }
    v.x = 0;
    v.y = -targetSpeed;
    return;
  }

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
      // Все ходы закрыты устойчиво — всплываем и берём бюджет полёта.
      // Направление полёта — ОТ ближайшего бокового края, к центру:
      // иначе агент долго карабкается вдоль стены у кромки
      avoid.value = p.x > fieldW * 0.5 ? -1 : 1;
      avoid.sweep = ESCAPE_SWEEP;
      avoid.hover = 0;
      if (!climbStep(field, p, r, targetSpeed)) {
        v.x = 0;
        v.y = 0;
        return;
      }
      v.x = 0;
      v.y = -targetSpeed;
      return;
    }
    v.x = 0;
  }
  v.y = 0;
}
