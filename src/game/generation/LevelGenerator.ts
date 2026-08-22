import SimplexNoise from 'simplex-noise';

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
}

// ============================================================
// Генератор уровней
// ============================================================

const CELL = 16;      // размер клетки сетки коллизий, px
const SMOOTH_ITER = 2;
// Нижняя часть поля свободна от препятствий: рукава из лабиринта
// свободно выливаются к зоне базы (~1/10 высоты поля)
const BOTTOM_FREE_RATIO = 0.1;

export class LevelGenerator {
  generate(params: LevelParams): Level {
    const seed = params.seed;

    // Детерминированный ГПСЧ; шум строится на его основе
    const rng = mulberry32(xmur3(seed)());
    const noise = new SimplexNoise(rng);

    const width = Math.max(200, Math.floor(params.width));
    const height = Math.max(300, Math.floor(params.height));
    const passageWidth = clamp(params.passageWidth ?? 60, 24, 200);
    const density = clamp(params.obstacleDensity ?? 0.4, 0.05, 0.95);
    const bottomMargin = clamp(height * BOTTOM_FREE_RATIO, CELL * 2, height * 0.25);

    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const grid = new Uint8Array(cols * rows); // 1 = клетка занята препятствием

    // --- 1. Вход и выход на всю ширину поля ---
    // Монстры спавнятся над экраном по всей ширине; на потоки их делит
    // сам лабиринт (прорехи между блобами у верхнего края). Снизу полоса
    // без препятствий — рукава свободно выливаются к базе.
    const entrances: Entrance[] = [{ x: width / 2, y: 0, width: width }];
    const exits: Exit[] = [{ x: width / 2, y: height, width: width }];

    // --- 2. Препятствия: органические блобы через fbm-шум ---
    // Порог подобран так, что density=0.4 даёт ~30% заполнения.
    const threshold = 0.685 - density * 0.25;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const wx = cx * CELL + CELL / 2;
        const wy = cy * CELL + CELL / 2;
        // Свободная зона только внизу: верх и бока без отступа, блобы
        // могут начинаться прямо от кромки поля
        if (wy > height - bottomMargin) continue;
        const n1 = noise.noise2D(wx * 0.006, wy * 0.006);
        const n2 = noise.noise2D(wx * 0.02 + 512.7, wy * 0.02 + 217.3);
        const u = (n1 * 0.72 + n2 * 0.28 + 1) / 2;
        if (u > threshold) {
          grid[cy * cols + cx] = 1;
        }
      }
    }

    // --- 3. Гарантия 100% проходимости от входа к выходу ---
    this.ensurePassability(grid, cols, rows, width, height, bottomMargin, passageWidth);

    // --- 4. Контурная трассировка блобов -> сглаженные полигоны ---
    const obstacles = this.buildPolygons(grid, cols, rows);

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
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
          return false; // вне поля боя коллизий нет
        }
        return grid[cy * cols + cx] === 1;
      }
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
    width: number,
    height: number,
    bottomMargin: number,
    passageWidth: number
  ): void {
    const botRows = Math.min(rows - 1, Math.ceil(bottomMargin / CELL));
    const brush = Math.max(passageWidth / 2, CELL * 1.25);

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
        // Ближайшая достигнутая клетка к середине нижней полосы
        const tx = width / 2;
        const ty = height - bottomMargin * 0.5;
        let bestI = -1;
        let bestD = Infinity;
        for (let i = 0; i < grid.length; i++) {
          if (dist[i] >= 0) {
            const dxp = (i % cols) * CELL + CELL / 2 - tx;
            const dyp = ((i / cols) | 0) * CELL + CELL / 2 - ty;
            const dd = dxp * dxp + dyp * dyp;
            if (dd < bestD) {
              bestD = dd;
              bestI = i;
            }
          }
        }
        if (bestI >= 0) {
          const sx = (bestI % cols) * CELL + CELL / 2;
          const sy = ((bestI / cols) | 0) * CELL + CELL / 2;
          this.carveCorridor(grid, cols, rows, sx, sy, tx, ty, brush);
        }
      }

      if (reachable) {
        break;
      }
    }
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
    r: number
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    const rSq = r * r;

    for (let s = 0; s <= steps; s++) {
      const px = x0 + (dx * s) / steps;
      const py = y0 + (dy * s) / steps;
      const cx0 = Math.max(0, Math.floor((px - r) / CELL));
      const cx1 = Math.min(cols - 1, Math.floor((px + r) / CELL));
      const cy0 = Math.max(0, Math.floor((py - r) / CELL));
      const cy1 = Math.min(rows - 1, Math.floor((py + r) / CELL));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx = cx * CELL + CELL / 2;
          const wy = cy * CELL + CELL / 2;
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
   */
  private buildPolygons(grid: Uint8Array, cols: number, rows: number): ObstaclePolygon[] {
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
        const x0 = cx * CELL;
        const y0 = cy * CELL;
        const x1 = x0 + CELL;
        const y1 = y0 + CELL;
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

      // Отсев мелких клякс по площади (формула шнурования)
      let area2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        area2 += a.x * b.y - b.x * a.y;
      }
      if (Math.abs(area2) / 2 < CELL * CELL * 2) continue;

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
