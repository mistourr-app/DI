import Phaser from 'phaser';
import { GameScene } from '../scenes/GameScene';
import { UpgradeScene } from '../scenes/UpgradeScene';
import { UI_SCALE } from './config/uiScale';

export class Game {
  private phaserGame: Phaser.Game | null = null;

  async start(): Promise<void> {
    // Ширина канваса КРАТНА 16: cellSize сетки препятствий становится
    // ровно 16px, позиции тайлов — целые. Дробный cellSize давал
    // вертикальные/горизонтальные полосы на блобах (швы арта при
    // субпиксельном рендере). Zoom компенсирует разницу до 8px.
    const w = Math.max(16, Math.round((window.innerWidth * UI_SCALE) / 16) * 16);
    const h = Math.max(1, Math.round(window.innerHeight * UI_SCALE));
    // Точный подгон: канвас занимает ровно всё окно (CSS-размер = w * zoom).
    // zoom = 1/UI_SCALE округлениями даёт щели до пикселя по краям на мобильных —
    // берём zoom от фактической ширины канваса, чтобы CSS-ширина = innerWidth.
    const zoom = window.innerWidth / w;

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.WEBGL,
      parent: 'game-container',
      width: w,
      height: h,
      backgroundColor: '#000000',
      scale: {
        mode: Phaser.Scale.NONE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: w,
        height: h,
        zoom
      },
      scene: [GameScene, UpgradeScene],
      physics: {
        default: 'arcade',
        arcade: {
          debug: false,
          gravity: { x: 0, y: 0 }
        }
      },
      input: {
        activePointers: 3
      }
    };

    this.phaserGame = new Phaser.Game(config);
    window.addEventListener('resize', this.handleWindowResize);
  }

  /** Ручной ресайз: режим NONE не следит за окном сам */
  private handleWindowResize = (): void => {
    const g = this.phaserGame;
    if (!g) return;
    const w = Math.max(16, Math.round((window.innerWidth * UI_SCALE) / 16) * 16);
    const h = Math.max(1, Math.round(window.innerHeight * UI_SCALE));
    g.scale.resize(w, h);
    g.scale.setZoom(window.innerWidth / w);
    g.scale.refresh();
  };

  stop(): void {
    window.removeEventListener('resize', this.handleWindowResize);
    if (this.phaserGame) {
      this.phaserGame.destroy(true);
      this.phaserGame = null;
    }
  }
}
