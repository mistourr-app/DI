// ============================================================
// EarthBarrierSystem — земля-барьер (Итерация 3).
// Земля = набор ячеек коллизионной сетки с ПОРОЧНОСТЬЮ НА ЯЧЕЙКУ
// (cellHp: bitesPerCell укусов). Монстр, касающийся земли, атакует
// и гибнет, грызя ячейки в радиусе biteRadius: каждая -1 HP.
// Ячейка исчезает (снимается с коллизий), когда HP = 0.
// bitesPerCell — прокачиваемый атрибут: выше = грызут медленнее.
//
// Чистые хелперы ячеек (cellsWithinCircle/cellAt/biteCells)
// тестируются без Phaser.
// Визуал: каждая ячейка — спрайт-точка из общего пула (мягкий круг),
// оттенок темнеет по мере потери HP, при 0 — прячется в пул.
// Нет полной перерисовки Graphics: укус меняет только затронутые
// спрайты, весь барьер — один draw call общей текстуры.
// ============================================================

import Phaser from 'phaser';
import { cellsWithinCircle, cellAt } from './earthCells';
import { DotPool } from '../visuals/dotTexture';

/** Опции инициализации: размеры коллизионной сетки и смещение поля боя */
export interface EarthBarrierOptions {
  cols: number;
  rows: number;
  cellSize: number;
  /** Смещение поля боя: мировые координаты локальной точки (0,0) */
  ox: number;
  oy: number;
  color: number;
}

export class EarthBarrierSystem {
  private opts: EarthBarrierOptions | null = null;
  /** 0 = нет земли, 1..max = осталось укусов */
  private cellHp: Uint8Array | null = null;
  /** Начальное HP каждой ячейки (для темнения: k = hp/max) */
  private cellMax: Uint8Array | null = null;
  /** Публикация изменений в воркер (main подключает setEarth) */
  private onSet: ((cells: Int32Array, value: 0 | 1) => void) | null = null;
  /** Спрайты ячеек: плоский индекс -> Image (только живые ячейки) */
  private sprites = new Map<number, Phaser.GameObjects.Image>();
  private pool: DotPool;
  /** Визуальный радиус ячейки (px, мировой) — как старые круги r=0.72·клетки */
  private cellVisualRadius = 0;

  /** Рендер-глубина земли (под штрихами стихий и дебагом) */
  private static readonly DEPTH = 700;

  constructor(scene: Phaser.Scene) {
    this.pool = new DotPool(scene);
  }

  /** Инициализация под новый уровень (сетка, смещение поля, цвет) */
  init(opts: EarthBarrierOptions, onSet: (cells: Int32Array, value: 0 | 1) => void): void {
    this.clear();
    this.opts = opts;
    this.cellHp = new Uint8Array(opts.cols * opts.rows);
    this.cellMax = new Uint8Array(opts.cols * opts.rows);
    this.onSet = onSet;
    this.cellVisualRadius = opts.cellSize * 0.72;
  }

  /** Растеризация штриха: точки пути ± радиус -> ячейки земли с полным HP.
   *  bitesPerCell берётся живым значением (можно прокачать/изменить в поп-апе). */
  addStroke(points: Array<{ x: number; y: number }>, radiusPx: number, bitesPerCell: number): void {
    if (!this.opts || !this.cellHp || !this.cellMax) return;
    const { cols, rows, cellSize } = this.opts;
    const hp = Math.max(1, Math.min(255, Math.round(bitesPerCell)));
    const toAdd = new Set<number>();
    for (const pt of points) {
      const lx = pt.x - this.opts.ox;
      const ly = pt.y - this.opts.oy;
      const cs = cellsWithinCircle(cols, rows, cellSize, lx, ly, radiusPx);
      for (const c of cs) toAdd.add(c);
    }
    if (toAdd.size === 0) return;
    const arr = Int32Array.from(toAdd);
    for (const c of arr) {
      this.cellHp[c] = hp;
      this.cellMax[c] = hp;
      // Спрайт ячейки: создаём при первом появлении, обновляем оттенок
      this.ensureSprite(c).setTint(this.tintFor(c));
    }
    this.onSet?.(arr, 1);
  }

  /**
   * Одиночный укус (legacy-путь без воркера и тесты): то же, что пакетный.
   */
  biteCellsAround(wx: number, wy: number, radiusPx: number): number {
    return this.biteCellsAroundMany([{ x: wx, y: wy }], 1, radiusPx);
  }

  /**
   * Пакетный укус за кадр: точки атакующих монстров объединяются в ОДИН
   * проход — каждая ячейка теряет ровно столько HP, сколько атакующих
   * попало в её круг в этом кадре (паритет с поштучными укусами).
   * Одна публикация в воркер, обновляются только затронутые спрайты.
   */
  biteCellsAroundMany(
    points: Array<{ x: number; y: number }>,
    count: number,
    radiusPx: number
  ): number {
    if (!this.opts || !this.cellHp || count <= 0) return 0;
    const { cols, rows, cellSize } = this.opts;

    // Ячейка -> сколько атакующих попало в неё за кадр
    const attacks = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const pt = points[i];
      const lx = pt.x - this.opts.ox;
      const ly = pt.y - this.opts.oy;
      const cs = cellsWithinCircle(cols, rows, cellSize, lx, ly, radiusPx);
      for (const c of cs) {
        attacks.set(c, (attacks.get(c) ?? 0) + 1);
      }
    }
    if (attacks.size === 0) return 0;

    let removedCount = 0;
    const removed = new Int32Array(attacks.size);
    for (const [c, dmg] of attacks) {
      if (this.cellHp[c] === 0) continue;
      this.cellHp[c] = this.cellHp[c] > dmg ? this.cellHp[c] - dmg : 0;
      const s = this.sprites.get(c);
      if (this.cellHp[c] === 0) {
        // Разрушена: прячем спрайт, снимаем с коллизий воркера
        if (s) {
          this.pool.release(s);
          this.sprites.delete(c);
        }
        removed[removedCount++] = c;
      } else if (s) {
        s.setTint(this.tintFor(c));
      }
    }
    if (removedCount > 0) {
      this.onSet?.(removed.length === removedCount ? removed : removed.slice(0, removedCount), 0);
    }
    return removedCount;
  }

  /** Земля ли в точке (мировые координаты) */
  hasEarthAt(wx: number, wy: number): boolean {
    if (!this.opts || !this.cellHp) return false;
    const c = cellAt(this.opts.cols, this.opts.rows, this.opts.cellSize, wx - this.opts.ox, wy - this.opts.oy);
    return c >= 0 && this.cellHp[c] > 0;
  }

  /** Касается ли прямоугольник вокруг точки земли (4 угла, мировые координаты) */
  hasEarthAtBox(wx: number, wy: number, r: number): boolean {
    return (
      this.hasEarthAt(wx - r, wy - r) ||
      this.hasEarthAt(wx + r, wy - r) ||
      this.hasEarthAt(wx - r, wy + r) ||
      this.hasEarthAt(wx + r, wy + r)
    );
  }

  /** Число живых ячеек земли (для дебага/смоук-тестов) */
  cellCount(): number {
    if (!this.cellHp) return 0;
    let n = 0;
    for (let i = 0; i < this.cellHp.length; i++) if (this.cellHp[i] > 0) n++;
    return n;
  }

  /** HP ячейки по мировым координатам (для смоук-тестов), 0 = нет земли */
  hpAt(wx: number, wy: number): number {
    if (!this.opts || !this.cellHp) return 0;
    const c = cellAt(this.opts.cols, this.opts.rows, this.opts.cellSize, wx - this.opts.ox, wy - this.opts.oy);
    return c >= 0 ? this.cellHp[c] : 0;
  }

  /** Полная очистка земли (новый уровень / регенерация) */
  clear(): void {
    if (this.cellHp) this.cellHp.fill(0);
    if (this.cellMax) this.cellMax.fill(0);
    for (const s of this.sprites.values()) {
      this.pool.release(s);
    }
    this.sprites.clear();
  }

  destroy(): void {
    this.clear();
    this.pool.destroy();
  }

  /** Спрайт ячейки (создаётся при первом появлении) */
  private ensureSprite(c: number): Phaser.GameObjects.Image {
    let s = this.sprites.get(c);
    if (!s) {
      const o = this.opts!;
      const cx = c % o.cols;
      const cy = (c / o.cols) | 0;
      s = this.pool.obtain(
        o.ox + cx * o.cellSize + o.cellSize / 2,
        o.oy + cy * o.cellSize + o.cellSize / 2,
        this.cellVisualRadius,
        o.color,
        0.9,
        EarthBarrierSystem.DEPTH
      );
      this.sprites.set(c, s);
    }
    return s;
  }

  /** Оттенок по доле оставшегося HP: полный — цвет земли, 1 HP — тёмный */
  private tintFor(c: number): number {
    const o = this.opts!;
    const max = this.cellMax![c] || 1;
    const k = this.cellHp![c] / max;
    const baseR = (o.color >> 16) & 0xff;
    const baseG = (o.color >> 8) & 0xff;
    const baseB = o.color & 0xff;
    const rr = Math.round(baseR * (0.25 + 0.75 * k));
    const gg = Math.round(baseG * (0.25 + 0.75 * k));
    const bb = Math.round(baseB * (0.25 + 0.75 * k));
    return (rr << 16) | (gg << 8) | bb;
  }
}
