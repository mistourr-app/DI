import { cellsWithinCircle, cellAt, biteCells } from './earthCells';

describe('earthCells', () => {
  const cols = 10;
  const rows = 20;
  const cell = 16;

  it('cellAt возвращает плоский индекс cy*cols+cx', () => {
    expect(cellAt(cols, rows, cell, 0, 0)).toBe(0);
    expect(cellAt(cols, rows, cell, 16, 16)).toBe(cols + 1);
    expect(cellAt(cols, rows, cell, 15, 15)).toBe(0);
  });

  it('cellAt вне сетки -> -1', () => {
    expect(cellAt(cols, rows, cell, -1, 0)).toBe(-1);
    expect(cellAt(cols, rows, cell, 0, -1)).toBe(-1);
    expect(cellAt(cols, rows, cell, 10 * cell, 0)).toBe(-1);
    expect(cellAt(cols, rows, cell, 0, 20 * cell)).toBe(-1);
  });

  it('cellsWithinCircle покрывает центр и соседей в радиусе', () => {
    // Точка в центре ячейки (cx=4, cy=5): 8 + 1 вокруг внутри радиуса ~клетки
    const cs = cellsWithinCircle(cols, rows, cell, 4 * cell + 8, 5 * cell + 8, cell * 1.4);
    const center = cellAt(cols, rows, cell, 4 * cell + 8, 5 * cell + 8);
    expect(cs).toContain(center);
    // Ни одна ячейка не дублируется
    expect(new Set(cs).size).toBe(cs.length);
  });

  it('cellsWithinCircle не выходит за сетку', () => {
    const cs = cellsWithinCircle(cols, rows, cell, 2, 2, cell * 3);
    for (const c of cs) {
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThan(cols);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThan(rows);
    }
  });

  it('cellsWithinCircle радиус 0 покрывает только центр', () => {
    const cs = cellsWithinCircle(cols, rows, cell, 8, 8, 0);
    expect(cs).toEqual([0]);
  });

  describe('biteCells', () => {
    it('декрементит HP и удаляет ячейки при 0', () => {
      const hp = new Uint8Array(5);
      hp[0] = 3;
      hp[1] = 1;
      hp[2] = 2;
      const removed = biteCells(hp, [0, 1, 2]);
      expect(hp[0]).toBe(2);
      expect(hp[1]).toBe(0);
      expect(hp[2]).toBe(1);
      expect(removed).toEqual([1]);
    });

    it('пустые ячейки (HP 0) не трогаются', () => {
      const hp = new Uint8Array(3);
      const removed = biteCells(hp, [0, 1, 2]);
      expect(removed).toEqual([]);
      expect(Array.from(hp)).toEqual([0, 0, 0]);
    });

    it('damage больше HP удаляет сразу', () => {
      const hp = new Uint8Array(2);
      hp[0] = 2;
      const removed = biteCells(hp, [0], 5);
      expect(hp[0]).toBe(0);
      expect(removed).toEqual([0]);
    });

    it('индексы вне массива игнорируются', () => {
      const hp = new Uint8Array(2);
      hp[0] = 1;
      const removed = biteCells(hp, [-1, 99]);
      expect(removed).toEqual([]);
      expect(hp[0]).toBe(1);
    });
  });
});