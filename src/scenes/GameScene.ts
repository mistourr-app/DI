import Phaser from 'phaser';

export class GameScene extends Phaser.Scene {
  private enemies!: Phaser.GameObjects.Group;
  private base!: Phaser.GameObjects.Rectangle;
  private debugText!: Phaser.GameObjects.Text;
  private enemyCount: number = 0;
  private maxEnemies: number = 20;
  
  // Зоны экрана
  private battlefieldZone!: Phaser.Geom.Rectangle;
  private baseZone!: Phaser.Geom.Rectangle;
  private gameArea!: Phaser.Geom.Rectangle;
  private battlefieldGraphics!: Phaser.GameObjects.Graphics;
  private baseZoneGraphics!: Phaser.GameObjects.Graphics;

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

    // Создаем начальных врагов в поле боя
    this.createInitialEnemies();

    // Debug текст для информации (FPS и количество монстров)
    this.createDebugText();

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
    this.debugText = this.add.text(10, 10, '', {
      font: '16px monospace',
      color: '#ffffff',
      backgroundColor: '#00000080',
      padding: { x: 8, y: 4 }
    });
    this.debugText.setScrollFactor(0);
  }

  private createInitialEnemies(): void {
    for (let i = 0; i < this.maxEnemies; i++) {
      this.createEnemy();
    }
  }

  private createEnemy(): void {
    // Враги спаунятся только в верхней части поля боя
    const spawnZoneHeight = this.battlefieldZone.height * 0.2;
    
    const x = Phaser.Math.Between(
      this.battlefieldZone.x + 20,
      this.battlefieldZone.x + this.battlefieldZone.width - 20
    );
    
    const y = Phaser.Math.Between(
      this.battlefieldZone.y + 10,
      this.battlefieldZone.y + spawnZoneHeight
    );

    // Адаптивный размер врага
    const enemySize = Math.max(8, Math.min(this.battlefieldZone.width * 0.02, 20));
    
    // Создаем врага
    const enemy = this.add.circle(x, y, enemySize, 0xff0000);
    enemy.setData('velocity', {
      x: Phaser.Math.FloatBetween(-0.2, 0.2),
      y: Phaser.Math.FloatBetween(0.5, 1.0)
    });
    
    enemy.setStrokeStyle(2, 0xff5555);

    this.enemies.add(enemy);
    this.enemyCount++;
  }

  update(): void {
    // Обновляем движение врагов
    this.updateEnemyMovement();

    // Обновляем debug информацию
    this.updateDebugInfo();
  }

  private updateEnemyMovement(): void {
    const baseX = this.base.x;
    const baseY = this.base.y;
    const baseRadius = this.base.width / 2;

    this.enemies.getChildren().forEach((enemy: any) => {
      const velocity = enemy.getData('velocity');
      
      // Основное движение вниз (к базе)
      const dx = baseX - enemy.x;
      const dy = baseY - enemy.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Усиливаем движение вниз
      velocity.y += 0.1;
      
      // Корректируем горизонтальное движение к центру базы
      if (distance > 0) {
        velocity.x += dx / distance * 0.03;
      }
      
      // Добавляем небольшой случайный шум
      velocity.x += Phaser.Math.FloatBetween(-0.05, 0.05);
      velocity.y += Phaser.Math.FloatBetween(-0.02, 0.02);

      // Ограничение скорости
      const maxSpeed = 3.0;
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      if (speed > maxSpeed) {
        velocity.x = (velocity.x / speed) * maxSpeed;
        velocity.y = (velocity.y / speed) * maxSpeed;
      }

      // Обновление позиции
      enemy.x += velocity.x;
      enemy.y += velocity.y;
      
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

      // Сохраняем обновленную скорость
      enemy.setData('velocity', velocity);

      // Проверка достижения базы
      if (enemy.y > this.baseZone.y) {
        const distanceToBase = Phaser.Math.Distance.Between(enemy.x, enemy.y, baseX, baseY);
        if (distanceToBase < baseRadius + enemy.radius) {
          this.handleEnemyReachedBase(enemy);
        }
      }
    });
  }

  private handleEnemyReachedBase(enemy: any): void {
    // Визуальный эффект при достижении базы
    this.createHitEffect(enemy.x, enemy.y);
    
    // Удаляем врага
    enemy.destroy();
    this.enemyCount--;

    // Создаем нового врага в поле боя
    this.createEnemy();
    
    // Небольшая тряска камеры для feedback
    this.cameras.main.shake(100, 0.01);
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
    
    this.debugText.setText([
      `Монстров: ${this.enemyCount}`,
      `FPS: ${Math.round(this.game.loop.actualFps)}`,
      `Игра: ${this.gameArea?.width.toFixed(0)}x${this.gameArea?.height.toFixed(0)}`
    ].join(' | '));
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