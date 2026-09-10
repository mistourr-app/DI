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
// Земля: стойкий слой (Итерация 2 — барьер).
//
// Рендер (оптимизация, Optimisation): вместо Graphics — спрайты-точки
// из общего пула с soft-текстурой (setTint цвета стихии). Весь штрих —
// один draw call, нет перерисовки текстуры каждый кадр во время жеста;
// затухание — один твин по массиву спрайтов, затем возврат в пул.
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE } from '../config/uiScale';
import type { ElementConfig, ElementType } from '../config/GameConfig';
import { DotPool } from '../visuals/dotTexture';

/** Минимальное смещение между точками штриха, доля толщины линии */
const POINT_SPACING_RATIO = 0.5;

/** Минимальное суммарное смещение, чтобы считать жест рисованием, css-px */
const MIN_DRAW_DISTANCE = 12;

/** Альфа спрайтов штриха (паритет с прежней alpha 0.5 у Graphics) */
const STROKE_ALPHA = 0.5;
/** Рендер-глубина штриха (над землёй и полем) */
const STROKE_DEPTH = 800;

export type DrawResult = 'draw' | 'tap' | 'none';

export interface StrokePoint {
  x: number;
  y: number;
}

export class ElementDrawer {
  private scene: Phaser.Scene;
  /** Коллизия в МИРОВЫХ координатах: true — точка на препятствии */
  private isBlocked: (x: number, y: number) => boolean;
  /** Штрих завершён: отдаёт стихию и путь (сцена применяет эффект) */
  private onStroke: ((key: ElementType, points: StrokePoint[]) => void) | null;

  private pool: DotPool;
  private strokeActive = false;
  /** Спрайты-точки текущего штриха */
  private strokeSprites: Phaser.GameObjects.Image[] = [];
  /** Спрайты, доживающие затухание (возврат в пул по завершении твина) */
  private fadingSprites: Phaser.GameObjects.Image[] = [];
  /** Координаты нарисованных точек: [x0,y0,x1,y1,...] для растеризации Земли */
  private paintedPts: number[] = [];

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
    onStroke: ((key: ElementType, points: StrokePoint[]) => void) | null = null
  ) {
    this.scene = scene;
    this.isBlocked = isBlocked;
    this.onStroke = onStroke;
    this.pool = new DotPool(scene);
  }

  /** Идёт ли в данный момент штрих (после beginPotential, до end) */
  get active(): boolean {
    return this.strokeActive;
  }

  /** Длина пути пальца за последний штрих (px) */
  get totalLength(): number {
    return this.totalPathLen;
  }

  /** Длина нарисованной (валидной) части последнего штриха (px) */
  get paintedLength(): number {
    return this.paintedLen;
  }

  /** Число спрайтов-точек активного штриха (для дебаг-панели) */
  get pointCount(): number {
    return this.strokeSprites.length;
  }

  /**
   * Начало потенциального штриха (pointerdown при выбранной стихии).
   * maxPaintedLength — лимит отрисованной длины из бюджета маны (px).
   * Решение «тап или рисование» принимается в end().
   */
  beginPotential(x: number, y: number, key: ElementType, cfg: ElementConfig, maxPaintedLength: number): void {
    if (this.strokeActive) {
      this.cancel();
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
    this.paintedPts = [];
    this.maxPaintedLen = maxPaintedLength;
    // Линия наносится сразу финальной альфой (без предпросмотра)
    this.strokeActive = true;
  }

  /**
   * Продолжение штриха по pointermove. Мелкие шаги копятся в pendingLen
   * и рисуются одной точкой при достижении толщины линии; точки на
   * препятствиях пропускаются (не рисуются, не в длине).
   */
  onMove(x: number, y: number): void {
    if (!this.strokeActive || !this.cfg) return;

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
    if (!this.strokeActive || !this.cfg) return 'none';
    const key = this.elementKey!;
    this.strokeActive = false;

    if (!this.drawing) {
      // Тап: спрайты уже не создавались, возвращаем стейт
      this.resetStroke();
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
      this.pool.releaseAll(this.strokeSprites);
      this.resetStroke();
      return 'none';
    }

    const sprites = this.strokeSprites;
    this.strokeSprites = [];

    if (key === 'earth') {
      // Земля-барьер: спрайты штриха больше не нужны (ячейки рисует сцена)
      this.pool.releaseAll(sprites);
    } else {
      // Вода/Огонь/Воздух: плавно исчезает за duration мс с момента отпускания
      const duration = Math.max(1, this.cfg.duration * 1000);
      this.fadingSprites.push(...sprites);
      this.scene.tweens.add({
        targets: sprites,
        alpha: 0,
        delay: duration * 0.6,
        duration: duration * 0.4,
        onComplete: () => {
          const first = sprites[0];
          const n = sprites.length;
          this.pool.releaseAll(sprites);
          const start = first ? this.fadingSprites.indexOf(first) : -1;
          if (start >= 0) {
            this.fadingSprites.splice(start, n);
          }
        }
      });
    }

    // Сцена применяет эффект стихии (Земля -> барьер, прочие -> эффекты)
    const flat = this.paintedPts;
    const pts: StrokePoint[] = new Array(flat.length / 2);
    for (let i = 0, j = 0; i < flat.length; i += 2, j++) {
      pts[j] = { x: flat[i], y: flat[i + 1] };
    }
    if (this.onStroke) {
      this.onStroke(key, pts);
    }

    this.resetStroke();
    return 'draw';
  }

  /** Отмена штриха без коммита (например, увод указателя из зоны) */
  cancel(): void {
    if (this.strokeActive) {
      this.strokeActive = false;
      this.pool.releaseAll(this.strokeSprites);
    }
    this.resetStroke();
  }

  /**
   * Очистить стойкие слои (новый уровень / перезапуск).
   * Спрайты штриха живут только во время жеста/затухания, земля —
   * в EarthBarrierSystem (пересоздаётся на generateLevel) — метод
   * сохранён для совместимости API, ничего не делает.
   */
  clearPersistent(): void {
    // no-op
  }

  destroy(): void {
    this.cancel();
    this.scene.tweens.killTweensOf(this.fadingSprites);
    this.pool.releaseAll(this.fadingSprites);
    this.pool.destroy();
  }

  /** Сброс состояния после завершения штриха */
  private resetStroke(): void {
    this.elementKey = null;
    this.cfg = null;
    this.drawing = false;
    this.stalled = false;
    this.paintedLen = 0;
    this.pendingLen = 0;
    this.paintedPts = [];
    this.maxPaintedLen = Infinity;
  }

  /** Точка: один спрайт-«капс» в цвет стихии */
  private paintPoint(x: number, y: number): void {
    if (!this.cfg) return;
    const r = this.cfg.radius * UI_SCALE;
    const s = this.pool.obtain(x, y, r, this.cfg.color, STROKE_ALPHA, STROKE_DEPTH);
    this.strokeSprites.push(s);
    this.paintedPts.push(x, y);
  }

  /** Отрезок: цепочка точек с шагом ~половина толщины (непрерывная линия) */
  private paintLine(x1: number, y1: number, x2: number, y2: number, len?: number): void {
    const cfg = this.cfg;
    if (!cfg) return;
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
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0) return;
    const r = cfg.radius * UI_SCALE;
    const spacing = Math.max(2, r * POINT_SPACING_RATIO);
    const steps = Math.max(1, Math.round(d / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.paintPoint(x1 + dx * t, y1 + dy * t);
    }
  }
}
