/**
 * Масштаб рендера: канвас рисуется в ФИЗИЧЕСКИХ пикселях устройства
 * (иначе на HiDPI-экранах всё размыто), а отображается в CSS-пикселях
 * через zoom = 1/UI_SCALE. Все игровые координаты становятся «плотными»,
 * UI-константы сцены умножаются на UI_SCALE для сохранения пропорций.
 *
 * Отдельный модуль (не в Game.ts): его импортируют и Game, и GameScene —
 * циклический импорт Game <-> GameScene ронял приложение на старте.
 */
export const UI_SCALE: number = Math.min(window.devicePixelRatio || 1, 2);

/**
 * Глобальный множитель читаемости текста поверх UI_SCALE.
 * Единственная ручка для «мелкий/крупный шрифт во всём UI».
 */
export const TEXT_BOOST = 1.25;

/** Размер шрифта в игровых px из css-размера дизайна */
export function fontPx(cssPx: number): number {
  return Math.round(cssPx * UI_SCALE * TEXT_BOOST);
}

/** Отступы, кнопки, скругления в игровых px из css-размера дизайна */
export function padPx(cssPx: number): number {
  return Math.round(cssPx * UI_SCALE);
}
