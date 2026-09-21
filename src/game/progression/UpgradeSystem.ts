// ============================================================
// UpgradeSystem — мета-прогресс между забегами (PROGRESSION.md).
// Чистый TS без Phaser: души, уровни параметров, формулы cost(),
// покупка, сброс с полным возвратом, персистентность (localStorage,
// отдельный ключ от TuningStore — прокачка мета-постоянна).
//
// Каталог параметров инжектится в конструктор (GameScene передаёт
// upgradeCatalog из balance_1.csv). Применение значений в GameConfig
// и sync систем — ответственность сцены.
// ============================================================

import { upgradeCost, type UpgradeDef } from './balance';

export interface ProgressionSave {
  souls: number;
  levels: Record<string, number>;
  completedLevels: number[];
}

const STORAGE_KEY = 'fluid-crowd-defense.progression.v1';

export class UpgradeSystem {
  private catalog: Record<string, UpgradeDef>;
  private souls = 0;
  private levels: Record<string, number> = {};
  private completed = new Set<number>();
  /** Есть ли несохранённые изменения (души, начисленные addSouls) */
  private dirty = false;

  constructor(catalog: Record<string, UpgradeDef>) {
    this.catalog = catalog;
    for (const key of Object.keys(catalog)) {
      this.levels[key] = 0;
    }
    this.load();
  }

  get totalSouls(): number {
    return this.souls;
  }

  /** true — в памяти есть души, ещё не записанные в localStorage */
  get hasUnsaved(): boolean {
    return this.dirty;
  }

  levelOf(key: string): number {
    return this.levels[key] ?? 0;
  }

  isMaxed(key: string): boolean {
    return this.levelOf(key) >= this.catalog[key].maxLevel;
  }

  isCompleted(level: number): boolean {
    return this.completed.has(level);
  }

  /** Стоимость следующего уровня параметра, либо null на максимуме */
  costOf(key: string): number | null {
    return upgradeCost(this.catalog[key], this.levelOf(key));
  }

  canBuy(key: string): boolean {
    const cost = this.costOf(key);
    return cost !== null && this.souls >= cost;
  }

  /** Покупка уровня. false — не хватает душ или параметр на максимуме */
  buy(key: string): boolean {
    const cost = this.costOf(key);
    if (cost === null || this.souls < cost) return false;
    this.souls -= cost;
    this.levels[key] = this.levelOf(key) + 1;
    this.save();
    return true;
  }

  /** Начисление душ за боевые убийства (1/убийство). Не сохраняет каждый раз —
   *  помечает состояние грязным; сцена флашит его по троттлу и на game over
   *  (см. SCENES_IMPROVEMENTS.md, I1) */
  addSouls(n: number): void {
    if (n <= 0) return;
    this.souls += n;
    this.dirty = true;
  }

  /**
   * Первое прохождение уровня N: бонус +10·N душ и отметка «пройден».
   * Возвращает true, если это первое прохождение (бонус начислен).
   */
  completeLevel(level: number): boolean {
    if (this.completed.has(level)) return false;
    this.completed.add(level);
    this.souls += 10 * level;
    this.save();
    return true;
  }

  /**
   * Сброс всех уровней прокачки с ПОЛНЫМ возвратом душ за вложенное
   * (PROGRESSION §8: souls += Σ spent(level) + обнуление уровней).
   * Пройденные уровни не отнимаются — награда за уровень не теряется.
   */
  reset(): void {
    this.souls += this.spentSouls();
    for (const key of Object.keys(this.levels)) {
      this.levels[key] = 0;
    }
    this.save();
  }

  /** Сбросить только количество собранных душ (обнулить souls) */
  resetSouls(): void {
    this.souls = 0;
    this.save();
  }

  /**
   * Полный сброс «fresh start»: души = 0, уровни = 0, пройденные уровни = ∅.
   * В отличие от reset() НЕ возвращает вложенные души — это именно стирание
   * всего прогресса (не откат с возвратом средств).
   */
  resetAll(): void {
    this.souls = 0;
    for (const key of Object.keys(this.levels)) {
      this.levels[key] = 0;
    }
    this.completed.clear();
    this.save();
  }

  /** Сумма душ, возвращаемых при полном сбросе (все вложенные) */
  spentSouls(): number {
    let total = 0;
    for (const key of Object.keys(this.levels)) {
      const def = this.catalog[key];
      for (let lvl = 0; lvl < this.levels[key]; lvl++) {
        const cost = upgradeCost(def, lvl);
        if (cost !== null) total += cost;
      }
    }
    return total;
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw) as ProgressionSave;
      if (!snap || typeof snap !== 'object') return;
      if (typeof snap.souls === 'number') this.souls = Math.max(0, snap.souls);
      if (snap.levels) {
        for (const key of Object.keys(this.levels)) {
          const v = snap.levels[key];
          if (typeof v === 'number') {
            this.levels[key] = Math.max(0, Math.min(this.catalog[key].maxLevel, Math.round(v)));
          }
        }
      }
      if (Array.isArray(snap.completedLevels)) {
        for (const l of snap.completedLevels) {
          if (typeof l === 'number') this.completed.add(l);
        }
      }
    } catch {
      // приватный режим / повреждённые данные — стартуем с нуля
    }
  }

  save(): void {
    try {
      const snap: ProgressionSave = {
        souls: this.souls,
        levels: { ...this.levels },
        completedLevels: Array.from(this.completed)
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      this.dirty = false;
    } catch {
      // приватный режим / переполнение — прокачка живёт до конца сессии
    }
  }
}