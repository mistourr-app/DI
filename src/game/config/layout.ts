import Phaser from 'phaser';

/** Фиксированное соотношение игрового поля (ширина/высота) */
export const GAME_RATIO = 9 / 19.5;

/**
 * Границы игрового поля 9:19.5 внутри экрана.
 *
 * ГЛАВНОЕ ПРАВИЛО UI: вся игра живёт внутри gameArea — все окна, поп-апы,
 * экраны (прокачка, настройки и т.п.) размещаются ВНУТРИ этих границ,
 * а не на всю ширину/высоту устройства (на широких экранах слева/справа
 * остаётся «арт-окружение», за которое интерфейс выходить не должен).
 *
 * Общая функция для GameScene и UpgradeScene: обе сцены считают границы
 * одинаково, чтобы интерфейс не «прыгал» между сценами.
 */
export function computeGameArea(
  screenWidth: number,
  screenHeight: number
): Phaser.Geom.Rectangle {
  const screenRatio = screenWidth / screenHeight;

  let gameWidth: number;
  let gameHeight: number;
  let gameX: number;
  let gameY: number;

  if (screenRatio > GAME_RATIO) {
    // Экран шире → игровое поле занимает ВСЮ высоту, центрируется по горизонтали.
    // Ширина ОКРУГЛЯЕТСЯ ВВЕРХ до кратной 16: cellSize сетки = 16px ровно,
    // тайлы в целых позициях — без вертикальных/горизонтальных полос
    // (дробный cellSize давал швы арта на субпиксельном рендере).
    gameHeight = screenHeight;
    gameWidth = Math.ceil((screenHeight * GAME_RATIO) / 16) * 16;
    gameX = Math.round((screenWidth - gameWidth) / 2);
    gameY = 0;
  } else {
    // Экран уже → игровое поле занимает ВСЮ ширину (канвас уже кратен 16)
    gameWidth = screenWidth;
    gameHeight = Math.round(screenWidth / GAME_RATIO);
    gameX = 0;
    gameY = Math.round((screenHeight - gameHeight) / 2);
  }

  return new Phaser.Geom.Rectangle(gameX, gameY, gameWidth, gameHeight);
}
