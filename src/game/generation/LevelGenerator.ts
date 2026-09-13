import * as simplexNoiseNS from 'simplex-noise';

// v3 поставляет две сборки: ESM — default-экспорт, CJS-обёртка — именованный
// SimplexNoise. vite и ts-jest (commonjs) резолвят по-разному — берём любой.
const SimplexNoise: new (rng?: () => number) => {
  noise2D(x: number, y: number): number;
} = ((simplexNoiseNS as any).default ?? (simplexNoiseNS as any).SimplexNoise);

// ============================================================
// Seeded RNG — детерминированная генерация по строковому seed.
// Никакого Math.random внутри генератора!
// ============================================================

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// ============================================================
// Типы уровня
// ============================================================

/** Вход (spawn point) на верхней границе поля боя */
export interface Entrance {
  /** Центр входа по X (локальные координаты поля боя) */
  x: number;
  /** Y верхней границы (всегда 0 в локальных координатах) */
  y: number;
  /** Ширина входа, px */
  width: number;
}

/** Выход на нижней границе поля боя */
export interface Exit {
  x: number;
  /** Y нижней границы (всегда height) */
  y: number;
  /** Ширина выхода, px */
  width: number;
}

/** Замкнутый сглаженный контур препятствия («контур + сплошная заливка») */
export interface ObstaclePolygon {
  points: { x: number; y: number }[];
}

export interface LevelParams {
  seed: string;
  /** Ширина поля боя, px */
  width: number;
  /** Высота поля боя, px (5/6 высоты игрового поля) */
  height: number;
  /** Минимальная ширина прохода между препятствиями, px (по умолчанию 60) */
  passageWidth?: number;
  /** Плотность препятствий 0.0 - 1.0 (по умолчанию 0.4) */
  obstacleDensity?: number;
  /** Множитель размера структур: 1 = база, больше = крупнее блобы (по умолчанию 1) */
  blobScale?: number;
  /** Свободная полоса сверху, px (загон монстров): препятствий нет */
  topFreeHeight?: number;
}

export interface Level {
  seed: string;
  width: number;
  height: number;
  basePosition: { x: number; y: number };
  entrances: Entrance[];
  exits: Exit[];
  /** Точки появления монстров — центры входов (локальные координаты) */
  spawnPoints: { x: number; y: number }[];
  /** Полигоны препятствий для отрисовки */
  obstacles: ObstaclePolygon[];
  /**
   * Коллизия за O(1). Координаты локальные — относительно левого верхнего
   * угла поля боя. Вне поля боя возвращает false.
   */
  isBlocked(x: number, y: number): boolean;
  /** Сетка коллизий для fluid worker (копия ссылки; сетка иммутабельна после генерации) */
  getCollisionField(): {
    cols: number;
    rows: number;
    cellSize: number;
    blocked: Uint8Array;
    /** Реальная ширина поля в px — для границ движения (cols*cell может быть больше) */
    widthPx: number;
  };
}

// ============================================================
// Генератор уровней
// ============================================================

const CELL = 16;      // размер клетки сетки коллизий, px
const SMOOTH_ITER = 2;
// Разрыв длинных горизонтальных гребней (шаг 2.6): гребень длиннее
// MIN_RUN клеток режется каналами GAP на сегменты не длиннее SEG.
// Канал вертикальный, шириной GAP (монстр ~2 клетки — проваливается).
const RUN_MIN = 8;
const RUN_SEG = 6;
const RUN_GAP = 2;
// Зигзаг каналов: каждые RUN_WIND рядов сдвиг на ±1 клетку — шахта
// не прямая, длинные ровные вертикальные проходы не образуются
const RUN_WIND = 3;
// Зубцы на длинных вертикальных стенах (шаг 2.61): стена длиннее
// WALL_MIN рядов получает выемки каждые WALL_STEP рядов с чередующихся
// сторон — коридор между стенами не ровный
const WALL_MIN = 10;
const WALL_STEP = 5;
// Нижняя часть поля свободна от препятствий: рукава из лабиринта
// свободно выливаются к зоне базы (~1/10 высоты поля)
const BOTTOM_FREE_RATIO = 0.1;
// Доля площади поля, которую может занимать один связный кластер препятствий
const MAX_CLUSTER_RATIO = 0.12;
// Каноническое «дизайн-разрешение» поля боя (соотношение 36:65 —
// поле боя 9:19.5 × 5/6). Частоты шума задаются относительно НЕГО,
// а не экрана: паттерн препятствий не зависит от устройства и
// определяется только seed + настройками генерации.
const REF_W = 540;
const REF_H = 975;

export class LevelGenerator {
  generate(params: LevelParams): Level {
    const seed = params.seed;

    // Детерминированный ГПСЧ; шум строится на его основе
    const rng = mulberry32(xmur3(seed)());
    const noise = new SimplexNoise(rng);

    // Сеед-джокер шума: веса октав, сдвиги фаз и амплитуда варпа берутся
    // из ГПСЧ — «характер» шума уникален для каждого seed, даже когда
    // порог насыщается (высокая плотность). Диапазон весов узкий: плотность
    // должна читаться одинаково, а не раскачиваться на ±10пп от seed к seed
    const mix1 = 0.66 + rng() * 0.14;   // вес первой (низкочастотной) октавы
    const mix2 = 1 - mix1;
    const warpAmp = 0.05 + rng() * 0.05; // амплитуда домен-варпа (в долях поля)
    // Сдвиги фаз октав и варпа (расстояние >> длины волн — октавы
    // полностью декоррелированы и от seed к seed дают разные изгибы)
    const offMainX = 50 + rng() * 200;
    const offMainY = 50 + rng() * 200;
    const offWarpA = 50 + rng() * 200;
    const offWarpB = 50 + rng() * 200;
    const offWarpC = 50 + rng() * 200;
    const offWarpD = 50 + rng() * 200;

    const width = Math.max(200, Math.floor(params.width));
    const height = Math.max(300, Math.floor(params.height));
    const passageWidth = clamp(params.passageWidth ?? 60, 24, 200);
    const density = clamp(params.obstacleDensity ?? 0.4, 0, 2);
    const blobScale = clamp(params.blobScale ?? 1, 0.1, 4);
    const bottomMargin = clamp(height * BOTTOM_FREE_RATIO, CELL * 2, height * 0.25);
    const topFree = clamp(params.topFreeHeight ?? 0, 0, height * 0.4);
    // Масштаб «дизайн-пикселя» под устройство: и шум, и кисти прорезки
    // нормализованы к REF. На реальных устройствах unit ≈ 1 (поле боя
    // ограничено соотношением 9:19.5 × 5/6, ширина колеблется в пределах
    // ~±10%) — но паттерн и ширина проходов не зависят от разрешения.
    const unit = width / REF_W;
    // Кисть прорезки коридоров/каньонов: passageWidth — минимальная
    // ширина прохода (по умолчанию 60 px в «дизайн-масштабе»)
    const brush = Math.max(passageWidth / 2, CELL * 1.25) * unit;

    // Снэп сетки к целым клеткам: cols·cellSize == width ТОЧНО. Это устраняет
    // частичную/фантомную последнюю колонку (width не кратен CELL), из-за
    // которой у правой кромки был систематически пустой коридор (десктоп:
    // колонка вычищалась, мобилка: монстры лезли вверх по щели). Теперь
    // правая колонка — полноценная и примыкает к границе поля ровно.
    const cols = Math.max(1, Math.round(width / CELL));
    const cellSize = width / cols;
    const rows = Math.ceil(height / CELL);
    const grid = new Uint8Array(cols * rows); // 1 = клетка занята препятствием

    // --- 1. Вход и выход на всю ширину поля (между бортами стакана) ---
    // Монстры спавнятся над экраном по всей ширине между бортами; на потоки
    // их делит сам лабиринт (прорехи между блобами у верхнего края). Снизу
    // полоса без препятствий — рукава свободно выливаются к базе.
    const gateWidth = width - cellSize * 2;
    const entrances: Entrance[] = [{ x: width / 2, y: 0, width: gateWidth }];
    const exits: Exit[] = [{ x: width / 2, y: height, width: gateWidth }];

    // --- 2. Препятствия: органические блобы через fbm-шум ---
    // Нормализованные координаты (wx/width, wy/height) × канонические
    // частоты REF: паттерн препятствий НЕ зависит от разрешения экрана —
    // тот же seed и настройки дают похожий лабиринт на любом устройстве.
    // Порог подобран так, что density=0.4 даёт ~30% заполнения.
    // density = 0 — ПОЛНОСТЬЮ пустое поле (последние уровни): заливка
    // пропускается, весь дальнейший пайплайн — no-op.
    if (density > 0) {
    const threshold = 0.685 - density * 0.25;
    // Частота домен-варпа (между частотами октав), в px-единицах референса
    const warpFreq = 0.009;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const wx = cx * cellSize;
        const wy = cy * cellSize;
        // Свободная зона только внизу: верх и бока без отступа, блобы
        // могут начинаться прямо от кромки поля
        if (wy > height - bottomMargin) continue;
        const nx = wx / width;
        const ny = wy / height;
        // Домен-варп: координаты сэмплирования «кривятся» сеед-специфичным
        // шумом — у каждого seed своя пластика структур, переживающая
        // насыщение порога на высокой плотности
        const warpX = nx + warpAmp * noise.noise2D(nx * (warpFreq * REF_W) + offWarpA, ny * (warpFreq * REF_H) + offWarpB);
        const warpY = ny + warpAmp * noise.noise2D(nx * (warpFreq * REF_W) + offWarpC, ny * (warpFreq * REF_H) + offWarpD);
        // Частоты шума делятся на blobScale: множитель >1 — структуры крупнее
        const f1 = 0.0045 / blobScale;
        const f2 = 0.015 / blobScale;
        const n1 = noise.noise2D(warpX * (f1 * REF_W), warpY * (f1 * REF_H));
        const n2 = noise.noise2D(warpX * (f2 * REF_W) + offMainX, warpY * (f2 * REF_H) + offMainY);
        const u = (n1 * mix1 + n2 * mix2 + 1) / 2;
        if (u > threshold) {
          grid[cy * cols + cx] = 1;
        }
      }
    }
    }

    // --- 2.5 Форма и размер структур ---
    // Открытие препятствий: тонкие гребни исчезают, крупные силуэты
    // и плавные изгибы остаются — проходы расширяются естественно
    this.openObstacles(grid, cols, rows);
    // Прямые щели-трещины между толстыми структурами закрываются
    this.sealPinchedGaps(grid, cols, rows);
    // Кластеры больше лимита режутся извилистым каньоном (не прямой!).
    // При высокой плотности резка пропускается: шум почти сплошной, и
    // детерминированные каньоны демонтируют лабиринт в «сыр» (а ещё все
    // сиды схлопываются к одному виду). Структуру дают сеед-случайные
    // коридоры (шаг 2.55) — они же режут гигантские кластеры.
    if (density < 0.9) {
      this.splitOversizedClusters(grid, cols, rows, brush, cellSize, MAX_CLUSTER_RATIO);
    }

    // --- 2.55 Извилистые коридоры на высокой плотности ---
    // При плотности выше ~0.55 свободного места мало, и лабиринт без
    // вмешательства схлопывается в «почти сплошную скалу». Прорезаем
    // сеть узких сеед-случайных извилистых коридоров (кисть = passageWidth,
    // вплоть до минимальной ширины прохода): лабиринт остаётся максимально
    // плотным, но связным и уникальным для каждого seed. Коридоры доходят
    // до нижней свободной полосы — дренируемы по построению, поэтому
    // заливка карманов (fillUndrained) их сохраняет.
    const corridorCount =
      density >= 1.5 ? 3 : density >= 0.9 ? 2 : density >= 0.55 ? 1 : 0;
    if (corridorCount > 0) {
      const yTo = height - bottomMargin;
      // Стратифицированная раскладка: по одному коридору на полосу ширины —
      // стартовые X гарантированно разнесены, лабиринты разных сидов не
      // могут совпасть коридорами (иначе при насыщенном шуме сиды почти
      // неотличимы)
      const band = width / corridorCount;
      for (let k = 0; k < corridorCount; k++) {
        const x0 = (k + 0.15 + rng() * 0.7) * band;
        const amp = 24 + rng() * 44;
        this.carveWindingV(grid, cols, rows, brush, x0, 0, yTo, amp, cellSize);
      }
    }

    // --- 3. Гарантия 100% проходимости от входа к выходу ---
    // Цель гарантийного коридора — сеед-случайная (не фиксированный центр):
    // положение основного прохода уникально для каждого seed
    const passTargetX = (0.2 + rng() * 0.6) * width;
    this.ensurePassability(grid, cols, rows, height, bottomMargin, brush, cellSize, passTargetX);

    // --- 3.7 Свободная полоса сверху (загон монстров) ---
    // Верх полосы загона свободен от препятствий: монстры выходят из загона
    // и падают в лабиринт. Очищаем до построения полигонов — и коллизии, и
    // отрисовка не задевают загон.
    const topFreeRows = clamp(Math.ceil(topFree / cellSize), 0, rows - 1);
    for (let cy = 0; cy < topFreeRows; cy++) {
      const row = cy * cols;
      for (let cx = 0; cx < cols; cx++) {
        grid[row + cx] = 0;
      }
    }

    // --- 3.8 Стены-кромки («стакан») ---
    // Борта-контейнер: крайние колонки целиком (от верха экрана, включая
    // загон, до самой нижней границы поля боя) — сплошные стены из блобов.
    // Раньше канал между крайней стеной лабиринта и границей поля (клэмп
    // EDGE_MARGIN) давал монстру, упавшему в него, застревать и лезть вверх
    // вдоль края; стакан убирает канал полностью — кромки как бортики поля.
    // Стакан строится ДО fillUndrained: заливы между бортом и блобом
    // заливаются как обычные недренируемые карманы.
    if (cols >= 2) {
      for (let cy = 0; cy < rows; cy++) {
        const row = cy * cols;
        grid[row] = 1;             // левый борт
        grid[row + cols - 1] = 1;  // правый борт
      }
    }

    // --- 3.5 Заливка недренируемых карманов ---
    // Движение монстров строго вниз: любая «яма» без пути вниз/вбок к
    // нижней полосе — пожизненная ловушка. Заливаем такие клетки.
    // Выполняется ПОСЛЕ стакана — карманы от бортов тоже заливаются.
    this.fillUndrained(grid, cols, rows, bottomMargin, cellSize);

    // --- 2.6 Разрыв длинных горизонтальных гребней ---
    // Монстры текут строго вниз: длинная горизонтальная «полка» —
    // ловушка, толпа копится и не может стечь. Разбиваем гребни длиннее
    // лимита вертикальными каналами шириной RUN_GAP (монстр ~2 клетки —
    // проваливается). Канал бурится СКВОЗЬ толщу гребня до первого
    // свободного ряда. Выполняется ПОСЛЕ заливки карманов: все свободные
    // клетки уже дренируемы, поэтому дно канала гарантированно имеет сток —
    // повторная заливка канал не тронет. Борта стакана (колонки 0 и
    // cols-1) не бурятся. Щели только увеличивают свободное пространство —
    // проходимость не страдает. На высокой плотности лабиринт — прорезанные
    // коридоры, разрыв не нужен.
    if (density < 1.5) {
      this.breakLongRuns(grid, cols, rows);

      // --- 2.61 Зубцы на вертикальных стенах ---
      // Длинные ровные стены дают ровные вертикальные коридоры. Ставим
      // выемки на краях длинных стен (толщина ≥ 2, чередуя стороны) —
      // коридор «дышит», не выглядит трубой. Выемка удаляет клетку только
      // при свободном соседе — сток есть, карманы не образуются.
      this.jitterVerticalWalls(grid, cols, rows);
    }

    // --- 3.6 Гарантия открытых входов сверху ---
    // Заливка могла запечатать весь верхний ряд (полости под входами).
    // Тогда монстрам некуда входить — пробиваем сквозные дренажные шахты.
    this.ensureTopEntrances(grid, cols, rows, height, bottomMargin, brush, cellSize);

    // --- 4. Контурная трассировка блобов -> сглаженные полигоны ---
    const obstacles = this.buildPolygons(grid, cols, rows, cellSize, width);

    const basePosition = { x: width / 2, y: height };
    const spawnPoints = entrances.map(e => ({ x: e.x, y: 6 }));

    return {
      seed,
      width,
      height,
      basePosition,
      entrances,
      exits,
      spawnPoints,
      obstacles,
      isBlocked: (x: number, y: number): boolean => {
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
          return false; // вне поля боя коллизий нет
        }
        return grid[cy * cols + cx] === 1;
      },
      getCollisionField: (): {
        cols: number;
        rows: number;
        cellSize: number;
        blocked: Uint8Array;
        widthPx: number;
      } => ({
        cols,
        rows,
        cellSize,
        // Сетка иммутабельна после генерации — отдаём ссылку без копии
        blocked: grid,
        widthPx: width
      })
    };
  }

  /**
   * Гарантия проходимости: многоисточниковый BFS от свободных клеток
   * самого верхнего ряда (всё, что входит в поле, обязательно проходит
   * через них). Если нижняя свободная полоса (выход) не достигнута —
   * прорезаем коридор шириной не меньше passageWidth от ближайшей
   * достигнутой клетки к середине нижней полосы.
   */
  private ensurePassability(
    grid: Uint8Array,
    cols: number,
    rows: number,
    height: number,
    bottomMargin: number,
    brush: number,
    cellSize: number,
    tx: number
  ): void {
    const botRows = Math.min(rows - 1, Math.ceil(bottomMargin / cellSize));

    // Страховка: если шум закрыл ВЕСЬ верхний ряд сплошняком, входа
    // сверху не будет вовсе — освобождаем центральные клетки ряда
    let topOpen = false;
    for (let cx = 0; cx < cols; cx++) {
      if (grid[cx] === 0) {
        topOpen = true;
        break;
      }
    }
    if (!topOpen) {
      const mid = Math.floor(cols / 2);
      for (let dx = -2; dx <= 2; dx++) {
        const cx = mid + dx;
        if (cx >= 0 && cx < cols) {
          grid[cx] = 0;
        }
      }
    }

    for (let iter = 0; iter < 25; iter++) {
      // BFS от свободных клеток верхнего ряда
      const dist = new Int32Array(cols * rows).fill(-1);
      const queue = new Int32Array(cols * rows);
      let qh = 0;
      let qt = 0;

      for (let cx = 0; cx < cols; cx++) {
        if (grid[cx] === 0) {
          dist[cx] = 0;
          queue[qt++] = cx;
        }
      }
      while (qh < qt) {
        const i = queue[qh++];
        const cx = i % cols;
        const cy = (i / cols) | 0;
        const d = dist[i] + 1;
        if (cx > 0 && grid[i - 1] === 0 && dist[i - 1] < 0) {
          dist[i - 1] = d;
          queue[qt++] = i - 1;
        }
        if (cx < cols - 1 && grid[i + 1] === 0 && dist[i + 1] < 0) {
          dist[i + 1] = d;
          queue[qt++] = i + 1;
        }
        if (cy > 0 && grid[i - cols] === 0 && dist[i - cols] < 0) {
          dist[i - cols] = d;
          queue[qt++] = i - cols;
        }
        if (cy < rows - 1 && grid[i + cols] === 0 && dist[i + cols] < 0) {
          dist[i + cols] = d;
          queue[qt++] = i + cols;
        }
      }

      // Достигнута ли нижняя свободная полоса (выход на всю ширину)
      let reachable = false;
      for (let cy = rows - 1 - botRows; cy < rows && !reachable; cy++) {
        for (let cx = 0; cx < cols && !reachable; cx++) {
          const i = cy * cols + cx;
          if (grid[i] === 0 && dist[i] >= 0) {
            reachable = true;
          }
        }
      }

      if (!reachable) {
        // Ближайшая достигнутая клетка к сеед-случайной цели у нижней полосы
        const ty = height - bottomMargin * 0.5;
        let bestI = -1;
        let bestD = Infinity;
        for (let i = 0; i < grid.length; i++) {
          if (dist[i] >= 0) {
            const dxp = (i % cols) * cellSize + cellSize / 2 - tx;
            const dyp = ((i / cols) | 0) * cellSize + cellSize / 2 - ty;
            const dd = dxp * dxp + dyp * dyp;
            if (dd < bestD) {
              bestD = dd;
              bestI = i;
            }
          }
        }
        if (bestI >= 0) {
          const sx = (bestI % cols) * cellSize + cellSize / 2;
          const sy = ((bestI / cols) | 0) * cellSize + cellSize / 2;
          this.carveCorridor(grid, cols, rows, sx, sy, tx, ty, brush, cellSize);
        }
      }

      if (reachable) {
        break;
      }
    }
  }

  /**
   * Морфологическое открытие препятствий (эрозия + дилатация, ядро 3x3):
   * исчезают гребни и шипы тоньше 3 клеток, крупные формы сохраняют
   * силуэт. В отличие от эрозии свободного места НЕ спрямляет проходы.
   * Клетки вне сетки считаются опорой — блобы у кромок не разрушаются.
   */
  /**
   * Разрыв длинных горизонтальных гребней вертикальными каналами.
   * Канал шириной RUN_GAP бурится вниз сквозь толщу гребня (обе колонки
   * вместе, пока обе заняты) до первого свободного ряда — монстры
   * проваливаются сквозь «полку», а не копятся на ней. Вызывается ПОСЛЕ
   * fillUndrained: все свободные клетки уже дренируемы, дно канала всегда
   * имеет сток, повторная заливка его не тронет. Борта стакана (колонки
   * 0 и cols-1) не бурятся: щель не может задеть крайние колонки.
   */
  private breakLongRuns(grid: Uint8Array, cols: number, rows: number): void {
    // Последняя допустимая стартовая колонка щели: RUN_GAP клеток не
    // задевают правый борт (cols-1)
    const gxMax = cols - RUN_GAP - 1;
    for (let cy = 0; cy < rows; cy++) {
      const row = cy * cols;
      let cx = 0;
      while (cx < cols) {
        if (grid[row + cx] === 0) {
          cx++;
          continue;
        }
        const start = cx;
        while (cx < cols && grid[row + cx] === 1) cx++;
        const len = cx - start;
        if (len < RUN_MIN) continue;
        let gx = start + RUN_SEG;
        while (gx + RUN_GAP <= start + len) {
          // Щель не может задеть правый борт: кламп стартовой колонки
          const gxC = Math.min(gx, gxMax);
          let cur = gxC;
          let dy = cy;
          while (dy < rows) {
            // Стоп: выход в свободные клетки ПОД текущими колонками канала —
            // дно канала всегда открыто (дренируется)
            if (grid[dy * cols + cur] !== 1 || grid[dy * cols + cur + 1] !== 1) break;
            if (dy > cy && (dy - cy) % RUN_WIND === 0) {
              // Зигзаг: сдвиг на ±1 (чередование). Переходный ряд освобождает
              // СТАРЫЕ и НОВЫЕ колонки (шаг шириной 3 клетки) — канал не
              // запечатывается на стыке, дно остаётся дренируемым
              const dir = ((dy + cur) & 1) === 0 ? 1 : -1;
              const ncur = Math.max(1, Math.min(gxMax, cur + dir));
              for (let c = Math.min(cur, ncur); c <= Math.max(cur, ncur) + 1; c++) {
                grid[dy * cols + c] = 0;
              }
              cur = ncur;
            } else {
              grid[dy * cols + cur] = 0;
              grid[dy * cols + cur + 1] = 0;
            }
            dy++;
          }
          gx += RUN_SEG + RUN_GAP;
        }
      }
    }
  }

  /**
   * Зубцы на длинных вертикальных стенах: выемки на краях (чередуя стороны)
   * каждые WALL_STEP рядов. Клетка удаляется ТОЛЬКО при свободном соседе
   * с соответствующей стороны — сток есть, карманы не образуются. Борта
   * стакана (колонки 0 и cols-1) и тонкие перегородки (< 2 клеток) не трогаем.
   */
  private jitterVerticalWalls(grid: Uint8Array, cols: number, rows: number): void {
    for (let cx = 1; cx < cols - 1; cx++) {
      let cy = 0;
      while (cy < rows) {
        if (grid[cy * cols + cx] === 0) {
          cy++;
          continue;
        }
        const start = cy;
        while (cy < rows && grid[cy * cols + cx] === 1) cy++;
        const len = cy - start;
        if (len < WALL_MIN) continue;
        // Толщина стены вправо от колонки cx (по первому ряду стены)
        let thick = 1;
        while (cx + thick < cols - 1 && grid[start * cols + cx + thick] === 1) thick++;
        if (thick < 2) continue;
        for (let k = 0; k * WALL_STEP < len - 2; k++) {
          const r = start + 2 + k * WALL_STEP;
          const row = r * cols;
          const leftFree = grid[row + cx - 1] === 0;
          const rightFree = grid[row + cx + thick] === 0;
          const useLeft = ((cx * 13 + start + k) & 1) === 0;
          if (useLeft && leftFree) {
            grid[row + cx] = 0;
          } else if (rightFree) {
            grid[row + cx + thick - 1] = 0;
          }
        }
      }
    }
  }

  private openObstacles(grid: Uint8Array, cols: number, rows: number): void {
    const eroded = new Uint8Array(grid.length);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        if (grid[i] === 0) continue;
        let survives = true;
        for (let dy = -1; dy <= 1 && survives; dy++) {
          for (let dx = -1; dx <= 1 && survives; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (grid[ny * cols + nx] === 0) survives = false;
          }
        }
        if (survives) eroded[i] = 1;
      }
    }

    // Дилтация: контур возвращается, кроме мест удалённых тонких деталей
    const opened = new Uint8Array(grid.length);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        if (eroded[i] === 1) {
          opened[i] = 1;
          continue;
        }
        let touch = false;
        for (let dy = -1; dy <= 1 && !touch; dy++) {
          for (let dx = -1; dx <= 1 && !touch; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (eroded[ny * cols + nx] === 1) touch = true;
          }
        }
        opened[i] = touch ? 1 : 0;
      }
    }
    grid.set(opened);
  }

  /**
   * Закрытие прямых трещин: свободная клетка, зажатая между препятствиями
   * по горизонтали или вертикали, заполняется. Диагональные «лестницы» и
   * широкие проходы не трогаются — органика форм сохраняется.
   */
  private sealPinchedGaps(grid: Uint8Array, cols: number, rows: number): void {
    for (let iter = 0; iter < 2; iter++) {
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const i = cy * cols + cx;
          if (grid[i] === 1) continue;
          const L = cx > 0 && grid[i - 1] === 1;
          const R = cx < cols - 1 && grid[i + 1] === 1;
          const U = cy > 0 && grid[i - cols] === 1;
          const D = cy < rows - 1 && grid[i + cols] === 1;
          if ((L && R) || (U && D)) grid[i] = 1;
        }
      }
    }
  }

  /** Очищает диск радиуса r в клетках сетки */
  private carveDisc(
    grid: Uint8Array,
    cols: number,
    rows: number,
    px: number,
    py: number,
    r: number,
    cellSize: number
  ): void {
    const rSq = r * r;
    const cx0 = Math.max(0, Math.floor((px - r) / cellSize));
    const cx1 = Math.min(cols - 1, Math.floor((px + r) / cellSize));
    const cy0 = Math.max(0, Math.floor((py - r) / cellSize));
    const cy1 = Math.min(rows - 1, Math.floor((py + r) / cellSize));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const wx = cx * cellSize + cellSize / 2;
        const wy = cy * cellSize + cellSize / 2;
        const ddx = wx - px;
        const ddy = wy - py;
        if (ddx * ddx + ddy * ddy <= rSq) {
          grid[cy * cols + cx] = 0;
        }
      }
    }
  }

  /** Извилистый вертикальный каньон (~1.5 синус-волны, детерминированный) */
  private carveWindingV(
    grid: Uint8Array,
    cols: number,
    rows: number,
    r: number,
    xCenter: number,
    yFrom: number,
    yTo: number,
    amplitude: number,
    cellSize: number
  ): void {
    const span = Math.max(CELL, yTo - yFrom);
    const freq = (Math.PI * 3) / span;
    const phase = ((Math.round(xCenter / CELL) * 31) % 10) * (Math.PI / 5);
    const steps = Math.ceil(span / (CELL * 0.5));
    for (let s = 0; s <= steps; s++) {
      const y = yFrom + ((yTo - yFrom) * s) / steps;
      const x = xCenter + Math.sin(y * freq + phase) * amplitude;
      this.carveDisc(grid, cols, rows, x, y, r, cellSize);
    }
  }

  /** Извилистый горизонтальный каньон */
  private carveWindingH(
    grid: Uint8Array,
    cols: number,
    rows: number,
    r: number,
    yCenter: number,
    xFrom: number,
    xTo: number,
    amplitude: number,
    cellSize: number
  ): void {
    const span = Math.max(CELL, xTo - xFrom);
    const freq = (Math.PI * 3) / span;
    const phase = ((Math.round(yCenter / CELL) * 17) % 10) * (Math.PI / 5);
    const steps = Math.ceil(span / (CELL * 0.5));
    for (let s = 0; s <= steps; s++) {
      const x = xFrom + ((xTo - xFrom) * s) / steps;
      const y = yCenter + Math.sin(x * freq + phase) * amplitude;
      this.carveDisc(grid, cols, rows, x, y, r, cellSize);
    }
  }

  /**
   * Лимит размера кластеров: если связный блоб занимает больше maxRatio
   * площади поля — разрезаем извилистым каньоном через его центр
   * (вертикаль/горизонталь чередуются по итерациям), до 8 раз.
   */
  private splitOversizedClusters(
    grid: Uint8Array,
    cols: number,
    rows: number,
    brush: number,
    cellSize: number,
    maxRatio: number
  ): void {
    const maxCells = Math.floor(cols * rows * maxRatio);
    const label = new Int32Array(grid.length);
    const stack: number[] = [];

    for (let iter = 0; iter < 8; iter++) {
      label.fill(0);
      let worstSize = 0;
      let worstBox: [number, number, number, number] | null = null;

      for (let start = 0; start < grid.length; start++) {
        if (grid[start] !== 1 || label[start] !== 0) continue;

        // BFS компонента (4-связность)
        stack.length = 0;
        stack.push(start);
        label[start] = 1;
        let size = 0;
        let minX = cols, maxX = -1, minY = rows, maxY = -1;
        while (stack.length > 0) {
          const j = stack.pop()!;
          size++;
          const jx = j % cols;
          const jy = (j / cols) | 0;
          if (jx < minX) minX = jx;
          if (jx > maxX) maxX = jx;
          if (jy < minY) minY = jy;
          if (jy > maxY) maxY = jy;

          if (jx > 0 && grid[j - 1] === 1 && label[j - 1] === 0) { label[j - 1] = 1; stack.push(j - 1); }
          if (jx < cols - 1 && grid[j + 1] === 1 && label[j + 1] === 0) { label[j + 1] = 1; stack.push(j + 1); }
          if (jy > 0 && grid[j - cols] === 1 && label[j - cols] === 0) { label[j - cols] = 1; stack.push(j - cols); }
          if (jy < rows - 1 && grid[j + cols] === 1 && label[j + cols] === 0) { label[j + cols] = 1; stack.push(j + cols); }
        }

        if (size > worstSize) {
          worstSize = size;
          worstBox = [minX, minY, maxX, maxY];
        }
      }

      if (worstSize <= maxCells || !worstBox) return;

      const [minX, minY, maxX, maxY] = worstBox;
      const amp = Math.min((iter % 2 === 0 ? maxX - minX : maxY - minY) * cellSize * 0.35, 64);
      if (iter % 2 === 0) {
        // Вертикальный извилистый каньон через блоб (только его bbox!)
        this.carveWindingV(
          grid, cols, rows, brush,
          ((minX + maxX) / 2 + 0.5) * cellSize,
          minY * cellSize - brush,
          (maxY + 1) * cellSize + brush,
          amp,
          cellSize
        );
      } else {
        this.carveWindingH(
          grid, cols, rows, brush,
          ((minY + maxY) / 2 + 0.5) * cellSize,
          minX * cellSize - brush,
          (maxX + 1) * cellSize + brush,
          amp,
          cellSize
        );
      }
    }
  }

  /**
   * Гарантия открытого верха: если после заливки карманов в верхнем ряду
   * не осталось свободных клеток, пробиваем вертикальные дренажные шахты
   * от кромки до нижней полосы (шаг ~240px). Шахта — цепочка свободных
   * клеток друг под другом, поэтому она дренируема по построению и не
   * закрывается повторной заливкой.
   */
  private ensureTopEntrances(
    grid: Uint8Array,
    cols: number,
    rows: number,
    height: number,
    bottomMargin: number,
    brush: number,
    cellSize: number
  ): void {
    let open = false;
    for (let cx = 0; cx < cols; cx++) {
      if (grid[cx] === 0) {
        open = true;
        break;
      }
    }
    if (open) return;

    const shafts = Math.max(2, Math.floor((cols * cellSize) / 240));
    const ty = height - bottomMargin * 0.5;
    for (let k = 0; k < shafts; k++) {
      const x = ((k + 0.5) / shafts) * cols * cellSize;
      this.carveCorridor(grid, cols, rows, x, -cellSize, x, ty, brush, cellSize);
    }

    // Шахты освободили новые клетки у стен — финальная заливка карманов
    this.fillUndrained(grid, cols, rows, bottomMargin, cellSize);
  }

  /**
   * Заливка недренируемых клеток (глубокие выемки, замкнутые полости).
   *
   * Семантика движения монстров: вниз, если свободно; иначе скольжение
   * вбок по строке. Клетка «безопасна», только если из неё есть путь
   * {вниз, влево, вправо} до нижней свободной полосы. Считаем снизу
   * вверх: прямое падение из клетки ниже + горизонтальное замыкание
   * внутри строки (два прохода LR/RL покрывают интервал целиком).
   * Все свободные небезопасные клетки заливаются как препятствия —
   * полигоны для отрисовки строятся уже после, поэтому ландшафт
   * остаётся бесшовным. Детерминизм не нарушен: чистая функция сетки.
   */
  private fillUndrained(
    grid: Uint8Array,
    cols: number,
    rows: number,
    bottomMargin: number,
    cellSize: number
  ): number {
    const botRows = Math.min(rows, Math.ceil(bottomMargin / cellSize));
    const safe = new Uint8Array(cols * rows);

    // Нижняя свободная полоса — сток, все её клетки безопасны
    for (let cy = rows - botRows; cy < rows; cy++) {
      const row = cy * cols;
      for (let cx = 0; cx < cols; cx++) {
        safe[row + cx] = 1;
      }
    }

    for (let cy = rows - botRows - 1; cy >= 0; cy--) {
      const row = cy * cols;
      const below = row + cols;

      // Падение прямо вниз
      for (let cx = 0; cx < cols; cx++) {
        if (grid[row + cx] === 0 && safe[below + cx] === 1) {
          safe[row + cx] = 1;
        }
      }
      // Скольжение вбок вдоль строки
      for (let cx = 1; cx < cols; cx++) {
        if (grid[row + cx] === 0 && safe[row + cx] === 0 && safe[row + cx - 1] === 1) {
          safe[row + cx] = 1;
        }
      }
      for (let cx = cols - 2; cx >= 0; cx--) {
        if (grid[row + cx] === 0 && safe[row + cx] === 0 && safe[row + cx + 1] === 1) {
          safe[row + cx] = 1;
        }
      }
    }

    // Небезопасные свободные клетки -> препятствие
    let filled = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === 0 && safe[i] === 0) {
        grid[i] = 1;
        filled++;
      }
    }
    return filled;
  }

  /** Очищает круги радиуса r вдоль отрезка (x0;y0)->(x1;y1) */
  private carveCorridor(
    grid: Uint8Array,
    cols: number,
    rows: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    cellSize: number
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    const rSq = r * r;

    for (let s = 0; s <= steps; s++) {
      const px = x0 + (dx * s) / steps;
      const py = y0 + (dy * s) / steps;
      const cx0 = Math.max(0, Math.floor((px - r) / cellSize));
      const cx1 = Math.min(cols - 1, Math.floor((px + r) / cellSize));
      const cy0 = Math.max(0, Math.floor((py - r) / cellSize));
      const cy1 = Math.min(rows - 1, Math.floor((py + r) / cellSize));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx = cx * cellSize + cellSize / 2;
          const wy = cy * cellSize + cellSize / 2;
          const ddx = wx - px;
          const ddy = wy - py;
          if (ddx * ddx + ddy * ddy <= rSq) {
            grid[cy * cols + cx] = 0;
          }
        }
      }
    }
  }

  /**
   * Трассировка контуров занятых клеток: направленные граничные рёбра
   * (по часовой стрелке) сцепляются в замкнутые петли, затем петли
   * сглаживаются алгоритмом Chaikin -> органичные формы без угловатости.
   * Мелкие «кляксы» (площадь < 2 клеток) отсеиваются, НО у кромок поля
   * сохраняются: иначе коллизия без отрисовки — «невидимое препятствие».
   */
  private buildPolygons(
    grid: Uint8Array,
    cols: number,
    rows: number,
    cellSize: number,
    fieldWidthPx?: number
  ): ObstaclePolygon[] {
    type Edge = [number, number, number, number];
    const edges: Edge[] = [];
    const startMap = new Map<string, number[]>();
    const keyOf = (x: number, y: number): string => `${Math.round(x)},${Math.round(y)}`;

    const pushEdge = (e: Edge): void => {
      const idx = edges.length;
      edges.push(e);
      const k = keyOf(e[0], e[1]);
      const arr = startMap.get(k);
      if (arr) {
        arr.push(idx);
      } else {
        startMap.set(k, [idx]);
      }
    };

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (grid[cy * cols + cx] !== 1) continue;
        const x0 = cx * cellSize;
        const y0 = cy * cellSize;
        const x1 = x0 + cellSize;
        const y1 = y0 + cellSize;
        const upFree = cy === 0 || grid[(cy - 1) * cols + cx] === 0;
        const rightFree = cx === cols - 1 || grid[cy * cols + cx + 1] === 0;
        const downFree = cy === rows - 1 || grid[(cy + 1) * cols + cx] === 0;
        const leftFree = cx === 0 || grid[cy * cols + cx - 1] === 0;
        if (upFree) pushEdge([x0, y0, x1, y0]);
        if (rightFree) pushEdge([x1, y0, x1, y1]);
        if (downFree) pushEdge([x1, y1, x0, y1]);
        if (leftFree) pushEdge([x0, y1, x0, y0]);
      }
    }

    const used = new Uint8Array(edges.length);
    const result: ObstaclePolygon[] = [];

    for (let s = 0; s < edges.length; s++) {
      if (used[s]) continue;

      const chain: Edge[] = [];
      let cur = s;
      while (cur !== -1 && !used[cur]) {
        used[cur] = 1;
        chain.push(edges[cur]);
        const endKey = keyOf(edges[cur][2], edges[cur][3]);
        const cands = startMap.get(endKey);
        let next = -1;
        if (cands) {
          for (let k = 0; k < cands.length; k++) {
            if (!used[cands[k]]) {
              next = cands[k];
              break;
            }
          }
        }
        cur = next;
      }

      // Петля обязана замыкаться
      if (chain.length < 4) continue;
      const firstKey = keyOf(chain[0][0], chain[0][1]);
      const lastEndKey = keyOf(chain[chain.length - 1][2], chain[chain.length - 1][3]);
      if (firstKey !== lastEndKey) continue;

      // Рёбра -> вершины
      let pts: { x: number; y: number }[] = chain.map(e => ({ x: e[0], y: e[1] }));

      // Сглаживание Chaikin
      for (let it = 0; it < SMOOTH_ITER; it++) {
        const nextPts: { x: number; y: number }[] = [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % n];
          nextPts.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
          nextPts.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
        }
        pts = nextPts;
      }

      // Отсев мелких клякс по площади (формула шнурования).
      // У кромок поля НЕ отсеиваем: иначе «невидимое препятствие» —
      // коллизия без отрисовки у левого/правого края.
      let area2 = 0;
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        area2 += a.x * b.y - b.x * a.y;
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
      }
      const nearEdge =
        minX <= cellSize || (fieldWidthPx !== undefined && maxX >= fieldWidthPx - cellSize);
      if (Math.abs(area2) / 2 < cellSize * cellSize * 2 && !nearEdge) continue;

      result.push({ points: pts });
    }

    return result;
  }

  static getDefaultParams(seed: string = Date.now().toString()): LevelParams & { monsterCount: number } {
    return {
      seed,
      width: 400,
      height: 900,
      passageWidth: 60,
      obstacleDensity: 0.4,
      monsterCount: 100
    };
  }
}
