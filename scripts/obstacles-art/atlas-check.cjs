// ============================================================
// Пайплайн арта препятствий — шаг 4: проверка стыков (seam-check).
//
// Сверяет попиксельно стыкуемые кромки кадров текущего атласа
// (текстура 'obstacle-blob' в игре — src/assets/obstacles_blob.png):
//   - ШВЫ:   правая/нижняя кромка кадра vs кромка кадра «сдвинутой» маски
//            (должны совпадать на средних 12 пикселях);
//   - ДЫРЫ:  обе стороны стыка пустые (зазор);
//   - УГЛЫ:  2×2 блока у диагональных контактов обязаны быть заполнены.
//
// Требует собранную игру (npm run build) — читает текстуру через preview.
// Запуск: node scripts/obstacles-art/atlas-check.cjs
// ============================================================

const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = require('path').resolve(__dirname, '../..');
const PORT = 4199;

const B_N = 1, B_NE = 2, B_E = 4, B_SE = 8, B_S = 16, B_SW = 32, B_W = 64, B_NW = 128;

function normalize(mask) {
  let m = mask & 0xff;
  if (!(m & B_N) || !(m & B_E)) m &= ~B_NE;
  if (!(m & B_S) || !(m & B_E)) m &= ~B_SE;
  if (!(m & B_S) || !(m & B_W)) m &= ~B_SW;
  if (!(m & B_N) || !(m & B_W)) m &= ~B_NW;
  return m;
}
const canonical = Array.from(new Set(Array.from({ length: 256 }, (_, m) => normalize(m)))).sort((a, b) => a - b);
const frameFor = new Map(canonical.map((m, i) => [m, i]));
const frameOf = m => frameFor.get(normalize(m));

function shiftRight(mask) { return B_W | (mask & B_N ? B_NW : 0) | (mask & B_NE ? B_N : 0) | (mask & B_SE ? B_S : 0) | (mask & B_S ? B_SW : 0); }
function shiftDown(mask) { return B_N | (mask & B_W ? B_NW : 0) | (mask & B_SW ? B_W : 0) | (mask & B_SE ? B_E : 0) | (mask & B_E ? B_NE : 0); }
function shiftRightUp(mask) { return (mask & B_N ? B_W : 0) | (mask & B_NE ? B_N : 0) | (mask & B_E ? B_NW : 0); }
function shiftLeftUp(mask) { return (mask & B_N ? B_E : 0) | (mask & B_NW ? B_N : 0) | (mask & B_W ? B_NE : 0); }

(async () => {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await wait(500);
    try { const res = await fetch(`http://localhost:${PORT}`); up = res.ok; } catch {}
  }
  if (!up) { console.error('PREVIEW FAILED — собери игру: npm run build'); process.exit(1); }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__di && window.__di.obstacleSprites', { timeout: 30000 });

  const frames = await page.evaluate(() => {
    const sc = window.__di;
    const src = sc.textures.get('obstacle-blob').getSourceImage();
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const out = [];
    for (let f = 0; f < 47; f++) {
      const col = f % 8, row = Math.floor(f / 8);
      out.push(ctx.getImageData(col * 16, row * 16, 16, 16).data);
    }
    return out;
  });

  const opaque = (d, x, y) => d[(y * 16 + x) * 4 + 3] > 40;
  const same = (d1, x1, y1, d2, x2, y2) => {
    const i1 = (y1 * 16 + x1) * 4, i2 = (y2 * 16 + x2) * 4;
    return d1[i1] === d2[i2] && d1[i1 + 1] === d2[i2 + 1] && d1[i1 + 2] === d2[i2 + 2] && d1[i1 + 3] === d2[i2 + 3];
  };

  let seamBad = 0, holeBad = 0, cornerBad = 0;
  const holes = [], corners = [];

  for (let f = 0; f < 47; f++) {
    const mask = canonical[f];
    if (mask & B_E) {
      const g = frameOf(shiftRight(mask));
      let bad = 0, holesHere = 0;
      for (let y = 2; y <= 13; y++) {
        if (!same(frames[f], 15, y, frames[g], 0, y)) bad++;
        if (!opaque(frames[f], 15, y) && !opaque(frames[g], 0, y)) holesHere++;
      }
      if (bad) seamBad++;
      if (holesHere) { holeBad++; holes.push(`кадр ${f}->${g}: ПРАВО, дыр ${holesHere}/12`); }
    }
    if (mask & B_S) {
      const g = frameOf(shiftDown(mask));
      let bad = 0, holesHere = 0;
      for (let x = 2; x <= 13; x++) {
        if (!same(frames[f], x, 15, frames[g], x, 0)) bad++;
        if (!opaque(frames[f], x, 15) && !opaque(frames[g], x, 0)) holesHere++;
      }
      if (bad) seamBad++;
      if (holesHere) { holeBad++; holes.push(`кадр ${f}->${g}: НИЗ, дыр ${holesHere}/12`); }
    }
    if (mask & B_NE) {
      const g = frameOf(shiftRightUp(mask));
      let ours = true, diag = true;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        if (!opaque(frames[f], 14 + dx, dy)) ours = false;
        if (!opaque(frames[g], dx, 14 + dy)) diag = false;
      }
      if (!ours || !diag) { cornerBad++; corners.push(`кадр ${f}->${g}: угол NE ${!ours ? 'не заполнен (наш)' : ''} ${!diag ? 'не заполнен (диагональ)' : ''}`); }
    }
    if (mask & B_NW) {
      const g = frameOf(shiftLeftUp(mask));
      let ours = true, diag = true;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        if (!opaque(frames[f], dx, dy)) ours = false;
        if (!opaque(frames[g], 14 + dx, 14 + dy)) diag = false;
      }
      if (!ours || !diag) { cornerBad++; corners.push(`кадр ${f}->${g}: угол NW ${!ours ? 'не заполнен (наш)' : ''} ${!diag ? 'не заполнен (диагональ)' : ''}`); }
    }
  }

  console.log(`ШВЫ (кромки): ${seamBad === 0 ? 'OK' : seamBad + ' проблем'}`);
  console.log(`ДЫРЫ (обе стороны пустые): ${holeBad === 0 ? 'нет' : holeBad + ' проблем'}`);
  if (holes.length) console.log('  ' + holes.join('\n  '));
  console.log(`УГЛЫ (2×2 диагональных кадров): ${cornerBad === 0 ? 'OK' : cornerBad + ' несовпадений'}`);
  if (corners.length) console.log('  ' + corners.slice(0, 20).join('\n  ') + (corners.length > 20 ? `\n  ... и ещё ${corners.length - 20}` : ''));

  await browser.close();
  try { preview.kill(); } catch {}
  process.exit(seamBad || holeBad || cornerBad ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });