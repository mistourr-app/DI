import { createWorld } from 'miniplex';
import { Position } from './components/Position';
import { Velocity } from './components/Velocity';
import { CrowdAgent } from './components/CrowdAgent';
import { Element } from './components/Element';

// Типы сущностей
export type Entity = {
  id: number;
  position?: typeof Position;
  velocity?: typeof Velocity;
  crowdAgent?: typeof CrowdAgent;
  element?: typeof Element;
  // Дополнительные компоненты будут добавлены позже
};

// Создаем мир ECS
export const world = createWorld<Entity>();

// Экспортируем компоненты для удобства
export { Position, Velocity, CrowdAgent, Element };