import {
  CANONICAL_MASKS,
  frameIndexForCell,
  frameIndexForMask,
  normalizeBlobMask,
  speckleRng,
  B_N,
  B_NE,
  B_E,
  B_SE,
  B_S,
  B_SW,
  B_W,
  B_NW
} from './blobTiles';

describe('blobTiles', () => {
  describe('normalizeBlobMask', () => {
    it('все 256 масок схлопываются ровно в 47 канонических', () => {
      const set = new Set<number>();
      for (let m = 0; m < 256; m++) set.add(normalizeBlobMask(m));
      expect(set.size).toBe(47);
      expect(CANONICAL_MASKS.length).toBe(47);
    });

    it('канонизация идемпотентна', () => {
      for (let m = 0; m < 256; m++) {
        const once = normalizeBlobMask(m);
        expect(normalizeBlobMask(once)).toBe(once);
      }
    });

    it('угловой бит сохраняется только при обоих прилегающих боках', () => {
      // NE без N или E -> отбрасывается
      expect(normalizeBlobMask(B_NE)).toBe(0);
      expect(normalizeBlobMask(B_N | B_NE)).toBe(B_N);
      // NE при N+E -> сохраняется
      expect(normalizeBlobMask(B_N | B_E | B_NE)).toBe(B_N | B_E | B_NE);
      // NW при N+W -> сохраняется
      expect(normalizeBlobMask(B_N | B_W | B_NW)).toBe(B_N | B_W | B_NW);
      // SE при S+E -> сохраняется
      expect(normalizeBlobMask(B_S | B_E | B_SE)).toBe(B_S | B_E | B_SE);
      // SW при S+W -> сохраняется
      expect(normalizeBlobMask(B_S | B_W | B_SW)).toBe(B_S | B_W | B_SW);
    });

    it('боковые биты всегда сохраняются', () => {
      expect(normalizeBlobMask(B_N | B_E | B_S | B_W)).toBe(B_N | B_E | B_S | B_W);
    });
  });

  describe('frameIndexForMask', () => {
    it('любая маска даёт валидный кадр 0..46', () => {
      for (let m = 0; m < 256; m++) {
        const f = frameIndexForMask(m);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThan(47);
      }
    });

    it('одинокий диагональный сосед не отличим от изолированной клетки', () => {
      expect(frameIndexForMask(B_NE)).toBe(frameIndexForMask(0));
      expect(frameIndexForMask(B_NW)).toBe(frameIndexForMask(0));
    });

    it('N+E+NE отличим от N+E (угол имеет значение при обоих боках)', () => {
      expect(frameIndexForMask(B_N | B_E | B_NE)).not.toBe(frameIndexForMask(B_N | B_E));
    });

    it('все 47 канонических масок дают разные кадры', () => {
      const frames = CANONICAL_MASKS.map(m => frameIndexForMask(m));
      expect(new Set(frames).size).toBe(47);
    });
  });

  describe('frameIndexForCell', () => {
    // Сетка 3x3: центр (1,1), соседи задаются вручную
    function gridWith(mask: number): { blocked: Uint8Array; cols: number; rows: number } {
      const cols = 3;
      const rows = 3;
      const blocked = new Uint8Array(cols * rows);
      const bits: Array<[number, number, number]> = [
        [B_N, 1, 0],
        [B_NE, 2, 0],
        [B_E, 2, 1],
        [B_SE, 2, 2],
        [B_S, 1, 2],
        [B_SW, 0, 2],
        [B_W, 0, 1],
        [B_NW, 0, 0]
      ];
      for (const [bit, nx, ny] of bits) {
        if (mask & bit) blocked[ny * cols + nx] = 1;
      }
      return { blocked, cols, rows };
    }

    it('кадр центра совпадает с кадром по маске соседей', () => {
      for (const mask of [0, B_N, B_N | B_E, B_N | B_E | B_NE, B_N | B_E | B_S | B_W, 0xff]) {
        const { blocked, cols, rows } = gridWith(mask);
        expect(frameIndexForCell(blocked, cols, rows, 1, 1)).toBe(frameIndexForMask(mask));
      }
    });

    it('solid: стены у кромок (угол (0,0) в сетке 1x1)', () => {
      const blocked = new Uint8Array(1);
      blocked[0] = 1;
      const frame = frameIndexForCell(blocked, 1, 1, 0, 0);
      // Соседи: N, NE, E, W, NW — стены (верх/бока); S, SE, SW — свободно (низ).
      const mask = B_N | B_NE | B_E | B_W | B_NW;
      expect(frame).toBe(frameIndexForMask(mask));
    });

    it('organic: всё за полем свободно -> изолированный кадр', () => {
      const blocked = new Uint8Array(1);
      blocked[0] = 1;
      expect(frameIndexForCell(blocked, 1, 1, 0, 0, { edgePolicy: 'organic' })).toBe(
        frameIndexForMask(0)
      );
    });

    it('solid: низ за полем свободен (угол (0, rows-1))', () => {
      const cols = 1;
      const rows = 2;
      const blocked = new Uint8Array(cols * rows);
      blocked[0] = 1; // верхняя клетка
      blocked[1] = 1; // нижняя (у края)
      // Нижняя клетка: N занят, NE/E/W/NW — стены (верх/бока), S/SE/SW — свободно
      const mask = B_N | B_NE | B_E | B_W | B_NW;
      expect(frameIndexForCell(blocked, cols, rows, 0, 1)).toBe(frameIndexForMask(mask));
    });
  });

  describe('speckleRng', () => {
    it('детерминирован: одинаковый seed -> одинаковые значения', () => {
      const a = speckleRng(3, 7, 1);
      const b = speckleRng(3, 7, 1);
      for (let i = 0; i < 10; i++) expect(a()).toBe(b());
    });

    it('разный seed -> разные последовательности', () => {
      const a = speckleRng(3, 7, 1);
      const b = speckleRng(3, 7, 2);
      expect(a()).not.toBe(b());
    });
  });
});