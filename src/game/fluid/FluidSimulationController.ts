// ============================================================
// FluidSimulationController — main-thread обёртка над FluidWorker.
// Владеет пулом transferable-буферов (ping-pong), протоколом и
// fallback-режимом (если Worker недоступен — физика остаётся на main).
// Все координаты в API — ЛОКАЛЬНЫЕ относительно поля боя.
// ============================================================

import {
  MAX_AGENTS,
  OUT_STRIDE,
  type CollisionField,
  type FluidParams,
  type WorkerResponse
} from './fluidProtocol';

/** Размер пула буферов (1 в полёте + запас) */
const POOL_SIZE = 3;

interface BufferTriple {
  data: ArrayBuffer;
  arrived: ArrayBuffer;
  attacks: ArrayBuffer;
}

export interface FrameInfo {
  count: number;
  arrivedCount: number;
  /** Float32Array(OUT_STRIDE * count): [id, x, y]... */
  data: Float32Array;
  /** Int32Array(arrivedCount): id агентов, достигших базы */
  arrived: Int32Array;
  /** Int32Array(attackCount): id агентов, атакующих землю (Итерация 2) */
  attackIds: Int32Array;
  attackCount: number;
  stepMs: number;
}

export class FluidSimulationController {
  // НЕ readonly: при ошибке воркера в рантайме переключаемся на fallback
  isWorkerMode: boolean;
  private worker: Worker | null = null;

  private bufferPool: BufferTriple[] = [];
  private inFlight = false;
  private ready = false;
  /** Выданные id без возврата; после прибытия/удаления id переиспользуется */
  private freeIds: number[] = [];
  private idsIssued = 0;

  /** Вызывается на каждый кадр симуляции (после 'frame' от воркера) */
  onFrame: ((info: FrameInfo) => void) | null = null;

  constructor() {
    this.isWorkerMode = typeof Worker !== 'undefined';

    if (this.isWorkerMode) {
      try {
        this.worker = new Worker(new URL('./FluidWorker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data as WorkerResponse);
        this.worker.onerror = () => {
          // Воркер упал — переходим на legacy-путь main-потока
          console.error('FluidWorker error: falling back to main-thread physics');
          this.isWorkerMode = false;
          this.inFlight = false;
        };
      } catch {
        console.warn('FluidWorker unavailable: falling back to main-thread physics');
        this.isWorkerMode = false;
      }
    }

    if (this.isWorkerMode) {
      for (let i = 0; i < POOL_SIZE; i++) {
        this.bufferPool.push({
          data: new Float32Array(MAX_AGENTS * OUT_STRIDE).buffer,
          arrived: new Int32Array(MAX_AGENTS).buffer,
          attacks: new Int32Array(MAX_AGENTS).buffer
        });
      }
    }
  }

  /** Инициализация мира. Координаты локальные. */
  init(width: number, height: number, baseX: number, baseY: number, params: FluidParams): void {
    if (!this.isWorkerMode) return;
    this.post({
      type: 'init',
      width,
      height,
      baseX,
      baseY,
      maxAgents: MAX_AGENTS,
      params
    });
  }

  /** Передаёт копию коллизионной сетки уровня (transferable) */
  setField(field: CollisionField): void {
    if (!this.isWorkerMode) return;
    const blockedCopy = field.blocked.slice(); // НЕ transfer оригинал уровня!
    this.post(
      {
        type: 'set_level',
        cols: field.cols,
        rows: field.rows,
        cellSize: field.cellSize,
        blocked: blockedCopy.buffer,
        widthPx: field.widthPx
      },
      [blockedCopy.buffer]
    );
  }

  /**
   * Регистрирует агента. Возвращает id (или -1, если лимит исчерпан /
   * fallback). Id переиспользуются: без этого после MAX_AGENTS суммарных
   * спавнов новые монстры переставали регистрироваться в физике.
   */
  addAgent(x: number, y: number, vx: number, vy: number, radius: number): number {
    if (!this.isWorkerMode) return -1;
    let id: number;
    if (this.freeIds.length > 0) {
      id = this.freeIds.pop()!;
    } else if (this.idsIssued < MAX_AGENTS) {
      id = this.idsIssued++;
    } else {
      return -1;
    }
    this.post({ type: 'add', id, x, y, vx, vy, radius });
    return id;
  }

  removeAgent(id: number): void {
    if (!this.isWorkerMode || id < 0) return;
    this.post({ type: 'remove', id });
    this.freeIds.push(id);
  }

  /**
   * Полный сброс физики толпы (смена уровня): воркер очищает все слоты
   * агентов, main обнуляет пул id — состояние обеих сторон становится
   * консистентным с нуля. Вызовется до отправки нового set_level/add.
   */
  resetAll(): void {
    if (!this.isWorkerMode) return;
    this.post({ type: 'reset_agents' });
    this.freeIds = [];
    this.idsIssued = 0;
  }

  setParams(params: FluidParams): void {
    if (!this.isWorkerMode) return;
    this.post({ type: 'params', params });
  }

  /**
   * Добавить/убрать ячейки земли-барьера (Итерация 2).
   * cells — плоские индексы ячеек коллизионной сетки (передаются transferable).
   */
  setEarth(cells: Int32Array, value: 0 | 1): void {
    if (!this.isWorkerMode || cells.length === 0) return;
    this.post({ type: 'set_earth', cells: cells.buffer, value }, [cells.buffer]);
  }

  /**
   * Добавить/убрать эффект стихии-физики (Итерация 4): вода — замедление,
   * воздух — отброс в направлении dirX/dirY. cells — плоские индексы ячеек.
   */
  setEffects(
    effect: 'water' | 'air',
    cells: Int32Array,
    value: 0 | 1,
    dirX?: number,
    dirY?: number
  ): void {
    if (!this.isWorkerMode || cells.length === 0) return;
    this.post(
      { type: 'set_effects', effect, cells: cells.buffer, value, dirX, dirY },
      [cells.buffer]
    );
  }

  /**
   * Вызывается каждый кадр сцены. Отправляет 'step' только когда
   * предыдущий кадр обработан и есть свободный буфер.
   * @param dt дельта кадра в секундах
   */
  update(dt: number): void {
    if (!this.isWorkerMode || !this.ready || this.inFlight) return;
    const buf = this.bufferPool.pop();
    if (!buf) return;

    this.inFlight = true;
    this.post({ type: 'step', dt, outData: buf.data, outArrived: buf.arrived, outAttacks: buf.attacks }, [
      buf.data,
      buf.arrived,
      buf.attacks
    ]);
  }

  destroy(): void {
    this.onFrame = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isWorkerMode = false;
    this.ready = false;
    this.freeIds = [];
    this.idsIssued = 0;
  }

  private post(msg: unknown, transfer?: Transferable[]): void {
    if (this.worker) {
      this.worker.postMessage(msg, transfer ?? []);
    }
  }

  private handleMessage(resp: WorkerResponse): void {
    switch (resp.type) {
      case 'ready': {
        this.ready = true;
        break;
      }
      case 'frame': {
        this.inFlight = false;
        const info: FrameInfo = {
          count: resp.count,
          arrivedCount: resp.arrivedCount,
          data: new Float32Array(resp.data),
          arrived: new Int32Array(resp.arrived),
          attackIds: new Int32Array(resp.attacks),
          attackCount: resp.attackCount,
          stepMs: resp.stepMs
        };
        // Буферы возвращаются в пул для следующего шага
        this.bufferPool.push({ data: resp.data, arrived: resp.arrived, attacks: resp.attacks });

        if (this.onFrame) {
          this.onFrame(info);
        }
        // Id прибывших возвращаются в пул для новых агентов
        for (let a = 0; a < info.arrivedCount; a++) {
          this.freeIds.push(info.arrived[a]);
        }
        break;
      }
    }
  }
}
