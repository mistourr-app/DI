// ============================================================
// GodPowerIcon — круглая иконка супер силы бога в зоне базы
// (ГДД 2.4/2.5): заряд заполняется СНИЗУ ВВЕРХ ярко-розовым
// (маджента) за каждое убийство молниями.
// Состояния:
//   пустой/частичный — чёрный круг, бледная иконка;
//   полный заряд     — заметная пульсация + вспышки-кольца;
//   выбрана (armed)  — кнопка увеличена, иконка максимально
//                      яркая, пульс сильнее, яркое свечение.
//
// ВАЖНО: без Phaser.Container — в 3.55 кастомные пути Graphics
// (beginPath/arc) внутри контейнера не рендерятся в WebGL.
// Все части живут на уровне сцены в одной точке; масштабирование
// armed — твином scale по массиву частей.
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
  private readonly x: number;
  private readonly y: number;
  private readonly radius: number;

  private glow: Phaser.GameObjects.Graphics;
  private bg: Phaser.GameObjects.Arc;
  private fill: Phaser.GameObjects.Graphics;
  private ring: Phaser.GameObjects.Arc;
  private bolt: Phaser.GameObjects.Text;
  private label: Phaser.GameObjects.Text;
  private zone: Phaser.GameObjects.Zone;
  /** Все масштабируемые части кнопки (armed-пульс) */
  private readonly parts: Phaser.GameObjects.GameObject[];

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
    this.x = x;
    this.y = y;
    this.radius = radius;

    // Свечение — под всеми (аддитивный бленд для «света»).
    // Graphics рисуется в ЛОКАЛЬНЫХ координатах вокруг (0,0) и позиционируется
    // в центр иконки: origin у Graphics (0,0), иначе setScale разъезжает контент
    this.glow = scene.add.graphics().setPosition(x, y);
    this.glow.setBlendMode(Phaser.BlendModes.ADD);

    this.bg = scene.add.arc(x, y, radius, 0, TWO_PI, false, COLOR_BG, 1);
    this.bg.setStrokeStyle(2 * UI_SCALE, COLOR_RING_DIM);

    this.fill = scene.add.graphics().setPosition(x, y);

    this.ring = scene.add.arc(x, y, radius).setFillStyle(0, 0);
    this.ring.setStrokeStyle(2 * UI_SCALE, COLOR_RING_DIM);

    this.bolt = scene.add.text(x, y - radius * 0.05, '⚡', {
      font: `${Math.round(radius * 1.0)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5);

    this.parts = [this.glow, this.bg, this.fill, this.ring, this.bolt];

    // Подпись — под кнопкой, не масштабируется
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

    this.drawChargeFill();
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
    this.scene.tweens.killTweensOf(this.parts);
    this.zone.destroy();
    this.label.destroy();
    for (const p of this.parts) {
      (p as Phaser.GameObjects.GameObject).destroy();
    }
  }

  /**
   * Заливка круга НИЖЕ уровня заряда — как жидкость в стаке:
   * чёрный остаётся сверху, маджента наливается снизу вверх.
   * p=0 — пусто, p=1 — полный круг.
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

    // Уровень поверхности: dy = +r (пусто) ... -r (полон)
    const dy = r - 2 * p * r;
    const w = Math.sqrt(Math.max(0, r * r - dy * dy));
    const a = Math.atan2(dy, w);
    g.beginPath();
    g.moveTo(-w, dy);
    g.lineTo(w, dy);
    // Дуга от правого пересечения через НИЗ круга (π/2) к левому
    g.arc(0, 0, r, a, Math.PI - a, false);
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
    this.scene.tweens.killTweensOf(this.parts);
    this.setScale(1);

    if (armed) {
      // Кнопка увеличивается и пульсирует сильнее
      this.setScale(1.22);
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.parts,
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
      // Заметная пульсация полного бара: дыхание альфой + размера
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.fill,
        alpha: { from: 1, to: 0.55 },
        duration: 650,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.parts,
        scale: { from: 1, to: 1.05 },
        duration: 650,
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

  private setScale(s: number): void {
    for (const p of this.parts) {
      (p as Phaser.GameObjects.Shape).setScale(s);
    }
  }

  /** Свечение ВОКРУГ кнопки: толстые кольца с аддитивным блендом.
   *  Кольца, а не диски — иначе аддитив выбеливает сам бар */
  private drawGlow(armed: boolean): void {
    const g = this.glow;
    g.clear();
    if (!armed) return;
    const r = this.radius;
    g.lineStyle(r * 0.3, COLOR_GLOW, 0.32);
    g.strokeCircle(0, 0, r * 1.2);
    g.lineStyle(r * 0.3, COLOR_GLOW, 0.18);
    g.strokeCircle(0, 0, r * 1.5);
    g.lineStyle(r * 0.35, COLOR_GLOW, 0.1);
    g.strokeCircle(0, 0, r * 1.85);
  }

  /** Периодические вспышки из центра кнопки; режим меняется без перезапуска */
  private setFlashes(mode: FlashMode): void {
    if (mode === this.flashMode) return;
    this.stopFlashes();
    this.flashMode = mode;
    if (mode === 'none') return;

    const strong = mode === 'strong';
    this.flashTimer = this.scene.time.addEvent({
      delay: strong ? 850 : 1200,
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

  /** Вспышка излучения из центра кнопки.
   *  soft (полный заряд) — светящееся кольцо расходится за пределы бара;
   *  strong (armed) — яркая белая вспышка-диск.
   *  Масштаб вместо tween radius: сеттер Arc.radius после destroy()
   *  обращается к занулённой геометрии и роняет кадр (Phaser 3.55) */
  private emitFlash(strong: boolean): void {
    const R = this.radius;

    if (!strong) {
      // Расходящееся светящееся кольцо — видно на чёрном фоне вокруг бара
      const ring = this.scene.add.circle(this.x, this.y, R * 0.95, 0xff66ff, 0)
        .setStrokeStyle(3 * UI_SCALE, 0xffaaff, 0.6);
      this.scene.tweens.add({
        targets: ring,
        scaleX: 1.6,
        scaleY: 1.6,
        alpha: 0,
        duration: 750,
        ease: 'Cubic.easeOut',
        onComplete: () => { ring.destroy(); }
      });
      return;
    }

    // Яркая вспышка-кольцо снаружи бара (диск выбеливал бы кнопку)
    const flash = this.scene.add.circle(this.x, this.y, R * 1.02, 0xffffff, 0)
      .setStrokeStyle(4 * UI_SCALE, 0xffffff, 0.75);
    this.scene.tweens.add({
      targets: flash,
      scaleX: 1.9,
      scaleY: 1.9,
      alpha: 0,
      duration: 500,
      ease: 'Cubic.easeOut',
      onComplete: () => { flash.destroy(); }
    });
  }
}
