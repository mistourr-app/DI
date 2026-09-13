// ============================================================
// balance.ts — единственный источник баланса: docs/balance_1.csv.
// Чистые функции (без ?raw и без Phaser): парсинг CSV в записи
// и построение UpgradeDef[]. Сам CSV подключается в
// upgradeCatalog.ts через Vite `?raw`; тесты используют инлайн-CSV.
//
// Формат CSV (разделитель ';', шапка в первой строке):
//   title;key;costBase;maxLevel;v0;v1;...;v8;;group
// Десятичные допустимы и через ',' и через '.' (нормализуются).
// ============================================================

import { GameConfig, type ElementType } from '../config/GameConfig';

export type UpgradeGroup = 'economy' | 'effect' | 'god';

export interface UpgradeDef {
  key: string;
  title: string;
  group: UpgradeGroup;
  element?: ElementType;
  maxLevel: number;
  costBase: number;
  /** Рост цены за уровень: cost(n) = round(costBase × costRatio^(n−1)) */
  costRatio: number;
  /** values[level] — значение на уровне level (0 = база, до maxLevel) */
  values: number[];
  /** Точность отображения числа (знаки после запятой) */
  precision: number;
  /** Записать значение уровня в GameConfig */
  apply: (level: number) => void;
}

/** Значение параметра на уровне level (за пределами шкалы — последнее) */
export function valueAt(def: UpgradeDef, level: number): number {
  const i = Math.max(0, Math.min(level, def.values.length - 1));
  return def.values[i];
}

/** Отображение значения с учётом точности */
export function displayValue(def: UpgradeDef, value: number): string {
  return value.toFixed(def.precision);
}

/**
 * Стоимость следующего уровня (PROGRESSION §7):
 * cost(n) = round(costBase × costRatio^(n−1)), n = 1..maxLevel.
 * null — параметр на максимуме.
 */
export function upgradeCost(def: UpgradeDef, currentLevel: number): number | null {
  if (currentLevel >= def.maxLevel) return null;
  return Math.round(def.costBase * Math.pow(def.costRatio, currentLevel));
}

/** Сырая запись из CSV (значения ещё строками/числами) */
export interface BalanceEntry {
  key: string;
  title: string;
  group: UpgradeGroup;
  costBase: number;
  costRatio: number;
  maxLevel: number;
  values: number[];
}

/** Карта «ключ параметра -> стихия» (для группировки в UI) */
const ELEMENT_BY_KEY: Record<string, ElementType> = {
  'capacity-fire': 'fire', 'gainPerKill-fire': 'fire', 'costPerUse-fire': 'fire',
  'fire.maxIgnite': 'fire', 'fire.duration': 'fire', 'fire.burnDuration': 'fire',
  'capacity-water': 'water', 'gainPerKill-water': 'water', 'costPerUse-water': 'water',
  'water.slowFactor': 'water', 'water.duration': 'water', 'water.wetDuration': 'water',
  'capacity-earth': 'earth', 'gainPerKill-earth': 'earth', 'costPerUse-earth': 'earth', 'earth.bites': 'earth',
  'capacity-air': 'air', 'gainPerKill-air': 'air', 'costPerUse-air': 'air',
  'air.push': 'air', 'air.duration': 'air', 'air.airDuration': 'air'
};

/**
 * Парсинг CSV баланса.
 * - первая строка — шапка, пропускается;
 * - колонки: title, key, costBase, costRatio, maxLevel, v0..v8, (пустая), group;
 * - десятичные запятые -> точки; пустые значения пропускаются;
 * - maxLevel ограничивается числом заполненных значений − 1 (защита);
 * - пустые строки пропускаются.
 */
export function parseBalance(csv: string): BalanceEntry[] {
  const lines = csv.split(/\r?\n/);
  const entries: BalanceEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(';');
    const key = cols[1]?.trim();
    if (!key) continue;

    const values: number[] = [];
    for (let v = 5; v < 14; v++) {
      const raw = cols[v]?.trim();
      if (!raw) continue;
      const num = Number(raw.replace(',', '.'));
      if (!Number.isNaN(num)) values.push(num);
    }
    if (values.length === 0) continue;

    const declared = Number(cols[4]?.trim().replace(',', '.'));
    const maxLevel = Number.isFinite(declared)
      ? Math.max(0, Math.min(declared, values.length - 1))
      : values.length - 1;

    const ratio = Number(cols[3]?.trim().replace(',', '.'));
    const costRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1.6;
    const group = (cols[15]?.trim() || 'economy') as UpgradeGroup;

    entries.push({
      key,
      title: cols[0]?.trim() || key,
      group,
      costBase: Number(cols[2]?.trim().replace(',', '.')) || 0,
      costRatio,
      maxLevel,
      values
    });
  }

  return entries;
}

/** Максимальное число знаков после запятой по значениям (для отображения) */
function inferPrecision(values: number[]): number {
  let max = 0;
  for (const v of values) {
    const s = String(v);
    const dot = s.indexOf('.');
    if (dot >= 0) max = Math.max(max, s.length - dot - 1);
  }
  return max;
}

/** Применение уровня параметра в GameConfig (карта «ключ -> поле») */
function applyForKey(key: string, values: number[]): (level: number) => void {
  const el = ELEMENT_BY_KEY[key];
  const val = (level: number): number => values[Math.max(0, Math.min(level, values.length - 1))];
  switch (key) {
    case 'capacity-fire': case 'capacity-water': case 'capacity-earth': case 'capacity-air':
      return (lvl) => { GameConfig.elements[el].capacity = val(lvl); };
    case 'gainPerKill-fire': case 'gainPerKill-water': case 'gainPerKill-earth': case 'gainPerKill-air':
      return (lvl) => { GameConfig.elements[el].gainPerKill = val(lvl); };
    case 'costPerUse-fire': case 'costPerUse-water': case 'costPerUse-earth': case 'costPerUse-air':
      return (lvl) => { GameConfig.elements[el].costPerUse = val(lvl); };
    case 'fire.maxIgnite':
      return (lvl) => { GameConfig.elements.fire.maxIgnitePerDeath = val(lvl); };
    case 'fire.duration':
      return (lvl) => { GameConfig.elements.fire.duration = val(lvl); };
    case 'fire.burnDuration':
      return (lvl) => { GameConfig.elements.fire.burnDuration = val(lvl); };
    case 'water.slowFactor':
      return (lvl) => { GameConfig.elements.water.slowFactor = val(lvl); };
    case 'water.duration':
      return (lvl) => { GameConfig.elements.water.duration = val(lvl); };
    case 'water.wetDuration':
      return (lvl) => { GameConfig.elements.water.wetDuration = val(lvl); };
    case 'earth.bites':
      return (lvl) => { GameConfig.earth.bitesPerCell = val(lvl); };
    case 'air.push':
      return (lvl) => { GameConfig.elements.air.pushStrength = val(lvl); };
    case 'air.duration':
      return (lvl) => { GameConfig.elements.air.duration = val(lvl); };
    case 'air.airDuration':
      return (lvl) => { GameConfig.elements.air.airDuration = val(lvl); };
    case 'god.lightning':
      return (lvl) => { GameConfig.godPower.lightningKillCount = val(lvl); };
    case 'god.superRadius':
      return (lvl) => { GameConfig.godPower.superRadius = val(lvl); };
    case 'god.superCharge':
      return (lvl) => { GameConfig.godPower.superChargeRequired = val(lvl); };
    default:
      return () => { /* неизвестный ключ: баланс есть, применения нет */ };
  }
}

/** Построение UpgradeDef[] из записей CSV */
export function buildUpgradeDefs(entries: BalanceEntry[]): UpgradeDef[] {
  return entries.map((e) => ({
    key: e.key,
    title: e.title,
    group: e.group,
    element: ELEMENT_BY_KEY[e.key],
    maxLevel: e.maxLevel,
    costBase: e.costBase,
    costRatio: e.costRatio,
    values: e.values,
    precision: inferPrecision(e.values),
    apply: applyForKey(e.key, e.values)
  }));
}