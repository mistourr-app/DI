import { defineComponent, Types } from 'bitecs';

export const CrowdAgent = defineComponent({
  // Параметры fluid simulation
  density: Types.f32,      // Плотность в текущей точке
  pressure: Types.f32,     // Давление
  targetX: Types.f32,      // Целевая позиция X
  targetY: Types.f32,      // Целевая позиция Y
  
  // Параметры поведения
  speed: Types.f32,        // Базовая скорость
  separation: Types.f32,   // Сила разделения
  cohesion: Types.f32,     // Сила сцепления
  alignment: Types.f32,    // Сила выравнивания
  
  // Состояние
  isStuck: Types.ui8,      // Застрял ли агент (0/1)
  stuckTime: Types.f32     // Время в заторе
});