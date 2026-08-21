import { world, Position, Velocity } from '../World';

export class MovementSystem {
  update(deltaTime: number): void {
    // Получаем все сущности с компонентами Position и Velocity
    const entities = world.with(Position, Velocity);
    
    for (const entity of entities) {
      if (!entity.position || !entity.velocity) continue;
      
      // Обновляем позицию на основе скорости
      entity.position.x += entity.velocity.vx * deltaTime;
      entity.position.y += entity.velocity.vy * deltaTime;
      
      // Ограничиваем скорость (максимум 5 единиц в секунду)
      const speed = Math.sqrt(
        entity.velocity.vx * entity.velocity.vx + 
        entity.velocity.vy * entity.velocity.vy
      );
      
      if (speed > 5) {
        entity.velocity.vx = (entity.velocity.vx / speed) * 5;
        entity.velocity.vy = (entity.velocity.vy / speed) * 5;
      }
    }
  }
  
  // Метод для установки скорости сущности
  setVelocity(entityId: number, vx: number, vy: number): void {
    const entity = world.entity(entityId);
    if (entity && entity.velocity) {
      entity.velocity.vx = vx;
      entity.velocity.vy = vy;
    }
  }
  
  // Метод для добавления силы к сущности
  addForce(entityId: number, fx: number, fy: number): void {
    const entity = world.entity(entityId);
    if (entity && entity.velocity) {
      entity.velocity.vx += fx;
      entity.velocity.vy += fy;
    }
  }
}