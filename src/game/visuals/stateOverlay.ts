// ============================================================
// stateOverlay — пул «двойников» статусов стихий (Путь 1).
// На цветной спрайт монстра нельзя вешать обычный tint (умножение
// смешивает цвета и грязнит картинку). Вместо этого на затронутого
// монстра кладём ВТОРОЙ спрайт той же текстуры с setTintFill() —
// сплошная заливка цветом состояния поверх оригинала (цвет текстуры
// игнорируется, форма сохраняется по прозрачности).
// Плавное угасание — через alpha (у воды/воздуха альфа = остаток
// времени статуса × STATE_FILL_ALPHA).
// Батчинг не ломается: та же текстура 'enemy', обычный blend; fill —
// цвет вершины, а не отдельная команда отрисовки.
// ============================================================

import Phaser from 'phaser';

/** Слой оверлея статуса: чуть выше монстра (850), ниже загона (870) */
const OVERLAY_DEPTH = 852;

export class StateOverlayPool {
  private readonly scene: Phaser.Scene;
  private free: Phaser.GameObjects.Image[] = [];
  private used = new Set<Phaser.GameObjects.Image>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Взять двойник под позицию/масштаб монстра (меняется tint/alpha позже) */
  obtain(x: number, y: number, scale: number): Phaser.GameObjects.Image {
    const s = this.free.pop() ?? this.scene.add.image(x, y, 'enemy');
    s.setPosition(x, y);
    s.setScale(scale);
    s.setDepth(OVERLAY_DEPTH);
    s.setVisible(true);
    s.setActive(true);
    this.used.add(s);
    return s;
  }

  /** Вернуть двойник в пул (скрытие, без уничтожения) */
  release(s: Phaser.GameObjects.Image): void {
    s.setVisible(false);
    s.setActive(false);
    if (this.used.delete(s)) {
      this.free.push(s);
    }
  }

  /** Освободить все выданные двойники (например, при перезапуске уровня) */
  clear(): void {
    for (const s of this.used) {
      s.destroy();
    }
    this.used.clear();
    for (const s of this.free) {
      s.destroy();
    }
    this.free.length = 0;
  }
}