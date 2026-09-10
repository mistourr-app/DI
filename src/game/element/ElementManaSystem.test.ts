import { ElementManaSystem, ELEMENT_KEYS, type ElementBalanceMap } from './ElementManaSystem';
import { GameConfig } from '../config/GameConfig';

/** Клон баланса из GameConfig: тесты не мутируют глобальный синглтон */
function makeBalance(): ElementBalanceMap {
  return {
    fire: { ...GameConfig.elements.fire },
    water: { ...GameConfig.elements.water },
    earth: { ...GameConfig.elements.earth },
    air: { ...GameConfig.elements.air }
  };
}

describe('ElementManaSystem', () => {
  it('стартует с нулевой маной и пустым выбором', () => {
    const m = new ElementManaSystem(makeBalance());
    for (const key of ELEMENT_KEYS) {
      expect(m.manaOf(key)).toBe(0);
      expect(m.progress(key)).toBe(0);
      expect(m.canUse(key)).toBe(false);
    }
    expect(m.armed).toBeNull();
  });

  it('убийства наполняют каждый алтарь своей порцией gainPerKill', () => {
    const m = new ElementManaSystem(makeBalance());
    m.gainFromKills(3);
    for (const key of ELEMENT_KEYS) {
      expect(m.manaOf(key)).toBe(3 * GameConfig.elements[key].gainPerKill);
      expect(m.progress(key)).toBeLessThanOrEqual(1);
    }
  });

  it('мана не превышает ёмкость алтаря (cap)', () => {
    const m = new ElementManaSystem(makeBalance());
    m.gainFromKills(1_000_000);
    for (const key of ELEMENT_KEYS) {
      expect(m.manaOf(key)).toBe(GameConfig.elements[key].capacity);
      expect(m.isFull(key)).toBe(true);
      expect(m.progress(key)).toBe(1);
    }
  });

  it('use списывает costPerUse и не списывает при нехватке', () => {
    const m = new ElementManaSystem(makeBalance());
    const key = 'water';
    const cost = GameConfig.elements.water.costPerUse;
    const gain = GameConfig.elements.water.gainPerKill;

    // Нехватка
    expect(m.use(key)).toBe(false);
    expect(m.manaOf(key)).toBe(0);

    // Достаточно для одного штриха
    m.gainFromKills(Math.ceil(cost / gain));
    expect(m.canUse(key)).toBe(true);
    expect(m.use(key)).toBe(true);
    expect(m.manaOf(key)).toBe(Math.ceil(cost / gain) * gain - cost);
  });

  it('spend списывает произвольную сумму; 0 и нехватка не трогают ману', () => {
    const m = new ElementManaSystem(makeBalance());
    m.gainFromKills(10); // вода: 20 маны

    expect(m.spend('water', 0)).toBe(true);
    expect(m.manaOf('water')).toBe(20);

    expect(m.spend('water', 5)).toBe(true);
    expect(m.manaOf('water')).toBe(15);

    expect(m.spend('water', 999)).toBe(false);
    expect(m.manaOf('water')).toBe(15);
  });

  it('arm требует доступной маны; disarm снимает выбор', () => {
    const m = new ElementManaSystem(makeBalance());
    expect(m.arm('fire')).toBe(false);
    expect(m.armed).toBeNull();

    m.gainFromKills(10);
    expect(m.arm('fire')).toBe(true);
    expect(m.armed).toBe('fire');
    m.disarm();
    expect(m.armed).toBeNull();
    expect(m.arm(null)).toBe(false);
  });

  it('reset обнуляет ману и выбор', () => {
    const m = new ElementManaSystem(makeBalance());
    m.gainFromKills(10);
    m.arm('earth');
    m.reset();
    for (const key of ELEMENT_KEYS) {
      expect(m.manaOf(key)).toBe(0);
    }
    expect(m.armed).toBeNull();
  });

  it('onBalanceChanged клэмпит ману к новой ёмкости и снимает необеспеченный выбор', () => {
    const bal = makeBalance();
    const m = new ElementManaSystem(bal);
    m.gainFromKills(10);
    expect(m.arm('air')).toBe(true);

    // Уменьшаем ёмкость и увеличиваем стоимость
    bal.air.capacity = 1;
    bal.air.costPerUse = 100;
    m.onBalanceChanged();
    expect(m.manaOf('air')).toBeLessThanOrEqual(1);
    expect(m.armed).toBeNull();
  });
});