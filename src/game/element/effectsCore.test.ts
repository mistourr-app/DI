import { applyStatus, igniteNeighbors, tintFor, lerpColor, type EffectConfig, type StatusEnemy } from './effectsCore';

const cfg: EffectConfig = {
  burnDurationMs: 2000,
  burnRadiusPx: 40,
  spreadChance: 0.4,
  maxIgnitePerDeath: 3,
  wetDurationMs: 5000,
  airDurationMs: 5000
};

const noFire = () => false;
const noWater = () => false;
const noAir = () => false;

function enemy(x: number, y: number, over: Partial<StatusEnemy> = {}): StatusEnemy {
  return { x, y, active: true, burnUntil: 0, wetUntil: 0, airUntil: 0, chainIgnited: false, ...over };
}

describe('effectsCore', () => {
  it('вход в огонь начинает горение на burnDuration', () => {
    const e = enemy(0, 0);
    const fire = (x: number, y: number) => x === 0 && y === 0;
    expect(applyStatus(e, 1000, cfg, fire, noWater, noAir)).toBe('burn');
    expect(e.burnUntil).toBe(1000 + 2000);
  });

  it('горение не обновляется, пока враг горит (не «вечное» пламя)', () => {
    const e = enemy(0, 0);
    const fire = () => true;
    applyStatus(e, 1000, cfg, fire, noWater, noAir);
    const deadline = e.burnUntil;
    // Через 1с всё ещё в огне, но горит с прежним дедлайном
    applyStatus(e, 2000, cfg, fire, noWater, noAir);
    expect(e.burnUntil).toBe(deadline);
  });

  it('враг, оставшийся в огне, сгорает по дедлайну', () => {
    const e = enemy(0, 0);
    const fire = () => true;
    applyStatus(e, 1000, cfg, fire, noWater, noAir);
    expect(applyStatus(e, 3000, cfg, fire, noWater, noAir)).toBe('burn_death');
    expect(e.burnUntil).toBe(0);
  });

  it('уход из огня гасит пламя (эффект живёт, пока существует зона)', () => {
    const e = enemy(0, 0);
    const fire = (x: number, _y: number) => x === 0;
    applyStatus(e, 1000, cfg, fire, noWater, noAir); // поджог в зоне
    expect(applyStatus(e, 2500, cfg, noFire, noWater, noAir)).toBe('none'); // покинул — погас
    expect(e.burnUntil).toBe(0);
  });

  it('цепно подожжённый горит вне зоны и сгорает', () => {
    const e = enemy(0, 0);
    e.burnUntil = 3000;
    e.chainIgnited = true;
    expect(applyStatus(e, 2500, cfg, noFire, noWater, noAir)).toBe('burn');
    expect(applyStatus(e, 3000, cfg, noFire, noWater, noAir)).toBe('burn_death');
  });

  it('вода: мокрый держится wetDuration после выхода из зоны', () => {
    const e = enemy(0, 0);
    const water = (x: number, _y: number) => x === 0;
    expect(applyStatus(e, 500, cfg, noFire, water, noAir)).toBe('wet');
    // вышел из воды — ещё мокрый (лингер)
    expect(applyStatus(e, 1000, cfg, noFire, noWater, noAir)).toBe('wet');
    // через wetDuration (5с) высох
    expect(applyStatus(e, 5501, cfg, noFire, noWater, noAir)).toBe('none');
    expect(e.wetUntil).toBe(0);
  });

  it('воздух: сдутый держится airDuration после выхода из зоны', () => {
    const e = enemy(0, 0);
    const air = (x: number, _y: number) => x === 0;
    expect(applyStatus(e, 500, cfg, noFire, noWater, air)).toBe('blown');
    expect(applyStatus(e, 1000, cfg, noFire, noWater, noAir)).toBe('blown');
    expect(applyStatus(e, 5501, cfg, noFire, noWater, noAir)).toBe('none');
    expect(e.airUntil).toBe(0);
  });

  it('горение приоритетнее сдутого/мокрого в перекраске', () => {
    const e = enemy(0, 0);
    e.burnUntil = 2000;
    e.wetUntil = 2000;
    e.airUntil = 2000;
    e.chainIgnited = true; // горит вне зоны (цепно)
    expect(tintFor(applyStatus(e, 1000, cfg, noFire, noWater, noAir))).toBe(0xffe206);
  });

  it('tintFor: дефолт красный, горение жёлтый, мокрый голубой, сдутый бледно-синий', () => {
    expect(tintFor('none')).toBe(0xed0000);
    expect(tintFor('burn')).toBe(0xffe206);
    expect(tintFor('wet')).toBe(0x00d9ff);
    expect(tintFor('blown')).toBe(0xb4c2f0);
  });

  it('lerpColor: t=0 -> a, t=1 -> b, t=0.5 -> середина', () => {
    expect(lerpColor(0xed0000, 0x00d9ff, 0)).toBe(0xed0000);
    expect(lerpColor(0xed0000, 0x00d9ff, 1)).toBe(0x00d9ff);
    const mid = lerpColor(0xed0000, 0x00d9ff, 0.5);
    // R: (237+0)/2=118.5->119, G: 0+(217-0)*0.5=108.5->109, B: 0+(255)*0.5=127.5->128
    expect(mid).toBe((119 << 16) | (109 << 8) | 128);
  });

  describe('igniteNeighbors (ограничение распространения огня)', () => {
    it('не поджигает вне радиуса и уже горящих', () => {
      const enemies = [
        enemy(100, 0),      // вне радиуса 40
        enemy(10, 0, { burnUntil: 5000 }), // уже горит
        enemy(-10, 0, { active: false }),  // мёртв
        enemy(5, 0)          // кандидат
      ];
      const ignited = igniteNeighbors(0, 0, enemies, cfg, 1000, () => 0);
      expect(ignited.map(e => e.x)).toEqual([5]);
    });

    it('уважает лимит maxIgnitePerDeath', () => {
      const enemies = Array.from({ length: 10 }, (_, i) => enemy(i * 5, 0));
      const ignited = igniteNeighbors(0, 0, enemies, { ...cfg, spreadChance: 1 }, 1000, () => 0);
      expect(ignited.length).toBe(cfg.maxIgnitePerDeath);
    });

    it('уважает шанс spreadChance (random >= chance — пропуск)', () => {
      const enemies = [enemy(0, 0), enemy(1, 0), enemy(2, 0), enemy(3, 0)];
      // random=0.5, chance=0.4 -> все пропущены (0.5 >= 0.4)
      const ignited = igniteNeighbors(0, 0, enemies, { ...cfg, spreadChance: 0.4 }, 1000, () => 0.5);
      expect(ignited.length).toBe(0);
    });

    it('сгоревший поджигает соседей, не поджигая сам себя', () => {
      const a = enemy(0, 0, { burnUntil: 3000 });
      const b = enemy(5, 0);
      const ignited = igniteNeighbors(0, 0, [a, b], cfg, 3000, () => 0, a);
      expect(ignited).toEqual([b]);
      expect(b.burnUntil).toBe(3000 + 2000);
      expect(b.chainIgnited).toBe(true);
    });
  });
});
