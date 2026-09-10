// ============================================================
// ElementEffectSystem — базовые эффекты стихий (Итерация 4).
// Огонь/Вода/Воздух: зона штриха растеризуется в ячейки коллизионной
// сетки (как Земля), эффект применяется к монстрам:
//   - Огонь  — статус «Горение»: горит burnDuration сек -> смерть;
//              при смерти поджигает соседей (шанс spreadChance, лимит
//              maxIgnitePerDeath) — ограниченное цепное выгорание;
//   - Вода   — статус «Мокрый»: замедление применяет ВОРКЕР (slowFactor),
//              здесь только подсветка (синий) + тушение НЕ делаем (комбинации
//              позже); wetDuration — сколько статус держится после выхода;
//   - Воздух — отброс применяет ВОРКЕР (airPushStrength по направлению
//              жеста), здесь только хранение оверлея для воркера.
//
// Статусы рисуются на самом монстре через перекраску (tint, §3.7):
// дефолт — красный, горение — оранжевый, мокрый — синий. setTint
// вызывается ТОЛЬКО при смене статуса (нет перекраски в каждом кадре).
//
// Оверлеи (fire/water/air) — счётчики на ячейку (refcount): два штриха
// могут перекрываться, ячейка гаснет, только когда её покинули ВСЕ.
// ============================================================

import Phaser from 'phaser';
import { UI_SCALE } from '../config/uiScale';
import { GameConfig, type ElementType } from '../config/GameConfig';
import { cellsWithinCircle } from './earthCells';
import { applyStatus, igniteNeighbors, tintFor, lerpColor, type EffectConfig } from './effectsCore';

/** Опции инициализации: сетка уровня + смещение поля боя */
export interface ElementEffectOptions {
  cols: number;
  rows: number;
  cellSize: number;
  /** Смещение поля боя: мировые координаты локальной точки (0,0) */
  ox: number;
  oy: number;
}

/** Публикация эффектов-физики в воркер (main подключает setEffects) */
export type PublishEffects = (
  effect: 'water' | 'air',
  cells: Int32Array,
  value: 0 | 1,
  dirX?: number,
  dirY?: number
) => void;

/** Хост: группа врагов + убийство (GameScene подключает) */
export interface ElementEffectHost {
  enemies: Phaser.GameObjects.Group;
  killEnemy: (enemy: any) => void;
}

/** Одна нарисованная зона (штрих) */
interface Zone {
  element: ElementType;
  cells: Int32Array;
  dirX: number;
  dirY: number;
  expiresAt: number;
}

export class ElementEffectSystem {
  private opts: ElementEffectOptions | null = null;
  private onPublish: PublishEffects | null = null;
  private host: ElementEffectHost | null = null;

  /** Счётчики ячеек по эффектам (0 = нет эффекта) */
  private fireCount: Uint16Array | null = null;
  private waterCount: Uint16Array | null = null;
  private airCount: Uint16Array | null = null;
  private airDirX: Float32Array | null = null;
  private airDirY: Float32Array | null = null;

  private zones: Zone[] = [];

  constructor() {}

  /** Инициализация под новый уровень */
  init(opts: ElementEffectOptions, onPublish: PublishEffects, host: ElementEffectHost): void {
    this.clear();
    this.opts = opts;
    this.onPublish = onPublish;
    this.host = host;
    const n = opts.cols * opts.rows;
    this.fireCount = new Uint16Array(n);
    this.waterCount = new Uint16Array(n);
    this.airCount = new Uint16Array(n);
    this.airDirX = new Float32Array(n);
    this.airDirY = new Float32Array(n);
  }

  /**
   * Добавить зону от штриха (мировые координаты). Для воздуха direction —
   * вектор жеста (нормализованный). Зона гаснет через duration (из конфига).
   */
  addStroke(points: Array<{ x: number; y: number }>, element: ElementType, direction: { x: number; y: number }): void {
    if (!this.opts || !this.onPublish) return;
    const cfg = GameConfig.elements[element];
    const { cols, rows, cellSize } = this.opts;
    const radiusPx = cfg.radius * UI_SCALE;

    // Растеризация: уникальные ячейки всех точек штриха
    const cells = new Set<number>();
    for (const pt of points) {
      const lx = pt.x - this.opts.ox;
      const ly = pt.y - this.opts.oy;
      const cs = cellsWithinCircle(cols, rows, cellSize, lx, ly, radiusPx);
      for (const c of cs) cells.add(c);
    }
    if (cells.size === 0) return;
    const arr = Int32Array.from(cells);

    // Увеличение счётчиков; собрать ячейки, впервые включённые (для воркера).
    // fireCount растёт ТОЛЬКО от огня — вода/воздух не должны помечать
    // ячейки как огонь (иначе монстры в воде/ветре загорались бы)
    let waterNew: number[] | null = null;
    let airNew: number[] | null = null;
    for (const c of arr) {
      if (element === 'fire' && this.fireCount![c] < 65535) this.fireCount![c]++;
      if (element === 'water' && this.waterCount![c] < 65535) {
        if (this.waterCount![c]++ === 0) (waterNew ??= []).push(c);
      }
      if (element === 'air' && this.airCount![c] < 65535) {
        if (this.airCount![c]++ === 0) {
          this.airDirX![c] = direction.x;
          this.airDirY![c] = direction.y;
          (airNew ??= []).push(c);
        }
      }
    }
    if (element === 'water' && waterNew && waterNew.length > 0) {
      this.onPublish('water', Int32Array.from(waterNew), 1);
    }
    if (element === 'air' && airNew && airNew.length > 0) {
      this.onPublish('air', Int32Array.from(airNew), 1, direction.x, direction.y);
    }

    const duration = (cfg.duration ?? 0) * 1000;
    this.zones.push({
      element,
      cells: arr,
      dirX: direction.x,
      dirY: direction.y,
      expiresAt: performance.now() + duration
    });
  }

  /** Параметры эффектов из конфига (в мировых единицах) */
  private effectConfig(): EffectConfig {
    const f = GameConfig.elements.fire;
    const w = GameConfig.elements.water;
    const a = GameConfig.elements.air;
    return {
      burnDurationMs: (f.burnDuration ?? 2) * 1000,
      burnRadiusPx: (f.burnRadius ?? 40) * UI_SCALE,
      spreadChance: f.spreadChance ?? 0.2,
      maxIgnitePerDeath: f.maxIgnitePerDeath ?? 2,
      wetDurationMs: (w.wetDuration ?? 5) * 1000,
      airDurationMs: (a.airDuration ?? 5) * 1000
    };
  }

  /**
   * Проход статусов (троттлится на сцене ~10 Гц). Обновляет горение/мокрый
   * tint каждого активного врага, убивает сгоревших и поджигает соседей.
   * Логика решения вынесена в чистое ядро effectsCore (тестируется в jest).
   */
  tickStatuses(now: number): void {
    if (!this.host) return;
    const cfg = this.effectConfig();
    const children = this.host.enemies.getChildren() as any[];
    const deaths: any[] = [];

    for (let i = 0; i < children.length; i++) {
      const e = children[i];
      if (!e.active) continue;

      const kind = applyStatus(
        e,
        now,
        cfg,
        (x, y) => this.isFireAt(x, y),
        (x, y) => this.waterAt(x, y),
        (x, y) => this.airAt(x, y) !== null
      );

      if (kind === 'burn_death') {
        // Сгорание: убрать статус, отдать в цепной поджог и на смерть
        e.setTint(tintFor('none'));
        e.statusTint = tintFor('none');
        deaths.push(e);
        continue;
      }

      // Tint: горение — резко (жёлтый), мокрый/сдутый — плавно к красному
      // по остатку длительности (эффект «ослабевает», а не обрывается)
      let tint: number;
      if (kind === 'burn') {
        tint = tintFor('burn');
      } else if (kind === 'blown') {
        const frac = Math.min(1, Math.max(0, (e.airUntil - now) / cfg.airDurationMs));
        tint = lerpColor(tintFor('none'), tintFor('blown'), frac);
      } else if (kind === 'wet') {
        const frac = Math.min(1, Math.max(0, (e.wetUntil - now) / cfg.wetDurationMs));
        tint = lerpColor(tintFor('none'), tintFor('wet'), frac);
      } else {
        tint = tintFor('none');
      }
      if (tint !== e.statusTint) {
        e.setTint(tint);
        e.statusTint = tint;
      }
    }

    // Цепной поджог + смерть сгоревших (вне основного цикла — killEnemy
    // мутирует группу). Сгоревший исключается из поджога (не поджигаем
    // заново источник)
    for (const e of deaths) {
      igniteNeighbors(e.x, e.y, children, cfg, now, undefined, e);
      this.host.killEnemy(e);
    }
  }

  /**
   * Истечение зон (каждый кадр, дёшево): снимает счётчики, публикует
   * выключение эффектов, когда ячейку покинули все штрихи.
   */
  update(now: number): void {
    if (!this.opts) return;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      if (z.expiresAt > now) continue;
      this.zones.splice(i, 1);
      this.decrementZone(z);
    }
  }

  /** Снятие счётчиков одной зоны + публикация выключения */
  private decrementZone(z: Zone): void {
    if (!this.onPublish) return;
    let waterOff: number[] | null = null;
    let airOff: number[] | null = null;
    for (const c of z.cells) {
      if (z.element === 'fire' && this.fireCount && this.fireCount[c] > 0) {
        this.fireCount[c]--;
      }
      if (z.element === 'water' && this.waterCount && this.waterCount[c] > 0) {
        if (--this.waterCount[c] === 0) (waterOff ??= []).push(c);
      }
      if (z.element === 'air' && this.airCount && this.airCount[c] > 0) {
        if (--this.airCount[c] === 0) {
          this.airDirX![c] = 0;
          this.airDirY![c] = 0;
          (airOff ??= []).push(c);
        }
      }
    }
    if (waterOff && waterOff.length > 0) this.onPublish('water', Int32Array.from(waterOff), 0);
    if (airOff && airOff.length > 0) this.onPublish('air', Int32Array.from(airOff), 0);
  }

  /** Число активных зон (для дебага/смоук-тестов) */
  zoneCount(): number {
    return this.zones.length;
  }

  /** Огонь ли в точке (мировые координаты) */
  isFireAt(wx: number, wy: number): boolean {
    const c = this.cellIndex(wx, wy);
    return c >= 0 && this.fireCount![c] > 0;
  }

  /** Вода ли в точке (мировые координаты) */
  waterAt(wx: number, wy: number): boolean {
    const c = this.cellIndex(wx, wy);
    return c >= 0 && this.waterCount![c] > 0;
  }

  /** Направление воздуха в точке или null (мировые координаты) */
  airAt(wx: number, wy: number): { x: number; y: number } | null {
    const c = this.cellIndex(wx, wy);
    if (c < 0 || !this.airCount || this.airCount[c] === 0) return null;
    return { x: this.airDirX![c], y: this.airDirY![c] };
  }

  private cellIndex(wx: number, wy: number): number {
    if (!this.opts) return -1;
    const cx = Math.floor((wx - this.opts.ox) / this.opts.cellSize);
    const cy = Math.floor((wy - this.opts.oy) / this.opts.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.opts.cols || cy >= this.opts.rows) return -1;
    return cy * this.opts.cols + cx;
  }

  /** Сброс всех зон и оверлеев (новый уровень / регенерация) */
  clear(): void {
    this.zones = [];
    if (this.fireCount) this.fireCount.fill(0);
    if (this.waterCount) this.waterCount.fill(0);
    if (this.airCount) this.airCount.fill(0);
    if (this.airDirX) this.airDirX.fill(0);
    if (this.airDirY) this.airDirY.fill(0);
  }

  destroy(): void {
    this.clear();
    this.opts = null;
    this.onPublish = null;
    this.host = null;
  }
}
