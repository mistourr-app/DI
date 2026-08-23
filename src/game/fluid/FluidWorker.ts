// ============================================================
// FluidWorker — выделенный воркер физики толпы.
// Состояние симуляции живёт здесь постоянно (SoA-массивы).
// Координаты: ЛОКАЛЬНЫЕ относительно поля боя (0..width, 0..height).
// ============================================================

import {
  MAX_AGENTS,
  SUBSTEP_DT,
  MAX_SUBSTEPS,
  OUT_STRIDE,
  FLUID_TUNING,
  defaultFluidParams,
  SpatialGrid,
  fluidDisplacement,
  type FluidParams,
  type CollisionField,
  type WorkerCommand,
  type FrameMsg,
  type FluidWorld,
  type DispOut,
  blockedAt,
  isBoxBlocked,
  moveDownStep
} from './fluidProtocol';

// --- Типизация worker-контекста без отдельной lib ---
const ctx = self as unknown as {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

// --- SoA-состояние агентов ---
const px = new Float32Array(MAX_AGENTS);
const py = new Float32Array(MAX_AGENTS);
const vx = new Float32Array(MAX_AGENTS);
const vy = new Float32Array(MAX_AGENTS);
const rad = new Float32Array(MAX_AGENTS);
const alive = new Uint8Array(MAX_AGENTS);

/** slot -> agentId (-1 = слот свободен) */
const idOfSlot = new Int32Array(MAX_AGENTS).fill(-1);
/** agentId -> slot (-1 = нет) */
const indexOfId = new Int32Array(MAX_AGENTS).fill(-1);
/** стек свободных слотов */
const freeList = new Int32Array(MAX_AGENTS);
let freeTop = 0;

for (let s = MAX_AGENTS - 1; s >= 0; s--) {
  freeList[freeTop++] = s;
}

// --- Конфигурация ---
let field: CollisionField | null = null;
let worldW = 0;
let worldH = 0;
let params: FluidParams = defaultFluidParams();
let accumulator = 0;
let readySent = false;

/** Выбранная сторона обхода препятствия на агента (-1/0/1) */
const avoidDir = new Int32Array(MAX_AGENTS);
/** Подряд закрытые горизонтальные ходы (триггер «всплытия») */
const avoidFail = new Int32Array(MAX_AGENTS);
/** Остаток бюджета спасательного бокового дрейфа */
const avoidSweep = new Int32Array(MAX_AGENTS);
/** Подшаги свободной вертикали подряд в полёте (подтверждение просвета) */
const avoidHover = new Int32Array(MAX_AGENTS);

/**
 * Фейлсейф: агент без прогресса вниз этот число подшагов возвращается
 * на спавн. Легитимный обход ширины поля занимает ~800 подшагов
 * (400px / 0.5px), порог взят с запасом. Гарантирует прибытие 100%
 * агентов при любых экзотических конфигурациях рельефа.
 */
const STALL_SUBSTEPS = 1500;
const stallCnt = new Int32Array(MAX_AGENTS);
const bestY = new Float32Array(MAX_AGENTS);

/** Скретч для id агентов, достигших базы за шаг */
const arrivedScratch = new Int32Array(MAX_AGENTS);
let arrivedCount = 0;

// --- Spatial hash и контекст сил жидкости ---
/** Покрытие зоны спавна над полем, px */
const SPAWN_MARGIN_PX = 64;

let grid: SpatialGrid | null = null;

const fluidWorld: FluidWorld = {
  px, py, vx, vy, rad, alive,
  grid: null,
  interactionR2: 0,
  params,
  maxDisp: 0
};

/** Скретч смещения от сил (переиспользуется, без аллокаций в цикле) */
const dispScratch: DispOut = { x: 0, y: 0 };

/** Обновляет params и зависимые от них величины контекста сил */
function applyParams(p: FluidParams): void {
  params = p;
  fluidWorld.params = p;
  fluidWorld.maxDisp = Math.max(0.05, p.targetSpeed * FLUID_TUNING.MAX_FORCE_DISP_RATIO);
}

/** Пересоздаёт spatial hash под текущий мир и радиус агентов */
function rebuildGrid(): void {
  const r = Math.max(
    FLUID_TUNING.INTERACTION_RADIUS_MIN,
    params.enemyRadius * FLUID_TUNING.INTERACTION_RADIUS_PER_R
  );
  fluidWorld.interactionR2 = r * r;
  grid = new SpatialGrid(r, Math.max(1, worldW), Math.max(1, worldH), SPAWN_MARGIN_PX, MAX_AGENTS);
  fluidWorld.grid = grid;
}

/** Освобождает слот агента */
function killSlot(slot: number): void {
  const id = idOfSlot[slot];
  if (id >= 0) {
    indexOfId[id] = -1;
    idOfSlot[slot] = -1;
    alive[slot] = 0;
    freeList[freeTop++] = slot;
  }
}

/**
 * Возврат агента на спавн (над верхней кромкой). Фейлсейф прогресса И
 * спасение погребённых после регенерации уровня (слайдеры генерации):
 * телепорт вместо «копания вверх» сквозь препятствия.
 */
function respawnToSpawn(slot: number): void {
  px[slot] = 20 + Math.random() * Math.max(1, worldW - 40);
  py[slot] = -20 - Math.random() * 10;
  vx[slot] = 0;
  vy[slot] = params.targetSpeed;
  avoidDir[slot] = 0;
  avoidFail[slot] = 0;
  avoidSweep[slot] = 0;
  avoidHover[slot] = 0;
  bestY[slot] = py[slot];
  stallCnt[slot] = 0;
}

/**
 * Один подшаг интеграции:
 *  Pass A — базовое движение «строго вниз» с обходом блобов по касательной
 *           (общая физика moveDownStep из протокола) + границы + прибытие;
 *  Pass B — силы жидкости (separation/pressure/viscosity/cohesion):
 *           пересборка spatial hash, смещение от соседей с осевым
 *           скольжением при коллизии.
 * Прибывшие пишутся в arrivedScratch начиная с arrivedBase (накопление
 * за все подшаги кадра). Возвращает число прибывших на этом подшаге.
 */
function integrate(arrivedBase: number): number {
  if (!field || !grid) return 0;

  const targetSpeed = params.targetSpeed;
  let arrivedN = 0;

  for (let s = 0; s < MAX_AGENTS; s++) {
    if (!alive[s]) continue;

    // Погребён внутри блоба (уровень пересобран слайдерами) — телепорт
    // на спавн вместо копания вверх сквозь препятствия
    if (blockedAt(field, px[s], py[s])) {
      respawnToSpawn(s);
      continue;
    }

    const p = { x: px[s], y: py[s] };
    const v = { x: vx[s], y: vy[s] };
    const hitR = Math.max(4, rad[s] * 0.6);

    // Строго вниз + обход препятствий (спасение застрявших внутри)
    const avoidRef = {
      value: avoidDir[s],
      failStreak: avoidFail[s],
      sweep: avoidSweep[s],
      hover: avoidHover[s]
    };
    moveDownStep(field, p, v, hitR, avoidRef, targetSpeed);
    avoidDir[s] = avoidRef.value;
    avoidFail[s] = avoidRef.failStreak;
    avoidSweep[s] = avoidRef.sweep;
    avoidHover[s] = avoidRef.hover;

    px[s] = p.x;
    py[s] = p.y;
    vx[s] = v.x;
    vy[s] = v.y;

    // Боковые границы поля боя (верхний клэмп отсутствует намеренно)
    if (px[s] < 10) {
      px[s] = 10;
      vx[s] = Math.abs(vx[s]) * 0.5;
    } else if (px[s] > worldW - 10) {
      px[s] = worldW - 10;
      vx[s] = -Math.abs(vx[s]) * 0.5;
    }

    // Фейлсейф: нет прогресса вниз слишком долго -> возврат на спавн
    if (py[s] > bestY[s] + 0.001) {
      bestY[s] = py[s];
      stallCnt[s] = 0;
    } else if (++stallCnt[s] > STALL_SUBSTEPS) {
      respawnToSpawn(s);
    }

    // Достижение нижней границы поля => база
    if (py[s] >= worldH) {
      arrivedScratch[arrivedBase + arrivedN] = idOfSlot[s];
      arrivedN++;
      killSlot(s);
    }
  }

  // --- Pass B: силы жидкости — модуляция поверх базового потока ---

  // Пересборка хэша по новым позициям
  grid.clear();
  for (let s = 0; s < MAX_AGENTS; s++) {
    if (alive[s]) grid.insert(s, px[s], py[s]);
  }

  // Смещение от соседей; при коллизии — осевое скольжение (семантика Pass A)
  for (let s = 0; s < MAX_AGENTS; s++) {
    if (!alive[s]) continue;
    fluidDisplacement(fluidWorld, s, dispScratch);
    const dx = dispScratch.x;
    const dy = dispScratch.y;
    if (dx === 0 && dy === 0) continue;

    const hitR = Math.max(4, rad[s] * 0.6);
    const nx = px[s] + dx;
    const ny = py[s] + dy;
    if (!isBoxBlocked(field, nx, ny, hitR)) {
      px[s] = nx;
      py[s] = ny;
    } else if (!isBoxBlocked(field, nx, py[s], hitR)) {
      px[s] = nx;
    } else if (!isBoxBlocked(field, px[s], ny, hitR)) {
      py[s] = ny;
    }

    // Боковые границы после выталкивания
    if (px[s] < 10) {
      px[s] = 10;
    } else if (px[s] > worldW - 10) {
      px[s] = worldW - 10;
    }
  }
  return arrivedN;
}

ctx.onmessage = (e: { data: unknown }) => {
  const msg = e.data as WorkerCommand;

  switch (msg.type) {
    case 'init': {
      // baseX/baseY из сообщения игнорируются: движение строго вниз,
      // база как цель не используется
      worldW = msg.width;
      worldH = msg.height;
      applyParams(msg.params);
      rebuildGrid();
      accumulator = 0;
      if (!readySent) {
        readySent = true;
        ctx.postMessage({ type: 'ready' } satisfies { type: 'ready' });
      }
      break;
    }

    case 'set_level': {
      // blocked приходит transferable-копией (оригинал уровня остаётся на main)
      field = {
        cols: msg.cols,
        rows: msg.rows,
        cellSize: msg.cellSize,
        blocked: new Uint8Array(msg.blocked),
        widthPx: msg.widthPx
      };
      break;
    }

    case 'add': {
      if (freeTop === 0 || msg.id >= MAX_AGENTS) break;
      const slot = freeList[--freeTop];
      alive[slot] = 1;
      idOfSlot[slot] = msg.id;
      indexOfId[msg.id] = slot;
      px[slot] = msg.x;
      py[slot] = msg.y;
      vx[slot] = msg.vx;
      vy[slot] = msg.vy;
      rad[slot] = msg.radius;
      // Слот мог принадлежать другому агенту — сбрасываем состояние обхода
      avoidDir[slot] = 0;
      avoidFail[slot] = 0;
      avoidSweep[slot] = 0;
      avoidHover[slot] = 0;
      bestY[slot] = msg.y;
      stallCnt[slot] = 0;
      break;
    }

    case 'remove': {
      if (msg.id < 0 || msg.id >= MAX_AGENTS) break;
      const slot = indexOfId[msg.id];
      if (slot >= 0) {
        killSlot(slot);
      }
      break;
    }

    case 'params': {
      applyParams(msg.params);
      rebuildGrid();
      break;
    }

    case 'step': {
      const t0 = performance.now();

      // Сброс счётчика прибывших: если подшагов не будет (лаги/малый dt),
      // нельзя переотправлять arrived из прошлого кадра — main повторно
      // снимет HP базы
      arrivedCount = 0;

      // Фиксированные подшаги c аккумулятором.
      // ВАЖНО: накапливаем прибывших за ВСЕ подшаги кадра. Перезапись
      // arrivedCount = integrate() теряла прибытия первого подшага при
      // 2+ подшагах (30fps мобильные): спрайты зависали у базы навсегда
      accumulator += msg.dt;
      let sub = 0;
      while (accumulator >= SUBSTEP_DT && sub < MAX_SUBSTEPS) {
        arrivedCount += integrate(arrivedCount);
        accumulator -= SUBSTEP_DT;
        sub++;
      }

      // Заполняем выходной буфер: [id, x, y] для всех живых
      const out = new Float32Array(msg.outData);
      let n = 0;
      for (let s = 0; s < MAX_AGENTS; s++) {
        if (!alive[s]) continue;
        out[n++] = idOfSlot[s];
        out[n++] = px[s];
        out[n++] = py[s];
      }

      const arrivedOut = new Int32Array(msg.outArrived);
      for (let a = 0; a < arrivedCount; a++) {
        arrivedOut[a] = arrivedScratch[a];
      }

      const frame: FrameMsg = {
        type: 'frame',
        count: n / OUT_STRIDE,
        arrivedCount,
        data: msg.outData,
        arrived: msg.outArrived,
        stepMs: performance.now() - t0
      };
      ctx.postMessage(frame, [msg.outData, msg.outArrived]);
      break;
    }
  }
};
