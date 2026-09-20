// ============================================================
// TuningStore — персистентность параметров, настраиваемых в
// поп-апе ⚙ (localStorage). Снимок всех тюнящихся значений:
// сцена не сбрасывает их ни при смене уровня, ни при перезагрузке.
// ============================================================

import type { ElementType } from '../config/GameConfig';

const STORAGE_KEY = 'fluid-crowd-defense.tuning.v1';

/** Тюнящиеся поля одной стихии (из GameConfig.elements) */
export interface ElementTuning {
  gainPerKill: number;
  costPerUse: number;
  radius: number;
}

/** Полный снимок параметров поп-апа.
 *  enemySpeed НЕ хранится: задаётся уровнем (сессионный оверрайд поп-апа
 *  живёт до перезагрузки страницы). genDensity/genBlobScale хранятся:
 *  оверрайды переживают рестарты и перезагрузку, базовые значения
 *  выставляются заново только при смене уровня. */
export interface TuningSnapshot {
  spawnInterval: number;
  currentLevel: number;
  maxEnemiesOnScreen: number;
  enemySize: number;
  genDensity: number;
  genBlobScale: number;
  godPower: {
    lightningKillCount: number;
    superRadius: number;
    superChargeRequired: number;
  };
  earth: {
    bitesPerCell: number;
  };
  elements: Record<ElementType, ElementTuning>;
}

export const TuningStore = {
  /** Читает сохранённый снимок или null (нет данных / ошибка хранилища) */
  load(): TuningSnapshot | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw) as TuningSnapshot;
      if (!snap || typeof snap !== 'object' || !snap.elements) return null;
      return snap;
    } catch {
      return null;
    }
  },

  /** Сохраняет снимок. Ошибки хранилища молча игнорируются */
  save(snap: TuningSnapshot): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // приватный режим / переполнение — тюнинг живёт до конца сессии
    }
  },

  /** Стирает сохранённый тюнинг (полный сброс «как первый запуск») */
  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // приватный режим — игнорируем
    }
  }
};