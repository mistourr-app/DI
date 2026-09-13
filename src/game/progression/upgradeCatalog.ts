// ============================================================
// upgradeCatalog — каталог прокачиваемых параметров (PROGRESSION.md §4).
// ЕДИНСТВЕННЫЙ источник баланса: docs/balance_1.csv (через Vite `?raw`).
// Новые балансные поля добавляются в CSV, значения/цены правятся там же;
// карта «ключ -> поле GameConfig» живёт в balance.ts (applyForKey).
// ============================================================

import raw from 'virtual:balance';
import { parseBalance, buildUpgradeDefs } from './balance';

export type { UpgradeDef, UpgradeGroup, BalanceEntry } from './balance';
export { valueAt, displayValue, upgradeCost } from './balance';

/** Каталог, построенный из balance_1.csv */
export const upgradeDefs = buildUpgradeDefs(parseBalance(raw));

/** Словарь по ключам */
export const upgradeCatalog: Record<string, ReturnType<typeof buildUpgradeDefs>[number]> = {};
for (const def of upgradeDefs) {
  upgradeCatalog[def.key] = def;
}