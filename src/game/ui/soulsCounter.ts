import Phaser from 'phaser';
import { fontPx, padPx } from '../config/uiScale';
import type { GameArea } from '../config/layout';

export interface SoulsCounter {
  container: Phaser.GameObjects.Container;
  setValue(value: number): void;
  place(gameArea: GameArea): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/** Иконка душ (emoji — отдельный ассет не нужен) */
const SOULS_ICON = '👻';

/**
 * Единый счётчик душ: [иконка + число] в левом верхнем углу игрового поля.
 *
 * Один вид и одна позиция во всех местах — геймплей, поп-апы победы/поражения
 * и экран прокачки (PROGRESSION.md §6), чтобы баланс читался одинаково и не
 * «прыгал» между сценами.
 */
export function createSoulsCounter(
  scene: Phaser.Scene,
  gameArea: GameArea,
  depth = 0
): SoulsCounter {
  const container = scene.add.container(0, 0).setScrollFactor(0).setDepth(depth);

  const bg = scene.add.graphics();
  const icon = scene.add.text(0, 0, SOULS_ICON, { font: `${fontPx(15)}px Arial` });
  const value = scene.add.text(0, 0, '0', {
    font: `bold ${fontPx(14)}px Arial`,
    color: '#ffd700'
  });
  container.add([bg, icon, value]);

  const padX = padPx(9);
  const gap = padPx(5);
  const h = fontPx(26);

  const relayout = (): void => {
    icon.setOrigin(0, 0.5).setPosition(padX, h / 2);
    value.setOrigin(0, 0.5).setPosition(padX + icon.width + gap, h / 2);
    const w = padX + icon.width + gap + value.width + padX;
    bg.clear();
    bg.fillStyle(0x000000, 0.5);
    bg.fillRoundedRect(0, 0, w, h, padPx(7));
    bg.lineStyle(padPx(1), 0x4a90d9, 0.6);
    bg.strokeRoundedRect(0, 0, w, h, padPx(7));
  };

  const place = (ga: GameArea): void => {
    container.setPosition(ga.x + padPx(8), ga.y + padPx(4));
  };

  relayout();
  place(gameArea);

  return {
    container,
    setValue(n: number): void {
      const text = String(Math.max(0, Math.floor(n)));
      if (value.text !== text) {
        value.setText(text);
        relayout();
      }
    },
    place,
    setVisible(visible: boolean): void {
      container.setVisible(visible);
    },
    destroy(): void {
      container.destroy(true);
    }
  };
}
