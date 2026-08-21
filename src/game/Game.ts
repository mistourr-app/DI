import Phaser from 'phaser';
import { GameScene } from '../scenes/GameScene';

export class Game {
  private phaserGame: Phaser.Game | null = null;

  async start(): Promise<void> {
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.WEBGL,
      parent: 'game-container',
      width: '100%',
      height: '100%',
      backgroundColor: '#000000',
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: '100%',
        height: '100%',
        min: {
          width: 300,
          height: 500
        },
        max: {
          width: 1920,
          height: 1080
        }
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
  }

  stop(): void {
    if (this.phaserGame) {
      this.phaserGame.destroy(true);
      this.phaserGame = null;
    }
  }
}