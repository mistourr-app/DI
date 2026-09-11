// ============================================================
// blobTiles — чистое ядро блоб-автотайла препятствий (без Phaser).
//
// Классическая схема «47 тайлов» (Tiled/Godot "match corners and sides"):
// из 256 вариантов соседства 2^8 различимы ровно 47. Правило схлопывания:
// угловой бит значим только если установлены ОБА прилегающих боковых бита
// (иначе диагональный сосед не меняет силуэт — уже есть внешний край).
//
// Геометрия тайла (см. blobAtlas.ts): базовый круг (радиус 8, центр клетки)
// + полудиски на сторонах, где есть сосед + четверть-диски на углах, где
// есть диагональный сосед с обоими боками. Полудиски/четверть-диски
// соседних клеток совпадают в одной точке — швов не бывает.
// ============================================================

// Биты соседей (y вниз). Порядок совпадает со стандартом Tiled/Godot.
export const B_N = 1;
export const B_NE = 2;
export const B_E = 4;
export const B_SE = 8;
export const B_S = 16;
export const B_SW = 32;
export const B_W = 64;
export const B_NW = 128;

export const SIDE_BITS = B_N | B_E | B_S | B_W;

/** Политика трактовки клеток за границей сетки при выборе кадра. */
export type BlobEdgePolicy = 'solid' | 'organic';

export interface BlobFrameOptions {
  /**
   * 'solid' (дефолт): верх/лево/право за полем считаются занятыми — стены
   * у кромок поля ровные (как при полигональном рендере).
   * 'organic': всё за полем свободно — кромки волнистые.
   * Низ всегда свободен (полоса выхода внутри сетки).
   */
  edgePolicy?: BlobEdgePolicy;
}

/**
 * Канонизация маски соседства: угловой бит сохраняется только при
 * установленных обоих прилегающих боках. 256 масок -> 47 канонических.
 */
export function normalizeBlobMask(mask: number): number {
  let m = mask & 0xff;
  if ((m & B_N) === 0 || (m & B_E) === 0) m &= ~B_NE;
  if ((m & B_S) === 0 || (m & B_E) === 0) m &= ~B_SE;
  if ((m & B_S) === 0 || (m & B_W) === 0) m &= ~B_SW;
  if ((m & B_N) === 0 || (m & B_W) === 0) m &= ~B_NW;
  return m;
}

/**
 * 47 канонических масок по возрастанию. Индекс в этом массиве = номер
 * кадра в атласе 8×6 (строка = i / 8, колонка = i % 8).
 */
export const CANONICAL_MASKS: ReadonlyArray<number> = (() => {
  const set = new Set<number>();
  for (let m = 0; m < 256; m++) set.add(normalizeBlobMask(m));
  return Array.from(set).sort((a, b) => a - b);
})();

if (CANONICAL_MASKS.length !== 47) {
  throw new Error(`blobTiles: ожидалось 47 канонических масок, получено ${CANONICAL_MASKS.length}`);
}

/** Каноническая маска -> номер кадра (0..46) в атласе. */
const FRAME_FOR_MASK: number[] = new Array(256).fill(-1);
for (let i = 0; i < CANONICAL_MASKS.length; i++) {
  FRAME_FOR_MASK[CANONICAL_MASKS[i]] = i;
}

/** Номер кадра для сырой маски соседства (0..46). */
export function frameIndexForMask(mask: number): number {
  return FRAME_FOR_MASK[normalizeBlobMask(mask)];
}

/**
 * Номер кадра для клетки (cx, cy) по сетке занятости.
 * Клетки за границей поля трактуются по edgePolicy (см. BlobFrameOptions).
 */
export function frameIndexForCell(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  options?: BlobFrameOptions
): number {
  const edge = options?.edgePolicy ?? 'solid';
  const at = (nx: number, ny: number): boolean => {
    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
      return blocked[ny * cols + nx] === 1;
    }
    if (edge === 'organic') return false;
    // solid: бока и верх — стены, низ — свободно
    return !(ny >= rows);
  };

  let mask = 0;
  if (at(cx, cy - 1)) mask |= B_N;
  if (at(cx + 1, cy - 1)) mask |= B_NE;
  if (at(cx + 1, cy)) mask |= B_E;
  if (at(cx + 1, cy + 1)) mask |= B_SE;
  if (at(cx, cy + 1)) mask |= B_S;
  if (at(cx - 1, cy + 1)) mask |= B_SW;
  if (at(cx - 1, cy)) mask |= B_W;
  if (at(cx - 1, cy - 1)) mask |= B_NW;
  return frameIndexForMask(mask);
}

/** Есть ли сосед на стороне (в канонической маске). */
export function sidePresent(mask: number, side: number): boolean {
  return (mask & side) !== 0;
}

/** Есть ли диагональный сосед на углу (в канонической маске). */
export function cornerPresent(mask: number, corner: number): boolean {
  return (mask & corner) !== 0;
}

// ------------------------------------------------------------
// Детерминированный шум для вкраплений (пятна/травинки в атласе).
// Один и тот же seed -> одна и та же последовательность.
// ------------------------------------------------------------

function hash2(a: number, b: number, salt: number): number {
  let h = 1779033703 ^ salt;
  h = Math.imul(h ^ a, 3432918353);
  h = Math.imul(h ^ b, 3432918353);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** ГПСЧ mulberry32, затравленный (cx, cy, salt) — детерминированный. */
export function speckleRng(cx: number, cy: number, salt: number): () => number {
  let a = hash2(cx | 0, cy | 0, salt | 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}