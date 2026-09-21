// ============================================================
// balance.ts — единственный источник баланса: docs/balance_1.csv.
// Чистые функции (без ?raw и без Phaser): парсинг CSV в записи
// и построение UpgradeDef[]. Сам CSV подключается в
// upgradeCatalog.ts через Vite `?raw`; тесты используют инлайн-CSV.
//
// Формат CSV — ГИБКИЙ: разделитель не важен (',' ';' '\t'
// определяются по шапке), колонки привязываются к ИМЕНАМ шапки,
// а не к номерам. Обязательные колонки: title, key, costBase,
// costRatio, maxLevel; значения — колонки v0..vN; group — опция.
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
 * Парсер CSV баланса, устойчивый к формату.
 * - первая строка — шапка: по ней определяется разделитель (','/';'/'\\t')
 *   и раскладка колонок ПО ИМЕНАМ (порядок/лишние колонки не важны);
 * - обязательные колонки: title, key, costBase, costRatio, maxLevel;
 * - значения: все колонки v0..vN (порядок по шапке);
 * - optional: group (по умолчанию 'economy');
 * - десятичные запятые -> точки; пустые значения пропускаются;
 * - maxLevel ограничивается числом заполненных значений − 1 (защита);
 * - пустые строки пропускаются.
 */

type BalanceHeader = Partial<Record<'title'|'key'|'costBase'|'costRatio'|'maxLevel'|'group', number>>;

/** Все кандидаты-разделители; победит тот, по которому шапка даёт больше
 *  знакомых колонок (чтобы не спутать ',' в заголовках-типах). */
const DELIMITERS = [',', ';', '\t'] as const;

const KNOWN_HEADERS = new Set(['title', 'key', 'costbase', 'costratio', 'maxlevel', 'group']);

/** Индексы колонок по именам шапки под конкретный разделитель */
function mapHeaders(header: string, delim: string): BalanceHeader | null {
  const cols = header.split(delim).map((c) => c.trim());
  const out: BalanceHeader = {};
  for (let i = 0; i < cols.length; i++) {
    const name = cols[i].toLowerCase();
    if (!out.title && name === 'title') out.title = i;
    else if (!out.key && name === 'key') out.key = i;
    else if (!out.costBase && name === 'costbase') out.costBase = i;
    else if (!out.costRatio && name === 'costratio') out.costRatio = i;
    else if (!out.maxLevel && name === 'maxlevel') out.maxLevel = i;
    else if (!out.group && name === 'group') out.group = i;
  }
  if (out.title === undefined || out.key === undefined) return null;
  return out;
}

function pickDelimiter(header: string): string {
  let best = ',' as string;
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const score = header.split(d).map((c) => c.trim().toLowerCase())
      .filter((c) => KNOWN_HEADERS.has(c)).length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Парсинг числа: нормализация ',' -> '.' и trim */
function toNumber(raw: string | undefined): number {
  const s = (raw ?? '').trim().replace(',', '.');
  if (!s) return NaN;
  return Number(s);
}

export function parseBalance(csv: string): BalanceEntry[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return [];

  const delim = pickDelimiter(lines[0]);
  const header = mapHeaders(lines[0], delim);
  if (!header) return [];

  // Индексы колонок значений v0..vN — в порядке появления в шапке
  const valueIdxs: number[] = [];
  const headCols = lines[0].split(delim);
  for (let i = 0; i < headCols.length; i++) {
    if (/^v\d+$/i.test(headCols[i].trim())) valueIdxs.push(i);
  }

  const entries: BalanceEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(delim);
    const key = cols[header.key!]?.trim();
    if (!key) continue;

    const values: number[] = [];
    for (const vi of valueIdxs) {
      const num = toNumber(cols[vi]);
      if (!Number.isNaN(num)) values.push(num);
    }
    if (values.length === 0) continue;

    const declared = toNumber(header.maxLevel !== undefined ? cols[header.maxLevel] : undefined);
    const maxLevel = Number.isFinite(declared)
      ? Math.max(0, Math.min(declared, values.length - 1))
      : values.length - 1;

    const ratio = toNumber(header.costRatio !== undefined ? cols[header.costRatio] : undefined);
    const costRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1.6;
    const group = (header.group !== undefined && cols[header.group]?.trim()) || 'economy';

    entries.push({
      key,
      title: (header.title !== undefined && cols[header.title]?.trim()) || key,
      group: group as UpgradeGroup,
      costBase: toNumber(header.costBase !== undefined ? cols[header.costBase] : undefined) || 0,
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
    case 'god.lightningRadius':
      return (lvl) => { GameConfig.godPower.lightningRadius = val(lvl); };
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