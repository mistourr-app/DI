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
// Визуал: каждая ячейка — перекрывающийся круг r≈0.72·клетки,
// темнеет по мере потери HP и исчезает при 0.
// ============================================================

import Phaser from 'phaser';
import { cellsWithinCircle, cellAt, biteCells } from './earthCells';

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
  private scene: Phaser.Scene;
  private opts: EarthBarrierOptions | null = null;
  /** 0 = нет земли, 1..max = осталось укусов */
  private cellHp: Uint8Array | null = null;
  /** Начальное HP каждой ячейки (для темнения: k = hp/max) */
  private cellMax: Uint8Array | null = null;
  private graphics: Phaser.GameObjects.Graphics | null = null;
  /** Публикация изменений в воркер (main подключает setEarth) */
  private onSet: ((cells: Int32Array, value: 0 | 1) => void) | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Инициализация под новый уровень (сетка, смещение поля, цвет) */
  init(opts: EarthBarrierOptions, onSet: (cells: Int32Array, value: 0 | 1) => void): void {
    this.opts = opts;
    this.cellHp = new Uint8Array(opts.cols * opts.rows);
    this.cellMax = new Uint8Array(opts.cols * opts.rows);
    this.onSet = onSet;
    if (this.graphics) {
      this.graphics.destroy();
    }
    this.graphics = this.scene.add.graphics();
    this.graphics.setDepth(700);
    this.render();
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
    }
    this.onSet?.(arr, 1);
    this.render();
  }

  /**
   * Укус монстра: ячейки в радиусе теряют 1 HP; разрушенные (HP=0)
   * снимаются с коллизий воркера. Возвращает число разрушенных ячеек.
   */
  biteCellsAround(wx: number, wy: number, radiusPx: number): number {
    if (!this.opts || !this.cellHp) return 0;
    const lx = wx - this.opts.ox;
    const ly = wy - this.opts.oy;
    const cs = cellsWithinCircle(this.opts.cols, this.opts.rows, this.opts.cellSize, lx, ly, radiusPx);
    const removed = biteCells(this.cellHp, cs);
    if (removed.length === 0) return 0;
    this.onSet?.(Int32Array.from(removed), 0);
    this.render();
    return removed.length;
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
    if (this.graphics) this.graphics.clear();
  }

  destroy(): void {
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
  }

  private render(): void {
    const g = this.graphics;
    if (!g || !this.opts || !this.cellHp || !this.cellMax) return;
    g.clear();
    const { cols, rows, cellSize, ox, oy, color } = this.opts;
    const r = cellSize * 0.72;
    // Тёмная база цвета земли для плавного затемнения по мере укусов
    const baseR = (color >> 16) & 0xff;
    const baseG = (color >> 8) & 0xff;
    const baseB = color & 0xff;
    const darkR = Math.round(baseR * 0.25);
    const darkG = Math.round(baseG * 0.25);
    const darkB = Math.round(baseB * 0.25);

    for (let cy = 0; cy < rows; cy++) {
      const rowBase = cy * cols;
      for (let cx = 0; cx < cols; cx++) {
        const hp = this.cellHp[rowBase + cx];
        if (hp === 0) continue;
        // Полный HP — цвет земли; 1 HP — тёмный (почти разрушена)
        const max = this.cellMax[rowBase + cx] || 1;
        const k = hp / max;
        const rr = Math.round(darkR + (baseR - darkR) * k);
        const gg = Math.round(darkG + (baseG - darkG) * k);
        const bb = Math.round(darkB + (baseB - darkB) * k);
        g.fillStyle((rr << 16) | (gg << 8) | bb, 0.9);
        g.fillCircle(ox + cx * cellSize + cellSize / 2, oy + cy * cellSize + cellSize / 2, r);
      }
    }
  }
}