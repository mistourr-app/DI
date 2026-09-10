import Phaser from 'phaser';
import { LevelGenerator } from '../game/generation/LevelGenerator';
import { FluidSimulationController, type FrameInfo } from '../game/fluid/FluidSimulationController';
import { MAX_AGENTS, OUT_STRIDE, type FluidParams } from '../game/fluid/fluidProtocol';
import { GameConfig, type ElementType } from '../game/config/GameConfig';
import { UI_SCALE, fontPx, padPx } from '../game/config/uiScale';
import { GodPowerSystem } from '../game/god/GodPowerSystem';
import { GodPowerIcon } from '../game/god/GodPowerIcon';
import { ElementManaSystem, ELEMENT_KEYS } from '../game/element/ElementManaSystem';
import { ElementDrawer, type StrokePoint } from '../game/element/ElementDrawer';
import { ElementAltarIcon } from '../game/element/ElementAltarIcon';
import { EarthBarrierSystem } from '../game/element/EarthBarrierSystem';
import { ElementEffectSystem } from '../game/element/ElementEffectSystem';
import { TuningStore, type TuningSnapshot } from '../game/save/TuningStore';

// Радиус круга в текстуре 'enemy' (SVG 20x20, circle r=8) — для масштабирования
const ENEMY_TEX_RADIUS = 8;
// Период обновления дебаг-текста, мс (setText растеризует текстуру — нельзя каждый кадр)
const DEBUG_TEXT_INTERVAL = 250;
// Границы адаптивного кегля дебаг-панели (в игровых px = css * UI_SCALE)
const DEBUG_FONT_MAX = Math.round(16 * UI_SCALE);
const DEBUG_FONT_MIN = Math.round(9 * UI_SCALE);
// Заводские множители сил жидкости — для кнопки сброса слайдеров
const FLUID_DEFAULTS = { ...GameConfig.enemies.fluid };

// Дефолтный tint монстра (§3.7: базовая текстура белая, цвет — tint'ом)
const DEFAULT_ENEMY_TINT = 0xed0000;
// Троттлинг тика статусов стихий, мс (~10 Гц)
const FX_TICK_INTERVAL = 100;
// Инерция воздуха (fallback-путь): отклик в зоне, затухание вне, порог сноса
const AIR_RESPONSE = 0.35;
const AIR_DAMP = 0.97;
const MIN_DRIFT_SQ = 0.0025;

export class GameScene extends Phaser.Scene {
  private enemies!: Phaser.GameObjects.Group;
  private base!: Phaser.GameObjects.Rectangle;
  private debugText!: Phaser.GameObjects.Text;
  
  // Зоны экрана
  private battlefieldZone!: Phaser.Geom.Rectangle;
  private baseZone!: Phaser.Geom.Rectangle;
  private gameArea!: Phaser.Geom.Rectangle;
  /** Статичный фон (чёрный экран + поле боя + зона базы + разделитель) одним объектом */
  private zoneGraphics!: Phaser.GameObjects.Graphics;
  
  // Настройки спавна врагов
  private currentLevel: number = 1;          // Текущий уровень (1..MAX_LEVEL)
  private totalEnemiesToSpawn: number = 100; // Монстров на уровне = level * 100
  private enemiesSpawned: number = 0;        // Сколько уже заспавнено
  private maxEnemiesOnScreen: number = 10000;  // Максимум на экране
  private enemyCount: number = 0;           // Текущее количество на экране
  private victoryShown: boolean = false;     // Экран победы показан
  private gameOverShown: boolean = false;    // Экран поражения показан
  private endText: Phaser.GameObjects.Text | null = null; // ПОБЕДА/GAME OVER
  
  // Здоровье базы
  private baseHealth: number = 1000;        // Начальное здоровье базы
  private baseMaxHealth: number = 1000;     // Максимальное здоровье
  
  // Таймеры
  private spawnTimer: number = 0;           // Таймер для спавна
  private spawnInterval: number = 5;        // Интервал спавна (мс)
  
  // Настройки монстров
  private enemySpeed: number = 0.75;       // Базовая скорость монстров
  private enemySize: number = 5;           // Размер монстров

  // Уровень (генерация по seed)
  private levelGenerator!: LevelGenerator;
  private level!: ReturnType<LevelGenerator['generate']>;
  private obstacleGraphics: Phaser.GameObjects.Graphics | null = null;
  private levelSeed: string = 'seed-' + Math.floor(Math.random() * 1e9).toString(36);
  private spawnGateIdx: number = 0; // раунд-робин по входам
  // Параметры генерации (крутятся в дебаг поп-апе)
  private genDensity: number = 0.3;
  private genBlobScale: number = 1;

  // Fluid simulation: физика толпы в воркере (fallback — main-thread путь)
  private fluidCtrl!: FluidSimulationController;
  private spriteById = new Map<number, Phaser.GameObjects.Image>();
  // Сглаженная длительность шага воркера, мс (EMA по кадрам)
  private simStepMs: number = 0;
  /** Текущий кегль дебаг-панели (чтобы не дёргать setStyle без изменений) */
  private debugFontSize: number = 0;

  // Супер сила бога: заряд от молний + иконка в зоне базы (ГДД 2.5)
  private godPower = new GodPowerSystem(GameConfig.godPower);
  private godIcon: GodPowerIcon | null = null;

  // Система стихий (Итерация 1): мана по алтарям + рисование слоёв
  private elementMana = new ElementManaSystem(GameConfig.elements);
  private elementDrawer!: ElementDrawer;
  private altars = new Map<ElementType, ElementAltarIcon>();
  /** Земля-барьер (Итерация 2): ячейки земли, прогрызаемые монстрами */
  private earthBarrier!: EarthBarrierSystem;
  /** Эффекты стихий (Итерация 4): горение/замедление/отброс по зонам штриха */
  private elementFx!: ElementEffectSystem;
  /** Последнее время тика статусов стихий (троттлинг FX_TICK_INTERVAL) */
  private lastFxTick = 0;
  /** Сколько длины уже оплачено за текущий штрих (px), для поюнитного списания */
  private strokeChargedLen = 0;
  /** Атакующие землю в этом кадре: позиции, батчатся в один укус в update() */
  private pendingBites: Array<{ x: number; y: number }> = [];
  private pendingBiteCount = 0;
  /** Индикатор здоровья базы: заливка зоны базы цветом снизу вверх (0 HP = полная) */
  private baseHealthFill: Phaser.GameObjects.Rectangle | null = null;
  /** Загон монстров: спрайты очереди у верхней кромки (оставшиеся), не в бою */
  private penSprites: Phaser.GameObjects.Image[] = [];

  // Константы
  private static readonly BATTLEFIELD_RATIO = 5 / 6;
  private static readonly BASE_RATIO = 1 / 6;
  private static readonly COLOR_BATTLEFIELD_BG = 0x0a0a1a;
  private static readonly COLOR_BASE_BG = 0x0a1a0a;
  /** Цвет индикатора здоровья базы: заливка зоны базы снизу вверх (0 HP = полная) */
  private static readonly COLOR_BASE_HEALTH = 0x461b1b;
  /** Цвет фона загона монстров (полоса у верхней кромки поля боя) */
  private static readonly COLOR_PEN_BG = 0x1c1c28;
  /** Высота загона монстров, css-px (полоса на всю ширину поля боя) */
  private static readonly PEN_HEIGHT = 64;
  /** Потолок видимой «толпы» в загоне (перф; десктоп не приоритетная платформа) */
  private static readonly PEN_CAP_MAX = 1000;
  /** Спад плотности градиента загона: каждый ряд выше — доля 0.6 от нижнего */
  private static readonly PEN_FALLOFF = 0.6;
  /** Доступно уровней: уровень N = N*100 монстров (50-й = 5000) */
  private static readonly MAX_LEVEL = 50;
  /** Монстров на первом уровне и шаг роста за уровень */
  private static readonly MONSTERS_PER_LEVEL_STEP = 100;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload(): void {
    // Временные ассеты для прототипа. База монстра — БЕЛАЯ (нейтральная):
    // цвет задаётся tint'ом (§3.7) — tint × белый = ровно нужный цвет
    // (серая база умножала бы цвет и делала его тёмным/неразличимым).
    this.load.image('enemy', 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMCIgY3k9IjEwIiByPSI4IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+');
  }

  create(): void {
    // Настраиваем размеры экрана
    this.setupScreenZones();
    
    // Создаем визуальные зоны
    this.createZoneVisuals();
    
    // Создаем базу в зоне базы
    this.createBase();
    
    // Создаем стихии в зоне базы
    this.createElements();

    // Земля-барьер: ячейки инициализируются в generateLevel() под сетку уровня
    this.earthBarrier = new EarthBarrierSystem(this);

    // Эффекты стихий (Итерация 4): зоны штрихов -> горение/замедление/отброс.
    // Оверлеи инициализируются в generateLevel() под сетку уровня
    this.elementFx = new ElementEffectSystem();

    // Рисование стихий на поле боя (препятствия не рисуются).
    // Земля-штрих превращается в барьер из ячеек (EarthBarrierSystem),
    // прочие стихии — в зоны эффектов (ElementEffectSystem)
    this.elementDrawer = new ElementDrawer(
      this,
      (x, y) => this.isDrawBlocked(x, y),
      (key, points) => this.applyElementStroke(key, points)
    );

    // Создаем группу для врагов
    this.enemies = this.add.group();

    // Инициализируем счётчики
    this.enemyCount = 0;
    this.enemiesSpawned = 0;
    this.baseHealth = this.baseMaxHealth;
    this.spawnTimer = 0;
    this.victoryShown = false;
    this.gameOverShown = false;

    // Восстановление параметров поп-апа из прошлой сессии: значения из
    // localStorage применяются ДО генерации уровня и инициализации физики
    // (влияют на currentLevel, ген-параметры, скорость/размер врагов)
    this.applyStoredTuning();

    this.totalEnemiesToSpawn = this.currentLevel * GameScene.MONSTERS_PER_LEVEL_STEP;

    // Fluid simulation: воркер физики толпы (fallback — main-thread путь)
    this.fluidCtrl = new FluidSimulationController();
    this.fluidCtrl.onFrame = this.handleFluidFrame;
    this.syncFluidWorld();

    // Генерация уровня по seed (локальные координаты поля боя)
    this.levelGenerator = new LevelGenerator();
    this.generateLevel();

    // Debug текст для информации
    this.createDebugText();

    // Кнопка настроек (поп-ап с параметрами)
    this.createSettingsButton();

    // Настраиваем управление
    this.setupInput();
    
    // Настраиваем камеру
    this.setupCamera();

    // Дебаг-хуки для смоук-тестов (только в debug-сборке)
    if (GameConfig.game.debug) {
      (window as any).__di = this;
      (window as any).__gc = GameConfig;
    }
    
    // Добавляем обработчик изменения размера окна
    this.scale.on('resize', this.handleResize, this);

    // Снимаем его при остановке сцены (иначе после scene.restart() обработчик задублируется)
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.handleResize, this);
      this.settingsOpen = false;
      // Останавливаем воркер физики и чистим карту спрайт<->агент
      if (this.fluidCtrl) {
        this.fluidCtrl.destroy();
      }
      this.spriteById.clear();
      this.godIcon = null;
      this.elementDrawer?.destroy();
      this.earthBarrier?.destroy();
      this.elementFx?.destroy();
      this.clearPen();
    });
  }

  /** Границы/база/параметры мира -> в воркер (локальные координаты) */
  private syncFluidWorld(): void {
    const z = this.battlefieldZone;
    this.fluidCtrl.init(
      z.width,
      z.height,
      this.base.x - z.x,
      this.base.y - z.y,
      this.buildFluidParams()
    );
  }

  private buildFluidParams(): FluidParams {
    const f = GameConfig.enemies.fluid;
    return {
      targetSpeed: this.enemySpeed * UI_SCALE,
      enemyRadius: this.enemySize * UI_SCALE,
      density: f.density,
      pressure: f.pressure,
      viscosity: f.viscosity,
      separation: f.separation,
      cohesion: f.cohesion,
      alignment: f.alignment,
      // Эффекты стихий (Итерация 4)
      waterSlowFactor: GameConfig.elements.water.slowFactor ?? 0.5,
      airPushStrength: GameConfig.elements.air.pushStrength ?? 1.5,
      wetDuration: GameConfig.elements.water.wetDuration ?? 5,
      airDuration: GameConfig.elements.air.airDuration ?? 5
    };
  }

  /** Пробрасывает актуальные скорость/размер в воркер физики */
  private syncFluidParams(): void {
    if (this.fluidCtrl?.isWorkerMode) {
      this.fluidCtrl.setParams(this.buildFluidParams());
    }
  }
  
  private handleResize(gameSize: Phaser.Structs.Size): void {
    const width = gameSize.width;
    const height = gameSize.height;

    this.cameras.main.setSize(width, height);
    this.setupScreenZones();

    // Перегенерация уровня под новый размер с тем же seed
    this.generateLevel();

    if (this.zoneGraphics) this.zoneGraphics.destroy();

    this.createZoneVisuals();

    if (this.base) this.base.destroy();
    this.createBase();
    this.createElements();

    // Нарисованные слои привязаны к старому размеру поля — сбрасываем
    this.elementDrawer?.clearPersistent();

    // Пересоздаем кнопку настроек при изменении размера
    this.createSettingsButton();

    // Обновляем позицию дебаг текста
    this.placeDebugText();

    this.setupCamera();
  }
  
  private setupScreenZones(): void {
    const screenWidth = this.cameras.main.width;
    const screenHeight = this.cameras.main.height;
    const screenRatio = screenWidth / screenHeight;
    const gameRatio = 9 / 19.5; // Фиксированное соотношение игрового поля

    let gameWidth: number;
    let gameHeight: number;
    let gameX: number;
    let gameY: number;

    if (screenRatio > gameRatio) {
      // Экран шире → игровое поле занимает ВСЮ высоту, центрируется по горизонтали
      gameHeight = screenHeight;
      gameWidth = screenHeight * gameRatio;
      gameX = (screenWidth - gameWidth) / 2;
      gameY = 0;
    } else {
      // Экран уже → игровое поле занимает ВСЮ ширину, центрируется по вертикали
      gameWidth = screenWidth;
      gameHeight = screenWidth / gameRatio;
      gameX = 0;
      gameY = (screenHeight - gameHeight) / 2;
    }

    // Игровое поле (9:19.5)
    this.gameArea = new Phaser.Geom.Rectangle(gameX, gameY, gameWidth, gameHeight);

    // Поле боя (5/6 высоты игрового поля)
    this.battlefieldZone = new Phaser.Geom.Rectangle(
      gameX,
      gameY,
      gameWidth,
      gameHeight * GameScene.BATTLEFIELD_RATIO
    );

    // Зона базы (1/6 высоты игрового поля)
    this.baseZone = new Phaser.Geom.Rectangle(
      gameX,
      gameY + this.battlefieldZone.height,
      gameWidth,
      gameHeight * GameScene.BASE_RATIO
    );
  }
  
  private createZoneVisuals(): void {
    const screenWidth = this.cameras.main.width;
    const screenHeight = this.cameras.main.height;

    // Весь статичный фон — ОДИН Graphics (один draw call вместо пяти):
    // чёрный фон для арта окружения, игровое поле, поле боя, зона базы,
    // разделительная линия. Порядок команд = порядок слоёв.
    const g = this.add.graphics();

    // 1. Чёрный фон на ВЕСЬ экран (для арта окружения)
    g.fillStyle(0x000000, 1);
    g.fillRect(0, 0, screenWidth, screenHeight);

    // 2. Игровое поле (9:19.5)
    if (this.gameArea) {
      g.fillStyle(0x1a1a2e, 1);
      g.fillRect(
        this.gameArea.x,
        this.gameArea.y,
        this.gameArea.width,
        this.gameArea.height
      );
    }

    // 3. Поле боя
    g.fillStyle(GameScene.COLOR_BATTLEFIELD_BG, 1);
    g.fillRect(
      this.battlefieldZone.x,
      this.battlefieldZone.y,
      this.battlefieldZone.width,
      this.battlefieldZone.height
    );

    // 3.1. Загон монстров: полоса у верхней кромки поля боя (оставшиеся).
    // Спрайты очереди рисуются поверх (depth 850). Нижняя граница — линия.
    const penH = GameScene.PEN_HEIGHT * UI_SCALE;
    g.fillStyle(GameScene.COLOR_PEN_BG, 1);
    g.fillRect(this.battlefieldZone.x, this.battlefieldZone.y, this.battlefieldZone.width, penH);
    g.lineStyle(2 * UI_SCALE, 0x00ffff, 0.35);
    g.beginPath();
    g.moveTo(this.battlefieldZone.x, this.battlefieldZone.y + penH);
    g.lineTo(this.battlefieldZone.x + this.battlefieldZone.width, this.battlefieldZone.y + penH);
    g.strokePath();

    // 4. Зона базы
    g.fillStyle(GameScene.COLOR_BASE_BG, 1);
    g.fillRect(
      this.baseZone.x,
      this.baseZone.y,
      this.baseZone.width,
      this.baseZone.height
    );

    // 5. Разделительная линия между полем боя и базой
    g.lineStyle(1 * UI_SCALE, 0x00ffff, 0.3);
    g.beginPath();
    g.moveTo(this.baseZone.x, this.baseZone.y);
    g.lineTo(this.baseZone.x + this.baseZone.width, this.baseZone.y);
    g.strokePath();

    this.zoneGraphics = g;

    // Индикатор здоровья базы: заливка зоны базы цветом 461B1B СНИЗУ ВВЕРХ.
    // Высота = доля потерянного здоровья (1 - HP/MAX): полная заливка = HP 0.
    // Прямоугольник фиксирован по размеру, высота — через scaleY (без
    // пересоздания геометрии каждый кадр). Ниже монстров (850) и UI.
    if (this.baseHealthFill) {
      this.baseHealthFill.destroy();
      this.baseHealthFill = null;
    }
    const fill = this.add.rectangle(
      this.baseZone.x + this.baseZone.width / 2,
      this.baseZone.y + this.baseZone.height,
      this.baseZone.width,
      this.baseZone.height,
      GameScene.COLOR_BASE_HEALTH,
      0.85
    );
    fill.setOrigin(0.5, 1);
    // Depth 0 (по умолчанию): создаётся в createZoneVisuals ДО алтарей
    // (createElements) — рендерится ПОД ними, но над фоном зоны базы
    this.baseHealthFill = fill;
    this.updateBaseHealthFill();
  }

  /** Перерисовать заливку индикатора здоровья базы (событийно) */
  private updateBaseHealthFill(): void {
    if (!this.baseHealthFill) return;
    const frac = 1 - this.baseHealth / Math.max(1, this.baseMaxHealth);
    this.baseHealthFill.setScale(1, Phaser.Math.Clamp(frac, 0, 1));
  }
  
  private createBase(): void {
    // База в центре зоны базы
    const baseX = this.baseZone.x + this.baseZone.width / 2;
    const baseY = this.baseZone.y + this.baseZone.height / 2;

    // Логическая точка базы (цель монстров, координаты физики).
    // Визуал «БАЗА» убран: центральный слот занят иконкой супер силы
    // бога с прогресс-баром (ГДД 2.4)
    this.base = this.add.rectangle(baseX, baseY, 1, 1, 0x00ffff, 0);
    this.base.setVisible(false);
  }
  
  private createElements(): void {
    const zone = this.baseZone;
    const centerX = zone.x + zone.width / 2;
    const centerY = zone.y + zone.height / 2;

    // Алтари стихий в ряд (центральный слот — иконка супер силы бога)
    const elements: Array<{ key: ElementType; offset: number; emoji: string; name: string }> = [
      { key: 'fire', offset: -2, emoji: '🔥', name: 'Огонь' },
      { key: 'water', offset: -1, emoji: '💧', name: 'Вода' },
      { key: 'earth', offset: 1, emoji: '🌍', name: 'Земля' },
      { key: 'air', offset: 2, emoji: '💨', name: 'Воздух' }
    ];

    // Адаптивный размер элементов в зависимости от ширины зоны
    const baseElementSize = Math.min(zone.width / 8, 50 * UI_SCALE); // Максимум 50 css px
    const elementSpacing = baseElementSize * 1.5;
    const elementRadius = baseElementSize / 2;

    // Адаптивный размер шрифта
    const labelFontSize = Math.max(10 * UI_SCALE, baseElementSize * 0.3);

    // Центральный слот ряда — иконка супер силы бога с прогресс-баром
    // (ГДД 2.4: иконка базы заменена на супер силу бога)
    this.godIcon?.destroy();
    this.godIcon = new GodPowerIcon(
      this,
      centerX,
      centerY,
      baseElementSize * 0.62,
      this.godPower,
      () => { this.toggleSuperMode(); }
    );

    // Пересоздаём алтари (при resize) — старые иконки уничтожаются
    this.altars.forEach(a => a.destroy());
    this.altars.clear();

    elements.forEach(element => {
      const elementX = centerX + (element.offset * elementSpacing);
      const elementY = centerY;
      const cfg = GameConfig.elements[element.key];

      // Название стихии под алтарём
      const nameLabel = this.add.text(elementX, elementY + elementRadius + 10 * UI_SCALE, element.name, {
        font: `${labelFontSize}px Arial`,
        color: '#cccccc',
        align: 'center'
      });
      nameLabel.setOrigin(0.5);

      // Алтарь: круг, заливка маны цветом стихии снизу вверх (как у силы бога)
      const altar = new ElementAltarIcon(this, elementX, elementY, elementRadius, {
        key: element.key,
        emoji: element.emoji,
        color: cfg.color,
        getProgress: () => this.elementMana.progress(element.key),
        canUse: () => this.elementMana.canUse(element.key),
        isSelected: () => this.elementMana.armed === element.key,
        onToggle: () => {
          if (this.elementMana.armed === element.key) {
            this.elementMana.disarm();
          } else {
            this.elementMana.arm(element.key);
          }
          this.refreshAltarBars();
        }
      });

      this.altars.set(element.key, altar);
    });

    this.refreshAltarBars();
  }

  /** Перерисовка алтарей: заливка маны + подсветка выбранного (событийно) */
  private refreshAltarBars(): void {
    this.altars.forEach(a => a.redraw());
  }

  /**
   * Поюнитное списание маны за текущий штрих: каждый пройденный юнит
   * длины (elementStrokeUnit) стоит costPerUse. Бар убывает в реальном
   * времени. Бюджет (beginPotential) не даёт нарисовать больше оплаченного.
   */
  private chargeStrokeUnits(el: ElementType): void {
    const unit = GameConfig.elementStrokeUnit * UI_SCALE;
    const units = Math.floor(this.elementDrawer.paintedLength / unit);
    const chargedUnits = Math.floor(this.strokeChargedLen / unit);
    if (units <= chargedUnits) return;
    const delta = units - chargedUnits;
    this.elementMana.spend(el, delta * GameConfig.elements[el].costPerUse);
    this.strokeChargedLen = units * unit;
    this.refreshAltarBars();
  }

  /**
   * Доплата за неполный хвостовой юнит на завершении штриха: всего за
   * штрих платим ceil(paintedLength / unit) юнитов — ровно «длина = цена».
   * Бюджет beginPotential гарантирует, что этой суммы хватит.
   */
  private settleStrokeUnits(el: ElementType): void {
    const unit = GameConfig.elementStrokeUnit * UI_SCALE;
    const painted = this.elementDrawer.paintedLength;
    const needed = Math.ceil(painted / unit);
    const charged = Math.floor(this.strokeChargedLen / unit);
    const extra = needed - charged;
    if (extra > 0) {
      this.elementMana.spend(el, extra * GameConfig.elements[el].costPerUse);
    }
  }
  
  private createDebugText(): void {
    this.debugText = this.add.text(0, 0, '', {
      font: `${12 * UI_SCALE}px monospace`,
      color: '#ffffff',
      backgroundColor: '#00000080',
      padding: { x: 8 * UI_SCALE, y: 4 * UI_SCALE }
    });
    // Поднимаем текст на максимальный depth, чтобы был выше всех монстров
    this.debugText.setDepth(1000);
    this.placeDebugText();
  }

  /** Панель инфо у верхней кромки поля боя — всегда внутри игровой области.
   *  Кегль адаптивный: строка + кнопка ⚙ обязаны помещаться в ширину поля */
  private placeDebugText(): void {
    if (!this.debugText || !this.gameArea) return;
    this.debugText.setPosition(this.gameArea.x + 8 * UI_SCALE, this.gameArea.y + 4 * UI_SCALE);

    // Самая длинная строка панели ~40 символов; моноширинный глиф ~0.62 кегля
    const avail = this.gameArea.width - 16 - 52;
    let size = DEBUG_FONT_MAX;
    while (size > DEBUG_FONT_MIN && size * 0.62 * 40 > avail) size--;

    if (size !== this.debugFontSize) {
      this.debugFontSize = size;
      this.debugText.setStyle({
        font: `${size}px monospace`,
        color: '#ffffff',
        backgroundColor: '#00000080',
        padding: { x: 8 * UI_SCALE, y: 4 * UI_SCALE }
      });
    }
  }

  /**
   * Вместимость загона при плотной упаковке: сколько монстров нужно, чтобы
   * занять его целиком. Ячейка = размер монстра × 0.9 (лёгкое перекрытие).
   * Десктоп не приоритетная платформа — потолок PEN_CAP_MAX.
   */
  private penCapacity(): number {
    const z = this.battlefieldZone;
    const margin = 8 * UI_SCALE;
    const penH = (GameScene.PEN_HEIGHT - 8) * UI_SCALE;
    const w = z.width - margin * 2;
    const size = Math.max(4, this.enemySize * UI_SCALE);
    const cell = Math.max(1, size * 0.9);
    const cols = Math.max(1, Math.floor(w / cell));
    const rows = Math.max(1, Math.floor(penH / cell));
    return Math.min(GameScene.PEN_CAP_MAX, cols * rows);
  }

  /**
   * Заполнить загон монстров очередью: min(оставшиеся, вместимость).
   * Если оставшихся больше вместимости — полная толпа (плотная сетка);
   * иначе — градиент от нижнего края (нижний ряд плотно, выше свободнее).
   */
  private initPen(): void {
    this.clearPen();
    const remaining = this.totalEnemiesToSpawn - this.enemiesSpawned;
    const count = Math.min(Math.max(0, remaining), this.penCapacity());
    for (let i = 0; i < count; i++) {
      this.addPenSprite(count);
    }
  }

  /**
   * Перераскладка загона по текущему числу: толпа «течёт» вниз — монстры
   * спускаются и редеют к хвосту, без дыр (вызывается при каждом уходе).
   */
  private relayoutPen(): void {
    const n = this.penSprites.length;
    for (let i = 0; i < n; i++) {
      this.placeInPen(this.penSprites[i], i, n);
    }
  }

  /** Очистить загон (новый уровень / регенерация). Паркованные спрайты
   *  (не выходившие на поле) уничтожаются — они не в группе врагов */
  private clearPen(): void {
    for (const s of this.penSprites) {
      s.destroy();
    }
    this.penSprites = [];
  }

  /** Добавить один спрайт в очередь загона. totalTarget — итоговое число
   *  монстров в загоне (для выбора раскладки «толпа/градиент») */
  private addPenSprite(totalTarget: number): void {
    const s = this.add.image(0, 0, 'enemy');
    s.setActive(false).setVisible(true);
    s.setScale((this.enemySize * UI_SCALE) / ENEMY_TEX_RADIUS);
    s.setTint(DEFAULT_ENEMY_TINT);
    s.setDepth(850);
    this.penSprites.push(s);
    this.placeInPen(s, this.penSprites.length - 1, totalTarget);
  }

  /**
   * Детерминированный джиттер (-1..1) по индексу: хаос без мерцания
   * (позиции пересчитываются при каждой перераскладке — random был бы скачущим).
   */
  private penJitter(seed: number): number {
    const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return (v - Math.floor(v)) * 2 - 1;
  }

  /**
   * Раскладка монстров загона:
   *  - total >= вместимости: ПОЛНАЯ ТОЛПА — плотная сетка на весь загон;
   *  - total < вместимости: ГРАДИЕНТ от нижнего края (нижний ряд плотно,
   *    выше — спад PEN_FALLOFF). Верхний по индексу монстр уходит первым
   *    и лежит в НИЖНЕМ ряду — монстры «спускаются» вниз, а не убывают вбок.
   *  Джиттер добавляет хаос (без строгих рядов/столбиков).
   */
  private placeInPen(s: Phaser.GameObjects.Image, index: number, total: number): void {
    const z = this.battlefieldZone;
    const margin = 8 * UI_SCALE;
    const penH = (GameScene.PEN_HEIGHT - 8) * UI_SCALE;
    const w = z.width - margin * 2;
    const size = Math.max(4, this.enemySize * UI_SCALE);
    const cell = Math.max(1, size * 0.9);
    const cols = Math.max(1, Math.floor(w / cell));
    const rows = Math.max(1, Math.floor(penH / cell));
    const capacity = Math.min(GameScene.PEN_CAP_MAX, cols * rows);
    const j = cell * 0.4; // хаос — но не разрушает толпу
    const jx = this.penJitter(index + 1) * j;
    const jy = this.penJitter(index + 2) * j;

    // --- Полная толпа: все ячейки заняты, уходит снизу (верхний index) ---
    if (total >= capacity) {
      const cx = index % cols;
      const cy = Math.floor(index / cols);
      s.setPosition(
        z.x + margin + cx * cell + cell / 2 + jx,
        z.y + margin + cy * cell + cell / 2 + jy
      );
      return;
    }

    // --- Градиент от нижнего края: сколько монстров в каждом ряду снизу вверх ---
    let rem = total;
    const rowCaps: number[] = [];
    for (let r = 0; r < rows && rem > 0; r++) {
      const cap = r === 0
        ? Math.min(cols, rem)                              // нижний ряд: плотно
        : Math.min(cols, Math.ceil(rem * (1 - GameScene.PEN_FALLOFF)));
      rowCaps.push(cap);
      rem -= cap;
    }
    // k с конца: наибольший index (уходит первым) -> нижний ряд
    const k = total - 1 - index;
    let acc = 0;
    for (let r = 0; r < rowCaps.length; r++) {
      if (k < acc + rowCaps[r]) {
        const t = (k - acc) / rowCaps[r];
        const cx = Math.min(cols - 1, Math.floor(t * cols));
        const cy = rows - 1 - r; // r=0 — нижний ряд
        s.setPosition(
          z.x + margin + cx * cell + cell / 2 + jx,
          z.y + margin + cy * cell + cell / 2 + jy
        );
        return;
      }
      acc += rowCaps[r];
    }
    // Фолбэк (не должно случаться): центр нижнего ряда
    s.setPosition(z.x + margin + w / 2, z.y + margin + cell / 2);
  }

  private createEnemy(): void {
    // Монстры выходят ИЗ ЗАГОНА (полоса у верхней кромки) и падают на поле.
    // Спавн — у нижней границы загона.
    const spawnY = this.battlefieldZone.y + GameScene.PEN_HEIGHT * UI_SCALE;

    // X: по очереди через ВСЕ входы уровня, равномерно на всю ширину входа.
    // ВНИМАНИЕ: entrances хранятся в ЛОКАЛЬНЫХ координатах поля боя,
    // поэтому добавляем zone.x для перевода в мировые.
    const zone = this.battlefieldZone;
    let x: number;
    const ents = this.level ? this.level.entrances : null;
    if (ents && ents.length > 0) {
      // Раунд-робин: каждый следующий монстр — в следующий вход,
      // так все входы задействованы равномерно
      this.spawnGateIdx = (this.spawnGateIdx + 1) % ents.length;
      const e = ents[this.spawnGateIdx];
      // На всю ширину входа, без отступов от его краёв.
      // Клэмп = коридору движения физики (EDGE_MARGIN=10 + запас):
      // иначе спавн у кромки телепортом слипается в колонну на стенке
      const localX = e.x + Phaser.Math.FloatBetween(-e.width / 2, e.width / 2);
      x = zone.x + Phaser.Math.Clamp(localX, 14 * UI_SCALE, zone.width - 14 * UI_SCALE);
    } else {
      x = Phaser.Math.Between(zone.x + 20 * UI_SCALE, zone.x + zone.width - 20 * UI_SCALE);
    }

    const y = Phaser.Math.Between(
      spawnY - 10 * UI_SCALE,
      spawnY + 10 * UI_SCALE
    );

    // Источник спрайта: сначала очередь загона (визуальный остаток), затем
    // пул мёртвых полевых, иначе — новый. Image батчится WebGL в один draw call.
    let enemy: Phaser.GameObjects.Image | null = null;
    if (this.penSprites.length > 0) {
      enemy = this.penSprites.pop()!;
      enemy.setPosition(x, y).setActive(true).setVisible(true);
      this.enemies.add(enemy);
    } else {
      enemy = this.enemies.getFirstDead(false) as Phaser.GameObjects.Image | null;
      if (!enemy) {
        enemy = this.add.image(x, y, 'enemy');
        this.enemies.add(enemy);
      } else {
        enemy.setPosition(x, y).setActive(true).setVisible(true);
      }
    }
    enemy.setScale((this.enemySize * UI_SCALE) / ENEMY_TEX_RADIUS);
    enemy.setAlpha(1);

    // Скорость — обычные свойства объекта (Data Manager заметно медленнее)
    const e = enemy as any;
    e.vx = Phaser.Math.FloatBetween(-0.1, 0.1) * UI_SCALE;
    e.vy = this.enemySpeed * UI_SCALE;
    e.aid = -1;

    // Статусы стихий (Итерация 4): сброс при респауне из пула + дефолтный
    // красный tint (базовая текстура белая, цвет — tint'ом по §3.7).
    // wetRemain/drift — состояние эффектов для fallback-пути (без воркера)
    e.burnUntil = 0;
    e.wetUntil = 0;
    e.airUntil = 0;
    e.chainIgnited = false;
    e.statusTint = DEFAULT_ENEMY_TINT;
    e.wetRemain = 0;
    e.driftX = 0;
    e.driftY = 0;
    enemy.setTint(DEFAULT_ENEMY_TINT);
    // Монстры рисуются ПОВЕРХ стихий (штрихи на depth 800, земля — 700):
    // стихии — фон, толпа — поверх, вспышки бога (900) и UI — выше всех
    enemy.setDepth(850);

    // Регистрируем агента в воркере физики (координаты -> локальные поля боя)
    if (this.fluidCtrl?.isWorkerMode) {
      const id = this.fluidCtrl.addAgent(
        enemy.x - this.battlefieldZone.x,
        enemy.y - this.battlefieldZone.y,
        e.vx,
        e.vy,
        this.enemySize * UI_SCALE
      );
      if (id >= 0) {
        e.aid = id;
        this.spriteById.set(id, enemy);
      }
    }

    // Увеличиваем счётчики
    this.enemyCount++;
    this.enemiesSpawned++;

    // Поддерживаем загон: пока осталось ≥ вместимости — загон полон
    // (толпа); иначе пустеет по мере спавна. Перераскладка заставляет
    // толпу «течь» вниз и редеть к хвосту (без дыр)
    const remaining = this.totalEnemiesToSpawn - this.enemiesSpawned;
    if (remaining >= this.penCapacity()) {
      this.addPenSprite(this.penCapacity());
    }
    this.relayoutPen();
  }

  // --- Генерация уровня ---

  private generateLevel(): void {
    const zone = this.battlefieldZone;
    this.level = this.levelGenerator.generate({
      seed: this.levelSeed,
      width: zone.width,
      height: zone.height,
      passageWidth: 60,
      obstacleDensity: this.genDensity,
      blobScale: this.genBlobScale,
      // Полоса загона сверху свободна от препятствий (+запас под спавн-джиттер)
      topFreeHeight: (GameScene.PEN_HEIGHT + 16) * UI_SCALE
    });
    this.renderObstacles();

    // Новая сетка коллизий и границы мира -> в воркер физики
    if (this.fluidCtrl?.isWorkerMode) {
      this.fluidCtrl.setField(this.level.getCollisionField());
      this.syncFluidWorld();
    }

    // Земля-барьер: пересоздать под новую сетку (ячейки и воркер сбрасываются
    // на set_field); нарисованная раньше земля не переносится между уровнями
    if (this.earthBarrier) {
      const cf = this.level.getCollisionField();
      this.earthBarrier.init(
        {
          cols: cf.cols,
          rows: cf.rows,
          cellSize: cf.cellSize,
          ox: this.battlefieldZone.x,
          oy: this.battlefieldZone.y,
          color: GameConfig.elements.earth.color
        },
        (cells, value) => { this.fluidCtrl?.setEarth(cells, value); }
      );
    }

    // Эффекты стихий (Итерация 4): оверлеи под ту же сетку; публикация
    // физических эффектов (вода/воздух) в воркер через setEffects
    if (this.elementFx) {
      const cf = this.level.getCollisionField();
      this.elementFx.init(
        {
          cols: cf.cols,
          rows: cf.rows,
          cellSize: cf.cellSize,
          ox: this.battlefieldZone.x,
          oy: this.battlefieldZone.y
        },
        (effect, cells, value, dirX, dirY) => {
          this.fluidCtrl?.setEffects(effect, cells, value, dirX, dirY);
        },
        { enemies: this.enemies, killEnemy: (e) => this.killEnemy(e) }
      );
    }

    // Загон монстров: очередь оставшихся у верхней кромки (пересоздаётся
    // под новый уровень/seed; нарисованные раньше монстры не переносятся)
    this.initPen();
  }

  private renderObstacles(): void {
    if (this.obstacleGraphics) {
      this.obstacleGraphics.destroy();
      this.obstacleGraphics = null;
    }
    const g = this.add.graphics();
    const ox = this.battlefieldZone.x;
    const oy = this.battlefieldZone.y;

    // Контур + сплошная заливка (по дизайн-доку)
    g.fillStyle(0x39445c, 1);
    g.lineStyle(2, 0xaebfdd, 0.9);
    for (const poly of this.level.obstacles) {
      if (poly.points.length < 3) continue;
      const pts = poly.points.map(p => new Phaser.Geom.Point(p.x + ox, p.y + oy));
      g.fillPoints(pts, true);
      g.strokePoints(pts, true);
    }
    this.obstacleGraphics = g;
  }

  /** Коллизия в мировых координатах: переводим в локальные поля боя */
  private isBlockedWorld(wx: number, wy: number): boolean {
    if (!this.level) return false;
    return this.level.isBlocked(
      wx - this.battlefieldZone.x,
      wy - this.battlefieldZone.y
    );
  }

  /** Полоса загона монстров (верх поля боя): стихии/силы туда не рисуются */
  private isInPen(_wx: number, wy: number): boolean {
    const z = this.battlefieldZone;
    return wy >= z.y && wy < z.y + GameScene.PEN_HEIGHT * UI_SCALE;
  }

  /** Где НЕЛЬЗЯ рисовать стихию: препятствия ИЛИ полоса загона.
   *  (для монстров движение идёт по isBlockedWorld без загона) */
  private isDrawBlocked(wx: number, wy: number): boolean {
    return this.isBlockedWorld(wx, wy) || this.isInPen(wx, wy);
  }

  /**
   * Коллизия по прямоугольнику вокруг центра (грубый хитбокс монстра),
   * а не по одной точке: крупные монстры не проваливаются в препятствия.
   * Точки выше края поля свободны (isBlocked вне сетки = false), поэтому
   * монстры корректно скользят вдоль верхних блобов ещё до входа в поле.
   */
  private isBlockedBox(wx: number, wy: number, r: number): boolean {
    return (
      this.isBlockedWorld(wx - r, wy - r) ||
      this.isBlockedWorld(wx + r, wy - r) ||
      this.isBlockedWorld(wx - r, wy + r) ||
      this.isBlockedWorld(wx + r, wy + r)
    );
  }

  /** Завершённый штрих: Земля -> барьер, прочие стихии -> зоны эффектов */
  private applyElementStroke(key: ElementType, points: StrokePoint[]): void {
    if (key === 'earth') {
      this.earthBarrier.addStroke(
        points,
        GameConfig.elements.earth.radius * UI_SCALE,
        GameConfig.earth.bitesPerCell
      );
      return;
    }
    this.elementFx.addStroke(points, key, this.strokeDirection(points));
  }

  /** Направление жеста рисования: от первой точки к последней (для воздуха) */
  private strokeDirection(points: StrokePoint[]): { x: number; y: number } {
    if (points.length === 0) return { x: 0, y: 1 };
    const a = points[0];
    const b = points[points.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-4) return { x: 0, y: 1 };
    return { x: dx / len, y: dy / len };
  }

  update(): void {
    // Диагностика: реальная длительность кадра (rAF-период, вкл. рендер)
    const now = performance.now();
    if (this.frameStartMs > 0) {
      const frame = now - this.frameStartMs;
      this.frameMs = this.frameMs === 0 ? frame : this.frameMs * 0.9 + frame * 0.1;
    }
    this.frameStartMs = now;
    this.updateStartMs = now;

    // Обновляем таймер спавна
    this.spawnTimer += this.game.loop.delta; // delta в мс
    
    // Спавн новых врагов, если нужно
    if (this.spawnTimer >= this.spawnInterval && 
        this.enemyCount < this.maxEnemiesOnScreen && 
        this.enemiesSpawned < this.totalEnemiesToSpawn) {
      this.createEnemy();
      this.spawnTimer = 0;
    }

    // Движение врагов: физика в воркере либо legacy main-thread путь
    if (this.fluidCtrl && this.fluidCtrl.isWorkerMode) {
      this.fluidCtrl.update(this.game.loop.delta / 1000);
    } else {
      this.updateEnemyMovement();
    }

    // Батч укусов земли: один проход за кадр со всеми атакующими
    // (одна публикация в воркер, обновляются только затронутые ячейки)
    if (this.pendingBiteCount > 0) {
      this.earthBarrier?.biteCellsAroundMany(
        this.pendingBites,
        this.pendingBiteCount,
        GameConfig.earth.biteRadius * UI_SCALE
      );
      this.pendingBiteCount = 0;
    }

    // Эффекты стихий (Итерация 4): истечение зон каждый кадр (дёшево),
    // тик статусов (горение/мокрый/цепной поджог) — с троттлингом ~10 Гц
    if (this.elementFx) {
      this.elementFx.update(now);
      if (now - this.lastFxTick >= FX_TICK_INTERVAL) {
        this.lastFxTick = now;
        this.elementFx.tickStatuses(now);
      }
    }

    // Обновляем debug информацию
    this.updateDebugInfo();

    // Условие победы: все монстры уровня заспавнены и поле чисто
    // (дошедшие до базы сняли HP, но убить их уже нельзя — они не в счёт)
    if (!this.victoryShown && !this.gameOverShown &&
        this.enemiesSpawned >= this.totalEnemiesToSpawn &&
        this.enemyCount === 0) {
      this.victoryShown = true;
      this.showVictory();
    }

    // Диагностика: длительность update() (скрипт main-потока, без рендера)
    const upd = performance.now() - this.updateStartMs;
    this.updateMs = this.updateMs === 0 ? upd : this.updateMs * 0.9 + upd * 0.1;
  }

  /**
   * Кадр из воркера: синхронизация позиций спрайтов + агенты,
   * достигшие базы (воркер уже освободил их слоты).
   */
  private handleFluidFrame = (info: FrameInfo): void => {
    const d = info.data;
    const ox = this.battlefieldZone.x;
    const oy = this.battlefieldZone.y;

    // Сглаженная метрика цены шага физики (для дебаг-панели)
    this.simStepMs = this.simStepMs === 0 ? info.stepMs : this.simStepMs * 0.9 + info.stepMs * 0.1;

    // Синк позиций: мерим только цикл setPosition — главный CPU-кандидат
    const syncT0 = performance.now();
    for (let i = 0; i < info.count; i++) {
      const o = i * OUT_STRIDE;
      const id = d[o];
      const sprite = this.spriteById.get(id);
      if (!sprite) continue;
      sprite.setPosition(ox + d[o + 1], oy + d[o + 2]);
    }
    const syncMs = performance.now() - syncT0;
    this.syncMs = this.syncMs === 0 ? syncMs : this.syncMs * 0.9 + syncMs * 0.1;

    for (let a = 0; a < info.arrivedCount; a++) {
      const id = info.arrived[a];
      const sprite = this.spriteById.get(id);
      this.spriteById.delete(id);
      if (sprite) {
        this.handleEnemyReachedBase(sprite);
      }
    }

    // Земля-барьер: монстры, атакующие землю, гибнут и грызут ячейки
    // (per-cell HP, bitesPerCell). Мана/заряд бога за эти смерти НЕ начисляются.
    // Укусы копятся в pendingBites и выполняются ОДНИМ проходом в update()
    // (вместо полной перерисовки барьера на каждого атакующего)
    for (let a = 0; a < info.attackCount; a++) {
      const id = info.attackIds[a];
      const sprite = this.spriteById.get(id);
      if (sprite && sprite.active) {
        this.killEnemy(sprite);
        this.pushPendingBite(sprite.x, sprite.y);
        // Вспышка укуса земли — как у базы, но в 2 раза меньше по радиусу
        this.createHitEffect(sprite.x, sprite.y, 0.5);
      }
    }
  };

  /** Копит позицию атакующего в переиспользуемом буфере (без аллокаций) */
  private pushPendingBite(x: number, y: number): void {
    if (this.pendingBiteCount >= this.pendingBites.length) {
      this.pendingBites.push({ x: 0, y: 0 });
    }
    const b = this.pendingBites[this.pendingBiteCount++];
    b.x = x;
    b.y = y;
  }

  private updateEnemyMovement(): void {
    const baseX = this.base.x;
    const baseY = this.base.y;
    const zone = this.battlefieldZone;
    const targetSpeed = this.enemySpeed * UI_SCALE;
    const minX = zone.x + 10 * UI_SCALE;
    const maxX = zone.x + zone.width - 10 * UI_SCALE;
    // Радиус хитбокса монстра (меньше визуального — прощающая коллизия)
    const hitR = Math.max(4, this.enemySize * 0.6) * UI_SCALE;
    // Обычный for вместо forEach: без замыканий и накладных расходов итератора
    const children = this.enemies.getChildren() as any[];

    for (let i = 0; i < children.length; i++) {
      const enemy = children[i];
      if (!enemy.active) continue; // «мёртвые» из пула пропускаем

      // Эффект воды (Итерация 4): в зоне скорость × slowFactor; после выхода
      // «мокрый» (и замедление) держится wetDuration секунд — паритет с воркером
      const dtSec = this.game.loop.delta / 1000;
      if (this.elementFx?.waterAt(enemy.x, enemy.y)) {
        enemy.wetRemain = GameConfig.elements.water.wetDuration ?? 5;
      } else if (enemy.wetRemain > 0) {
        enemy.wetRemain = Math.max(0, enemy.wetRemain - dtSec);
      }
      const inWater = this.elementFx?.waterAt(enemy.x, enemy.y) || enemy.wetRemain > 0;
      const ts = inWater
        ? targetSpeed * (GameConfig.elements.water.slowFactor ?? 0.5)
        : targetSpeed;
      const maxSpeed = ts * 1.05;

      // Земля-барьер (fallback): касающийся земли монстр атакует и гибнет,
      // грызя ячейки. Паритет с воркером (упреждающий хитбокс вниз)
      const look = Math.max(ts, hitR);
      if (
        (this.earthBarrier && this.earthBarrier.hasEarthAtBox(enemy.x, enemy.y, hitR)) ||
        (this.earthBarrier && this.earthBarrier.hasEarthAtBox(enemy.x, enemy.y + look, hitR))
      ) {
        this.killEnemy(enemy);
        this.earthBarrier.biteCellsAround(enemy.x, enemy.y, GameConfig.earth.biteRadius * UI_SCALE);
        // Вспышка укуса земли — как у базы, но в 2 раза меньше по радиусу
        this.createHitEffect(enemy.x, enemy.y, 0.5);
        continue;
      }

      // Вектор к базе
      const dx = baseX - enemy.x;
      const dy = baseY - enemy.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const dirX = distance > 0 ? dx / distance : 0;
      const dirY = distance > 0 ? dy / distance : 1;

      // Скорость к базе + минимальный шум
      let nvx = dirX * ts + Phaser.Math.FloatBetween(-0.01, 0.01) * UI_SCALE;
      let nvy = dirY * ts + Phaser.Math.FloatBetween(-0.01, 0.01) * UI_SCALE;

      const speed = Math.sqrt(nvx * nvx + nvy * nvy);
      if (speed > maxSpeed) {
        nvx = (nvx / speed) * maxSpeed;
        nvy = (nvy / speed) * maxSpeed;
      }

      // Погребён внутри блоба (уровень пересобран слайдерами) — телепорт
      // на спавн вместо копания вверх сквозь препятствия
      if (this.isBlockedWorld(enemy.x, enemy.y)) {
        enemy.setPosition(
          Phaser.Math.Between(zone.x + 20 * UI_SCALE, zone.x + zone.width - 20 * UI_SCALE),
          this.battlefieldZone.y - Phaser.Math.Between(20, 30) * UI_SCALE
        );
        enemy.vx = 0;
        enemy.vy = targetSpeed;
      }

      // Позиция с радиус-коллизией по сетке уровня (скольжение вдоль стен).
      // Проверяется прямоугольник вокруг центра, а не одна точка — иначе
      // крупные монстры визуально проваливаются в препятствия
      const nx = enemy.x + nvx;
      const ny = enemy.y + nvy;
      if (!this.isBlockedBox(nx, ny, hitR)) {
        enemy.x = nx;
        enemy.y = ny;
      } else if (!this.isBlockedBox(nx, enemy.y, hitR)) {
        enemy.x = nx;
        nvy = 0;
      } else if (!this.isBlockedBox(enemy.x, ny, hitR)) {
        enemy.y = ny;
        nvx = 0;
      }

      // Эффект воздуха (Итерация 4): инерция. В зоне дрейф к ветру,
      // вне зоны — затухает (постепенное торможение). Паритет с воркером.
      // ВАЖНО: вне зоны СОХРАНЯЕМ долю дрейфа (AIR_DAMP), а не (1 - AIR_DAMP)
      const wind = this.elementFx?.airAt(enemy.x, enemy.y);
      if (wind) {
        const wtx = wind.x * (GameConfig.elements.air.pushStrength ?? 1.5);
        const wty = wind.y * (GameConfig.elements.air.pushStrength ?? 1.5);
        enemy.driftX += (wtx - enemy.driftX) * AIR_RESPONSE;
        enemy.driftY += (wty - enemy.driftY) * AIR_RESPONSE;
      } else {
        enemy.driftX *= AIR_DAMP;
        enemy.driftY *= AIR_DAMP;
      }
      if (enemy.driftX * enemy.driftX + enemy.driftY * enemy.driftY > MIN_DRIFT_SQ) {
        const wx2 = enemy.x + enemy.driftX;
        const wy2 = enemy.y + enemy.driftY;
        if (!this.isBlockedBox(wx2, wy2, hitR)) {
          enemy.x = wx2;
          enemy.y = wy2;
        } else if (!this.isBlockedBox(wx2, enemy.y, hitR)) {
          enemy.x = wx2;
        } else if (!this.isBlockedBox(enemy.x, wy2, hitR)) {
          enemy.y = wy2;
        }
        nvx += enemy.driftX;
        nvy += enemy.driftY;
      }

      // Границы поля боя. Клэмп по верху УДАЛЕН: спавн выше экрана должен
      // свободно падать вниз — старый клэмп телепортировал свежих монстров
      // внутрь блобов у кромки, и они застревали
      if (enemy.x < minX) {
        enemy.x = minX;
        nvx = Math.abs(nvx) * 0.5;
      } else if (enemy.x > maxX) {
        enemy.x = maxX;
        nvx = -Math.abs(nvx) * 0.5;
      }

      enemy.vx = nvx;
      enemy.vy = nvy;

      // Достижение зоны базы
      if (this.baseZone.contains(enemy.x, enemy.y)) {
        this.handleEnemyReachedBase(enemy);
      }
    }
  }

  private handleEnemyReachedBase(enemy: any): void {
    // Визуальный эффект при достижении базы
    this.createHitEffect(enemy.x, enemy.y);

    // Уменьшаем здоровье базы
    this.baseHealth = Math.max(0, this.baseHealth - 1);
    this.updateBaseHealthFill();

    // Возвращаем врага в пул вместо уничтожения (нет нагрузки на GC)
    this.enemies.killAndHide(enemy);
    this.enemyCount--;

    // Если база разбита
    if (this.baseHealth <= 0) {
      this.showGameOver();
    }
  }

  /**
   * Финальная надпись уровня (ПОБЕДА/GAME OVER): плавно гаснет, чтобы
   * не перекрывала поле; состояние уровня сбрасывает её принудительно
   */
  private showEndMessage(message: string, color: string): void {
    if (this.endText) {
      this.endText.destroy();
      this.endText = null;
    }
    const t = this.add.text(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      message,
      {
        font: `${48 * UI_SCALE}px Arial`,
        color,
        stroke: '#000000',
        strokeThickness: 4 * UI_SCALE
      }
    );
    t.setOrigin(0.5).setDepth(1100);
    this.endText = t;

    this.tweens.add({
      targets: t,
      alpha: 0,
      delay: 1800,
      duration: 700,
      onComplete: () => {
        t.destroy();
        if (this.endText === t) {
          this.endText = null;
        }
      }
    });
  }

  private showGameOver(): void {
    this.gameOverShown = true;
    this.showEndMessage('Deus mortuus est', '#ff0000');
  }

  private showVictory(): void {
    this.showEndMessage('Deus vivit', '#ffd700');
  }
  
  private createHitEffect(x: number, y: number, radiusMul = 1): void {
    const effect = this.add.circle(x, y, 20 * UI_SCALE * radiusMul, 0xffff00);
    effect.setAlpha(0.7);
    
    this.tweens.add({
      targets: effect,
      scaleX: 2,
      scaleY: 2,
      alpha: 0,
      duration: 300,
      ease: 'Power2',
      onComplete: () => {
        effect.destroy();
      }
    });
  }

  private debugTextTimer: number = 0;

  // --- Диагностика производительности (дебаг-панель) ---
  /** Время начала предыдущего rAF-кадра (performance.now) */
  private frameStartMs = 0;
  /** Время старта текущего update() (для замера длительности) */
  private updateStartMs = 0;
  /** Реальная длительность кадра, вкл. рендер (EMA) */
  private frameMs = 0;
  /** Длительность update() — скрипт main-потока без рендера (EMA) */
  private updateMs = 0;
  /** Длительность цикла синка позиций из воркера (EMA) */
  private syncMs = 0;

  private updateDebugInfo(): void {
    // setText растеризует текст и заливает текстуру в GPU — делаем это
    // 4 раза в секунду, а не каждый кадр
    this.debugTextTimer += this.game.loop.delta;
    if (this.debugTextTimer < DEBUG_TEXT_INTERVAL) return;
    this.debugTextTimer = 0;

    if (!this.debugText) return;

    const simTag = this.fluidCtrl?.isWorkerMode ? 'W' : 'M';
    const agents = this.spriteById.size;
    const objects = this.sys.displayList.length;
    // DrawCalls есть не во всех версиях Phaser — опционально
    const renderer = this.game.renderer as any;
    const dc = typeof renderer?.drawCount === 'number' ? renderer.drawCount : -1;
    const dcStr = dc >= 0 ? ` | DC ${dc}` : '';

    this.debugText.setText([
      `FPS ${Math.round(this.game.loop.actualFps)} | Кадр ${this.frameMs.toFixed(1)}мс | Обн ${this.updateMs.toFixed(1)}мс`,
      `Sim${simTag} ${this.simStepMs.toFixed(1)}мс | Синк ${this.syncMs.toFixed(1)}мс`,
      `Агенты ${agents} | Объекты ${objects}${dcStr}`,
      `Земля ${this.earthBarrier?.cellCount() ?? 0} | Штрих ${this.elementDrawer.pointCount}`
    ]);

    // Позиционируем текст у верхнего края экрана
    this.placeDebugText();
  }

  // --- Настройки: кнопка и поп-ап ---
  private settingsButton: Phaser.GameObjects.Text | null = null;
  private settingsPopup: Phaser.GameObjects.Container | null = null;
  private settingsOpen: boolean = false;
  private popupUpdaters: Array<{ text: Phaser.GameObjects.Text, getValue: () => string }> = [];

  private createSettingsButton(): void {
    if (this.settingsButton) {
      this.settingsButton.destroy();
      this.settingsButton = null;
    }
    const wasOpen = this.settingsOpen;
    this.closeSettingsPopup();

    // Кнопка живёт в одной строке с дебаг-панелью и всегда внутри
    // игровой области: правый верхний угол поля боя
    const ga = this.gameArea;
    const btn = this.add.text(0, 0, '⚙', {
      font: `${fontPx(22)}px Arial`,
      color: '#ffffff',
      backgroundColor: '#333333',
      padding: { x: padPx(10), y: padPx(6) }
    }).setScrollFactor(0).setDepth(1000).setInteractive({ useHandCursor: true });
    btn.setPosition(ga.x + ga.width - btn.width - padPx(10), ga.y + padPx(4));
    btn.on('pointerdown', () => { this.toggleSettingsPopup(); });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#555555' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#333333' }));
    this.settingsButton = btn;

    if (wasOpen) {
      this.openSettingsPopup();
    }
  }

  private toggleSettingsPopup(): void {
    if (this.settingsOpen) {
      this.closeSettingsPopup();
    } else {
      this.openSettingsPopup();
    }
  }

  private closeSettingsPopup(): void {
    this.settingsOpen = false;
    if (this.settingsPopup) {
      this.settingsPopup.destroy(true);
      this.settingsPopup = null;
    }
    this.popupUpdaters = [];
  }

  private openSettingsPopup(): void {
    this.closeSettingsPopup();
    this.settingsOpen = true;

    const screenWidth = this.cameras.main.width;
    const screenHeight = this.cameras.main.height;

    const panelWidth = Math.min(fontPx(340), screenWidth * 0.92);
    const headerH = fontPx(46);
    const rowHeight = fontPx(28); // компактные строки (панель растёт с числом строк)
    const genBtnH = fontPx(48);
    const padBottom = padPx(16);
    // 9 строк спавна/генерации/силы бога + 8 строк баланса стихий/заряда
    // + 2 строки длительности стихий/статуса + строка сбросов
    const rowCount = 20;
    const panelHeight = headerH + rowCount * rowHeight + genBtnH + padBottom;
    const px = Math.round((screenWidth - panelWidth) / 2);
    const py = Math.round(Math.max(padPx(20), screenHeight * 0.06));

    const popup = this.add.container(0, 0).setScrollFactor(0).setDepth(1200);
    this.settingsPopup = popup;

    // Фон поп-апа
    const bg = this.add.graphics();
    bg.fillStyle(0x101822, 0.96);
    bg.fillRoundedRect(px, py, panelWidth, panelHeight, padPx(12));
    bg.lineStyle(padPx(2), 0x4a90d9, 1);
    bg.strokeRoundedRect(px, py, panelWidth, panelHeight, 12);
    popup.add(bg);

    // Заголовок
    popup.add(this.add.text(px + 16, py + 11, 'НАСТРОЙКИ', {
      font: `bold ${fontPx(17)}px Arial`,
      color: '#ffffff'
    }));

    // Кнопка закрытия
    const closeBtn = this.add.text(px + panelWidth - 38, py + 8, '✕', {
      font: `bold ${fontPx(16)}px Arial`,
      color: '#ff6666',
      backgroundColor: '#333333',
      padding: { x: padPx(8), y: padPx(2) }
    }).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerdown', () => { this.closeSettingsPopup(); });
    closeBtn.on('pointerover', () => closeBtn.setStyle({ backgroundColor: '#555555' }));
    closeBtn.on('pointerout', () => closeBtn.setStyle({ backgroundColor: '#333333' }));
    popup.add(closeBtn);

    // Строки контролов: метка параметра слева, [-] значение [+]+ справа
    let y = py + headerH;
    const btnW = fontPx(28);
    const valW = fontPx(62);
    const gap = padPx(4);
    const ctrlBlockW = btnW * 2 + valW + gap * 2;
    const x0 = px + padPx(14);

    const addRow = (label: string,
      minusCb: () => void,
      plusCb: () => void,
      getValue: () => string): void => {

      // Название параметра (что он делает) — слева
      popup.add(this.add.text(x0, y + padPx(3), label, {
        font: `${fontPx(12)}px Arial`,
        color: '#bbbbbb'
      }));

      // Блок управления прижат к правому краю панели
      const ctrlX = px + panelWidth - padPx(14) - ctrlBlockW;

      const minus = this.add.text(ctrlX, y, '-', {
        font: `${fontPx(14)}px Arial`,
        color: '#ff6666',
        backgroundColor: '#444444',
        padding: { x: padPx(9), y: padPx(3) }
      }).setInteractive({ useHandCursor: true });
      minus.on('pointerdown', () => { minusCb(); this.updatePopupValues(); });
      minus.on('pointerover', () => minus.setStyle({ backgroundColor: '#666666' }));
      minus.on('pointerout', () => minus.setStyle({ backgroundColor: '#444444' }));
      popup.add(minus);

      const valueText = this.add.text(ctrlX + btnW + gap + valW / 2, y + padPx(3), getValue(), {
        font: `bold ${fontPx(13)}px Arial`,
        color: '#ffffff'
      }).setOrigin(0.5, 0);
      popup.add(valueText);
      this.popupUpdaters.push({ text: valueText, getValue });

      const plus = this.add.text(ctrlX + btnW + gap + valW + gap, y, '+', {
        font: `${fontPx(14)}px Arial`,
        color: '#88ff88',
        backgroundColor: '#444444',
        padding: { x: padPx(9), y: padPx(3) }
      }).setInteractive({ useHandCursor: true });
      plus.on('pointerdown', () => { plusCb(); this.updatePopupValues(); });
      plus.on('pointerover', () => plus.setStyle({ backgroundColor: '#666666' }));
      plus.on('pointerout', () => plus.setStyle({ backgroundColor: '#444444' }));
      popup.add(plus);

      y += rowHeight;
    };

    // Интервал между спавнами монстров
    addRow('Интервал спавна, мс',
      () => { this.spawnInterval = Math.max(10, this.spawnInterval - 10); },
      () => { this.spawnInterval = Math.min(5000, this.spawnInterval + 10); },
      () => `${this.spawnInterval}`
    );

    // Уровень: N даёт N*100 монстров; победа открывает следующий
    addRow('Уровень (x100 монстров)',
      () => { this.setLevel(this.currentLevel - 1); },
      () => { this.setLevel(this.currentLevel + 1); },
      () => `${this.currentLevel} (${this.totalEnemiesToSpawn})`
    );

    // Одновременный лимит живых монстров (потолок = ёмкость физики)
    addRow('Максимум на экране',
      () => { this.maxEnemiesOnScreen = Math.max(10, this.maxEnemiesOnScreen - 10); },
      () => { this.maxEnemiesOnScreen = Math.min(MAX_AGENTS, this.maxEnemiesOnScreen + 10); },
      () => `${this.maxEnemiesOnScreen}`
    );

    // Базовая скорость движения одного монстра
    addRow('Скорость монстров',
      () => { this.enemySpeed = Math.max(0.1, this.enemySpeed - 0.05); this.syncFluidParams(); },
      () => { this.enemySpeed = Math.min(10, this.enemySpeed + 0.05); this.syncFluidParams(); },
      () => `${this.enemySpeed.toFixed(2)}`
    );

    // Визуальный размер монстра и его хитбокс
    addRow('Размер монстров',
      () => { this.enemySize = Math.max(2, this.enemySize - 1); this.applyEnemySizeToAll(); this.syncFluidParams(); },
      () => { this.enemySize = Math.min(50, this.enemySize + 1); this.applyEnemySizeToAll(); this.syncFluidParams(); },
      () => `${this.enemySize}`
    );

    // --- Параметры генерации уровня: пересборка на лету с тем же seed ---
    addRow('Плотность препятствий',
      () => { this.genDensity = Math.max(0.01, +(this.genDensity - 0.05).toFixed(2)); this.generateLevel(); },
      () => { this.genDensity = Math.min(2, +(this.genDensity + 0.05).toFixed(2)); this.generateLevel(); },
      () => this.genDensity.toFixed(2)
    );

    addRow('Размер структур',
      () => { this.genBlobScale = Math.max(0.1, +(this.genBlobScale - 0.1).toFixed(1)); this.generateLevel(); },
      () => { this.genBlobScale = Math.min(3, +(this.genBlobScale + 0.1).toFixed(1)); this.generateLevel(); },
      () => `x${this.genBlobScale.toFixed(1)}`
    );

    // --- Силы жидкости: в конфиге (GameConfig.enemies.fluid), из поп-апа
    // убраны как перегруз UI; тюнинг — через код/«Сброс сил» ---

    // --- Супер сила бога: балансные параметры (ГДД 2.5) ---
    // superChargeRequired тоже в конфиге (из поп-апа убран)
    const G = GameConfig.godPower;

    addRow('Убийств за молнию',
      () => { G.lightningKillCount = Math.max(1, G.lightningKillCount - 1); },
      () => { G.lightningKillCount = Math.min(100, G.lightningKillCount + 1); },
      () => `${G.lightningKillCount}`
    );

    addRow('Радиус супер атаки',
      () => { G.superRadius = Math.max(40, G.superRadius - 10); },
      () => { G.superRadius = Math.min(400, G.superRadius + 10); },
      () => `${G.superRadius}`
    );

    // Убийств молнией для полной зарядки бара (выше = медленнее заряд)
    addRow('Убийств на заряд бога',
      () => {
        G.superChargeRequired = Math.max(10, G.superChargeRequired - 10);
        this.godPower.onBalanceChanged();
        this.godIcon?.redraw();
      },
      () => {
        G.superChargeRequired = Math.min(500, G.superChargeRequired + 10);
        this.godPower.onBalanceChanged();
        this.godIcon?.redraw();
      },
      () => `${G.superChargeRequired}`
    );

    // --- Стихии: баланс (мана за убийство / стоимость / радиус штриха) ---

    // gainPerKill — общий для всех алтарей (0.1..2); конфиг остаётся per-altar
    addRow('Мана за убийство',
      () => {
        const v = +(GameConfig.elements.fire.gainPerKill - 0.1).toFixed(1);
        for (const k of ELEMENT_KEYS) GameConfig.elements[k].gainPerKill = Math.max(0.1, v);
      },
      () => {
        const v = +(GameConfig.elements.fire.gainPerKill + 0.1).toFixed(1);
        for (const k of ELEMENT_KEYS) GameConfig.elements[k].gainPerKill = Math.min(2, v);
      },
      () => GameConfig.elements.fire.gainPerKill.toFixed(1)
    );

    // costPerUse — отдельно у каждого алтаря (1..100); цена за юнит длины
    const costRows: Array<[ElementType, string]> = [
      ['fire', `Стоимость огня (${GameConfig.elementStrokeUnit}px)`],
      ['water', `Стоимость воды (${GameConfig.elementStrokeUnit}px)`],
      ['earth', `Стоимость земли (${GameConfig.elementStrokeUnit}px)`],
      ['air', `Стоимость воздуха (${GameConfig.elementStrokeUnit}px)`]
    ];
    for (const [key, label] of costRows) {
      addRow(label,
        () => {
          GameConfig.elements[key].costPerUse = Math.max(1, GameConfig.elements[key].costPerUse - 1);
          this.elementMana.onBalanceChanged();
        },
        () => {
          GameConfig.elements[key].costPerUse = Math.min(100, GameConfig.elements[key].costPerUse + 1);
          this.elementMana.onBalanceChanged();
        },
        () => `${GameConfig.elements[key].costPerUse}`
      );
    }

    // radius штриха — общий для всех алтарей (10..100)
    addRow('Радиус штриха',
      () => {
        const v = GameConfig.elements.fire.radius - 5;
        for (const k of ELEMENT_KEYS) GameConfig.elements[k].radius = Math.max(10, v);
      },
      () => {
        const v = GameConfig.elements.fire.radius + 5;
        for (const k of ELEMENT_KEYS) GameConfig.elements[k].radius = Math.min(100, v);
      },
      () => `${GameConfig.elements.fire.radius}`
    );

    // Прочность Земли: укусов держит ячейка (выше = грызут медленнее).
    // Прокачиваемый атрибут: пока ручка в поп-апе, экономика прокачки — потом
    addRow('Прочность земли (укусов)',
      () => { GameConfig.earth.bitesPerCell = Math.max(1, GameConfig.earth.bitesPerCell - 1); },
      () => { GameConfig.earth.bitesPerCell = Math.min(100, GameConfig.earth.bitesPerCell + 1); },
      () => `${GameConfig.earth.bitesPerCell}`
    );

    // --- Эффекты стихий (Итерация 4): длительность зоны Огонь/Вода/Воздух ---
    // Одна ручка на три стихии; конфиг остаётся per-element (duration) для
    // будущей раздельной прокачки времени каждой стихии
    addRow('Длительность стихий, с',
      () => { this.setElementDurations(GameConfig.elements.fire.duration - 1); },
      () => { this.setElementDurations(GameConfig.elements.fire.duration + 1); },
      () => `${GameConfig.elements.fire.duration}`
    );

    // Длительность статуса «мокрый»/«сдутый» после выхода из зоны
    // (вода/воздух). Конфиг per-element для будущей раздельной прокачки
    addRow('Длительность статуса, с',
      () => { this.setStatusDuration(GameConfig.elements.water.wetDuration - 1); },
      () => { this.setStatusDuration(GameConfig.elements.water.wetDuration + 1); },
      () => `${GameConfig.elements.water.wetDuration}`
    );

    // Кнопки сброса (в одну строку): силы и параметры генерации
    const rstY = y + padPx(4);
    const btnHw = (panelWidth - 28 - 8) / 2;

    const makeReset = (x: number, w: number, label: string, cb: () => void): void => {
      const bg = this.add.graphics();
      bg.fillStyle(0x444444, 1);
      bg.fillRoundedRect(x, rstY, w, fontPx(24), padPx(6));
      popup.add(bg);

      const label_ = this.add.text(x + w / 2, rstY + fontPx(12), label, {
        font: `bold ${fontPx(12)}px Arial`,
        color: '#dddddd'
      }).setOrigin(0.5);
      popup.add(label_);

      const zone = this.add.zone(x, rstY, w, fontPx(24)).setOrigin(0, 0)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerdown', cb);
      popup.add(zone);
    };

    makeReset(px + padPx(14), btnHw, 'Сброс сил', () => {
      Object.assign(GameConfig.enemies.fluid, FLUID_DEFAULTS);
      this.updatePopupValues();
      this.syncFluidParams();
    });
    makeReset(px + padPx(22), btnHw, 'Сброс генерации', () => {
      this.genDensity = 0.3;
      this.genBlobScale = 1;
      this.updatePopupValues();
      this.generateLevel();
    });
    y += rowHeight;

    // Кнопка генерации нового уровня
    const genY = y + padPx(6);
    const genBg = this.add.graphics();
    genBg.fillStyle(0x2e7d32, 1);
    genBg.fillRoundedRect(px + padPx(14), genY, panelWidth - padPx(28), fontPx(38), padPx(8));
    popup.add(genBg);

    const genLabel = this.add.text(px + panelWidth / 2, genY + fontPx(19), 'Сгенерировать уровень', {
      font: `bold ${fontPx(14)}px Arial`,
      color: '#ffffff'
    }).setOrigin(0.5);
    popup.add(genLabel);

    const genZone = this.add.zone(px + padPx(14), genY, panelWidth - padPx(28), fontPx(38)).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    genZone.on('pointerdown', () => { this.regenerateLevelWithNewSeed(); });
    popup.add(genZone);
  }

  private updatePopupValues(): void {
    this.popupUpdaters.forEach(u => { u.text.setText(u.getValue()); });
    // Каждое изменение в поп-апе сохраняется (новый уровень/перезагрузка
    // восстанавливают значения из TuningStore)
    this.persistTuning();
  }

  /** Снимок всех тюнящихся параметров (поля сцены + GameConfig) */
  private collectTuning(): TuningSnapshot {
    const elements = {} as TuningSnapshot['elements'];
    for (const k of ELEMENT_KEYS) {
      elements[k] = {
        gainPerKill: GameConfig.elements[k].gainPerKill,
        costPerUse: GameConfig.elements[k].costPerUse,
        radius: GameConfig.elements[k].radius
      };
    }
    return {
      spawnInterval: this.spawnInterval,
      currentLevel: this.currentLevel,
      maxEnemiesOnScreen: this.maxEnemiesOnScreen,
      enemySpeed: this.enemySpeed,
      enemySize: this.enemySize,
      genDensity: this.genDensity,
      genBlobScale: this.genBlobScale,
      godPower: {
        lightningKillCount: GameConfig.godPower.lightningKillCount,
        superRadius: GameConfig.godPower.superRadius,
        superChargeRequired: GameConfig.godPower.superChargeRequired
      },
      earth: {
        bitesPerCell: GameConfig.earth.bitesPerCell
      },
      effects: {
        duration: GameConfig.elements.fire.duration,
        statusDuration: GameConfig.elements.water.wetDuration ?? 5
      },
      elements
    };
  }

  /** Восстановление тюнинга из localStorage (при create/restart) */
  private applyStoredTuning(): void {
    const snap = TuningStore.load();
    if (!snap) return;

    if (typeof snap.spawnInterval === 'number') this.spawnInterval = snap.spawnInterval;
    if (typeof snap.currentLevel === 'number') {
      this.currentLevel = Phaser.Math.Clamp(Math.round(snap.currentLevel), 1, GameScene.MAX_LEVEL);
    }
    if (typeof snap.maxEnemiesOnScreen === 'number') {
      this.maxEnemiesOnScreen = Math.min(Math.max(10, snap.maxEnemiesOnScreen), MAX_AGENTS);
    }
    if (typeof snap.enemySpeed === 'number') this.enemySpeed = snap.enemySpeed;
    if (typeof snap.enemySize === 'number') this.enemySize = snap.enemySize;
    if (typeof snap.genDensity === 'number') this.genDensity = snap.genDensity;
    if (typeof snap.genBlobScale === 'number') this.genBlobScale = snap.genBlobScale;

    if (snap.godPower) {
      if (typeof snap.godPower.lightningKillCount === 'number') {
        GameConfig.godPower.lightningKillCount = snap.godPower.lightningKillCount;
      }
      if (typeof snap.godPower.superRadius === 'number') {
        GameConfig.godPower.superRadius = snap.godPower.superRadius;
      }
      if (typeof snap.godPower.superChargeRequired === 'number') {
        GameConfig.godPower.superChargeRequired = snap.godPower.superChargeRequired;
        this.godPower.onBalanceChanged();
        this.godIcon?.redraw();
      }
    }

    if (snap.elements) {
      for (const k of ELEMENT_KEYS) {
        const e = snap.elements[k];
        if (!e) continue;
        if (typeof e.gainPerKill === 'number') GameConfig.elements[k].gainPerKill = e.gainPerKill;
        if (typeof e.costPerUse === 'number') GameConfig.elements[k].costPerUse = e.costPerUse;
        if (typeof e.radius === 'number') GameConfig.elements[k].radius = e.radius;
      }
      this.elementMana.onBalanceChanged();
    }

    if (snap.earth && typeof snap.earth.bitesPerCell === 'number') {
      GameConfig.earth.bitesPerCell = Math.max(1, Math.round(snap.earth.bitesPerCell));
    }

    if (snap.effects && typeof snap.effects.duration === 'number') {
      this.setElementDurations(snap.effects.duration);
    }
    if (snap.effects && typeof snap.effects.statusDuration === 'number') {
      this.setStatusDuration(snap.effects.statusDuration);
    }
  }

  /** Сохранение текущего тюнинга в localStorage */
  private persistTuning(): void {
    TuningStore.save(this.collectTuning());
  }

  /** Применяет новый размер ко всем живым врагам (событийно, не каждый кадр) */
  private applyEnemySizeToAll(): void {
    const s = (this.enemySize * UI_SCALE) / ENEMY_TEX_RADIUS;
    const children = this.enemies.getChildren();
    for (let i = 0; i < children.length; i++) {
      (children[i] as any).setScale(s);
    }
  }

  /** Одинаковая длительность зоны Огонь/Вода/Воздух (будущая раздельная прокачка) */
  private setElementDurations(value: number): void {
    const d = Phaser.Math.Clamp(value, 1, 30);
    GameConfig.elements.fire.duration = d;
    GameConfig.elements.water.duration = d;
    GameConfig.elements.air.duration = d;
  }

  /** Одинаковая длительность статуса «мокрый»/«сдутый» (будущая раздельная) */
  private setStatusDuration(value: number): void {
    const d = Phaser.Math.Clamp(value, 0, 30);
    GameConfig.elements.water.wetDuration = d;
    GameConfig.elements.air.airDuration = d;
    this.syncFluidParams();
  }

  /** Новый seed и полный перезапуск сцены с новой генерацией уровня */
  private regenerateLevelWithNewSeed(): void {
    this.levelSeed = 'seed-' + Math.floor(Math.random() * 1e9).toString(36);
    this.closeSettingsPopup();
    this.scene.restart();
  }

  private setupInput(): void {
    // Тап по полю боя: победа -> следующий уровень, поражение -> рестарт уровня,
    // обычная молния либо (в режиме супер силы) супер атака.
    // При выбранной стихии pointerdown начинает потенциальный штрих,
    // решение «тап или рисование» принимается на pointerup.
    // Тапы по поп-апу настроек поле боя не затрагивают
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.settingsOpen) return;
      if (!this.battlefieldZone.contains(pointer.x, pointer.y)) return;

      if (this.victoryShown) {
        this.nextLevel();
        return;
      }
      if (this.gameOverShown) {
        this.restartLevel(true);
        return;
      }

      // Загон монстров: стихии и силы (молния/супер) сюда не рисуются/не бьют
      if (this.isInPen(pointer.x, pointer.y)) return;

      const armed = this.elementMana.armed;
      if (armed !== null) {
        // Бюджет штриха = столько юнитов, сколько можно оплатить маной
        const cfg = GameConfig.elements[armed];
        const unit = GameConfig.elementStrokeUnit * UI_SCALE;
        const units = Math.floor(this.elementMana.manaOf(armed) / cfg.costPerUse);
        this.strokeChargedLen = 0;
        this.elementDrawer.beginPotential(pointer.x, pointer.y, armed, cfg, units * unit);
        return;
      }

      this.fireGodTap(pointer.x, pointer.y);
    });

    // Рисование стихии: движение пальца ведёт линию; мана списывается
    // поюнитно в реальном времени (бар убывает прямо во время штриха)
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.elementDrawer?.active) return;
      const el = this.elementMana.armed;
      this.elementDrawer.onMove(pointer.x, pointer.y);
      if (el !== null) {
        this.chargeStrokeUnits(el);
      }
    });

    // Завершение штриха: линия уже нанесена и оплачена по мере рисования;
    // тап без движения — молния. Выбор алтаря СБРАСЫВАЕТСЯ только тапом
    // по полю или выбором другого алтаря — после штриха он сохраняется
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.elementDrawer?.active) return;
      const el = this.elementMana.armed;
      const res = this.elementDrawer.end();

      if (res === 'tap') {
        // Тап по полю при выбранной стихии = молния + снятие выбора
        this.elementMana.disarm();
        this.fireGodTap(pointer.x, pointer.y);
      } else {
        // 'draw': доплата за неполный хвостовой юнит (длина = цена ровно);
        // 'none': нарисовано нечего, мана не списывалась.
        // Выбор НЕ снимаем — можно рисовать следующий кусок без перевыбора
        if (res === 'draw' && el !== null) {
          this.settleStrokeUnits(el);
        }
      }
      this.refreshAltarBars();
    });
  }

  /** Тап по полю боя без стихии: супер атака или обычная молния (ГДД 2.5) */
  private fireGodTap(x: number, y: number): void {
    if (this.godPower.isArmed) {
      this.castSuperAttack(x, y);
    } else {
      this.castLightning(x, y);
    }
  }

  // --- Система уровней ---

  /** Выбор уровня в поп-апе: перезапуск с указанного уровня */
  private setLevel(level: number): void {
    this.currentLevel = Phaser.Math.Clamp(level, 1, GameScene.MAX_LEVEL);
    this.restartLevel(false);
    // Прогресс уровня запоминается и для победы (nextLevel), и для поп-апа
    this.persistTuning();
  }

  /** Победа: следующий уровень (на 100 монстров больше) */
  private nextLevel(): void {
    this.setLevel(this.currentLevel + 1);
  }

  /**
   * Перезапуск уровня: НОВЫЙ лабиринт (seed), снятие всех живых монстров,
   * сброс счётчиков спавна.
   * @param restoreHealth true только при рестарте после GAME OVER
   * (иначе мягкий лок); между уровнями HP базы НЕ восстанавливается
   */
  private restartLevel(restoreHealth: boolean): void {
    if (this.endText) {
      this.endText.destroy();
      this.endText = null;
    }
    // Каждый уровень — новая генерация
    this.levelSeed = 'seed-' + Math.floor(Math.random() * 1e9).toString(36);
    this.generateLevel();

    const children = this.enemies.getChildren() as any[];
    for (let i = 0; i < children.length; i++) {
      const e = children[i];
      if (e.active) {
        this.killEnemy(e);
      }
    }
    this.enemiesSpawned = 0;
    this.spawnTimer = 0;
    this.totalEnemiesToSpawn = this.currentLevel * GameScene.MONSTERS_PER_LEVEL_STEP;
    if (restoreHealth) {
      this.baseHealth = this.baseMaxHealth;
    }
    this.updateBaseHealthFill();
    // Заряд силы бога не переносится на новый уровень
    this.godPower.reset();
    this.godIcon?.redraw();
    // Мана стихий и нарисованные слои тоже не переносятся между уровнями
    this.elementMana.reset();
    this.elementDrawer.clearPersistent();
    this.refreshAltarBars();
    this.victoryShown = false;
    this.gameOverShown = false;
    this.showLevelBanner();
  }

  /** Баннер «УРОВЕНЬ N» по центру поля, плавно гаснет */
  private showLevelBanner(): void {
    const banner = this.add.text(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      `УРОВЕНЬ ${this.currentLevel}`,
      {
        font: `bold ${36 * UI_SCALE}px Arial`,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4 * UI_SCALE
      }
    ).setOrigin(0.5).setDepth(1100);

    this.tweens.add({
      targets: banner,
      alpha: 0,
      delay: 900,
      duration: 600,
      onComplete: () => { banner.destroy(); }
    });
  }

  /** Тап по иконке: включить/отменить режим супер силы (ГДД 2.5) */
  private toggleSuperMode(): void {
    if (this.godPower.isArmed) {
      this.godPower.disarm();
    } else {
      this.godPower.arm();
    }
    this.godIcon?.redraw();
  }

  /** Обычная атака бога: AOE-молния, убивает до lightningKillCount монстров */
  private castLightning(x: number, y: number): void {
    const gp = this.godPower;
    const radiusPx = gp.lightningRadius * UI_SCALE;
    const targets = this.captureTargets(x, y, radiusPx, gp.lightningKillCount);
    for (let i = 0; i < targets.length; i++) {
      this.killEnemy(targets[i]);
    }
    if (targets.length > 0) {
      gp.registerKills(targets.length);
      // Убийства наполняют ману каждого алтаря стихий
      this.elementMana.gainFromKills(targets.length);
      this.refreshAltarBars();
    }
    this.godIcon?.redraw();
    this.createWhiteFlash(x, y, radiusPx, false);
  }

  /** Супер атака: все монстры в радиусе superRadius погибают, бар сбрасывается */
  private castSuperAttack(x: number, y: number): void {
    const radiusCss = this.godPower.consume();
    if (radiusCss === null) return;
    const radiusPx = radiusCss * UI_SCALE;
    const targets = this.captureTargets(x, y, radiusPx, Infinity);
    for (let i = 0; i < targets.length; i++) {
      this.killEnemy(targets[i]);
    }
    if (targets.length > 0) {
      this.elementMana.gainFromKills(targets.length);
      this.refreshAltarBars();
    }
    this.godIcon?.redraw();
    this.createWhiteFlash(x, y, radiusPx, true);
  }

  /**
   * Живые монстры вокруг точки, отсортированные по удалению,
   * не более limit штук (limit=Infinity — без ограничения).
   */
  private captureTargets(x: number, y: number, radiusPx: number, limit: number): any[] {
    const r2 = radiusPx * radiusPx;
    const hits: Array<{ e: any; d2: number }> = [];
    const children = this.enemies.getChildren() as any[];
    for (let i = 0; i < children.length; i++) {
      const e = children[i];
      if (!e.active) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        hits.push({ e, d2 });
      }
    }
    hits.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(hits.length, limit);
    const out: any[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = hits[i].e;
    }
    return out;
  }

  /** Уничтожение монстра: снятие с физики + возврат спрайта в пул */
  private killEnemy(enemy: any): void {
    const aid: number = enemy.aid ?? -1;
    if (aid >= 0 && this.fluidCtrl?.isWorkerMode) {
      this.fluidCtrl.removeAgent(aid);
      this.spriteById.delete(aid);
    }
    this.enemies.killAndHide(enemy);
    this.enemyCount--;
  }

  /** Белая вспышка бога: ядро + расширяющееся кольцо зоны поражения.
   *  Масштаб вместо tween radius: сеттер Arc.radius после destroy()
   *  обращается к занулённой геометрии и роняет кадр (Phaser 3.55) */
  private createWhiteFlash(x: number, y: number, radiusPx: number, isSuper: boolean): void {
    const coreR = radiusPx * (isSuper ? 0.45 : 0.35);
    const coreScale = radiusPx / coreR;
    const core = this.add.circle(x, y, coreR, 0xffffff, 0.95).setDepth(900);
    const ringR = coreR;
    const ring = this.add.circle(x, y, ringR, 0xffffff, 0)
      .setStrokeStyle(isSuper ? 6 * UI_SCALE : 3 * UI_SCALE, 0xffffff, 0.9)
      .setDepth(900);

    this.tweens.add({
      targets: core,
      scaleX: coreScale,
      scaleY: coreScale,
      alpha: 0,
      duration: isSuper ? 320 : 240,
      ease: 'Quad.easeOut',
      onComplete: () => { core.destroy(); }
    });
    this.tweens.add({
      targets: ring,
      scaleX: coreScale,
      scaleY: coreScale,
      alpha: 0,
      duration: isSuper ? 460 : 340,
      ease: 'Cubic.easeOut',
      onComplete: () => { ring.destroy(); }
    });
  }
  
  private setupCamera(): void {
    const camera = this.cameras.main;

    // Камера должна видеть ВЕСЬ экран (включая чёрные зоны для арта)
    camera.setBounds(0, 0, this.cameras.main.width, this.cameras.main.height);

    // Центрируем камеру на игровом поле (9:19.5)
    if (this.gameArea) {
      camera.centerOn(
        this.gameArea.x + this.gameArea.width / 2,
        this.gameArea.y + this.gameArea.height / 2
      );
    }

    camera.setZoom(1.0);
    camera.setRoundPixels(true);
  }
}
