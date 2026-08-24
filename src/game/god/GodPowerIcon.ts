// ============================================================
// GodPowerIcon — круглая иконка супер силы бога в зоне базы
// (ГДД 2.4/2.5): заряд заполняется СНИЗУ ВВЕРХ ярко-розовым
// (маджента) за каждое убийство молниями.
// Состояния:
//   пустой/частичный — чёрный круг, бледная иконка;
//   полный заряд     — лёгкая пульсация + лёгкие вспышки;
//   выбрана (armed)  — кнопка увеличена, иконка максимально
//                      яркая, пульс сильнее, яркое свечение.
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE, fontPx } from '../config/uiScale';
import type { GodPowerSystem } from './GodPowerSystem';

const TWO_PI = Math.PI * 2;

const COLOR_FILL = 0xff00ff;        // ярко-розовый / маджента
const COLOR_BG = 0x000000;          // пустой бар — чёрный
const COLOR_RING_DIM = 0x7a2f7a;    // приглушённая обводка
const COLOR_RING_CHARGED = 0xff2dff;
const COLOR_RING_ARMED = 0xffffff;
const COLOR_GLOW = 0xff3dff;

type FlashMode = 'none' | 'soft' | 'strong';

export class GodPowerIcon {
  private readonly scene: Phaser.Scene;
  private readonly system: GodPowerSystem;
  private readonly radius: number;

  /** Все визуальные части в контейнере — для масштабирования кнопки */
  private readonly container: Phaser.GameObjects.Container;
  private readonly glow: Phaser.GameObjects.Graphics;
  private readonly bg: Phaser.GameObjects.Arc;
  private readonly fill: Phaser.GameObjects.Graphics;
  private readonly ring: Phaser.GameObjects.Arc;
  private readonly bolt: Phaser.GameObjects.Text;
  private readonly label: Phaser.GameObjects.Text;
  private readonly zone: Phaser.GameObjects.Zone;

  private pulseTweens: Phaser.Tweens.Tween[] = [];
  private flashTimer: Phaser.Time.TimerEvent | null = null;
  private flashMode: FlashMode = 'none';

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
    this.radius = radius;

    this.container = scene.add.container(x, y);

    // Свечение — под всем остальным, аддитивный бленд для «света»
    this.glow = scene.add.graphics();
    this.glow.setBlendMode(Phaser.BlendModes.ADD);
    this.container.add(this.glow);

    this.bg = scene.add.arc(0, 0, radius, 0, TWO_PI, false, COLOR_BG, 1);
    this.bg.setStrokeStyle(2 * UI_SCALE, COLOR_RING_DIM);
    this.container.add(this.bg);

    this.fill = scene.add.graphics();
    this.container.add(this.fill);

    this.ring = scene.add.arc(0, 0, radius).setFillStyle(0, 0);
    this.ring.setStrokeStyle(2 * UI_SCALE, COLOR_RING_DIM);
    this.container.add(this.ring);

    this.bolt = scene.add.text(0, -radius * 0.05, '⚡', {
      font: `${Math.round(radius * 1.0)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5);
    this.container.add(this.bolt);

    // Подпись и зона тапа — вне контейнера (не масштабируются)
    this.label = scene.add.text(
      x,
      y + radius + fontPx(11),
      'СИЛА БОГА',
      { font: `${fontPx(10)}px Arial`, color: '#cccccc' }
    ).setOrigin(0.5);

    // Зона тапа чуть больше иконки — палец не должен попадать мимо
    this.zone = scene.add.zone(x, y, radius * 3.2, radius * 3.2)
      .setInteractive({ useHandCursor: true });
    this.zone.on('pointerdown', onToggle);

    this.refreshState();
  }

  /** Перерисовка бара и состояний (после каждого изменения заряда) */
  redraw(): void {
    this.drawChargeFill();
    this.refreshState();
  }

  destroy(): void {
    this.stopFlashes();
    this.stopPulses();
    this.scene.tweens.killTweensOf(this.container);
    this.zone.destroy();
    this.label.destroy();
    this.container.destroy();
  }

  /**
   * Заливка круга ниже/выше уровня заряда (сегмент круга).
   * p=0 — пусто, p=1 — полный круг; уровень растёт снизу вверх.
   * Координаты локальные (центр контейнера = 0,0).
   */
  private drawChargeFill(): void {
    const g = this.fill;
    const r = Math.max(0, this.radius - 2 * UI_SCALE); // внутри кольца
    g.clear();
    const p = this.system.progress;
    if (p <= 0 || r <= 0) return;

    g.fillStyle(COLOR_FILL, 1);
    if (p >= 1) {
      g.fillCircle(0, 0, r);
      return;
    }

    // Хорда уровня: dy>0 — ниже центра (заполнено больше половины)
    const dy = r - 2 * p * r;
    const w = Math.sqrt(Math.max(0, r * r - dy * dy));
    const a = Math.atan2(dy, w);
    g.beginPath();
    g.moveTo(w, dy);
    g.lineTo(-w, dy);
    // Дуга от левого пересечения через ВЕРХ круга к правому
    g.arc(0, 0, r, Math.PI - a, TWO_PI + a, false);
    g.closePath();
    g.fillPath();
  }

  private refreshState(): void {
    const armed = this.system.isArmed;
    const charged = this.system.isCharged;

    // --- Иконка-молния: бледная на пустом, яркая на заряженном ---
    if (armed) {
      this.bolt.setColor('#ffffff');
      this.bolt.setAlpha(1);
    } else if (charged) {
      this.bolt.setColor('#ff8dff');
      this.bolt.setAlpha(1);
    } else {
      this.bolt.setColor('#ffffff');
      this.bolt.setAlpha(0.28);
    }

    // --- Кольцо ---
    const ringColor = armed ? COLOR_RING_ARMED : charged ? COLOR_RING_CHARGED : COLOR_RING_DIM;
    const ringWidth = (armed ? 3 : 2) * UI_SCALE;
    this.ring.setStrokeStyle(ringWidth, ringColor);
    this.ring.setAlpha(1);

    // --- Свечение: очень яркое только в режиме выбранной силы ---
    this.drawGlow(armed);

    // --- Пульс и масштаб ---
    this.stopPulses();
    this.scene.tweens.killTweensOf(this.container);
    this.container.setScale(1);

    if (armed) {
      // Кнопка увеличивается и пульсирует сильнее
      this.container.setScale(1.22);
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.container,
        scale: { from: 1.22, to: 1.3 },
        duration: 340,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.ring,
        alpha: { from: 1, to: 0.45 },
        duration: 340,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
    } else if (charged) {
      // Лёгкая пульсация полного бара
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.fill,
        alpha: { from: 1, to: 0.78 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
    }

    // --- Лёгкие вспышки ---
    this.setFlashes(armed ? 'strong' : charged ? 'soft' : 'none');
  }

  private stopPulses(): void {
    for (const t of this.pulseTweens) {
      t.stop();
    }
    this.pulseTweens = [];
  }

  /** Свечение вокруг кнопки: концентрические круги с аддитивным блендом */
  private drawGlow(armed: boolean): void {
    const g = this.glow;
    g.clear();
    if (!armed) return;
    const r = this.radius;
    g.fillStyle(COLOR_GLOW, 0.1);
    g.fillCircle(0, 0, r * 1.75);
    g.fillStyle(COLOR_GLOW, 0.18);
    g.fillCircle(0, 0, r * 1.5);
    g.fillStyle(COLOR_GLOW, 0.3);
    g.fillCircle(0, 0, r * 1.28);
    g.fillStyle(0xffffff, 0.22);
    g.fillCircle(0, 0, r * 1.12);
  }

  /** Периодические вспышки из центра кнопки; режим меняется без перезапуска */
  private setFlashes(mode: FlashMode): void {
    if (mode === this.flashMode) return;
    this.stopFlashes();
    this.flashMode = mode;
    if (mode === 'none') return;

    const strong = mode === 'strong';
    this.flashTimer = this.scene.time.addEvent({
      delay: strong ? 850 : 1900,
      loop: true,
      callback: () => { this.emitFlash(strong); }
    });
    this.emitFlash(strong);
  }

  private stopFlashes(): void {
    if (this.flashTimer) {
      this.flashTimer.remove();
      this.flashTimer = null;
    }
    this.flashMode = 'none';
  }

  /** Одна вспышка: мягкий круг разлетается и гаснет.
   *  Масштаб вместо tween radius: сеттер Arc.radius после destroy()
   *  обращается к занулённой геометрии и роняет кадр (Phaser 3.55) */
  private emitFlash(strong: boolean): void {
    const r0 = this.radius * 0.45;
    const flash = this.scene.add.circle(
      0, 0,
      r0,
      strong ? 0xffffff : COLOR_FILL,
      strong ? 0.5 : 0.26
    );
    this.container.add(flash);

    this.scene.tweens.add({
      targets: flash,
      scaleX: strong ? 4.2 : 3.2,
      scaleY: strong ? 4.2 : 3.2,
      alpha: 0,
      duration: strong ? 650 : 900,
      ease: 'Cubic.easeOut',
      onComplete: () => { flash.destroy(); }
    });
  }
}
