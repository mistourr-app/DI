import { waterAt, airAt, blockedByLevel, type CollisionField } from './fluidProtocol';

function field(over: Partial<CollisionField> = {}): CollisionField {
  return {
    cols: 4,
    rows: 4,
    cellSize: 10,
    blocked: new Uint8Array(16),
    water: new Uint8Array(16),
    airX: new Float32Array(16),
    airY: new Float32Array(16),
    ...over
  };
}

describe('waterAt / airAt (эффекты стихий)', () => {
  it('waterAt: 1 в ячейке -> true, 0 -> false; вне сетки -> false', () => {
    const f = field();
    f.water![1] = 1; // ячейка (cx=1, cy=0) = x∈[10,20), y∈[0,10)
    expect(waterAt(f, 15, 5)).toBe(true);
    expect(waterAt(f, 5, 5)).toBe(false);
    expect(waterAt(f, -5, 0)).toBe(false);
    expect(waterAt(f, 100, 100)).toBe(false);
  });

  it('waterAt: null water-оверлей -> false (старое поле без эффектов)', () => {
    const f = field({ water: undefined });
    expect(waterAt(f, 15, 5)).toBe(false);
  });

  it('airAt: возвращает направление или null; (0,0) = нет эффекта', () => {
    const f = field();
    f.airX![1] = 0.6;
    f.airY![1] = -0.8;
    const d = airAt(f, 15, 5)!;
    expect(d.x).toBeCloseTo(0.6, 5);
    expect(d.y).toBeCloseTo(-0.8, 5);
    expect(airAt(f, 5, 5)).toBeNull();
    expect(airAt(f, 100, 100)).toBeNull();
  });

  it('airAt: null оверлеев -> null', () => {
    const f = field({ airX: undefined, airY: undefined });
    expect(airAt(f, 15, 5)).toBeNull();
  });
});

describe('blockedByLevel (телепорт только на препятствия, не на землю)', () => {
  it('препятствие уровня -> true', () => {
    const f = field();
    f.blocked[1] = 1;
    expect(blockedByLevel(f, 15, 5)).toBe(true);
  });

  it('земля не считается препятствием уровня -> false', () => {
    const f = field();
    f.water = undefined;
    f.earth = new Uint8Array(16);
    f.earth[1] = 1;
    f.blocked[1] = 0;
    expect(blockedByLevel(f, 15, 5)).toBe(false);
  });

  it('вне сетки / за widthPx -> false', () => {
    const f = field();
    expect(blockedByLevel(f, -5, 0)).toBe(false);
    expect(blockedByLevel(f, 100, 100)).toBe(false);
    expect(blockedByLevel(f, 50, 5)).toBe(false); // widthPx=... фантомная полоса
  });
});
