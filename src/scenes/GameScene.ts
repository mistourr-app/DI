import Phaser from 'phaser';

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

    // Debug текст для информации
    this.createDebugText();

    // Панель контролов для дебага (вне игрового поля)
    this.createDebugControls();

    // Настраиваем управление
    this.setupInput();
    
    // Настраиваем камеру
    this.setupCamera();
    
    // Добавляем обработчик изменения размера окна
    this.scale.on('resize', this.handleResize, this);
  }
  
  private handleResize(gameSize: Phaser.Structs.Size): void {
    const width = gameSize.width;
    const height = gameSize.height;

    this.cameras.main.setSize(width, height);
    this.setupScreenZones();

    if (this.battlefieldGraphics) this.battlefieldGraphics.destroy();
    if (this.baseZoneGraphics) this.baseZoneGraphics.destroy();

    this.createZoneVisuals();

    if (this.base) this.base.destroy();
    this.createBase();
    this.createElements();

    // Пересоздаем панель дебаг-контролов при изменении размера
    this.createDebugControls();

    // Обновляем позицию дебаг текста
    if (this.debugText && this.gameArea) {
      this.debugText.setPosition(this.gameArea.x + 10, this.gameArea.y + 10);
    }

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
    divider.lineStyle(1, 0x00ffff, 0.3);
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
    const fontSize = Math.max(16, baseSize * 0.4);
    
    this.base = this.add.rectangle(
      baseX,
      baseY,
      baseSize,
      baseSize,
      0x00ffff
    );
    this.base.setStrokeStyle(3, 0xffffff);
    
    // Текст "БАЗА"
    const baseText = this.add.text(baseX, baseY, 'БАЗА', {
      font: `${fontSize}px Arial`,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3
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
    const baseElementSize = Math.min(zone.width / 8, 50); // Максимум 50px
    const elementSpacing = baseElementSize * 1.5;
    const elementRadius = baseElementSize / 2;
    
    // Адаптивный размер шрифта
    const fontSize = Math.max(14, baseElementSize * 0.5);
    const labelFontSize = Math.max(10, baseElementSize * 0.3);
    
    elements.forEach(element => {
      const elementX = centerX + (element.offset * elementSpacing);
      const elementY = centerY;
      
      // Для базы - уже создана, пропускаем
      if (element.name === 'База') return;
      
      // Круг стихии
      const elementCircle = this.add.circle(elementX, elementY, elementRadius, element.color);
      elementCircle.setStrokeStyle(2, 0xffffff);
      
      // Эмодзи стихии
      const emoji = this.add.text(elementX, elementY, element.emoji, {
        font: `${fontSize}px Arial`,
        color: '#ffffff'
      });
      emoji.setOrigin(0.5);
      
      // Название стихии
      const nameLabel = this.add.text(elementX, elementY + elementRadius + 10, element.name, {
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
    // Позиционируем в левом верхнем углу игрового поля (9:19.5)
    const debugX = this.gameArea ? this.gameArea.x + 10 : 10;
    const debugY = this.gameArea ? this.gameArea.y + 10 : 10;
    
    this.debugText = this.add.text(debugX, debugY, '', {
      font: '16px monospace',
      color: '#ffffff',
      backgroundColor: '#00000080',
      padding: { x: 8, y: 4 }
    });
    // Поднимаем текст на максимальный depth, чтобы был выше всех монстров
    this.debugText.setDepth(1000);
    // Если gameArea есть, то текст будет внутри игрового поля
    // Если нет — в углу экрана
  }

  private createEnemy(): void {
    // Враги спаунятся НАД верхней границей поля боя (выше экрана)
    const spawnY = this.battlefieldZone.y - 20; // 20 пикселей выше верхней границы поля боя
    
    const x = Phaser.Math.Between(
      this.battlefieldZone.x + 20,
      this.battlefieldZone.x + this.battlefieldZone.width - 20
    );
    
    const y = Phaser.Math.Between(
      spawnY - 10,
      spawnY + 10
    );

    // Создаем врага с настраиваемым размером
    const enemy = this.add.circle(x, y, this.enemySize, 0xff0000);
    
    // Увеличиваем счётчики
    this.enemyCount++;
    this.enemiesSpawned++;
    
    // Начальная скорость с настройками (движение вниз к базе)
    enemy.setData('velocity', {
      x: Phaser.Math.FloatBetween(-0.1, 0.1),
      y: this.enemySpeed
    });
    
    enemy.setStrokeStyle(2, 0xff5555);

    this.enemies.add(enemy);
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

    // Обновляем движение врагов
    this.updateEnemyMovement();

    // Обновляем debug информацию
    this.updateDebugInfo();
  }

  private updateEnemyMovement(): void {
    const baseX = this.base.x;
    const baseY = this.base.y;

    this.enemies.getChildren().forEach((enemy: any) => {
      // Хранимые данные врага
      let velocity = enemy.getData('velocity');
      
      // Инициализация при первом создании
      if (!velocity) {
        velocity = { x: 0, y: this.enemySpeed };
      }
      
      // Vector к базе
      const dx = baseX - enemy.x;
      const dy = baseY - enemy.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Нормализованное направление к базе
      const dirX = distance > 0 ? dx / distance : 0;
      const dirY = distance > 0 ? dy / distance : 1;
      
      // Базовая скорость движения к базе
      const targetSpeed = this.enemySpeed;
      
      // Прямо задаём скорость как вектор к базе (без накопления!)
      // 90% скорости идёт прямо к базе, 10% случайное отклонение
      velocity.x = dirX * targetSpeed;
      velocity.y = dirY * targetSpeed;
      
      // Минимальный случайный шум (очень небольшой)
      velocity.x += Phaser.Math.FloatBetween(-0.01, 0.01);
      velocity.y += Phaser.Math.FloatBetween(-0.01, 0.01);
      
      // Ограничение скорости (не даём превышать targetSpeed + небольшой запас)
      const maxSpeed = targetSpeed * 1.05;
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      if (speed > maxSpeed) {
        velocity.x = (velocity.x / speed) * maxSpeed;
        velocity.y = (velocity.y / speed) * maxSpeed;
      }

      // Обновление позиции
      enemy.x += velocity.x;
      enemy.y += velocity.y;
      
      // Обновляем размер врага если изменился enemySize
      if (enemy.radius !== this.enemySize) {
        enemy.setRadius(this.enemySize);
      }
      
      // Проверка выхода за границы поля боя
      if (enemy.x < this.battlefieldZone.x + 10) {
        enemy.x = this.battlefieldZone.x + 10;
        velocity.x = Math.abs(velocity.x) * 0.5;
      }
      if (enemy.x > this.battlefieldZone.x + this.battlefieldZone.width - 10) {
        enemy.x = this.battlefieldZone.x + this.battlefieldZone.width - 10;
        velocity.x = -Math.abs(velocity.x) * 0.5;
      }
      
      // Враги не могут уйти выше зоны спауна
      const minY = this.battlefieldZone.y + 10;
      if (enemy.y < minY) {
        enemy.y = minY;
        velocity.y = Math.abs(velocity.y) * 0.5;
      }

      // Сохраняем скорость
      enemy.setData('velocity', velocity);

      // Проверка достижения области базы (не иконки, а зоны)
      if (this.baseZone.contains(enemy.x, enemy.y)) {
        this.handleEnemyReachedBase(enemy);
      }
    });
  }

  private handleEnemyReachedBase(enemy: any): void {
    // Визуальный эффект при достижении базы
    this.createHitEffect(enemy.x, enemy.y);
    
    // Уменьшаем здоровье базы
    this.baseHealth = Math.max(0, this.baseHealth - 1);
    
    // Удаляем врага
    enemy.destroy();
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
        font: '48px Arial',
        color: '#ff0000',
        stroke: '#000000',
        strokeThickness: 4
      }
    );
    gameOverText.setOrigin(0.5);
  }
  
  private createHitEffect(x: number, y: number): void {
    const effect = this.add.circle(x, y, 20, 0xffff00);
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

  private updateDebugInfo(): void {
    if (!this.debugText) return;
    
    const healthPercent = Math.round((this.baseHealth / this.baseMaxHealth) * 100);
    
    // Компактный текст в 3 строки, чтобы поместиться в игровом поле
    this.debugText.setText([
      `HP: ${this.baseHealth}/${this.baseMaxHealth} (${healthPercent}%)`,
      `Мон: ${this.enemyCount}/${this.maxEnemiesOnScreen} | Spawn: ${this.spawnInterval}мс`,
      `Спавн: ${this.enemiesSpawned}/${Math.floor(this.totalEnemiesToSpawn/1000)}K | Spd: ${this.enemySpeed.toFixed(2)} | Sz: ${this.enemySize} | FPS: ${Math.round(this.game.loop.actualFps)}`
    ]);
    
    // Позиционируем текст в левом верхнем углу игрового поля
    if (this.gameArea) {
      this.debugText.setPosition(this.gameArea.x + 10, this.gameArea.y + 10);
    }
  }

  private debugControlPanel!: Phaser.GameObjects.Graphics;
  private debugControlTexts: Phaser.GameObjects.Text[] = [];
  
  // Хранилище для обновления значений контролов
  private debugControlUpdaters: Array<{ text: Phaser.GameObjects.Text, getValue: () => string }> = [];
  
  private createDebugControls(): void {
    // Уничтожаем старую панель, если она есть
    if (this.debugControlPanel) {
      this.debugControlPanel.destroy();
    }
    this.debugControlTexts = [];
    this.debugControlUpdaters = [];
    
    // Панель контролов в правом верхнем углу экрана (вне игрового поля)
    const screenWidth = this.cameras.main.width;
    const panelWidth = 220;
    const panelHeight = 200;
    const panelX = screenWidth - panelWidth - 10;
    const panelY = 10;
    
    // Фон панели
    this.debugControlPanel = this.add.graphics();
    this.debugControlPanel.fillStyle(0x000000, 0.85);
    this.debugControlPanel.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.debugControlPanel.setScrollFactor(0);
    this.debugControlPanel.setDepth(1000);
    
    // Рамка панели
    this.debugControlPanel.lineStyle(1, 0x555555, 1);
    this.debugControlPanel.strokeRect(panelX, panelY, panelWidth, panelHeight);
    
    // Заголовок
    this.add.text(panelX + 10, panelY + 5, 'DEBUG CONTROLS', {
      font: 'bold 14px Arial',
      color: '#ffffff'
    }).setScrollFactor(0).setDepth(1000);
    
    // Отступ от верха
    let yOffset = 25;
    const rowHeight = 24;
    const btnWidth = 24;
    const valueWidth = 50;
    
    // Функция для создания строки контрола: [-] [значение] [+] [метка]
    const createControlRow = (label: string, y: number, 
      minusCallback: () => void, 
      plusCallback: () => void,
      getValue: () => string) => {
      const x = panelX + 10;
      
      // Минус кнопка
      const btnMinus = this.add.text(x, y, '-', {
        font: '14px Arial',
        color: '#ff0000',
        backgroundColor: '#444444',
        padding: { x: 8, y: 4 }
      }).setScrollFactor(0).setDepth(1000).setInteractive();
      btnMinus.on('pointerdown', () => {
        minusCallback();
        this.updateDebugControlsText();
      });
      btnMinus.on('pointerover', () => btnMinus.setStyle({ backgroundColor: '#666666' }));
      btnMinus.on('pointerout', () => btnMinus.setStyle({ backgroundColor: '#444444' }));
      
      // Значение (будем обновлять через updaters)
      const valueText = this.add.text(x + btnWidth + 6, y, getValue(), {
        font: 'bold 14px Arial',
        color: '#ffffff'
      }).setScrollFactor(0).setDepth(1000);
      this.debugControlTexts.push(valueText);
      this.debugControlUpdaters.push({ text: valueText, getValue });
      
      // Плюс кнопка
      const btnPlus = this.add.text(x + btnWidth + 12 + valueWidth, y, '+', {
        font: '14px Arial',
        color: '#00ff00',
        backgroundColor: '#444444',
        padding: { x: 8, y: 4 }
      }).setScrollFactor(0).setDepth(1000).setInteractive();
      btnPlus.on('pointerdown', () => {
        plusCallback();
        this.updateDebugControlsText();
      });
      btnPlus.on('pointerover', () => btnPlus.setStyle({ backgroundColor: '#666666' }));
      btnPlus.on('pointerout', () => btnPlus.setStyle({ backgroundColor: '#444444' }));
      
      // Метка
      this.add.text(x + btnWidth + 12 + valueWidth + btnWidth + 4, y, label, {
        font: '14px Arial',
        color: '#bbbbbb'
      }).setScrollFactor(0).setDepth(1000);
    };
    
    // Spawn Interval (мс)
    createControlRow('мс', yOffset, 
      () => { this.spawnInterval = Math.max(10, this.spawnInterval - 10); },
      () => { this.spawnInterval = Math.min(5000, this.spawnInterval + 10); },
      () => `${this.spawnInterval}`
    );
    yOffset += rowHeight;
    
    // Total Enemies (тыс.)
    createControlRow('тыс.', yOffset,
      () => { this.totalEnemiesToSpawn = Math.max(100, this.totalEnemiesToSpawn - 100); },
      () => { this.totalEnemiesToSpawn += 100; },
      () => `${Math.floor(this.totalEnemiesToSpawn / 1000)}K`
    );
    yOffset += rowHeight;
    
    // Max On Screen
    createControlRow('макс.', yOffset,
      () => { this.maxEnemiesOnScreen = Math.max(10, this.maxEnemiesOnScreen - 10); },
      () => { this.maxEnemiesOnScreen = Math.min(1000, this.maxEnemiesOnScreen + 10); },
      () => `${this.maxEnemiesOnScreen}`
    );
    yOffset += rowHeight;
    
    // Enemy Speed
    createControlRow('скор.', yOffset,
      () => { this.enemySpeed = Math.max(0.1, this.enemySpeed - 0.05); },
      () => { this.enemySpeed = Math.min(10, this.enemySpeed + 0.05); },
      () => `${this.enemySpeed.toFixed(2)}`
    );
    yOffset += rowHeight;
    
    // Enemy Size
    createControlRow('разм.', yOffset,
      () => { this.enemySize = Math.max(2, this.enemySize - 1); },
      () => { this.enemySize = Math.min(50, this.enemySize + 1); },
      () => `${this.enemySize}`
    );
  }
  
  private updateDebugControlsText(): void {
    // Обновляем все текстовые поля значений
    this.debugControlUpdaters.forEach(updater => {
      updater.text.setText(updater.getValue());
    });
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
    const circle1 = this.add.circle(x, y, 10, 0x00ffff, 0.5);
    const circle2 = this.add.circle(x, y, 5, 0xffffff, 0.7);
    
    this.tweens.add({
      targets: circle1,
      radius: 40,
      alpha: 0,
      duration: 400,
      ease: 'Power2',
      onComplete: () => circle1.destroy()
    });
    
    this.tweens.add({
      targets: circle2,
      radius: 20,
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