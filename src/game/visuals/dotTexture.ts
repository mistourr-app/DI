// ============================================================
// dotTexture — общая мягкая круговая текстура и пул спрайтов-точек.
// Замена Graphics-рисованию стихий и ячеек Земли: вся отрисовка
// идёт пулом Image с ОДНОЙ белой soft-gradient текстурой (цвет —
// через setTint). Общая текстура батчится WebGL в один draw call,
// ноль перерисовок текстур, ноль аллокаций в кадровом цикле.
// ============================================================

import Phaser from 'phaser';

const TEXTURE_KEY = 'dot-soft';
const DOT_SIZE = 64; // размер текстуры, px
const DOT_RADIUS = DOT_SIZE / 2;
/** Доля радиуса текстуры, внутри которой градиент почти непрозрачен */
const SOLID_FRACTION = 0.85;

/** Создаёт (один раз на сцену) белую мягкую круглую текстуру */
export function ensureDotTexture(scene: Phaser.Scene): string {
  if (scene.textures.exists(TEXTURE_KEY)) return TEXTURE_KEY;
  const canvas = document.createElement('canvas');
  canvas.width = DOT_SIZE;
  canvas.height = DOT_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(
      DOT_RADIUS,
      DOT_RADIUS,
      0,
      DOT_RADIUS,
      DOT_RADIUS,
      DOT_RADIUS
    );
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(SOLID_FRACTION, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DOT_SIZE, DOT_SIZE);
  }
  scene.textures.addCanvas(TEXTURE_KEY, canvas);
  return TEXTURE_KEY;
}

/** Масштаб спрайта под нужный мировой радиус точки (px) */
export function scaleForRadius(worldRadius: number): number {
  return worldRadius / (DOT_RADIUS * SOLID_FRACTION);
}

/**
 * Пул спрайтов-точек: переиспользование Image без создания/уничтожения.
 * obtain() — одна точка (позиция/масштаб/цвет/alpha/depth),
 * release() — возврат в пул (скрытие, без уничтожения).
 */
export class DotPool {
  private readonly scene: Phaser.Scene;
  private readonly textureKey: string;
  private free: Phaser.GameObjects.Image[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.textureKey = ensureDotTexture(scene);
  }

  obtain(
    x: number,
    y: number,
    worldRadius: number,
    color: number,
    alpha: number,
    depth: number
  ): Phaser.GameObjects.Image {
    const s = this.free.pop() ?? this.scene.add.image(x, y, this.textureKey);
    s.setPosition(x, y);
    s.setScale(scaleForRadius(worldRadius));
    s.setTint(color);
    s.setAlpha(alpha);
    s.setDepth(depth);
    s.setVisible(true);
    s.setActive(true);
    return s;
  }

  release(s: Phaser.GameObjects.Image): void {
    s.setVisible(false);
    s.setActive(false);
    this.free.push(s);
  }

  /** Освободить все спрайты массива и очистить его */
  releaseAll(arr: Phaser.GameObjects.Image[]): void {
    for (let i = 0; i < arr.length; i++) {
      this.release(arr[i]);
    }
    arr.length = 0;
  }

  destroy(): void {
    for (const s of this.free) {
      s.destroy();
    }
    this.free = [];
  }
}
