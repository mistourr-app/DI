// ============================================================
// Пайплайн арта препятствий — шаг 1: шаблон для рисования.
//
// Генерирует из текущего процедурного атласа:
//   - assets-src/blob_template.png  — сетка 8×6 с силуэтами, мини-схемами
//     соседей, номерами кадров и подписями сторон/углов (2× для удобства);
//   - assets-src/blob_reference.png — цветной референс текущего атласа.
//
// Требует собранную игру (npm run build) — читает текстуру через preview.
// Запуск: node scripts/obstacles-art/gen-blob-template.cjs
// ============================================================

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4199;
const OUT_TEMPLATE = path.join(ROOT, 'assets-src/blob_template.png');
const OUT_REFERENCE = path.join(ROOT, 'assets-src/blob_reference.png');

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
const SIDES = [B_N, B_E, B_S, B_W];
const CORNERS = [B_NE, B_SE, B_SW, B_NW];
const SIDE_CHAR = { [B_N]: 'N', [B_E]: 'E', [B_S]: 'S', [B_W]: 'W' };
const CORNER_CHAR = { [B_NE]: 'NE', [B_SE]: 'SE', [B_SW]: 'SW', [B_NW]: 'NW' };

function labelFor(mask) {
  const sides = SIDES.filter(b => mask & b).map(b => SIDE_CHAR[b]);
  const corners = CORNERS.filter(b => mask & b).map(b => CORNER_CHAR[b]);
  const parts = [];
  if (sides.length) parts.push(sides.join(' '));
  else if (corners.length) parts.push('—');
  if (corners.length) parts.push(corners.join(' '));
  if (!sides.length && !corners.length) return '— изолированный';
  return parts.join(' · ');
}

const labels = canonical.map(labelFor);

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

  const { templateDataUrl, referenceDataUrl } = await page.evaluate((labels, canonical) => {
    const sc = window.__di;
    const src = sc.textures.get('obstacle-blob').getSourceImage();

    // Нейтральный серый силуэт из текущего атласа
    const sil = document.createElement('canvas');
    sil.width = src.width; sil.height = src.height;
    const sctx = sil.getContext('2d');
    sctx.drawImage(src, 0, 0);
    const img = sctx.getImageData(0, 0, sil.width, sil.height);
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] > 40) { img.data[i] = 155; img.data[i + 1] = 155; img.data[i + 2] = 155; }
    }
    sctx.putImageData(img, 0, 0);

    const CELL = 48;
    const COLS = 8, ROWS = 6;
    const LEGEND_H = 78;
    const W = COLS * CELL, H = ROWS * CELL + LEGEND_H;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    const BITS = [
      [0, 0, 128], [1, 0, 1], [2, 0, 2],
      [0, 1, 64], [1, 1, 0], [2, 1, 4],
      [0, 2, 32], [1, 2, 16], [2, 2, 8]
    ];

    for (let f = 0; f < 47; f++) {
      const col = f % COLS, row = Math.floor(f / COLS);
      const x = col * CELL, y = row * CELL;
      const mask = canonical[f];

      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.drawImage(sil, (f % 8) * 16, Math.floor(f / 8) * 16, 16, 16, x, y, CELL, CELL);
      ctx.restore();

      const G = 5, GAP = 1, GW = G * 3 + GAP * 2;
      const gx = x + CELL - GW - 1, gy = y + 1;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(gx - 1, gy - 1, GW + 2, GW + 2);
      for (const [bx, by, bit] of BITS) {
        const sx = gx + bx * (G + GAP), sy = gy + by * (G + GAP);
        if (bx === 1 && by === 1) {
          ctx.fillStyle = 'rgba(230,120,40,0.95)';
          ctx.fillRect(sx, sy, G, G);
        } else if (mask & bit) {
          ctx.fillStyle = 'rgba(30,30,30,0.92)';
          ctx.fillRect(sx, sy, G, G);
        } else {
          ctx.strokeStyle = 'rgba(30,30,30,0.4)';
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + 0.5, sy + 0.5, G - 1, G - 1);
        }
      }

      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillRect(x + 1, y + 1, CELL - GW - 4, 22);
      ctx.fillStyle = 'rgba(15,15,15,0.95)';
      ctx.font = 'bold 13px monospace';
      ctx.fillText(String(f), x + 3, y + 14);
      ctx.font = '9px monospace';
      ctx.fillText(labels[f], x + 3, y + 20);

      ctx.fillStyle = 'rgba(15,15,15,0.55)';
      ctx.font = '8px monospace';
      ctx.fillText(mask.toString(2).padStart(8, '0'), x + 2, y + CELL - 3);
    }

    ctx.fillStyle = 'rgba(15,15,15,0.95)';
    ctx.font = '12px monospace';
    const ly = ROWS * CELL;
    ctx.fillText('■ = сосед-препятствие есть  □ = пусто  ■(оранж.) = рисуемый тайл.  Подпись: стороны N E S W · углы NE SE SW NW.', 8, ly + 16);
    ctx.fillText('Кадры 0..46 идут слева-направо по возрастанию битовой маски (стандарт 8×6). Кадр 0 = изолированный (круг), 46 = полный.', 8, ly + 32);
    ctx.fillText('Рисуй поверх силуэтов, сохраняя границы: стыки кадров обязаны совпадать (полудиски на краях — общие с соседями).', 8, ly + 48);
    ctx.fillText('Экспорт: PNG 128×128, кадры 16×16, 8 колонок × 6 рядов, порядок по возрастанию масок. Цвет — любой (tint не используется).', 8, ly + 64);

    const ref = document.createElement('canvas');
    ref.width = 256; ref.height = 256;
    const rctx = ref.getContext('2d');
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(src, 0, 0, 128, 128, 0, 0, 256, 256);

    return { templateDataUrl: cv.toDataURL('image/png'), referenceDataUrl: ref.toDataURL('image/png') };
  }, labels, canonical);

  fs.writeFileSync(OUT_TEMPLATE, Buffer.from(templateDataUrl.split(',')[1], 'base64'));
  fs.writeFileSync(OUT_REFERENCE, Buffer.from(referenceDataUrl.split(',')[1], 'base64'));
  console.log('TEMPLATE ->', OUT_TEMPLATE);
  console.log('REFERENCE ->', OUT_REFERENCE);

  await browser.close();
  try { preview.kill(); } catch {}
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });