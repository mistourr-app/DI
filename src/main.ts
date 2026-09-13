import { Game } from './game/Game';
import { runFactoryResetIfRequested } from './game/save/factoryReset';

async function boot(): Promise<void> {
  // Полный сброс «как первый запуск»: открыть игру с ?reset — стираются
  // localStorage/IndexedDB/кэши/SW и страница перезагружается без параметра.
  if (await runFactoryResetIfRequested()) return;

  const game = new Game();
  await game.start().catch((error) => {
    console.error('Failed to start game:', error);
    const container = document.getElementById('game-container');
    if (container) {
      container.innerHTML =
        '<div style="color: red; padding: 20px;">Failed to load game. Please refresh the page.</div>';
    }
  });
}

boot();