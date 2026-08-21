import Phaser from 'phaser';
import { world, Position } from '../World';

export class RenderingSystem {
  private scene: Phaser.Scene;
  private graphics: Map<number, Phaser.GameObjects.Graphics>;
  private enemyPool: Phaser.GameObjects.Group;
  
  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.graphics = new Map();
    this.enemyPool = this.scene.add.group();
    
    // Предварительно создаем объекты для пула
    this.createPoolObjects(50);
  }
  
  private createPoolObjects(count: number): void {
    for (let i = 0; i < count; i++) {
      const enemy = this.scene.add.circle(0, 0, 8, 0xff0000);
      enemy.setActive(false);
      enemy.setVisible(false);
      this.enemyPool.add(enemy);
    }
  }
  
  private getFromPool(): Phaser.GameObjects.Arc | null {
    const enemy = this.enemyPool.getFirstDead(false, 0, 0) as Phaser.GameObjects.Arc;
    if (enemy) {
      enemy.setActive(true);
      enemy.setVisible(true);
      return enemy;
    }
    
    // Если в пуле нет свободных объектов, создаем новый
    const newEnemy = this.scene.add.circle(0, 0, 8, 0xff0000);
    this.enemyPool.add(newEnemy);
    return newEnemy;
  }
  
  private returnToPool(enemy: Phaser.GameObjects.Arc): void {
    enemy.setActive(false);
    enemy.setVisible(false);
    enemy.x = 0;
    enemy.y = 0;
  }
  
  update(): void {
    // Получаем все сущности с компонентом Position
    const entities = world.with(Position);
    
    // Обновляем существующие графические объекты
    for (const entity of entities) {
      if (!entity.position) continue;
      
      let graphic = this.graphics.get(entity.id);
      
      if (!graphic) {
        // Создаем новый графический объект из пула
        graphic = this.getFromPool();
        if (graphic) {
          this.graphics.set(entity.id, graphic);
        }
      }
      
      if (graphic) {
        // Обновляем позицию
        graphic.x = entity.position.x;
        graphic.y = entity.position.y;
        
        // Обновляем цвет в зависимости от типа сущности
        if (entity.crowdAgent) {
          // Враги - красные
          graphic.fillColor = 0xff0000;
        } else if (entity.element) {
          // Стихии - разные цвета в зависимости от типа
          const elementType = entity.element.type;
          switch (elementType) {
            case 0: // Огонь
              graphic.fillColor = 0xff5500;
              break;
            case 1: // Вода
              graphic.fillColor = 0x0066ff;
              break;
            case 2: // Земля
              graphic.fillColor = 0x8b4513;
              break;
            case 3: // Воздух
              graphic.fillColor = 0x87ceeb;
              break;
          }
        }
      }
    }
    
    // Удаляем графические объекты для несуществующих сущностей
    for (const [entityId, graphic] of this.graphics.entries()) {
      if (!world.entity(entityId)) {
        this.returnToPool(graphic);
        this.graphics.delete(entityId);
      }
    }
  }
  
  // Метод для создания сущности с графическим представлением
  createEntity(x: number, y: number, radius: number = 8, color: number = 0xff0000): number {
    const entity = world.createEntity({
      position: { x, y }
    });
    
    // Создаем графический объект
    const graphic = this.getFromPool();
    if (graphic) {
      graphic.x = x;
      graphic.y = y;
      graphic.radius = radius;
      graphic.fillColor = color;
      this.graphics.set(entity.id, graphic);
    }
    
    return entity.id;
  }
  
  // Метод для удаления сущности и её графического представления
  destroyEntity(entityId: number): void {
    const graphic = this.graphics.get(entityId);
    if (graphic) {
      this.returnToPool(graphic);
      this.graphics.delete(entityId);
    }
    
    world.destroyEntity(entityId);
  }
  
  // Метод для очистки всех графических объектов
  clear(): void {
    for (const graphic of this.graphics.values()) {
      this.returnToPool(graphic);
    }
    this.graphics.clear();
  }
}