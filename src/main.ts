import { Game } from './game/Game';

// Инициализация игры
const game = new Game();

// Запуск игры
game.start().catch((error) => {
  console.error('Failed to start game:', error);
  const container = document.getElementById('game-container');
  if (container) {
    container.innerHTML = 
      '<div style="color: red; padding: 20px;">Failed to load game. Please refresh the page.</div>';
  }
});