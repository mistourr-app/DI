// ============================================================
// factoryReset — полный сброс «как первый запуск»: стирает всё
// персистентное состояние игры (localStorage, IndexedDB, PWA-кэши,
// service worker) и перезагружает страницу начисто.
// Запуск: открыть игру с ?reset в URL — после сброса параметр уходит.
// ============================================================

/** Префиксы ключей localStorage, принадлежащих игре */
const GAME_LS_PREFIXES = ['fluid-crowd-defense', 'fluid_crowd'];

function removeGameLocalStorage(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && GAME_LS_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // приватный режим — игнорируем
  }
}

async function deleteAllIndexedDB(): Promise<void> {
  try {
    // indexedDB.databases() может отсутствовать в старых Safari
    const databases = (indexedDB as any).databases as (() => Promise<Array<{ name?: string }>>) | undefined;
    if (typeof indexedDB !== 'undefined' && typeof databases === 'function') {
      const dbs = await databases.call(indexedDB);
      await Promise.all(
        dbs.filter((d) => d.name).map((d) => indexedDB.deleteDatabase(d.name!))
      );
    }
  } catch {
    // базы закрыты/заблокированы — игнорируем
  }
}

async function clearAllCaches(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // кэшей нет/доступ запрещён
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    if (registrations) {
      await Promise.all(registrations.map((r) => r.unregister()));
    }
  } catch {
    // SW недоступен
  }
}

/** Стереть всё персистентное состояние игры */
export async function clearAllPersistedState(): Promise<void> {
  removeGameLocalStorage();
  await deleteAllIndexedDB();
  await clearAllCaches();
  await unregisterServiceWorkers();
}

/**
 * Полный сброс по URL: если адрес содержит ?reset — стирает всё и
 * перезагружает страницу БЕЗ параметра (чистая игра «первый запуск»).
 * Возвращает true, если сброс выполнен (игру в этом вызове не запускать).
 */
export async function runFactoryResetIfRequested(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('reset')) return false;

  await clearAllPersistedState();
  // Убираем ?reset и перезагружаемся начисто
  window.location.replace(window.location.pathname);
  return true;
}