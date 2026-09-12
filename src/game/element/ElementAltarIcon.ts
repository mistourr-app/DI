// ============================================================
// ElementAltarIcon — алтарь стихии в зоне базы (Итерация 1).
// Заполнение по аналогии с GodPowerIcon: круг чёрный полупрозрачный, заряд
// наливается СНИЗУ ВВЕРХ цветом САМОЙ стихии (не маджента).
// Состояния:
//   частичный — полупрозрачный чёрный круг + сегмент-заливка цвета стихии;
//   достаточно маны (canUse) — иконка яркая, кольцо цветом стихии;
//   не хватает — иконка и кольцо затемнены (alpha 0.35);
//   полный    — лёгкая пульсация заливки;
//   выбран    — белое кольцо, кнопка увеличена, пульс сильнее.
//
// Без Phaser.Container (грабли 3.55, см. GOD_POWER.md §6.7):
// все части на уровне сцены в одной точке, масштаб — твином scale.
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE } from '../config/uiScale';
import type { ElementType } from '../config/GameConfig';

const COLOR_BG = 0x000000; // фон под иконкой — чёрный ПОЛУПРОЗРАЧНЫЙ
// Альфа фона: святая земля базы просвечивает сквозь диск (фон не сплошная
// заглушка, а мягкая тёмная подложка под иконку и заливку)
const BG_ALPHA = 0.5;

export interface ElementAltarOptions {
  key: ElementType;
  emoji: string;
  /** Цвет стихии: и кольцо, и заливка бара */
  color: number;
  /** Заполнение 0..1 (мана алтаря / ёмкость) */
  getProgress: () => number;
  /** Хватает ли маны на один штрих (иконка яркая/затемнена) */
  canUse: () => boolean;
  /** Выбрана ли стихия для рисования */
  isSelected: () => boolean;
  /** Тап по алтарю: выбрать/снять */
  onToggle: () => void;
}

export class ElementAltarIcon {
  private readonly scene: Phaser.Scene;
  private readonly opts: ElementAltarOptions;
  private readonly radius: number;

  private bg: Phaser.GameObjects.Arc;
  private fill: Phaser.GameObjects.Graphics;
  private ring: Phaser.GameObjects.Arc;
  private emoji: Phaser.GameObjects.Text;
  private zone: Phaser.GameObjects.Zone;
  /** Все масштабируемые части кнопки (пульс выбранного) */
  private readonly parts: Phaser.GameObjects.GameObject[];

  private pulseTweens: Phaser.Tweens.Tween[] = [];

  constructor(scene: Phaser.Scene, x: number, y: number, radius: number, opts: ElementAltarOptions) {
    this.scene = scene;
    this.opts = opts;
    this.radius = radius;

    // Чёрный ПОЛУПРОЗРАЧНЫЙ круг под иконкой и заливкой, ПОДТВЕРЖДЕНО: при
    // включённом fade заливка и эмодзи читаются поверх тёмной подложки, а
    // зелёная земля базы мягко просвечивает сквозь неё. Создаётся раньше
    // остальных частей — на глубине под ними.
    this.bg = scene.add.circle(x, y, radius, COLOR_BG, BG_ALPHA);

    // Заливка рисуется в ЛОКАЛЬНЫХ координатах вокруг (0,0),
    // Graphics позиционируется в центр — иначе setScale разъезжает контент
    this.fill = scene.add.graphics().setPosition(x, y);

    this.ring = scene.add.circle(x, y, radius, 0x000000, 0);

    this.emoji = scene.add.text(x, y, opts.emoji, {
      font: `${Math.round(radius * 0.9)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5);

    this.parts = [this.bg, this.fill, this.ring, this.emoji];

    // Зона тапа чуть больше иконки — палец не должен попадать мимо
    this.zone = scene.add.zone(x, y, radius * 3.2, radius * 3.2)
      .setInteractive({ useHandCursor: true });
    this.zone.on('pointerdown', opts.onToggle);

    this.drawFill();
    this.refreshState();
  }

  /** Перерисовка заливки и состояний (после каждого изменения маны) */
  redraw(): void {
    this.drawFill();
    this.refreshState();
  }

  destroy(): void {
    this.stopPulses();
    this.scene.tweens.killTweensOf(this.parts);
    this.zone.destroy();
    for (const p of this.parts) {
      (p as Phaser.GameObjects.GameObject).destroy();
    }
  }

  /** Заливка круга НИЖЕ уровня заряда — как жидкость в стаке:
   *  чёрный сверху, цвет стихии наливается снизу вверх. p=1 — полный круг */
  private drawFill(): void {
    const g = this.fill;
    const r = Math.max(0, this.radius - 2 * UI_SCALE);
    g.clear();
    const p = this.opts.getProgress();
    if (p <= 0 || r <= 0) return;

    g.fillStyle(this.opts.color, 1);
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
    const sel = this.opts.isSelected();
    const ready = this.opts.canUse();
    const full = this.opts.getProgress() >= 1;

    // --- Иконка: яркая, если выбрана ИЛИ хватает маны; иначе затемнена
    // (независимо от степени заполнения бара) ---
    const lit = sel || ready;
    this.emoji.setAlpha(lit ? 1 : 0.35);

    // --- Кольцо: выбранное — белое, доступное — цвет стихии, иначе тусклое ---
    const ringColor = sel ? 0xffffff : ready ? this.opts.color : 0xffffff;
    const ringWidth = (sel ? 3 : 2) * UI_SCALE;
    this.ring.setStrokeStyle(ringWidth, ringColor);
    this.ring.setAlpha(lit ? 1 : 0.35);

    // --- Пульс и масштаб ---
    this.stopPulses();
    this.scene.tweens.killTweensOf(this.parts);
    this.setScale(1);

    if (sel) {
      // Выбранная: кнопка увеличена и пульсирует сильнее
      this.setScale(1.12);
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.parts,
        scale: { from: 1.12, to: 1.2 },
        duration: 340,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
    } else if (full) {
      // Полная мана: лёгкое дыхание заливки
      this.pulseTweens.push(this.scene.tweens.add({
        targets: this.fill,
        alpha: { from: 1, to: 0.6 },
        duration: 650,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      }));
    }
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
}