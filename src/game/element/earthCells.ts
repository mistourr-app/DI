// ============================================================
// earthCells — чистые хелперы ячеек Земли-барьера (Итерация 2).
// Без Phaser: тестируются в jest. Координаты ЛОКАЛЬНЫЕ (поле боя).
// ============================================================

/**
 * Плоские индексы ячеек (cy*cols+cx), центры которых попадают в круг
 * вокруг точки. Вне сетки ячейки отбрасываются.
 */
export function cellsWithinCircle(
  cols: number,
  rows: number,
  cellSize: number,
  lx: number,
  ly: number,
  radiusPx: number
): number[] {
  const out: number[] = [];
  const r2 = radiusPx * radiusPx;
  const minCX = Math.floor((lx - radiusPx) / cellSize);
  const maxCX = Math.floor((lx + radiusPx) / cellSize);
  const minCY = Math.floor((ly - radiusPx) / cellSize);
  const maxCY = Math.floor((ly + radiusPx) / cellSize);
  for (let cy = minCY; cy <= maxCY; cy++) {
    if (cy < 0 || cy >= rows) continue;
    for (let cx = minCX; cx <= maxCX; cx++) {
      if (cx < 0 || cx >= cols) continue;
      const ccx = cx * cellSize + cellSize / 2;
      const ccy = cy * cellSize + cellSize / 2;
      const dx = ccx - lx;
      const dy = ccy - ly;
      if (dx * dx + dy * dy <= r2) out.push(cy * cols + cx);
    }
  }
  return out;
}

/** Плоский индекс ячейки по точке или -1 (вне сетки) */
export function cellAt(
  cols: number,
  rows: number,
  cellSize: number,
  lx: number,
  ly: number
): number {
  const cx = Math.floor(lx / cellSize);
  const cy = Math.floor(ly / cellSize);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return -1;
  return cy * cols + cx;
}

/**
 * Укус монстра: декрементит HP перечисленных ячеек на damage (по умолчанию 1).
 * Ячейки, чьё HP упало до 0, возвращаются как удалённые (их снимает воркер).
 * cellHp — overlay прочности (0 = нет земли, >0 = осталось укусов).
 */
export function biteCells(
  cellHp: Uint8Array,
  indices: number[],
  damage = 1
): number[] {
  const removed: number[] = [];
  for (const c of indices) {
    if (c < 0 || c >= cellHp.length || cellHp[c] === 0) continue;
    cellHp[c] = cellHp[c] > damage ? cellHp[c] - damage : 0;
    if (cellHp[c] === 0) removed.push(c);
  }
  return removed;
}