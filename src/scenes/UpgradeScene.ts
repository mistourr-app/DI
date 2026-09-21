import Phaser from 'phaser';
import { fontPx, padPx } from '../game/config/uiScale';
import { computeGameArea } from '../game/config/layout';
import { progression } from '../game/progression/progressionStore';
import { upgradeDefs, valueAt, displayValue, type UpgradeDef } from '../game/progression/upgradeCatalog';
import type { GameScene } from './GameScene';

/**
 * UpgradeScene — полноэкранный экран прокачки (мета-прогресс, PROGRESSION.md).
 *
 * Отдельная сцена: GameScene на время прокачки уходит в sleep (сохраняет всё
 * состояние забега: HP базы, уровень, монстров, воркер физики), а эта сцена
 * рендерится поверх. Прогресс — общий инстанс progressionStore.
 *
 * ГЛАВНОЕ ПРАВИЛО UI: весь интерфейс живёт ВНУТРИ gameArea (9:19.5).
 */
export class UpgradeScene extends Phaser.Scene {
  private gameArea!: Phaser.Geom.Rectangle;
  private root: Phaser.GameObjects.Container | null = null;
  private content: Phaser.GameObjects.Container | null = null;
  private soulsText: Phaser.GameObjects.Text | null = null;

  private scrollY = 0;
  private maxScroll = 0;
  private viewportTop = 0;
  private viewportBottom = 0;
  private dragging = false;
  private dragStartY = 0;
  private scrollStart = 0;
  private moved = false;

  /** Параметры, купленные за текущий визит на экран (индикатор-подсветка) */
  private purchasedThisVisit = new Set<string>();

  constructor() {
    super({ key: 'UpgradeScene' });
  }

  create(): void {
    this.purchasedThisVisit.clear();
    this.scrollY = 0;
    this.dragging = false;
    this.gameArea = computeGameArea(this.cameras.main.width, this.cameras.main.height);

    this.buildUi();
    this.setupInput();

    this.scale.on('resize', this.handleResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.handleResize, this);
      this.dragging = false;
      this.root = null;
      this.content = null;
      this.soulsText = null;
    });
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    this.cameras.main.setSize(gameSize.width, gameSize.height);
    this.gameArea = computeGameArea(gameSize.width, gameSize.height);
    this.buildUi();
  }

  // --- UI ---

  private buildUi(): void {
    if (this.root) {
      this.root.destroy(true);
      this.root = null;
    }
    const g = this.gameArea;
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;

    const root = this.add.container(0, 0);
    this.root = root;

    // Полный непрозрачный фон: GameScene спит и не рендерит — иначе останутся
    // артефакты прошлого кадра/чёрные поля.
    const fullBg = this.add.graphics();
    fullBg.fillStyle(0x000000, 1);
    fullBg.fillRect(0, 0, camW, camH);
    root.add(fullBg);

    // Панель в границах игрового поля + обводка
    const bg = this.add.graphics();
    bg.fillStyle(0x070b14, 0.985);
    bg.fillRect(g.x, g.y, g.width, g.height);
    bg.lineStyle(padPx(2), 0x1a2b4a, 1);
    bg.strokeRect(g.x, g.y, g.width, g.height);
    root.add(bg);

    // --- Шапка: заголовок + баланс душ + служебный fresh start ---
    const pad = padPx(14);
    const headerH = fontPx(72);
    root.add(this.add.text(g.x + g.width / 2, g.y + pad + fontPx(12), 'ПРОКАЧКА', {
      font: `bold ${fontPx(22)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5, 0));
    this.soulsText = this.add.text(g.x + g.width / 2, g.y + pad + fontPx(44), `Души: ${progression.totalSouls}`, {
      font: `bold ${fontPx(15)}px Arial`,
      color: '#ffd700'
    }).setOrigin(0.5, 0);
    root.add(this.soulsText);

    this.buildFreshStartButton(root, g, pad);

    // --- Область списка (внутри игрового поля) ---
    const bottomH = this.bottomPanelHeight();
    this.viewportTop = g.y + headerH;
    this.viewportBottom = g.y + g.height - bottomH;
    const viewportW = g.width;

    // Маска: содержимое списка видно только между шапкой и нижней панелью
    const maskRect = this.make.graphics({ x: 0, y: 0 }, false);
    maskRect.fillRect(g.x, this.viewportTop, viewportW, this.viewportBottom - this.viewportTop);
    const mask = new Phaser.Display.Masks.GeometryMask(this, maskRect);

    const content = this.add.container(0, this.viewportTop).setMask(mask);
    root.add(content);
    this.content = content;

    this.rebuildContent();
    this.setScroll(0);

    this.buildBottomPanel(root);
  }

  /** Временная тестовая кнопка: полный fresh start (стирает прокачку и тюнинг) */
  private buildFreshStartButton(
    root: Phaser.GameObjects.Container,
    g: Phaser.Geom.Rectangle,
    pad: number
  ): void {
    const btnY = g.y + pad + fontPx(2);
    const btnPad = padPx(6);
    const btnBg = '#1a1f2e';
    const maxBtnW = g.width - pad * 2 - padPx(2);
    let btnFont = 14;
    let resetBtn = this.add.text(0, 0, '↺ Сбросить прогресс', {
      font: `bold ${fontPx(btnFont)}px Arial`,
      color: '#ff6666',
      backgroundColor: btnBg,
      padding: { x: btnPad, y: padPx(2) }
    });
    while (resetBtn.width > maxBtnW && btnFont > 8) {
      btnFont--;
      resetBtn.destroy();
      resetBtn = this.add.text(0, 0, '↺ Сбросить прогресс', {
        font: `bold ${fontPx(btnFont)}px Arial`,
        color: '#ff6666',
        backgroundColor: btnBg,
        padding: { x: btnPad, y: padPx(2) }
      });
    }
    resetBtn.setOrigin(1, 0).setPosition(g.x + g.width - pad, btnY)
      .setInteractive({ useHandCursor: true });
    resetBtn.on('pointerover', () => resetBtn.setStyle({ color: '#ff8888' }));
    resetBtn.on('pointerout', () => resetBtn.setStyle({ color: '#ff6666' }));
    resetBtn.on('pointerdown', () => this.onFreshStart());
    root.add(resetBtn);
  }

  private bottomPanelHeight(): number {
    return fontPx(110);
  }

  /** Нижняя панель: две кнопки рядом — «Сброс» и «Сохранить и играть» */
  private buildBottomPanel(root: Phaser.GameObjects.Container): void {
    const g = this.gameArea;
    const pad = padPx(14);
    const bottomH = this.bottomPanelHeight();
    const btnH = fontPx(52);
    const gap = padPx(10);
    const totalW = Math.min(g.width - pad * 2, fontPx(440));
    const btnW = (totalW - gap) / 2;
    const y = g.y + g.height - bottomH + fontPx(22);
    const leftX = g.x + g.width / 2 - totalW / 2;
    const rightX = leftX + btnW + gap;

    this.makeButton(root, leftX, y, btnW, btnH, 0x8b2e2e, 'СБРОС', () => this.onReset());
    this.makeButton(root, rightX, y, btnW, btnH, 0x2e8b57, 'СОХРАНИТЬ И ИГРАТЬ', () => this.onSaveAndPlay());
  }

  /** Кнопка: скруглённый фон + подпись + интерактивная зона */
  private makeButton(
    root: Phaser.GameObjects.Container,
    x: number,
    y: number,
    w: number,
    h: number,
    color: number,
    label: string,
    onClick: () => void
  ): void {
    const bg = this.add.graphics();
    bg.fillStyle(color, 1);
    bg.fillRoundedRect(x, y, w, h, padPx(10));
    root.add(bg);

    const text = this.add.text(x + w / 2, y + h / 2, label, {
      font: `bold ${fontPx(12)}px Arial`,
      color: '#ffffff',
      align: 'center',
      wordWrap: { width: w - padPx(10) }
    }).setOrigin(0.5);
    root.add(text);

    const zone = this.add.zone(x, y, w, h).setOrigin(0).setInteractive({ useHandCursor: true });
    zone.on('pointerdown', () => { this.moved = false; });
    zone.on('pointerup', () => {
      if (this.moved) return;
      onClick();
    });
    root.add(zone);
  }

  private rebuildContent(): void {
    if (!this.content) return;
    this.content.removeAll(true);
    this.soulsText?.setText(`Души: ${progression.totalSouls}`);

    const viewportW = this.gameArea.width;
    const pad = padPx(14);
    const groupH = fontPx(32);
    const content = this.content;

    let y = 0;
    for (const group of this.buildGroups()) {
      const headerText = this.add.text(this.gameArea.x + pad, y + padPx(2), group.name, {
        font: `bold ${fontPx(14)}px Arial`,
        color: '#ffd700'
      });
      content.add(headerText);
      y += Math.max(groupH, headerText.height + padPx(8));
      for (const def of group.defs) {
        y += this.renderRow(content, def, y, viewportW, pad);
      }
      y += fontPx(8);
    }

    // Нижний отступ: последняя группа (Сила бога) полностью видна над кнопками
    y += fontPx(40);

    const contentH = y;
    this.maxScroll = Math.max(0, contentH - (this.viewportBottom - this.viewportTop));
    this.setScroll(this.scrollY);
  }

  /** Группы параметров по стихиям (порядок: Огонь, Вода, Земля, Воздух, Бог) */
  private buildGroups(): Array<{ name: string; defs: UpgradeDef[] }> {
    const byEl: Record<string, UpgradeDef[]> = {};
    for (const d of upgradeDefs) {
      const k = d.element ?? 'god';
      (byEl[k] = byEl[k] ?? []).push(d);
    }
    const nameMap: Record<string, string> = {
      fire: '🔥 Огонь',
      water: '💧 Вода',
      earth: '🌍 Земля',
      air: '💨 Воздух',
      god: '⚡ Сила бога'
    };
    return ['fire', 'water', 'earth', 'air', 'god'].map((k) => ({
      name: nameMap[k],
      defs: byEl[k] ?? []
    }));
  }

  /** Одна строка параметра: название · значение → следующее · [КУПИТЬ].
   *  Возвращает реальную высоту строки (заголовок может переноситься). */
  private renderRow(
    container: Phaser.GameObjects.Container,
    def: UpgradeDef,
    y: number,
    viewportW: number,
    pad: number
  ): number {
    const gx = this.gameArea.x;
    const rowH = fontPx(28);
    const labelW = viewportW * 0.46;
    const leftX = gx + pad;

    // Индикатор покупки за визит: зелёный фон строки
    if (this.purchasedThisVisit.has(def.key)) {
      const hl = this.add.graphics();
      hl.fillStyle(0x2e7d32, 0.30);
      hl.fillRoundedRect(gx + padPx(6), y - padPx(2), viewportW - padPx(12), rowH, padPx(6));
      container.add(hl);
    }

    const titleText = this.add.text(leftX, y + padPx(3), def.title, {
      font: `${fontPx(12)}px Arial`,
      color: '#bbbbbb',
      wordWrap: { width: labelW }
    });
    container.add(titleText);

    container.add(this.add.text(leftX + labelW + padPx(4), y + padPx(3), this.rowValue(def), {
      font: `bold ${fontPx(12)}px Arial`,
      color: '#ffffff'
    }));

    const cost = progression.costOf(def.key);
    const btnW = fontPx(70);
    const btnX = gx + viewportW - pad - btnW;
    if (cost === null) {
      container.add(this.add.text(btnX + btnW / 2, y + padPx(3), 'MAX', {
        font: `bold ${fontPx(12)}px Arial`,
        color: '#888888'
      }).setOrigin(0.5, 0));
    } else {
      const affordable = progression.totalSouls >= cost;
      const btnBg = this.add.graphics();
      btnBg.fillStyle(affordable ? 0x2e7d32 : 0x444444, 1);
      btnBg.fillRoundedRect(btnX, y, btnW, rowH - padPx(2), padPx(6));
      container.add(btnBg);
      container.add(this.add.text(btnX + btnW / 2, y + padPx(3), `🛒 ${cost}`, {
        font: `bold ${fontPx(11)}px Arial`,
        color: '#ffffff'
      }).setOrigin(0.5, 0));
      const zone = this.add.zone(btnX, y, btnW, rowH).setOrigin(0).setInteractive({ useHandCursor: true });
      // Покупка по pointerup, чтобы драг-скролл, начавшийся на кнопке, не покупал
      zone.on('pointerdown', () => { this.moved = false; });
      zone.on('pointerup', () => {
        if (this.moved) return;
        if (this.buyUpgrade(def.key)) {
          this.rebuildContent();
        }
      });
      container.add(zone);
    }

    // Реальная высота: перенос заголовка или базовый rowH
    return Math.max(rowH, titleText.height + padPx(6));
  }

  /** Строка «текущее → следующее» для параметра */
  private rowValue(def: UpgradeDef): string {
    const level = progression.levelOf(def.key);
    const cur = valueAt(def, level);
    const next = valueAt(def, Math.min(level + 1, def.values.length - 1));
    return `${displayValue(def, cur)} → ${displayValue(def, next)}`;
  }

  /** Покупка уровня параметра: списать души + отметить индикатором за визит */
  private buyUpgrade(key: string): boolean {
    if (!progression.buy(key)) return false;
    this.purchasedThisVisit.add(key);
    return true;
  }

  private setScroll(y: number): void {
    this.scrollY = Phaser.Math.Clamp(y, 0, this.maxScroll);
    if (this.content) {
      this.content.setY(this.viewportTop - this.scrollY);
    }
  }

  // --- Действия ---

  /** «Сброс»: респек — вернуть все вложенные души и обнулить уровни */
  private onReset(): void {
    progression.reset();
    this.purchasedThisVisit.clear();
    this.rebuildContent();
  }

  /** «Сохранить и играть»: зафиксировать и запустить следующий уровень */
  private onSaveAndPlay(): void {
    progression.save();
    const gs = this.scene.get('GameScene') as GameScene;
    gs.requestNextLevel();
    this.scene.wake('GameScene');
    this.scene.stop();
  }

  /** Временный fresh start: стирает прокачку и тюнинг, забег с первого уровня */
  private onFreshStart(): void {
    const gs = this.scene.get('GameScene') as GameScene;
    gs.resetAllProgress();
    this.scene.wake('GameScene');
    this.scene.stop();
  }

  // --- Ввод ---

  private setupInput(): void {
    // Прокрутка списка: драг в области списка двигает содержимое
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.dragging) return;
      if (pointer.y < this.viewportTop || pointer.y > this.viewportBottom) return;
      this.dragging = true;
      this.moved = false;
      this.dragStartY = pointer.y;
      this.scrollStart = this.scrollY;
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      const delta = this.dragStartY - pointer.y;
      if (Math.abs(delta) > 4) this.moved = true;
      this.setScroll(this.scrollStart + delta);
    });
    this.input.on('pointerup', () => {
      this.dragging = false;
    });
    // Колесо мыши на десктопе
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _over: any, _deltaX: number, deltaY: number) => {
      this.setScroll(this.scrollY + deltaY * 0.6);
    });
  }
}
