// ============================================================
// Пайплайн арта препятствий — шаг 3: сборка канонического атласа.
//
// Берёт шит художника (16×16 тайлы, любая сетка) и маппинг
// «ячейка -> кадр» (mapping.json от ocr-table), складывает атлас
// 8×6 (кадр = маска по возрастанию) и пишет src/assets/obstacles_blob.png.
//
// Запуск: node scripts/obstacles-art/reorder.cjs [sheet.png] [mapping.json]
// Пример: node scripts/obstacles-art/reorder.cjs assets-src/Test2.png
// Дубли кадров: берётся первая ячейка; лишние копии игнорируются.
// Пустые кадры (-1) -> ошибка (нужно исправить маппинг/дорисовать).
// ============================================================

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const SRC_SHEET = path.resolve(ROOT, process.argv[2] || 'assets-src/sheet.png');
const SRC_MAPPING = path.resolve(ROOT, process.argv[3] || 'scripts/obstacles-art/mapping.json');
const OUT = path.resolve(ROOT, 'src/assets/obstacles_blob.png');
const T = 16;

(async () => {
  if (!fs.existsSync(SRC_SHEET)) { console.error('Шит не найден:', SRC_SHEET); process.exit(1); }
  if (!fs.existsSync(SRC_MAPPING)) { console.error('Маппинг не найден:', SRC_MAPPING); process.exit(1); }
  const mapping = JSON.parse(fs.readFileSync(SRC_MAPPING, 'utf8'));
  const cellToFrame = mapping.cellToFrame || mapping; // поддержка и старого формата (массив)

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const r = await page.evaluate(async (sheetB64, cellToFrame, T) => {
    const load = b64 => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64; });
    const sheet = await load(sheetB64);
    const cols = sheet.width / T;
    const grab = (t) => {
      const c = document.createElement('canvas');
      c.width = T; c.height = T;
      const ctx = c.getContext('2d');
      ctx.drawImage(sheet, (t % cols) * T, Math.floor(t / cols) * T, T, T, 0, 0, T, T);
      return c;
    };
    const out = document.createElement('canvas');
    out.width = 128; out.height = 128;
    const ctx = out.getContext('2d');
    const used = new Set();
    const missing = [];
    for (let f = 0; f < 47; f++) {
      const cell = cellToFrame.indexOf(f);
      const col = f % 8, row = Math.floor(f / 8);
      if (cell < 0) { missing.push(f); continue; }
      ctx.drawImage(grab(cell), col * T, row * T);
      used.add(cell);
    }
    const unused = Array.from({ length: cellToFrame.length }, (_, i) => i).filter(i => !used.has(i));
    return { dataUrl: out.toDataURL('image/png'), unused, missing, sheetCount: cellToFrame.length };
  }, fs.readFileSync(SRC_SHEET).toString('base64'), cellToFrame, T);

  if (r.missing.length) {
    console.error('НЕ ХВАТАЕТ КАДРОВ (нет ячеек):', r.missing.join(', '));
    console.error('Дорисуй недостающие тайлы или исправь маппинг. Атлас НЕ записан.');
    await browser.close();
    process.exit(1);
  }
  fs.writeFileSync(OUT, Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  console.log('Атлас собран ->', OUT);
  console.log('Неиспользованные ячейки (дубли кадров):', r.unused.length ? r.unused.join(', ') : 'нет');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });