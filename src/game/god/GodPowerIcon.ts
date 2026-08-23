// ============================================================
// GodPowerIcon — круглая иконка супер силы бога в зоне базы
// (ГДД 2.4/2.5): заряд заполняется СНИЗУ ВВЕРХ за каждое
// убийство молнией; тап при полном заряде включает/отменяет
// режим супер силы.
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE, fontPx } from '../config/uiScale';
import type { GodPowerSystem } from './GodPowerSystem';

const TWO_PI = Math.PI * 2;

const COLOR_FILL = 0xffd700;
const COLOR_RING_EMPTY = 0x555577;
const COLOR_RING_CHARGED = 0xffd700;
const COLOR_RING_ARMED = 0xffffff;

export class GodPowerIcon {
  private readonly scene: Phaser.Scene;
  private readonly system: GodPowerSystem;
  private readonly cx: number;
  private readonly cy: number;
  private readonly radius: number;

  private bg: Phaser.GameObjects.Arc;
  private ring: Phaser.GameObjects.Arc;
  private fill: Phaser.GameObjects.Graphics;
  private bolt: Phaser.GameObjects.Text;
  private label: Phaser.GameObjects.Text;
  private zone: Phaser.GameObjects.Zone;

  /** Пульсация кольца в заряженном/активном состоянии */
  private pulseTween: Phaser.Tweens.Tween | null = null;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    radius: number,
    system: GodPowerSystem,
    onToggle: () => void
  ) {
    this.scene = scene;
    this.system = system;
    this.cx = x;
    this.cy = y;
    this.radius = radius;

    this.bg = scene.add.arc(x, y, radius, 0, TWO_PI, false, 0x101826, 1);
    this.bg.setStrokeStyle(2 * UI_SCALE, COLOR_RING_EMPTY);

    this.fill = scene.add.graphics();
    this.drawChargeFill();

    this.ring = scene.add.arc(x, y, radius).setFillStyle(0, 0);
    this.ring.setStrokeStyle(2 * UI_SCALE, COLOR_RING_EMPTY);

    this.bolt = scene.add.text(x, y - radius * 0.05, '⚡', {
      font: `${Math.round(radius * 1.0)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5);

    // Зона тапа чуть больше иконки — палец не должен попадать мимо
    this.zone = scene.add.zone(x, y, radius * 2.8, radius * 2.8)
      .setInteractive({ useHandCursor: true });
    this.zone.on('pointerdown', onToggle);

    this.label = scene.add.text(
      x,
      y + radius + fontPx(11),
      'СИЛА БОГА',
      { font: `${fontPx(10)}px Arial`, color: '#cccccc' }
    ).setOrigin(0.5);

    this.refreshState();
  }

  /** Перерисовка бара и состояний кольца (после каждого изменения заряда) */
  redraw(): void {
    this.drawChargeFill();
    this.refreshState();
  }

  destroy(): void {
    if (this.pulseTween) {
      this.pulseTween.stop();
      this.pulseTween = null;
    }
    this.zone.destroy();
    this.label.destroy();
    this.bolt.destroy();
    this.fill.destroy();
    this.ring.destroy();
    this.bg.destroy();
  }

  /**
   * Заливка круга ниже/выше уровня заряда (сегмент круга).
   * p=0 — пусто, p=1 — полный круг; уровень растёт снизу вверх.
   */
  private drawChargeFill(): void {
    const g = this.fill;
    const r = Math.max(0, this.radius - 2 * UI_SCALE); // внутри кольца
    g.clear();
    const p = this.system.progress;
    if (p <= 0 || r <= 0) return;

    g.fillStyle(COLOR_FILL, 0.9);
    if (p >= 1) {
      g.fillCircle(this.cx, this.cy, r);
      return;
    }

    // Хорда уровня: dy>0 — ниже центра (заполнено больше половины)
    const dy = r - 2 * p * r;
    const w = Math.sqrt(Math.max(0, r * r - dy * dy));
    const a = Math.atan2(dy, w);
    g.beginPath();
    g.moveTo(this.cx + w, this.cy + dy);
    g.lineTo(this.cx - w, this.cy + dy);
    // Дуга от левого пересечения через ВЕРХ круга к правому
    g.arc(this.cx, this.cy, r, Math.PI - a, TWO_PI + a, false);
    g.closePath();
    g.fillPath();
  }

  private refreshState(): void {
    const armed = this.system.isArmed;
    const charged = this.system.isCharged;

    const color = armed ? COLOR_RING_ARMED : charged ? COLOR_RING_CHARGED : COLOR_RING_EMPTY;
    const width = (armed ? 3 : 2) * UI_SCALE;
    this.ring.setStrokeStyle(width, color);
    this.bolt.setColor(armed ? '#ffffff' : charged ? '#ffd700' : '#888899');

    if (this.pulseTween) {
      this.pulseTween.stop();
      this.pulseTween = null;
      this.ring.setAlpha(1);
    }
    if (charged) {
      this.pulseTween = this.scene.tweens.add({
        targets: this.ring,
        alpha: { from: 1, to: armed ? 0.35 : 0.55 },
        duration: armed ? 320 : 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }
  }
}
