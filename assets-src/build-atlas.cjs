// ============================================================
// Нарезчик блоб-тайлсета (drag-and-drop).
//
// Берёт PNG-шит с тайлами 16×16 (раскладка Test2: 7×7, порядок
// ячеек слева-направо сверху-вниз), нарезает по фиксированному
// маппингу и собирает канонический атлас 8×6 (кадр = маска
// по возрастанию) -> src/assets/obstacles_blob.png.
//
// Никаких проверок соответствия шаблону — ответственность
// за раскладку на художнике.
//
// Запуск: node build-atlas.cjs <путь-к-png>
// (обычно — перетаскиванием файла на build_atlas.bat)
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const T = 16; // размер тайла
const OUT = path.join(__dirname, '..', 'src', 'assets', 'obstacles_blob.png');

// Фиксированный маппинг Test2: ячейка шита -> кадр атласа (0..46).
// Распознан по листу Table.png и сверен с формой тайлов.
const CELL_TO_FRAME = [
  0, 2, 20, 23, 31, 28, 18, 5, 10, 29, 25, 46, 45, 27, 8, 22, 40, 33, 46, 44,
  37, 11, 32, 30, 36, 39, 38, 19, 12, 46, 42, 7, 14, 6, 1, 9, 41, 43, 21, 15,
  24, 26, 3, 17, 35, 16, 13, 4, 34
];

// ---------------- PNG-декодер (8-бит, фильтры 0-4, без чересстрочки) ----------------

function decodePNG(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('файл не похож на PNG');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const palette = [];
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      for (let i = 0; i + 3 <= len; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('в PNG нет картинки (IHDR)');
  if (interlace !== 0) throw new Error('чересстрочный PNG не поддерживается');
  if (bitDepth !== 8) throw new Error(`глубина цвета ${bitDepth} не поддерживается (нужен 8-бит)`);
  let channels;
  switch (colorType) {
    case 0: channels = 1; break; // оттенки серого
    case 2: channels = 3; break; // RGB
    case 3: channels = 1; break; // палитра
    case 4: channels = 2; break; // серый+альфа
    case 6: channels = 4; break; // RGBA
    default: throw new Error(`цветовой формат ${colorType} не поддерживается`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let p = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = raw[p + x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`фильтр строки ${filter} не поддерживается`);
      }
      row[x] = v;
    }
    prev = row;
    p += stride;
  }
  // -> RGBA
  const rgba = Buffer.alloc(width * height * 4);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const si = i * channels, di = i * 4;
    if (colorType === 0) {
      const g = out[si];
      rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = 255;
    } else if (colorType === 2) {
      rgba[di] = out[si]; rgba[di + 1] = out[si + 1]; rgba[di + 2] = out[si + 2]; rgba[di + 3] = 255;
    } else if (colorType === 3) {
      const pl = palette[out[si]];
      if (!pl) throw new Error('индекс палитры вне диапазона');
      rgba[di] = pl[0]; rgba[di + 1] = pl[1]; rgba[di + 2] = pl[2]; rgba[di + 3] = 255;
    } else if (colorType === 4) {
      const g = out[si];
      rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = out[si + 1];
    } else {
      rgba[di] = out[si]; rgba[di + 1] = out[si + 1]; rgba[di + 2] = out[si + 2]; rgba[di + 3] = out[si + 3];
    }
  }
  return { width, height, data: rgba };
}

// ---------------- PNG-энкодер (RGBA8) ----------------

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------- Нарезка ----------------

const FILE = process.argv[2];
if (!FILE) {
  console.error('Нет файла: перетащи PNG на build_atlas.bat');
  process.exit(1);
}

let sheet;
try {
  sheet = decodePNG(fs.readFileSync(FILE));
} catch (e) {
  console.error('Не удалось прочитать файл:', FILE);
  console.error('Причина:', e.message);
  process.exit(1);
}

const cols = Math.floor(sheet.width / T);
const rows = Math.floor(sheet.height / T);
if (cols < 1 || rows < 1 || cols * rows < CELL_TO_FRAME.length) {
  console.error(`В шите ${sheet.width}×${sheet.height} — тайлов меньше, чем нужно (${CELL_TO_FRAME.length})`);
  process.exit(1);
}

const at = (cx, cy) => (cy * sheet.width + cx) * 4;
const out = Buffer.alloc(128 * 128 * 4); // прозрачный атлас 128×128

for (let f = 0; f < 47; f++) {
  const cell = CELL_TO_FRAME.indexOf(f);
  if (cell < 0) continue; // кадр без ячейки — остаётся пустым
  const sx = (cell % cols) * T;
  const sy = Math.floor(cell / cols) * T;
  const dx = (f % 8) * T;
  const dy = Math.floor(f / 8) * T;
  for (let y = 0; y < T; y++) {
    sheet.data.copy(
      out,
      ((dy + y) * 128 + dx) * 4,
      at(sx, sy + y),
      at(sx + T, sy + y)
    );
  }
}

fs.writeFileSync(OUT, encodePNG(128, 128, out));
console.log('Готово:', OUT);
console.log(`Тайлов использовано: ${CELL_TO_FRAME.filter((v, i) => CELL_TO_FRAME.indexOf(v) === i).length} из 47`);