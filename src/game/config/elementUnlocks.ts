// ============================================================
// Прогрессия стихий (ELEMENT_UNLOCKS.md): уровни открытия стихий
// по максимальному достигнутому уровню забега (персистентно в
// UpgradeSystem.maxLevelReached). Закрытая стихия не копит ману,
// не выбирается и показывает «Lvl. N» вместо названия.
// ============================================================

import type { ElementType } from './GameConfig';

/** Ключи прокачиваемых механик: стихии + супер-заряд силы бога */
export type UnlockableKey = ElementType | 'god';

/** Уровень достижения забега, на котором механика открывается */
export const ELEMENT_UNLOCK_LEVELS: Record<UnlockableKey, number> = {
  air: 2,
  water: 4,
  earth: 6,
  fire: 8,
  god: 10
};

/** Открыта ли механика при достигнутом максимуме уровней забега */
export function isElementUnlocked(key: UnlockableKey, maxLevelReached: number): boolean {
  return maxLevelReached >= ELEMENT_UNLOCK_LEVELS[key];
}

/** Подпись кнопки закрытой механики: «Lvl. N» */
export function unlockLabel(key: UnlockableKey): string {
  return `Lvl. ${ELEMENT_UNLOCK_LEVELS[key]}`;
}