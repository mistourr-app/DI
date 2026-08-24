// ============================================================
// GodPowerSystem — состояние механики супер силы бога (ГДД 2.5).
// Чистый TS без Phaser: заряд от убийств молниями, режимы
// обычной атаки / супер силы. Балансные параметры — GameConfig.godPower.
// ============================================================

export interface GodPowerBalance {
  /** Монстров уничтожает одна обычная молния */
  lightningKillCount: number;
  /** Радиус поражения молнии, css-px дизайна */
  lightningRadius: number;
  /** Радиус зоны супер атаки, css-px дизайна */
  superRadius: number;
  /** Убийств молнией для полной зарядки прогресс-бара */
  superChargeRequired: number;
}

export class GodPowerSystem {
  private balance: GodPowerBalance;
  /** Убийств молнией с момента последней супер атаки */
  private kills: number = 0;
  /** Режим супер силы активирован (следующий тап по полю = супер атака) */
  private armedFlag: boolean = false;

  constructor(balance: GodPowerBalance) {
    this.balance = balance;
  }

  /** Заполнение бара 0..1 */
  get progress(): number {
    return Math.min(1, this.kills / Math.max(1, this.balance.superChargeRequired));
  }

  get isCharged(): boolean {
    return this.kills >= this.balance.superChargeRequired;
  }

  get isArmed(): boolean {
    return this.armedFlag;
  }

  get lightningKillCount(): number {
    return this.balance.lightningKillCount;
  }

  get lightningRadius(): number {
    return this.balance.lightningRadius;
  }

  get superRadius(): number {
    return this.balance.superRadius;
  }

  /** Учёт убитых молнией. true — бар заполнился только что */
  registerKills(n: number): boolean {
    if (n <= 0) return false;
    const wasCharged = this.isCharged;
    this.kills = Math.min(this.balance.superChargeRequired, this.kills + n);
    return !wasCharged && this.isCharged;
  }

  /** Включение режима супер силы. false — заряд ещё не полон */
  arm(): boolean {
    if (!this.isCharged) return false;
    this.armedFlag = true;
    return true;
  }

  /** Отмена режима супер силы (повторный тап по иконке) */
  disarm(): void {
    this.armedFlag = false;
  }

  /**
   * Применение супер силы: снимает режим и сбрасывает бар в 0.
   * Возвращает радиус поражения или null, если режим не был активирован.
   */
  consume(): number | null {
    if (!this.armedFlag) return null;
    this.armedFlag = false;
    this.kills = 0;
    return this.balance.superRadius;
  }

  /** Полный сброс заряда и режима (новый уровень) */
  reset(): void {
    this.kills = 0;
    this.armedFlag = false;
  }

  /** Синхронизация после изменения superChargeRequired в настройках */
  onBalanceChanged(): void {
    if (this.armedFlag && !this.isCharged) {
      this.armedFlag = false;
    }
    if (this.kills > this.balance.superChargeRequired) {
      this.kills = this.balance.superChargeRequired;
    }
  }
}
