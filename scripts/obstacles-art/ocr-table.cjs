// ============================================================
// Пайплайн арта препятствий — шаг 2: OCR листа цифр.
//
// Читает Table.png (7×7 ячеек, чёрные цифры на белом) и строит
// маппинг «ячейка шита -> кадр атласа (0..46)».
// Результат: console-отчёт + mapping.json (массив из 49 чисел).
//
// Запуск:  node scripts/obstacles-art/ocr-table.cjs [table.png] [out.json]
// Примеры: node scripts/obstacles-art/ocr-table.cjs
//          node scripts/obstacles-art/ocr-table.cjs assets-src/Table.png
// ============================================================

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.resolve(ROOT, process.argv[2] || 'assets-src/Table.png');
const OUT_JSON = path.resolve(ROOT, process.argv[3] || 'scripts/obstacles-art/mapping.json');
const T = 64; // размер ячейки листа
const GW = 12, GH = 14; // каноническая сетка для сравнения

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('Файл не найден:', SRC);
    console.error('Клади лист цифр в assets-src/Table.png (7×7, чёрные цифры на белом).');
    process.exit(1);
  }
  const b64 = fs.readFileSync(SRC).toString('base64');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const r = await page.evaluate(async (dataUrl, T, GW, GH) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const cols = img.width / T;
    const rows = img.height / T;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const isDark = i => d[i + 3] > 60 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90;

    // Нормализация ячейки: bbox тёмных пикселей -> сетка GW×GH
    const norm = (t) => {
      const tx = (t % cols) * T, ty = Math.floor(t / cols) * T;
      let minX = T, minY = T, maxX = -1, maxY = -1;
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        if (isDark(((ty + y) * img.width + (tx + x)) * 4)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const g = new Uint8Array(GW * GH);
      if (maxX >= 0) {
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        for (let gy = 0; gy < GH; gy++) {
          for (let gx = 0; gx < GW; gx++) {
            const sx = minX + ((gx + 0.5) / GW) * bw;
            const sy = minY + ((gy + 0.5) / GH) * bh;
            g[gy * GW + gx] = isDark((Math.floor(ty + sy) * img.width + Math.floor(tx + sx)) * 4) ? 1 : 0;
          }
        }
      }
      return { g, has: maxX >= 0 };
    };

    // Эталоны 0..46 в 4 шрифтах
    const refs = [];
    const fonts = ['bold 90px Arial', 'bold 90px Arial Black', 'bold 90px Verdana', 'bold 90px Courier New'];
    for (let n = 0; n < 47; n++) {
      const maps = [];
      for (const font of fonts) {
        const cv = document.createElement('canvas');
        cv.width = 128; cv.height = 128;
        const rctx = cv.getContext('2d');
        rctx.fillStyle = '#fff';
        rctx.fillRect(0, 0, 128, 128);
        rctx.fillStyle = '#000';
        rctx.font = font;
        rctx.textAlign = 'center';
        rctx.textBaseline = 'middle';
        rctx.fillText(String(n), 64, 66);
        const rd = rctx.getImageData(0, 0, 128, 128).data;
        let minX = 128, minY = 128, maxX = -1, maxY = -1;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          if (rd[(y * 128 + x) * 4] < 90) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        const g = new Uint8Array(GW * GH);
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        for (let gy = 0; gy < GH; gy++) {
          for (let gx = 0; gx < GW; gx++) {
            const sx = minX + ((gx + 0.5) / GW) * bw;
            const sy = minY + ((gy + 0.5) / GH) * bh;
            g[gy * GW + gx] = rd[(Math.floor(sy) * 128 + Math.floor(sx)) * 4] < 90 ? 1 : 0;
          }
        }
        maps.push(g);
      }
      refs.push(maps);
    }

    const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] !== b[i] ? 1 : 0; return s; };

    const report = [];
    for (let t = 0; t < cols * rows; t++) {
      const { g, has } = norm(t);
      if (!has) { report.push({ t, digit: -1, dist: -1, conf: 0 }); continue; }
      let best = -1, bestD = Infinity, best2 = Infinity;
      for (let n = 0; n < 47; n++) {
        for (const ref of refs[n]) {
          const dd = dist(g, ref);
          if (dd < bestD) { best2 = bestD; bestD = dd; best = n; }
          else if (dd < best2) best2 = dd;
        }
      }
      report.push({ t, digit: best, dist: bestD, conf: +(1 - bestD / Math.max(best2, 1)).toFixed(2) });
    }
    return { cols, rows, report };
  }, b64 && `data:image/png;base64,${b64}`, T, GW, GH);

  // ВАЖНО: распознавание может ошибаться — сверяй отчёт с формой тайлов
  // (кромки шита должны совпадать с маской кадра) и с художником.
  console.log(`OCR: сетка ${r.cols}×${r.rows}, файл ${SRC}`);
  const flagged = [];
  for (const x of r.report) {
    if (x.digit < 0) { console.log(`  ячейка ${String(x.t).padStart(2)} -> ПУСТО`); continue; }
    const flag = x.conf < 0.8 ? '  <-- проверить' : '';
    if (flag) flagged.push(x.t);
    console.log(`  ячейка ${String(x.t).padStart(2)} -> кадр ${String(x.digit).padStart(2)} (dist=${x.dist}, conf=${x.conf})${flag}`);
  }
  const cellToFrame = r.report.map(x => x.digit);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ source: SRC, cellToFrame, report: r.report }, null, 2));
  console.log('');
  console.log('Маппинг сохранён ->', OUT_JSON);
  if (flagged.length) console.log('ПОД ВОПРОСОМ (сверь с художником): ячейки', flagged.join(', '));
  else console.log('Все распознаны уверенно.');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });