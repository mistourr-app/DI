import { UpgradeSystem } from './UpgradeSystem';
import { parseBalance, buildUpgradeDefs, upgradeCost, type UpgradeDef } from './balance';

/** In-memory localStorage (jest testEnvironment = 'node', без DOM) */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); }
  };
  (globalThis as any).localStorage = ls;
  (globalThis as any).__di_store = store;
}

/** Фикстурный каталог: те же ключи/цены, что в balance_1.csv (подмножество) */
const FIXTURE_CSV = [
  'title;key;costBase;costRatio;maxLevel;v0;v1;v2;v3;v4;v5;v6;v7;v8;;group',
  'Fire: mana capacity;capacity-fire;75;1.6;8;20;28;36;43;51;59;66;74;80;;economy',
  'Water: mana per kill;gainPerKill-water;75;1.6;8;0.3;0.4;0.5;0.6;0.7;0.8;0.9;0.95;1.0;;economy',
  'Fire: chain ignite;fire.maxIgnite;130;1.6;5;1;1;2;2;3;3;;;effect',
  'God: kills per lightning;god.lightning;600;1.6;5;1;2;3;4;5;;;;god',
  'God: super radius;god.superRadius;130;1.6;8;80;100;120;140;160;180;200;220;240;;god'
].join('\n');

function makeCatalog(): Record<string, UpgradeDef> {
  const defs = buildUpgradeDefs(parseBalance(FIXTURE_CSV));
  const dict: Record<string, UpgradeDef> = {};
  for (const d of defs) dict[d.key] = d;
  return dict;
}

function freshSystem(): UpgradeSystem {
  installLocalStorage();
  return new UpgradeSystem(makeCatalog());
}

describe('upgradeCost (PROGRESSION §7, ratio 1.6)', () => {
  it('считает cost(n) = round(costBase × ratio^(n−1))', () => {
    const cat = makeCatalog();
    expect(upgradeCost(cat['capacity-fire'], 0)).toBe(75);
    expect(upgradeCost(cat['capacity-fire'], 1)).toBe(Math.round(75 * 1.6));
    expect(upgradeCost(cat['god.lightning'], 0)).toBe(600);
  });

  it('возвращает null на максимуме', () => {
    const cat = makeCatalog();
    expect(upgradeCost(cat['fire.maxIgnite'], 5)).toBeNull();
    expect(upgradeCost(cat['god.superRadius'], 8)).toBeNull();
  });
});

describe('UpgradeSystem', () => {
  it('стартует с нулём душ и нулевыми уровнями', () => {
    const s = freshSystem();
    expect(s.totalSouls).toBe(0);
    expect(s.levelOf('capacity-fire')).toBe(0);
    expect(s.isMaxed('capacity-fire')).toBe(false);
  });

  it('addSouls начисляет, buy списывает и повышает уровень', () => {
    const s = freshSystem();
    s.addSouls(200);
    expect(s.totalSouls).toBe(200);
    expect(s.canBuy('capacity-fire')).toBe(true);
    const cost = s.costOf('capacity-fire')!;
    expect(s.buy('capacity-fire')).toBe(true);
    expect(s.levelOf('capacity-fire')).toBe(1);
    expect(s.totalSouls).toBe(200 - cost);
  });

  it('buy не уходит в минус и не качает без средств', () => {
    const s = freshSystem();
    s.addSouls(10);
    expect(s.canBuy('god.superRadius')).toBe(false); // cost 130
    expect(s.buy('god.superRadius')).toBe(false);
    expect(s.levelOf('god.superRadius')).toBe(0);
    expect(s.totalSouls).toBe(10);
  });

  it('прокачка до максимума затем блокируется', () => {
    const s = freshSystem();
    s.addSouls(1_000_000);
    const key = 'fire.maxIgnite'; // maxLevel 5
    for (let i = 0; i < 5; i++) {
      expect(s.buy(key)).toBe(true);
    }
    expect(s.isMaxed(key)).toBe(true);
    expect(s.costOf(key)).toBeNull();
    expect(s.buy(key)).toBe(false);
    expect(s.levelOf(key)).toBe(5);
  });

  it('прокачка god.lightning (costBase 600) списывает по кривой', () => {
    const s = freshSystem();
    s.addSouls(1000);
    expect(s.costOf('god.lightning')).toBe(600);
    expect(s.buy('god.lightning')).toBe(true);
    expect(s.totalSouls).toBe(400);
  });

  it('completeLevel даёт +10*N и только один раз', () => {
    const s = freshSystem();
    expect(s.completeLevel(3)).toBe(true);
    expect(s.totalSouls).toBe(30);
    expect(s.completeLevel(3)).toBe(false);
    expect(s.totalSouls).toBe(30);
  });

  it('reset возвращает все вложенные души (100%)', () => {
    const s = freshSystem();
    s.addSouls(2000);
    s.buy('capacity-fire');
    s.buy('gainPerKill-water');
    const spent = s.spentSouls();
    expect(spent).toBeGreaterThan(0);
    const before = s.totalSouls;
    s.reset();
    expect(s.totalSouls).toBe(before + spent);
    expect(s.levelOf('capacity-fire')).toBe(0);
  });

  it('resetAll стирает всё: души, уровни, пройденные (fresh start)', () => {
    const s = freshSystem();
    s.addSouls(2000);
    s.buy('capacity-fire');
    s.buy('gainPerKill-water');
    s.completeLevel(3);
    s.completeLevel(4);
    s.resetAll();
    expect(s.totalSouls).toBe(0);
    expect(s.levelOf('capacity-fire')).toBe(0);
    expect(s.levelOf('gainPerKill-water')).toBe(0);
    expect(s.isCompleted(3)).toBe(false);
    expect(s.isCompleted(4)).toBe(false);
  });

  it('resetAll переживает перезагрузку (state стёрт в хранилище)', () => {
    const s = freshSystem();
    s.addSouls(2000);
    s.buy('capacity-fire');
    s.completeLevel(2);
    s.resetAll();

    const s2 = new UpgradeSystem(makeCatalog());
    expect(s2.totalSouls).toBe(0);
    expect(s2.levelOf('capacity-fire')).toBe(0);
    expect(s2.isCompleted(2)).toBe(false);
  });

  it('сохраняет и загружает состояние (persistence)', () => {
    const s = freshSystem();
    s.addSouls(500);
    s.buy('capacity-fire');
    s.completeLevel(2);

    const s2 = new UpgradeSystem(makeCatalog());
    expect(s2.totalSouls).toBe(s.totalSouls);
    expect(s2.levelOf('capacity-fire')).toBe(1);
    expect(s2.isCompleted(2)).toBe(true);
    expect(s2.isCompleted(3)).toBe(false);
  });

  it('не падает без сохранённых данных', () => {
    installLocalStorage();
    const s = new UpgradeSystem(makeCatalog());
    expect(s.totalSouls).toBe(0);
    expect(s.levelOf('god.superRadius')).toBe(0);
  });
});