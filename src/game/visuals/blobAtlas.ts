// ============================================================
// blobAtlas — программная генерация атласа блоб-тайлов препятствий.
//
// Паттерн как у dotTexture.ts: один canvas при старте, ноль ассетов.
// Атлас 128×128 = 47 кадров 16px в раскладке 8 колонок × 6 рядов
// (маска по возрастанию: строка = i/8, колонка = i%8) — совместим с
// типовыми блоб-сетами; художник может заменить сгенерированный атлас
// PNG с той же раскладкой (см. GRAPHICS_IMPORT.md), код не меняется.
//
// Геометрия тайла (классический блоб): клетка 16px, радиус R=8.
// Точка внутри формы, если: |p - центр| <= R  ИЛИ
//   (сосед на стороне И |p - середина стороны| <= R)  ИЛИ
//   (сосед на углу И |p - угол| <= R).
// Соседние клетки рисуют совпадающие полу-/четверть-диски -> бесшовно.
// Силуэты (нет соседа) — выпуклые дуги базового круга.
//
// Палитра «Земля/трава»: база #6B5B43, рим-свет #A8C07A (верх/лево),
// тень #4A3D2E (низ/право), вкрапления-камешки и травинки (по
// speckleRng от номера кадра — детерминированно, без повторов внутри
// тайла за счёт суперсэмпла).
// ============================================================

import Phaser from 'phaser';
import {
  CANONICAL_MASKS,
  cornerPresent,
  sidePresent,
  speckleRng,
  B_N,
  B_E,
  B_S,
  B_W,
  B_NE,
  B_SE,
  B_SW,
  B_NW
} from './blobTiles';

export const OBSTACLE_ATLAS_KEY = 'obstacle-blob';
export const OBSTACLE_INFERNO_ATLAS_KEY = 'obstacle-blob-inferno';

const TILE = 16; // размер ячейки, px
const R = TILE / 2; // радиус дисков
const ATLAS_COLS = 8;
const ATLAS_SIZE = 128;

// Суперсэмпл: рисуем каждый тайл в SS×SS, потом уменьшаем в TILE.
const SS = 4;
const TILE_SS = TILE * SS;

/** Палитра атласа (RGB). Геометрия кадров одинаковая — отличается только цвет. */
export interface BlobPalette {
  base: [number, number, number];
  rim: [number, number, number];
  shadow: [number, number, number];
  speckleDark: [number, number, number];
  speckleLight: [number, number, number];
  grassDark: [number, number, number];
  grassLight: [number, number, number];
}

// Палитра «Земля/трава»: база #6B5B43, рим-свет #A8C07A (верх/лево),
// тень #4A3D2E (низ/право), вкрапления-камешки и травинки.
export const EARTH_PALETTE: BlobPalette = {
  base: [107, 91, 67], // #6B5B43
  rim: [168, 192, 122], // #A8C07A
  shadow: [74, 61, 46], // #4A3D2E
  speckleDark: [83, 63, 47],
  speckleLight: [138, 115, 83], // #8A7353
  grassDark: [125, 155, 84], // #7D9B54
  grassLight: [148, 178, 106] // #94B26A
};

const SALT = 0x0b10b;

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function packColor(c: [number, number, number]): number {
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

function inCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Принадлежность точки (в единицах тайла 0..16) форме канонической маски */
function insideShape(x: number, y: number, mask: number): boolean {
  if (inCircle(x, y, R, R, R)) return true;
  if (sidePresent(mask, B_N) && inCircle(x, y, R, 0, R)) return true;
  if (sidePresent(mask, B_E) && inCircle(x, y, TILE, R, R)) return true;
  if (sidePresent(mask, B_S) && inCircle(x, y, R, TILE, R)) return true;
  if (sidePresent(mask, B_W) && inCircle(x, y, 0, R, R)) return true;
  if (cornerPresent(mask, B_NE) && inCircle(x, y, TILE, 0, R)) return true;
  if (cornerPresent(mask, B_SE) && inCircle(x, y, TILE, TILE, R)) return true;
  if (cornerPresent(mask, B_SW) && inCircle(x, y, 0, TILE, R)) return true;
  if (cornerPresent(mask, B_NW) && inCircle(x, y, 0, 0, R)) return true;
  return false;
}

/**
 * Рисует один тайл с суперсэмплом SS: заливка + бевел (рим-свет сверху/слева,
 * тень снизу/справа по силуэту) + детерминированные вкрапления.
 */
function renderTile(mask: number, frame: number, palette: BlobPalette): HTMLCanvasElement {
  const { base: BASE, rim: RIM, shadow: SHADOW, speckleDark: SPECKLE_DARK, speckleLight: SPECKLE_LIGHT, grassDark: GRASS_DARK, grassLight: GRASS_LIGHT } = palette;
  const cv = document.createElement('canvas');
  cv.width = TILE_SS;
  cv.height = TILE_SS;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;

  // 1. Маска принадлежности с суперсэмплом (индекс y*W+x)
  const inside = new Uint8Array(TILE_SS * TILE_SS);
  for (let sy = 0; sy < TILE_SS; sy++) {
    for (let sx = 0; sx < TILE_SS; sx++) {
      const x = (sx + 0.5) / SS;
      const y = (sy + 0.5) / SS;
      if (insideShape(x, y, mask)) inside[sy * TILE_SS + sx] = 1;
    }
  }

  // 2. Глубина силуэта: 1 = на границе, 2 = рядом с границей.
  // «Снаружи» — не только за пределами тайла, но и за пределами ФОРМЫ:
  // за границей тайла пусто только если соседа там нет (иначе внутренние
  // швы получили бы ложный бевел-контур).
  const depth = new Uint8Array(TILE_SS * TILE_SS);
  const isOutside = (ix: number, iy: number): boolean => {
    if (ix >= 0 && iy >= 0 && ix < TILE_SS && iy < TILE_SS) {
      return inside[iy * TILE_SS + ix] === 0;
    }
    const dx = ix < 0 ? -1 : ix >= TILE_SS ? 1 : 0;
    const dy = iy < 0 ? -1 : iy >= TILE_SS ? 1 : 0;
    if (dx !== 0 && dy !== 0) {
      // За углом тайла форму продолжает четверть-диск диагонального соседа
      const c = dx < 0 ? (dy < 0 ? B_NW : B_SW) : dy < 0 ? B_NE : B_SE;
      return !cornerPresent(mask, c);
    }
    // За краем тайла форму продолжает полудиск бокового соседа
    const s = dx < 0 ? B_W : dx > 0 ? B_E : dy < 0 ? B_N : B_S;
    return !sidePresent(mask, s);
  };
  for (let iy = 0; iy < TILE_SS; iy++) {
    for (let ix = 0; ix < TILE_SS; ix++) {
      if (inside[iy * TILE_SS + ix] === 0) continue;
      if (
        isOutside(ix - 1, iy) ||
        isOutside(ix + 1, iy) ||
        isOutside(ix, iy - 1) ||
        isOutside(ix, iy + 1)
      ) {
        depth[iy * TILE_SS + ix] = 1;
      }
    }
  }
  for (let iy = 0; iy < TILE_SS; iy++) {
    for (let ix = 0; ix < TILE_SS; ix++) {
      if (depth[iy * TILE_SS + ix] !== 0 || inside[iy * TILE_SS + ix] === 0) continue;
      const nb =
        depth[iy * TILE_SS + (ix - 1 < 0 ? ix : ix - 1)] === 1 ||
        depth[iy * TILE_SS + (ix + 1 >= TILE_SS ? ix : ix + 1)] === 1 ||
        depth[(iy - 1 < 0 ? iy : iy - 1) * TILE_SS + ix] === 1 ||
        depth[(iy + 1 >= TILE_SS ? iy : iy + 1) * TILE_SS + ix] === 1;
      if (nb) depth[iy * TILE_SS + ix] = 2;
    }
  }

  // 3. Цвет пикселя: база + бевел по направлению силуэта.
  const img = ctx.createImageData(TILE_SS, TILE_SS);
  for (let iy = 0; iy < TILE_SS; iy++) {
    for (let ix = 0; ix < TILE_SS; ix++) {
      const i = iy * TILE_SS + ix;
      if (inside[i] === 0) continue;
      let color: [number, number, number] = BASE;
      const d = depth[i];
      if (d > 0) {
        // Рим-свет — где пусто сверху/слева; тень — снизу/справа.
        const up = isOutside(ix, iy - 1) || isOutside(ix - 1, iy);
        const down = isOutside(ix, iy + 1) || isOutside(ix + 1, iy);
        const t = d === 1 ? 0.55 : 0.28;
        if (up && down) {
          color = lerpColor(lerpColor(BASE, RIM, t * 0.5), SHADOW, t * 0.5);
        } else if (up) {
          color = lerpColor(BASE, RIM, t);
        } else if (down) {
          color = lerpColor(BASE, SHADOW, t);
        } else {
          // Глубина 2 без прямого контакта — лёгкий общий бевел
          color = lerpColor(BASE, SHADOW, 0.12);
        }
      }
      const packed = packColor(color);
      img.data[i * 4] = (packed >> 16) & 0xff;
      img.data[i * 4 + 1] = (packed >> 8) & 0xff;
      img.data[i * 4 + 2] = packed & 0xff;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 4. Вкрапления: камешки + травинки, детерминированные (seed = кадр).
  // Кламп к центру тайла: крапинки не должны касаться кромок (x/y < 2.5
  // или > 13.5) — иначе разные кадры дают разные пиксели на стыках,
  // внутренние швы становятся видимыми (seam-check это ловит).
  const MARGIN = 2.5;
  const rng = speckleRng(frame, 0, SALT);
  const dots = 5 + Math.floor(rng() * 3);
  let placed = 0;
  for (let attempt = 0; attempt < 60 && placed < dots; attempt++) {
    const dx = MARGIN + rng() * (TILE - MARGIN * 2);
    const dy = MARGIN + rng() * (TILE - MARGIN * 2);
    if (!insideShape(dx, dy, mask)) continue;
    const radius = (0.35 + rng() * 0.7) * SS;
    const roll = rng();
    const c = roll < 0.3 ? SPECKLE_DARK : roll < 0.62 ? SPECKLE_LIGHT : roll < 0.85 ? GRASS_DARK : GRASS_LIGHT;
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.globalAlpha = 0.55 + rng() * 0.45;
    ctx.beginPath();
    ctx.arc(dx * SS, dy * SS, radius, 0, Math.PI * 2);
    ctx.fill();
    placed++;
  }
  // Травинки-акценты в верхней половине (чуть ярче, мельче), тоже с клампом
  const tufts = 2 + Math.floor(rng() * 2);
  let tuftPlaced = 0;
  for (let attempt = 0; attempt < 30 && tuftPlaced < tufts; attempt++) {
    const dx = MARGIN + rng() * (TILE - MARGIN * 2);
    const dy = MARGIN + rng() * (TILE * 0.55 - MARGIN);
    if (!insideShape(dx, dy, mask)) continue;
    ctx.fillStyle = `rgb(${GRASS_LIGHT[0]},${GRASS_LIGHT[1]},${GRASS_LIGHT[2]})`;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(dx * SS, dy * SS, 0.5 * SS, 0, Math.PI * 2);
    ctx.fill();
    tuftPlaced++;
  }
  ctx.globalAlpha = 1;

  return cv;
}

/**
 * Создаёт (один раз на сцену) атлас блоб-тайлов и возвращает его ключ.
 * 128×128, 47 кадров 16×16, раскладка 8×6 (маски по возрастанию).
 * Если текстура с ключом уже зарегистрирована (ручной PNG художника из
 * preload) — процедурная генерация пропускается, ключ возвращается как есть.
 */
export function ensureObstacleAtlas(
  scene: Phaser.Scene,
  key: string = OBSTACLE_ATLAS_KEY,
  palette: BlobPalette = EARTH_PALETTE
): string {
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let f = 0; f < CANONICAL_MASKS.length; f++) {
      const tile = renderTile(CANONICAL_MASKS[f], f, palette);
      const col = f % ATLAS_COLS;
      const row = Math.floor(f / ATLAS_COLS);
      ctx.drawImage(tile, 0, 0, TILE_SS, TILE_SS, col * TILE, row * TILE, TILE, TILE);
    }
  }
  scene.textures.addCanvas(key, canvas);
  // Кадры 16×16 в раскладке 8×6 (маски по возрастанию). Фреймы регистрируем
  // вручную через Texture.add — addSpriteSheet не принимает canvas по типам.
  const tex = scene.textures.get(key);
  for (let f = 0; f < CANONICAL_MASKS.length; f++) {
    const col = f % ATLAS_COLS;
    const row = Math.floor(f / ATLAS_COLS);
    tex.add(f, 0, col * TILE, row * TILE, TILE, TILE);
  }
  return key;
}

/**
 * Огненный атлас для поджога блобов фронтом инферно. Используется ТОЛЬКО
 * ручной шит художника (obstacles_blob_inferno.png из preload). Временный
 * процедурный фолбэк убран: если шита нет — возвращается null, и блобы
 * просто не поджигаются (никакой «временной закраски»).
 */
export function ensureObstacleInfernoAtlas(scene: Phaser.Scene): string | null {
  return scene.textures.exists(OBSTACLE_INFERNO_ATLAS_KEY) ? OBSTACLE_INFERNO_ATLAS_KEY : null;
}