// ============================================================
// ElementManaSystem — мана стихий (ГДД 2.2, Итерация 1).
// Чистый TS без Phaser: независимые запасы маны по алтарям,
// накопление от убийств монстров, списание за штрих, арм-состояние
// выбранной стихии. Балансные параметры — GameConfig.elements.
// ============================================================

import type { ElementConfig, ElementType } from '../config/GameConfig';

/** Конфиг всех алтарей: ключ стихии -> её баланс (мана алтаря) */
export type ElementBalanceMap = Record<ElementType, ElementConfig>;

export const ELEMENT_KEYS: ElementType[] = ['fire', 'water', 'earth', 'air'];

export class ElementManaSystem {
  private balance: ElementBalanceMap;
  private mana: Record<ElementType, number>;
  private armedElement: ElementType | null = null;
  /** Закрытые стихии (ELEMENT_UNLOCKS.md): не копят ману, не выбираются */
  private lockedKeys = new Set<ElementType>();

  constructor(balance: ElementBalanceMap) {
    this.balance = balance;
    this.mana = {
      fire: 0,
      water: 0,
      earth: 0,
      air: 0
    };
  }

  /** Текущий запас маны алтаря */
  manaOf(key: ElementType): number {
    return this.mana[key];
  }

  /** Ёмкость маны алтаря */
  capacityOf(key: ElementType): number {
    return this.balance[key].capacity;
  }

  /** Заполнение бара алтаря 0..1 */
  progress(key: ElementType): number {
    return Math.min(1, this.mana[key] / Math.max(1, this.balance[key].capacity));
  }

  /** Заполнен ли бар (мана достигла ёмкости) */
  isFull(key: ElementType): boolean {
    return this.mana[key] >= this.balance[key].capacity;
  }

  /** Закрыта ли стихия (не копит ману, не выбирается) */
  isLocked(key: ElementType): boolean {
    return this.lockedKeys.has(key);
  }

  /** Задать множество закрытых стихий (синк с прогрессией) */
  setLocked(keys: Iterable<ElementType>): void {
    this.lockedKeys = new Set(keys);
    if (this.armedElement !== null && this.lockedKeys.has(this.armedElement)) {
      this.armedElement = null;
    }
  }

  /**
   * Учёт боевых убийств монстров: каждый убитый даёт каждому ОТКРЫТОМУ
   * алтарю свою порцию gainPerKill. Мана не превышает ёмкость (cap).
   * Закрытые стихии ману не копят.
   */
  gainFromKills(n: number): void {
    if (n <= 0) return;
    for (const key of ELEMENT_KEYS) {
      if (this.lockedKeys.has(key)) continue;
      const add = n * this.balance[key].gainPerKill;
      this.mana[key] = Math.min(this.balance[key].capacity, this.mana[key] + add);
    }
  }

  /** Хватает ли маны алтарю на один штрих (у закрытой — никогда) */
  canUse(key: ElementType): boolean {
    return !this.lockedKeys.has(key) && this.mana[key] >= this.balance[key].costPerUse;
  }

  /**
   * Списание маны за штрих. Возвращает false, если маны недостаточно
   * (в этом случае ничего не списывается).
   */
  use(key: ElementType): boolean {
    if (!this.canUse(key)) return false;
    this.mana[key] -= this.balance[key].costPerUse;
    return true;
  }

  /**
   * Списание произвольной суммы (штрих частично над препятствием).
   * amount — неотрицательная сумма; 0 списывает ничего. false при нехватке.
   */
  spend(key: ElementType, amount: number): boolean {
    if (amount <= 0) return true;
    if (this.lockedKeys.has(key)) return false;
    if (this.mana[key] < amount) return false;
    this.mana[key] -= amount;
    return true;
  }

  /** Выбранная (армнутая) для рисования стихия, либо null */
  get armed(): ElementType | null {
    return this.armedElement;
  }

  /**
   * Выбрать стихию для рисования. false — на стихию не хватает маны
   * (или передан null), выбор не меняется. null снимает выбор.
   */
  arm(key: ElementType | null): boolean {
    if (key === null) {
      this.armedElement = null;
      return false;
    }
    if (this.lockedKeys.has(key)) return false;
    if (!this.canUse(key)) return false;
    this.armedElement = key;
    return true;
  }

  /** Снять выбор стихии */
  disarm(): void {
    this.armedElement = null;
  }

  /** Полный сброс запасов и выбора (новый уровень) */
  reset(): void {
    for (const key of ELEMENT_KEYS) {
      this.mana[key] = 0;
    }
    this.armedElement = null;
  }

  /** Синхронизация после изменения баланса в настройках */
  onBalanceChanged(): void {
    for (const key of ELEMENT_KEYS) {
      if (this.mana[key] > this.balance[key].capacity) {
        this.mana[key] = this.balance[key].capacity;
      }
    }
    if (this.armedElement !== null && !this.canUse(this.armedElement)) {
      this.armedElement = null;
    }
  }
}
