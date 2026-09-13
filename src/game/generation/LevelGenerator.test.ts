import { LevelGenerator, type Level } from './LevelGenerator';

const gen = new LevelGenerator();

function blockedOf(level: Level): Uint8Array {
  return level.getCollisionField().blocked;
}

function fillRatio(level: Level): number {
  const cf = level.getCollisionField();
  let n = 0;
  for (let i = 0; i < cf.blocked.length; i++) n += cf.blocked[i];
  return n / cf.blocked.length;
}

/**
 * BFS-проверка гарантии проходимости генератора: из свободных клеток
 * верхнего ряда достижима нижняя свободная полоса (выход на всю ширину).
 */
function isPassable(level: Level): boolean {
  const cf = level.getCollisionField();
  const { cols, rows, blocked } = cf;
  const bottomMargin = Math.min(level.height * 0.25, Math.max(level.height * 0.1, 32));
  const botRows = Math.min(rows, Math.ceil(bottomMargin / cf.cellSize));
  const dist = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  let qh = 0;
  let qt = 0;
  for (let cx = 0; cx < cols; cx++) {
    if (blocked[cx] === 0) {
      dist[cx] = 0;
      queue[qt++] = cx;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const cx = i % cols;
    const cy = (i / cols) | 0;
    const d = dist[i] + 1;
    if (cx > 0 && blocked[i - 1] === 0 && dist[i - 1] < 0) {
      dist[i - 1] = d;
      queue[qt++] = i - 1;
    }
    if (cx < cols - 1 && blocked[i + 1] === 0 && dist[i + 1] < 0) {
      dist[i + 1] = d;
      queue[qt++] = i + 1;
    }
    if (cy > 0 && blocked[i - cols] === 0 && dist[i - cols] < 0) {
      dist[i - cols] = d;
      queue[qt++] = i - cols;
    }
    if (cy < rows - 1 && blocked[i + cols] === 0 && dist[i + cols] < 0) {
      dist[i + cols] = d;
      queue[qt++] = i + cols;
    }
  }
  for (let cy = rows - botRows; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      if (blocked[i] === 0 && dist[i] >= 0) return true;
    }
  }
  return false;
}

/**
 * Количество свободных клеток без пути вниз к нижней полосе (карманы).
 * Тот же алгоритм, что в fillUndrained: сток — нижние botRows рядов.
 */
function undrainedCount(level: Level): number {
  const cf = level.getCollisionField();
  const { cols, rows, blocked } = cf;
  const bottomMargin = Math.min(level.height * 0.25, Math.max(level.height * 0.1, 32));
  const botRows = Math.min(rows, Math.ceil(bottomMargin / cf.cellSize));
  const safe = new Uint8Array(cols * rows);
  for (let cy = rows - botRows; cy < rows; cy++) {
    const row = cy * cols;
    for (let cx = 0; cx < cols; cx++) safe[row + cx] = 1;
  }
  for (let cy = rows - botRows - 1; cy >= 0; cy--) {
    const row = cy * cols;
    const below = row + cols;
    for (let cx = 0; cx < cols; cx++) {
      if (blocked[row + cx] === 0 && safe[below + cx] === 1) safe[row + cx] = 1;
    }
    for (let cx = 1; cx < cols; cx++) {
      if (blocked[row + cx] === 0 && safe[row + cx] === 0 && safe[row + cx - 1] === 1) safe[row + cx] = 1;
    }
    for (let cx = cols - 2; cx >= 0; cx--) {
      if (blocked[row + cx] === 0 && safe[row + cx] === 0 && safe[row + cx + 1] === 1) safe[row + cx] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < blocked.length; i++) if (blocked[i] === 0 && safe[i] === 0) n++;
  return n;
}

describe('LevelGenerator', () => {
  describe('детерминизм', () => {
    it('тот же seed → идентичная сетка коллизий и полигоны', () => {
      const params = { seed: 'det-1', width: 544, height: 976, obstacleDensity: 1.2, blobScale: 1.3 };
      const a = gen.generate(params);
      const b = gen.generate(params);
      expect(blockedOf(a)).toEqual(blockedOf(b));
      expect(a.obstacles).toEqual(b.obstacles);
    });

    it('разные seed → разные сетки', () => {
      const a = gen.generate({ seed: 'det-2-a', width: 544, height: 976 });
      const b = gen.generate({ seed: 'det-2-b', width: 544, height: 976 });
      const ca = blockedOf(a);
      const cb = blockedOf(b);
      let diff = 0;
      for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) diff++;
      expect(diff / ca.length).toBeGreaterThan(0.02);
    });
  });

  describe('независимость от разрешения экрана', () => {
    it('тот же seed на полях 1× и 2× даёт похожий паттерн', () => {
      // 544×976 → 34×61 клеток, 1088×1952 → 68×122: углы клеток совпадают
      // ровно (cx,cy) ↔ (2cx,2cy), raw-шум в этих точках идентичен —
      // расхождение даёт только постобработка, масштабируемая по клеткам.
      // Тест — стресс ×2 (реальные устройства дают разброс ширины ~±10%,
      // где совпадение существенно выше); пороги ниже — осознанно.
      for (const density of [0.4, 1.5, 2.0]) {
        for (let s = 0; s < 4; s++) {
          const seed = `res-${density}-${s}`;
          const l1 = gen.generate({ seed, width: 544, height: 976, obstacleDensity: density });
          const l2 = gen.generate({ seed, width: 1088, height: 1952, obstacleDensity: density });
          const f1 = l1.getCollisionField();
          const f2 = l2.getCollisionField();
          let agree = 0;
          let total = 0;
          for (let cy = 0; cy < f1.rows; cy++) {
            for (let cx = 0; cx < f1.cols; cx++) {
              total++;
              if ((f1.blocked[cy * f1.cols + cx] === 1) === (f2.blocked[cy * 2 * f2.cols + cx * 2] === 1)) agree++;
            }
          }
          expect(agree / total).toBeGreaterThan(0.55);
          expect(Math.abs(fillRatio(l1) - fillRatio(l2))).toBeLessThan(0.16);
        }
      }
    });
  });

  describe('плотность и разнообразие', () => {
    it('максимальная плотность: очень плотно, но проходимо', () => {
      const seeds = ['max-0', 'max-1', 'max-2', 'max-3', 'max-4', 'max-5'];
      for (const seed of seeds) {
        const f = fillRatio(gen.generate({ seed, width: 544, height: 976, obstacleDensity: 2 }));
        expect(f).toBeGreaterThan(0.5);
        expect(f).toBeLessThan(0.9);
        expect(isPassable(gen.generate({ seed, width: 544, height: 976, obstacleDensity: 2 }))).toBe(true);
      }
    });

    it('максимальная плотность: сиды различаются существенно', () => {
      const seeds = ['var-0', 'var-1', 'var-2', 'var-3', 'var-4'];
      const grids = seeds.map(seed => blockedOf(gen.generate({ seed, width: 544, height: 976, obstacleDensity: 2 })));
      for (let i = 0; i < grids.length; i++) {
        for (let j = i + 1; j < grids.length; j++) {
          let diff = 0;
          for (let k = 0; k < grids[i].length; k++) if (grids[i][k] !== grids[j][k]) diff++;
          expect(diff / grids[i].length).toBeGreaterThan(0.08);
        }
      }
    });

    it('плотность читается: медиана заполнения растёт с obstacleDensity', () => {
      const median = (density: number): number => {
        const fills = [0, 1, 2, 3, 4].map(s =>
          fillRatio(gen.generate({ seed: `mono-${density}-${s}`, width: 544, height: 976, obstacleDensity: density }))
        );
        fills.sort((a, b) => a - b);
        return fills[2];
      };
      const m03 = median(0.3);
      const m09 = median(0.9);
      const m20 = median(2);
      expect(m09).toBeGreaterThan(m03);
      expect(m20).toBeGreaterThan(m09);
    });

    it('проходимость на всех плотностях', () => {
      for (const density of [0.01, 0.3, 0.9, 2]) {
        for (let s = 0; s < 5; s++) {
          const level = gen.generate({ seed: `pass-${density}-${s}`, width: 544, height: 976, obstacleDensity: density });
          expect(isPassable(level)).toBe(true);
        }
      }
    });

    it('плотность 0 — пустое поле с бортами-стаканом (последние уровни)', () => {
      const level = gen.generate({ seed: 'empty-1', width: 544, height: 976, obstacleDensity: 0 });
      const cf = level.getCollisionField();
      const { cols, rows, blocked } = cf;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const expected = cx === 0 || cx === cols - 1 ? 1 : 0;
          expect(blocked[cy * cols + cx]).toBe(expected);
        }
      }
      expect(isPassable(level)).toBe(true);
      expect(undrainedCount(level)).toBe(0);
    });

    it('борта-стакан: крайние колонки сплошные на любой плотности', () => {
      for (const density of [0, 0.3, 0.4, 2]) {
        const level = gen.generate({ seed: `cup-${density}`, width: 544, height: 976, obstacleDensity: density });
        const cf = level.getCollisionField();
        const { cols, rows, blocked } = cf;
        for (let cy = 0; cy < rows; cy++) {
          expect(blocked[cy * cols]).toBe(1);
          expect(blocked[cy * cols + cols - 1]).toBe(1);
        }
      }
    });

    it('нет недренируемых клеток (карманы) на всех плотностях', () => {
      for (const density of [0.3, 0.9, 2]) {
        for (let s = 0; s < 5; s++) {
          const level = gen.generate({ seed: `drain-${density}-${s}`, width: 544, height: 976, obstacleDensity: density });
          expect(undrainedCount(level)).toBe(0);
        }
      }
    });
  });
});