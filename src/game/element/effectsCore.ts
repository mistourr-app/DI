// ============================================================
// effectsCore — чистое ядро эффектов стихий (Итерация 4).
// Без Phaser, без аллокаций в горячем пути. Тестируется в jest.
// Решает: какую перекраску применить к врагу, когда он сгорает,
// и кого поджечь цепным огнём (с шансом и лимитом — чтобы толпа
// не выгорала мгновенно).
// ============================================================

import type { ElementType } from '../config/GameConfig';

/** Параметры эффектов (единицы уже готовы к использованию) */
export interface EffectConfig {
  burnDurationMs: number;  // секунд горения до смерти
  burnRadiusPx: number;    // радиус цепного поджога, px
  spreadChance: number;    // шанс заражения соседа (0..1)
  maxIgnitePerDeath: number; // лимит поджигов за одну смерть
  wetDurationMs: number;   // сколько «мокрый» держится после выхода из воды
  airDurationMs: number;   // сколько «сдутый» держится после выхода из воздуха
}

/** Минимальный контракт врага для статусов */
export interface StatusEnemy {
  x: number;
  y: number;
  active: boolean;
  burnUntil: number;
  wetUntil: number;
  airUntil: number;
  /** Цепно подожжён (горит вне зоны огня до дедлайна) */
  chainIgnited?: boolean;
}

export type StatusKind = 'burn' | 'blown' | 'wet' | 'none' | 'burn_death';

/**
 * Непрозрачность сплошной заливки статуса (основная прозрачность оверлея).
 * Горение держит её на 100% этого значения, вода/воздух — с угасанием
 * (альфа = STATE_FILL_ALPHA * остаток времени).
 */
export const STATE_FILL_ALPHA = 0.8;

/**
 * Цвет статуса для сплошной заливки оверлея (setTintFill — цвет БЕЗ
 * смешивания с текстурой, сохраняется только форма): горение — жёлтый,
 * мокрый — голубой, сдутый — бледно-синий. Статусы держатся, пока действует
 * эффект (лингер).
 */
export function tintFor(kind: StatusKind): number {
  return kind === 'burn'
    ? 0xffe206
    : kind === 'blown'
      ? 0xb4c2f0
      : kind === 'wet'
        ? 0x00d9ff
        : 0xffffff;
}

/** Линейная интерполяция двух 24-битных цветов: t=0 -> a, t=1 -> b */
export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Один проход статуса для врага. Мутирует burnUntil/wetUntil/airUntil.
 * Эффекты живут, ПОКА СУЩЕСТВУЕТ ЗОНА (длительность стихии) + лингер:
 *   - Огонь: вход в зону поджигает (без обновления, пока горит — иначе
 *     вечное пламя). Уход из зоны гасит, если не подожжён цепно.
 *   - Вода: в зоне обновляет wetUntil = now + wetDuration; при выходе
 *     статус держится ещё wetDuration (монстр высыхает по времени).
 *   - Воздух: в зоне обновляет airUntil = now + airDuration; при выходе
 *     статус «сдутый» держится ещё airDuration (инерция затухает).
 * Возвращает 'burn_death' (врага надо убить + поджечь соседей) либо
 * новую перекраску ('burn'/'blown'/'wet'/'none').
 */
export function applyStatus(
  e: StatusEnemy,
  now: number,
  cfg: EffectConfig,
  isFireAt: (x: number, y: number) => boolean,
  waterAt: (x: number, y: number) => boolean,
  airAt: (x: number, y: number) => boolean
): StatusKind {
  const inFire = isFireAt(e.x, e.y);
  const inWater = waterAt(e.x, e.y);
  const inAir = airAt(e.x, e.y);

  // Смерть от горения проверяем ДО поджога: на дедлайне нельзя «переподжечь»
  if (e.burnUntil > 0 && now >= e.burnUntil) {
    e.burnUntil = 0;
    e.chainIgnited = false;
    return 'burn_death';
  }

  // Огонь: поджиг при входе (не обновляем, пока горит)
  if (inFire && e.burnUntil <= now) {
    e.burnUntil = now + cfg.burnDurationMs;
  }
  // Уход из огня без цепного поджога — пламя гаснет
  if (!inFire && !e.chainIgnited && e.burnUntil > 0) {
    e.burnUntil = 0;
  }

  // Вода: лингер — держится wetDuration после выхода (обновляем в зоне)
  if (inWater) e.wetUntil = now + cfg.wetDurationMs;
  else if (e.wetUntil <= now) e.wetUntil = 0;

  // Воздух: лингер — держится airDuration после выхода (обновляем в зоне)
  if (inAir) e.airUntil = now + cfg.airDurationMs;
  else if (e.airUntil <= now) e.airUntil = 0;

  if (e.burnUntil > 0) return 'burn';
  if (e.airUntil > 0) return 'blown';
  if (e.wetUntil > 0) return 'wet';
  return 'none';
}

/**
 * Цепной поджог: среди врагов в радиусе burnRadiusPx от точки, не более
 * maxIgnitePerDeath, каждого — с шансом spreadChance. Минимальный поджог:
 * ожидаемое число заражений < 1 (субкритично, цепь затухает). Подожжённые
 * помечаются chainIgnited — горят до дедлайна даже вне зоны. Мутирует
 * burnUntil/chainIgnited. skip — сгоревший враг (его не поджигаем заново).
 */
export function igniteNeighbors(
  cx: number,
  cy: number,
  enemies: StatusEnemy[],
  cfg: EffectConfig,
  now: number,
  random: () => number = Math.random,
  skip?: StatusEnemy
): StatusEnemy[] {
  const r2 = cfg.burnRadiusPx * cfg.burnRadiusPx;
  const out: StatusEnemy[] = [];
  let ignited = 0;
  for (let i = 0; i < enemies.length && ignited < cfg.maxIgnitePerDeath; i++) {
    const e = enemies[i];
    if (e === skip) continue; // источник — не поджигаем заново
    if (!e.active || e.burnUntil > now) continue; // мёртвые / уже горящие
    const dx = e.x - cx;
    const dy = e.y - cy;
    if (dx * dx + dy * dy > r2) continue;
    if (random() >= cfg.spreadChance) continue;
    e.burnUntil = now + cfg.burnDurationMs;
    e.chainIgnited = true;
    out.push(e);
    ignited++;
  }
  return out;
}

/** Баланс по элементу (для отладки/конфигов) */
export type { ElementType };
