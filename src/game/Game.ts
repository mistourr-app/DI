import Phaser from 'phaser';
import { GameScene } from '../scenes/GameScene';
import { UI_SCALE } from './config/uiScale';

export class Game {
  private phaserGame: Phaser.Game | null = null;

  async start(): Promise<void> {
    const w = Math.max(1, Math.round(window.innerWidth * UI_SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * UI_SCALE));

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
        zoom: 1 / UI_SCALE
      },
      scene: [GameScene],
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
    g.scale.resize(
      Math.max(1, Math.round(window.innerWidth * UI_SCALE)),
      Math.max(1, Math.round(window.innerHeight * UI_SCALE))
    );
    g.scale.setZoom(1 / UI_SCALE);
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
