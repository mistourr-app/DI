// ============================================================
// ElementDrawer — жест рисования стихий (Итерация 1).
// После выбора алтаря (арм) движение пальца по полю боя рисует
// линию толщиной radius в цвет стихии. Линия наносится СРАЗУ
// (без предпросмотра): списание маны идёт в реальном времени
// по длине — costPerUse за каждый юнит (GameConfig.elementStrokeUnit).
//
// Бюджет маны задаётся на beginPotential (floor(mana/costPerUse) юнитов):
// дальше него линия не рисуется — обрыв в точке исчерпания маны.
//
// Препятствия: стихия не рисуется там, где isBlocked(x,y) == true.
//   - начало над препятствием — рисование стартует только вне его;
//   - заход на препятствие во время штриха — жест не сбрасывается,
//     линия продолжается после выхода (на препятствии — пауза);
//   - полностью над препятствием — ничего не рисуется, 0 маны.
//
// Вода/Огонь/Воздух: слой плавно исчезает за duration мс с pointerup.
// Земля: стойкий слой (пока без блокировки; Итерация 2 — барьер).
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE } from '../config/uiScale';
import type { ElementConfig, ElementType } from '../config/GameConfig';

/** Минимальное смещение между точками штриха, доля толщины линии */
const POINT_SPACING_RATIO = 0.5;

/** Минимальное суммарное смещение, чтобы считать жест рисованием, css-px */
const MIN_DRAW_DISTANCE = 12;

export type DrawResult = 'draw' | 'tap' | 'none';

export interface StrokePoint {
  x: number;
  y: number;
}

export class ElementDrawer {
  private scene: Phaser.Scene;
  /** Коллизия в МИРОВЫХ координатах: true — точка на препятствии */
  private isBlocked: (x: number, y: number) => boolean;
  /** Земля-штрих: отдаёт нарисованный путь (сцена превращает его в барьер) */
  private onEarthStroke: ((points: StrokePoint[]) => void) | null;

  private graphics: Phaser.GameObjects.Graphics | null = null;
  private persistentLayers: Phaser.GameObjects.Graphics[] = [];
  /** Точки, реально нарисованные текущим штрихом (для растеризации Земли) */
  private paintedPoints: StrokePoint[] = [];

  private elementKey: ElementType | null = null;
  private cfg: ElementConfig | null = null;
  private startX = 0;
  private startY = 0;
  private lastSampleX = 0;
  private lastSampleY = 0;
  private lastValidX = 0;
  private lastValidY = 0;
  private lastValid = false;
  private drawing = false;
  private stalled = false;
  private drawnDistance = 0;
  private totalPathLen = 0;
  private paintedLen = 0;
  /** Накопленное смещение с момента последней отрисованной точки (px) */
  private pendingLen = 0;
  /** Максимум отрисованной длины: бюджет маны на начало штриха (px) */
  private maxPaintedLen = Infinity;

  constructor(
    scene: Phaser.Scene,
    isBlocked: (x: number, y: number) => boolean,
    onEarthStroke: ((points: StrokePoint[]) => void) | null = null
  ) {
    this.scene = scene;
    this.isBlocked = isBlocked;
    this.onEarthStroke = onEarthStroke;
  }

  /** Идёт ли в данный момент штрих (после beginPotential, до end) */
  get active(): boolean {
    return this.graphics !== null;
  }

  /** Длина пути пальца за последний штрих (px) */
  get totalLength(): number {
    return this.totalPathLen;
  }

  /** Длина нарисованной (валидной) части последнего штриха (px) */
  get paintedLength(): number {
    return this.paintedLen;
  }

  /**
   * Начало потенциального штриха (pointerdown при выбранной стихии).
   * maxPaintedLength — лимит отрисованной длины из бюджета маны (px).
   * Решение «тап или рисование» принимается в end().
   */
  beginPotential(x: number, y: number, key: ElementType, cfg: ElementConfig, maxPaintedLength: number): void {
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
    this.elementKey = key;
    this.cfg = cfg;
    this.startX = x;
    this.startY = y;
    this.lastSampleX = x;
    this.lastSampleY = y;
    this.lastValidX = x;
    this.lastValidY = y;
    this.lastValid = !this.isBlocked(x, y);
    this.drawing = false;
    this.stalled = false;
    this.drawnDistance = 0;
    this.totalPathLen = 0;
    this.paintedLen = 0;
    this.pendingLen = 0;
    this.paintedPoints = [];
    this.maxPaintedLen = maxPaintedLength;
    // Линия наносится сразу финальной альфой (без предпросмотра)
    this.graphics = this.scene.add.graphics();
    this.graphics.setAlpha(0.5).setDepth(800);
  }

  /**
   * Продолжение штриха по pointermove. Мелкие шаги копятся в pendingLen
   * и рисуются одной точкой при достижении толщины линии; точки на
   * препятствиях пропускаются (не рисуются, не в длине).
   */
  onMove(x: number, y: number): void {
    if (!this.graphics || !this.cfg) return;

    const dx = x - this.lastSampleX;
    const dy = y - this.lastSampleY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    this.lastSampleX = x;
    this.lastSampleY = y;
    this.totalPathLen += dist;

    const dd = Math.sqrt((x - this.startX) ** 2 + (y - this.startY) ** 2);
    this.drawnDistance = Math.max(this.drawnDistance, dd);

    // До преодоления порога жест считается тапом: ничего не рисуем
    if (!this.drawing) {
      if (this.drawnDistance < MIN_DRAW_DISTANCE * UI_SCALE) return;
      this.drawing = true;
      // Начало линии от точки касания (если она была вне препятствий)
      if (this.lastValid) {
        this.paintPoint(this.lastValidX, this.lastValidY);
      }
    }

    // Мана закончилась — дальше линия не рисуется
    if (this.stalled) return;

    const valid = !this.isBlocked(x, y);
    if (!valid) {
      // На препятствии: пауза рисования (жест живёт, линия продолжится после)
      this.lastValid = false;
      this.pendingLen = 0;
      return;
    }

    if (!this.lastValid) {
      // Вышли из препятствия / первый валидный образец: точка
      this.paintPoint(x, y);
      this.lastValid = true;
      this.lastValidX = x;
      this.lastValidY = y;
      this.pendingLen = 0;
      return;
    }

    const spacing = Math.max(2, this.cfg.radius * UI_SCALE * POINT_SPACING_RATIO);
    this.pendingLen += dist;
    if (this.pendingLen < spacing) return;

    // Не превышаем бюджет маны: обрыв на границе юнита
    if (this.paintedLen + this.pendingLen > this.maxPaintedLen) {
      const room = this.maxPaintedLen - this.paintedLen;
      if (room > 0) {
        this.paintLine(this.lastValidX, this.lastValidY, x, y, room);
        this.paintedLen += room;
        this.lastValidX = x;
        this.lastValidY = y;
      }
      this.stalled = true;
      this.pendingLen = 0;
      return;
    }

    this.paintLine(this.lastValidX, this.lastValidY, x, y);
    this.paintedLen += this.pendingLen;
    this.lastValidX = x;
    this.lastValidY = y;
    this.pendingLen = 0;
  }

  /**
   * Завершение штриха (pointerup).
   * @returns 'draw' — линия нарисована (сцена завершает слой),
   *          'tap'   — движения не было (сцена кастует молнию),
   *          'none'  — жест был, но нарисовано нечего (всё на препятствиях).
   */
  end(): DrawResult {
    if (!this.graphics || !this.cfg) return 'none';
    const g = this.graphics;
    const key = this.elementKey!;

    if (!this.drawing) {
      // Тап: превью удаляется, сцена решает, что делать
      g.destroy();
      this.graphics = null;
      this.elementKey = null;
      this.cfg = null;
      return 'tap';
    }

    // Дорисовываем «хвост» (не накопленный по порогу), пока мана позволяла
    if (!this.stalled && this.lastValid && this.pendingLen > 0) {
      this.paintLine(this.lastValidX, this.lastValidY, this.lastSampleX, this.lastSampleY);
      this.paintedLen += this.pendingLen;
      this.pendingLen = 0;
    }

    if (this.paintedLen <= 0) {
      // Жест был, но всё на препятствиях: ничего не нарисовано, 0 маны
      g.destroy();
      this.graphics = null;
      this.elementKey = null;
      this.cfg = null;
      return 'none';
    }

    this.graphics = null;

    if (key === 'earth') {
      // Земля-барьер (Итерация 2): путь отдаётся сцене -> EarthBarrierSystem
      // растеризует его в ячейки; полилиния больше не нужна
      const pts = this.paintedPoints;
      if (this.onEarthStroke) {
        g.destroy();
        this.onEarthStroke(pts);
      } else {
        this.persistentLayers.push(g);
      }
    } else {
      // Вода/Огонь/Воздух: плавно исчезает за duration мс с момента отпускания
      const duration = Math.max(1, this.cfg.duration * 1000);
      this.scene.tweens.add({
        targets: g,
        alpha: 0,
        delay: duration * 0.6,
        duration: duration * 0.4,
        onComplete: () => { g.destroy(); }
      });
    }

    this.elementKey = null;
    this.cfg = null;
    return 'draw';
  }

  /** Отмена штриха без коммита (например, увод указателя из зоны) */
  cancel(): void {
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
    this.elementKey = null;
    this.cfg = null;
  }

  /** Уничтожить все стойкие слои (новый уровень / перезапуск) */
  clearPersistent(): void {
    for (const g of this.persistentLayers) {
      g.destroy();
    }
    this.persistentLayers = [];
  }

  destroy(): void {
    this.cancel();
    this.clearPersistent();
  }

  private paintLine(x1: number, y1: number, x2: number, y2: number, len?: number): void {
    const g = this.graphics;
    if (!g || !this.cfg) return;
    const r = this.cfg.radius * UI_SCALE;
    const color = this.cfg.color;
    // Ограничение длины сегмента: тянем часть линии к точке x2,y2
    if (len !== undefined && len >= 0) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0) {
        const k = Math.min(1, len / d);
        x2 = x1 + dx * k;
        y2 = y1 + dy * k;
      }
    }
    g.fillStyle(color, 0.6);
    g.lineStyle(r * 2, color, 0.6);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.strokePath();
    // Капсы: круг на каждой точке, чтобы ломаная выглядела непрерывной
    g.fillCircle(x2, y2, r);
    this.paintedPoints.push({ x: x2, y: y2 });
  }

  private paintPoint(x: number, y: number): void {
    const g = this.graphics;
    if (!g || !this.cfg) return;
    const r = this.cfg.radius * UI_SCALE;
    g.fillStyle(this.cfg.color, 0.6);
    g.fillCircle(x, y, r);
    this.paintedPoints.push({ x, y });
  }
}