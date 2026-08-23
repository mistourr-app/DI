import Phaser from 'phaser';
import { LevelGenerator } from '../game/generation/LevelGenerator';
import { FluidSimulationController, type FrameInfo } from '../game/fluid/FluidSimulationController';
import { MAX_AGENTS, OUT_STRIDE, type FluidParams } from '../game/fluid/fluidProtocol';
import { GameConfig } from '../game/config/GameConfig';
import { UI_SCALE, fontPx, padPx } from '../game/config/uiScale';

// Радиус круга в текстуре 'enemy' (SVG 20x20, circle r=8) — для масштабирования
const ENEMY_TEX_RADIUS = 8;
// Период обновления дебаг-текста, мс (setText растеризует текстуру — нельзя каждый кадр)
const DEBUG_TEXT_INTERVAL = 250;
// Границы адаптивного кегля дебаг-панели (в игровых px = css * UI_SCALE)
const DEBUG_FONT_MAX = Math.round(16 * UI_SCALE);
const DEBUG_FONT_MIN = Math.round(9 * UI_SCALE);
// Заводские множители сил жидкости — для кнопки сброса слайдеров
const FLUID_DEFAULTS = { ...GameConfig.enemies.fluid };

export class GameScene extends Phaser.Scene {
  private enemies!: Phaser.GameObjects.Group;
  private base!: Phaser.GameObjects.Rectangle;
  private debugText!: Phaser.GameObjects.Text;
  
  // Зоны экрана
  private battlefieldZone!: Phaser.Geom.Rectangle;
  private baseZone!: Phaser.Geom.Rectangle;
  private gameArea!: Phaser.Geom.Rectangle;
  private battlefieldGraphics!: Phaser.GameObjects.Graphics;
  private baseZoneGraphics!: Phaser.GameObjects.Graphics;
  
  // Настройки спавна врагов
  private totalEnemiesToSpawn: number = 25000;  // Общее количество монстров для спавна
  private enemiesSpawned: number = 0;        // Сколько уже заспавнено
  private maxEnemiesOnScreen: number = 1000;   // Максимум на экране
  private enemyCount: number = 0;           // Текущее количество на экране
  
  // Здоровье базы
  private baseHealth: number = 1000;        // Начальное здоровье базы
  private baseMaxHealth: number = 1000;     // Максимальное здоровье
  
  // Таймеры
  private spawnTimer: number = 0;           // Таймер для спавна
  private spawnInterval: number = 30;       // Интервал спавна (мс)
  
  // Настройки монстров
  private enemySpeed: number = 0.5;        // Базовая скорость монстров
  private enemySize: number = 5;           // Размер монстров

  // Уровень (генерация по seed)
  private levelGenerator!: LevelGenerator;
  private level!: ReturnType<LevelGenerator['generate']>;
  private obstacleGraphics: Phaser.GameObjects.Graphics | null = null;
  private levelSeed: string = 'seed-' + Math.floor(Math.random() * 1e9).toString(36);
  private spawnGateIdx: number = 0; // раунд-робин по входам
  // Параметры генерации (крутятся в дебаг поп-апе)
  private genDensity: number = 1.1;
  private genBlobScale: number = 0.3;

  // Fluid simulation: физика толпы в воркере (fallback — main-thread путь)
  private fluidCtrl!: FluidSimulationController;
  private spriteById = new Map<number, Phaser.GameObjects.Image>();
  // Сглаженная длительность шага воркера, мс (EMA по кадрам)
  private simStepMs: number = 0;
  /** Текущий кегль дебаг-панели (чтобы не дёргать setStyle без изменений) */
  private debugFontSize: number = 0;

  // Константы
  private static readonly BATTLEFIELD_RATIO = 5 / 6;
  private static readonly BASE_RATIO = 1 / 6;
  private static readonly COLOR_BATTLEFIELD_BG = 0x0a0a1a;
  private static readonly COLOR_BASE_BG = 0x0a1a0a;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload(): void {
    // Временные ассеты для прототипа
    this.load.image('enemy', 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iOCIgZmlsbD0iI0ZGMDAwMCIvPgo8L3N2Zz4=');
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

    // Создаем группу для врагов
    this.enemies = this.add.group();

    // Инициализируем счётчики
    this.enemyCount = 0;
    this.enemiesSpawned = 0;
    this.baseHealth = this.baseMaxHealth;
    this.spawnTimer = 0;

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
      alignment: f.alignment
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

    if (this.battlefieldGraphics) this.battlefieldGraphics.destroy();
    if (this.baseZoneGraphics) this.baseZoneGraphics.destroy();

    this.createZoneVisuals();

    if (this.base) this.base.destroy();
    this.createBase();
    this.createElements();

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

    // 1. Чёрный фон на ВЕСЬ экран (для арта окружения)
    const background = this.add.graphics();
    background.fillStyle(0x000000, 1);
    background.fillRect(0, 0, screenWidth, screenHeight);

    // 2. Игровое поле (9:19.5)
    if (this.gameArea) {
      const gameAreaGraphics = this.add.graphics();
      gameAreaGraphics.fillStyle(0x1a1a2e, 1);
      gameAreaGraphics.fillRect(
        this.gameArea.x,
        this.gameArea.y,
        this.gameArea.width,
        this.gameArea.height
      );
    }

    // 3. Поле боя
    this.battlefieldGraphics = this.add.graphics();
    this.battlefieldGraphics.fillStyle(GameScene.COLOR_BATTLEFIELD_BG, 1);
    this.battlefieldGraphics.fillRect(
      this.battlefieldZone.x,
      this.battlefieldZone.y,
      this.battlefieldZone.width,
      this.battlefieldZone.height
    );

    // 4. Зона базы
    this.baseZoneGraphics = this.add.graphics();
    this.baseZoneGraphics.fillStyle(GameScene.COLOR_BASE_BG, 1);
    this.baseZoneGraphics.fillRect(
      this.baseZone.x,
      this.baseZone.y,
      this.baseZone.width,
      this.baseZone.height
    );

    // 5. Разделительная линия между полем боя и базой
    const divider = this.add.graphics();
    divider.lineStyle(1 * UI_SCALE, 0x00ffff, 0.3);
    divider.beginPath();
    divider.moveTo(this.baseZone.x, this.baseZone.y);
    divider.lineTo(this.baseZone.x + this.baseZone.width, this.baseZone.y);
    divider.strokePath();
  }
  
  private createBase(): void {
    // База в центре зоны базы
    const baseX = this.baseZone.x + this.baseZone.width / 2;
    const baseY = this.baseZone.y + this.baseZone.height / 2;

    // Адаптивный размер базы
    const baseSize = Math.min(this.baseZone.width, this.baseZone.height) * 0.2;
    const fontSize = Math.max(16 * UI_SCALE, baseSize * 0.4);

    this.base = this.add.rectangle(
      baseX,
      baseY,
      baseSize,
      baseSize,
      0x00ffff
    );
    this.base.setStrokeStyle(3 * UI_SCALE, 0xffffff);

    // Текст "БАЗА"
    const baseText = this.add.text(baseX, baseY, 'БАЗА', {
      font: `${fontSize}px Arial`,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3 * UI_SCALE
    });
    baseText.setOrigin(0.5);
  }
  
  private createElements(): void {
    const zone = this.baseZone;
    const centerX = zone.x + zone.width / 2;
    const centerY = zone.y + zone.height / 2;
    
    // 5 элементов в ряд: Огонь, Вода, База, Земля, Воздух
    const elements = [
      { offset: -2, color: 0xff5500, emoji: '🔥', name: 'Огонь' },
      { offset: -1, color: 0x0066ff, emoji: '💧', name: 'Вода' },
      { offset: 0, color: 0x00ffff, emoji: '🏰', name: 'База' },
      { offset: 1, color: 0x8b4513, emoji: '🌍', name: 'Земля' },
      { offset: 2, color: 0x87ceeb, emoji: '💨', name: 'Воздух' }
    ];
    
    // Адаптивный размер элементов в зависимости от ширины зоны
    const baseElementSize = Math.min(zone.width / 8, 50 * UI_SCALE); // Максимум 50 css px
    const elementSpacing = baseElementSize * 1.5;
    const elementRadius = baseElementSize / 2;

    // Адаптивный размер шрифта
    const fontSize = Math.max(14 * UI_SCALE, baseElementSize * 0.5);
    const labelFontSize = Math.max(10 * UI_SCALE, baseElementSize * 0.3);
    
    elements.forEach(element => {
      const elementX = centerX + (element.offset * elementSpacing);
      const elementY = centerY;
      
      // Для базы - уже создана, пропускаем
      if (element.name === 'База') return;
      
      // Круг стихии
      const elementCircle = this.add.circle(elementX, elementY, elementRadius, element.color);
      elementCircle.setStrokeStyle(2 * UI_SCALE, 0xffffff);

      // Эмодзи стихии
      const emoji = this.add.text(elementX, elementY, element.emoji, {
        font: `${fontSize}px Arial`,
        color: '#ffffff'
      });
      emoji.setOrigin(0.5);

      // Название стихии
      const nameLabel = this.add.text(elementX, elementY + elementRadius + 10 * UI_SCALE, element.name, {
        font: `${labelFontSize}px Arial`,
        color: '#cccccc',
        align: 'center'
      });
      nameLabel.setOrigin(0.5);
      
      // Делаем интерактивным
      elementCircle.setInteractive();
      elementCircle.on('pointerdown', () => {
        elementCircle.setStrokeStyle(3, 0xffff00);
        this.time.delayedCall(300, () => {
          elementCircle.setStrokeStyle(2, 0xffffff);
        });
      });
    });
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

    // Самая длинная строка панели ~38 символов; моноширинный глиф ~0.62 кегля
    const avail = this.gameArea.width - 16 - 52;
    let size = DEBUG_FONT_MAX;
    while (size > DEBUG_FONT_MIN && size * 0.62 * 38 > avail) size--;

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

  private createEnemy(): void {
    // Враги спаунятся НАД верхней границей поля боя (выше экрана).
    // Блобы теперь начинаются от самой кромки — даём запас, чтобы
    // появление было видно до первого столкновения
    const spawnY = this.battlefieldZone.y - 32 * UI_SCALE;

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

    // Пул: переиспользуем «мёртвых» врагов вместо создания/уничтожения.
    // Image с общей текстурой батчится WebGL в ОДИН draw call на всех,
    // в отличие от Arc-фигур, которые рисуются каждая отдельно.
    let enemy = this.enemies.getFirstDead(false) as Phaser.GameObjects.Image | null;
    if (!enemy) {
      enemy = this.add.image(x, y, 'enemy');
      this.enemies.add(enemy);
    } else {
      enemy.setPosition(x, y).setActive(true).setVisible(true);
    }
    enemy.setScale((this.enemySize * UI_SCALE) / ENEMY_TEX_RADIUS);
    enemy.setAlpha(1);

    // Скорость — обычные свойства объекта (Data Manager заметно медленнее)
    const e = enemy as any;
    e.vx = Phaser.Math.FloatBetween(-0.1, 0.1) * UI_SCALE;
    e.vy = this.enemySpeed * UI_SCALE;
    e.aid = -1;

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
      blobScale: this.genBlobScale
    });
    this.renderObstacles();

    // Новая сетка коллизий и границы мира -> в воркер физики
    if (this.fluidCtrl?.isWorkerMode) {
      this.fluidCtrl.setField(this.level.getCollisionField());
      this.syncFluidWorld();
    }
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

  update(): void {
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

    // Обновляем debug информацию
    this.updateDebugInfo();
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

    for (let i = 0; i < info.count; i++) {
      const o = i * OUT_STRIDE;
      const id = d[o];
      const sprite = this.spriteById.get(id);
      if (!sprite) continue;
      sprite.setPosition(ox + d[o + 1], oy + d[o + 2]);
    }

    for (let a = 0; a < info.arrivedCount; a++) {
      const id = info.arrived[a];
      const sprite = this.spriteById.get(id);
      this.spriteById.delete(id);
      if (sprite) {
        this.handleEnemyReachedBase(sprite);
      }
    }
  };

  private updateEnemyMovement(): void {
    const baseX = this.base.x;
    const baseY = this.base.y;
    const zone = this.battlefieldZone;
    const targetSpeed = this.enemySpeed * UI_SCALE;
    const maxSpeed = targetSpeed * 1.05;
    const minX = zone.x + 10 * UI_SCALE;
    const maxX = zone.x + zone.width - 10 * UI_SCALE;
    // Радиус хитбокса монстра (меньше визуального — прощающая коллизия)
    const hitR = Math.max(4, this.enemySize * 0.6) * UI_SCALE;
    // Обычный for вместо forEach: без замыканий и накладных расходов итератора
    const children = this.enemies.getChildren() as any[];

    for (let i = 0; i < children.length; i++) {
      const enemy = children[i];
      if (!enemy.active) continue; // «мёртвые» из пула пропускаем

      // Вектор к базе
      const dx = baseX - enemy.x;
      const dy = baseY - enemy.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const dirX = distance > 0 ? dx / distance : 0;
      const dirY = distance > 0 ? dy / distance : 1;

      // Скорость к базе + минимальный шум
      let nvx = dirX * targetSpeed + Phaser.Math.FloatBetween(-0.01, 0.01) * UI_SCALE;
      let nvy = dirY * targetSpeed + Phaser.Math.FloatBetween(-0.01, 0.01) * UI_SCALE;

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

    // Возвращаем врага в пул вместо уничтожения (нет нагрузки на GC)
    this.enemies.killAndHide(enemy);
    this.enemyCount--;

    // Если база разбита
    if (this.baseHealth <= 0) {
      this.showGameOver();
    }
  }

  private showGameOver(): void {
    const gameOverText = this.add.text(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      'GAME OVER!',
      {
        font: '${48 * UI_SCALE}px Arial',
        color: '#ff0000',
        stroke: '#000000',
        strokeThickness: 4 * UI_SCALE
      }
    );
    gameOverText.setOrigin(0.5);
  }
  
  private createHitEffect(x: number, y: number): void {
    const effect = this.add.circle(x, y, 20 * UI_SCALE, 0xffff00);
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

  private updateDebugInfo(): void {
    // setText растеризует текст и заливает текстуру в GPU — делаем это
    // 4 раза в секунду, а не каждый кадр
    this.debugTextTimer += this.game.loop.delta;
    if (this.debugTextTimer < DEBUG_TEXT_INTERVAL) return;
    this.debugTextTimer = 0;

    if (!this.debugText) return;
    
    const healthPercent = Math.round((this.baseHealth / this.baseMaxHealth) * 100);
    
    // Компактный текст в 3 строки (расчётная ширина ~38 символов — см. placeDebugText)
    const simTag = this.fluidCtrl?.isWorkerMode ? 'W' : 'M';
    this.debugText.setText([
      `HP: ${this.baseHealth}/${this.baseMaxHealth} (${healthPercent}%)`,
      `Монстры: ${this.enemyCount}/${this.maxEnemiesOnScreen} | Интервал: ${this.spawnInterval}мс`,
      `Sim${simTag}: ${this.simStepMs.toFixed(1)}мс | Всего: ${this.enemiesSpawned} | FPS: ${Math.round(this.game.loop.actualFps)}`
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
    const rowHeight = fontPx(34);
    const genBtnH = fontPx(48);
    const padBottom = padPx(16);
    // 5 параметров спавна + 2 генерации + 4 силы + строка сбросов
    const panelHeight = headerH + 12 * rowHeight + genBtnH + padBottom;
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

    // Общее число монстров за уровень (шаг растёт с величиной — до 100k без ста кликов)
    const totalStep = this.totalEnemiesToSpawn >= 10000 ? 1000 : 100;
    addRow('Всего монстров, тыс.',
      () => { this.totalEnemiesToSpawn = Math.max(100, this.totalEnemiesToSpawn - totalStep); },
      () => { this.totalEnemiesToSpawn += totalStep; },
      () => `${Math.floor(this.totalEnemiesToSpawn / 1000)}K`
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

    // --- Силы жидкости: тюнинг в реальном времени (мутаторы GameConfig -> syncFluidParams) ---
    const F = GameConfig.enemies.fluid;

    // Разлетаются ли монстры при сближении (анти-стопки)
    addRow('Расталкивание',
      () => { F.separation = Math.max(0, +(F.separation - 0.25).toFixed(2)); this.syncFluidParams(); },
      () => { F.separation = Math.min(6, +(F.separation + 0.25).toFixed(2)); this.syncFluidParams(); },
      () => F.separation.toFixed(2)
    );

    // Распирание плотных мест толпы
    addRow('Давление в толпе',
      () => { F.pressure = Math.max(0, +(F.pressure - 0.05).toFixed(2)); this.syncFluidParams(); },
      () => { F.pressure = Math.min(2, +(F.pressure + 0.05).toFixed(2)); this.syncFluidParams(); },
      () => F.pressure.toFixed(2)
    );

    // Согласованность движения, гладкость потока
    addRow('Вязкость потока',
      () => { F.viscosity = Math.max(0, +(F.viscosity - 0.001).toFixed(3)); this.syncFluidParams(); },
      () => { F.viscosity = Math.min(0.05, +(F.viscosity + 0.001).toFixed(3)); this.syncFluidParams(); },
      () => F.viscosity.toFixed(3)
    );

    // Держатся ли рукава потока вместе
    addRow('Сплочённость потока',
      () => { F.cohesion = Math.max(0, +(F.cohesion - 0.1).toFixed(2)); this.syncFluidParams(); },
      () => { F.cohesion = Math.min(3, +(F.cohesion + 0.1).toFixed(2)); this.syncFluidParams(); },
      () => F.cohesion.toFixed(2)
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
      this.genDensity = 1.1;
      this.genBlobScale = 0.3;
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
  }

  /** Применяет новый размер ко всем живым врагам (событийно, не каждый кадр) */
  private applyEnemySizeToAll(): void {
    const s = (this.enemySize * UI_SCALE) / ENEMY_TEX_RADIUS;
    const children = this.enemies.getChildren();
    for (let i = 0; i < children.length; i++) {
      (children[i] as any).setScale(s);
    }
  }

  /** Новый seed и полный перезапуск сцены с новой генерацией уровня */
  private regenerateLevelWithNewSeed(): void {
    this.levelSeed = 'seed-' + Math.floor(Math.random() * 1e9).toString(36);
    this.closeSettingsPopup();
    this.scene.restart();
  }

  private setupInput(): void {
    // Тап в поле боя - добавляет врагов
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // Проверяем, что тап в поле боя
      if (this.battlefieldZone.contains(pointer.x, pointer.y)) {
        for (let i = 0; i < 3; i++) {
          this.createEnemy();
        }
        
        // Визуальный feedback
        this.createTapEffect(pointer.x, pointer.y);
      }
    });
  }
  
  private createTapEffect(x: number, y: number): void {
    const circle1 = this.add.circle(x, y, 10 * UI_SCALE, 0x00ffff, 0.5);
    const circle2 = this.add.circle(x, y, 5 * UI_SCALE, 0xffffff, 0.7);
    
    this.tweens.add({
      targets: circle1,
      radius: 40 * UI_SCALE,
      alpha: 0,
      duration: 400,
      ease: 'Power2',
      onComplete: () => circle1.destroy()
    });
    
    this.tweens.add({
      targets: circle2,
      radius: 20 * UI_SCALE,
      alpha: 0,
      duration: 300,
      ease: 'Power2',
      delay: 50,
      onComplete: () => circle2.destroy()
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
