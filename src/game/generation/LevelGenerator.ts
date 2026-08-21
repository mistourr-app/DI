import SimplexNoise from 'simplex-noise';

export interface LevelParams {
  seed: string;
  width: number;
  height: number;
  passageWidth: number;
  obstacleDensity: number;
  monsterCount: number;
}

export interface Obstacle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Level {
  seed: string;
  width: number;
  height: number;
  basePosition: { x: number; y: number };
  obstacles: Obstacle[];
  spawnPoints: { x: number; y: number }[];
  passages: { x1: number; y1: number; x2: number; y2: number }[];
}

export class LevelGenerator {
  private simplex: SimplexNoise;
  
  constructor() {
    this.simplex = new SimplexNoise();
  }
  
  generate(params: LevelParams): Level {
    const { seed, width, height, passageWidth, obstacleDensity, monsterCount } = params;
    
    // Устанавливаем seed для воспроизводимости
    this.simplex = new SimplexNoise(seed);
    
    // Позиция базы в центре нижней части экрана
    const basePosition = {
      x: width / 2,
      y: height - 100
    };
    
    // Генерируем препятствия с помощью шума
    const obstacles: Obstacle[] = this.generateObstacles(width, height, obstacleDensity);
    
    // Генерируем проходы (упрощенный лабиринт)
    const passages = this.generatePassages(width, height, passageWidth);
    
    // Генерируем точки спавна врагов
    const spawnPoints = this.generateSpawnPoints(width, height, monsterCount, basePosition);
    
    return {
      seed,
      width,
      height,
      basePosition,
      obstacles,
      spawnPoints,
      passages
    };
  }
  
  private generateObstacles(width: number, height: number, density: number): Obstacle[] {
    const obstacles: Obstacle[] = [];
    const cellSize = 40;
    const cols = Math.floor(width / cellSize);
    const rows = Math.floor(height / cellSize);
    
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        // Используем шум для определения, есть ли здесь препятствие
        const noiseValue = this.simplex.noise2D(x * 0.1, y * 0.1);
        
        if (noiseValue > 0.5 - density) {
          // Создаем органичное препятствие
          const obstacleWidth = cellSize * (0.5 + Math.random() * 1.5);
          const obstacleHeight = cellSize * (0.5 + Math.random() * 1.5);
          
          obstacles.push({
            x: x * cellSize + (cellSize - obstacleWidth) / 2,
            y: y * cellSize + (cellSize - obstacleHeight) / 2,
            width: obstacleWidth,
            height: obstacleHeight
          });
        }
      }
    }
    
    return obstacles;
  }
  
  private generatePassages(width: number, height: number, passageWidth: number): any[] {
    const passages = [];
    const gridSize = 100;
    const cols = Math.floor(width / gridSize);
    const rows = Math.floor(height / gridSize);
    
    // Простой алгоритм для создания проходов
    for (let x = 0; x < cols - 1; x++) {
      for (let y = 0; y < rows - 1; y++) {
        // Вертикальные проходы
        if (Math.random() > 0.3) {
          passages.push({
            x1: (x + 0.5) * gridSize,
            y1: y * gridSize,
            x2: (x + 0.5) * gridSize,
            y2: (y + 1) * gridSize,
            width: passageWidth
          });
        }
        
        // Горизонтальные проходы
        if (Math.random() > 0.3) {
          passages.push({
            x1: x * gridSize,
            y1: (y + 0.5) * gridSize,
            x2: (x + 1) * gridSize,
            y2: (y + 0.5) * gridSize,
            width: passageWidth
          });
        }
      }
    }
    
    return passages;
  }
  
  private generateSpawnPoints(
    width: number, 
    height: number, 
    count: number, 
    basePosition: { x: number; y: number }
  ): { x: number; y: number }[] {
    const spawnPoints: { x: number; y: number }[] = [];
    const safeDistance = 200; // Минимальное расстояние от базы
    
    for (let i = 0; i < count; i++) {
      let attempts = 0;
      let point: { x: number; y: number };
      
      do {
        // Точки спавна в верхней части экрана
        point = {
          x: Math.random() * width,
          y: Math.random() * (height * 0.3) // Только верхние 30% экрана
        };
        
        attempts++;
        
        // Проверяем расстояние до базы
        const distance = Math.sqrt(
          Math.pow(point.x - basePosition.x, 2) + 
          Math.pow(point.y - basePosition.y, 2)
        );
        
        if (distance > safeDistance || attempts > 100) {
          break;
        }
      } while (true);
      
      spawnPoints.push(point);
    }
    
    return spawnPoints;
  }
  
  // Метод для получения параметров уровня по умолчанию
  static getDefaultParams(seed: string = Date.now().toString()): LevelParams {
    return {
      seed,
      width: 1200,
      height: 1800,
      passageWidth: 60,
      obstacleDensity: 0.4,
      monsterCount: 100
    };
  }
}