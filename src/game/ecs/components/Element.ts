import { defineComponent, Types } from 'bitecs';

export const Element = defineComponent({
  type: Types.ui8,         // Тип стихии: 0=огонь, 1=вода, 2=земля, 3=воздух
  power: Types.f32,        // Сила стихии
  duration: Types.f32,     // Длительность эффекта
  radius: Types.f32,       // Радиус эффекта
  
  // Для комбинаций
  combinationType: Types.ui8, // Тип комбинации (если есть)
  combinationPower: Types.f32 // Сила комбинации
});