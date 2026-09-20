import { parseBalance, buildUpgradeDefs, valueAt, displayValue, upgradeCost } from './balance';
import { GameConfig } from '../config/GameConfig';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Полное содержимое docs/balance_1.csv (рабочий баланс) */
const BALANCE_CSV = [
  'title;key;costBase;costRatio;maxLevel;v0;v1;v2;v3;v4;v5;v6;v7;v8;;group',
  'Air: mana capacity;capacity-air;75;1.6;8;20,00;25,00;30,00;35,00;40,00;45,00;50,00;55,00;60,00;;economy',
  'Air: mana per kill;gainPerKill-air;75;1.6;8;0.3;0.4;0.5;0.6;0.7;0.8;0.9;0.95;1.0;;economy',
  'Air: push strength;air.push;130;1.6;8;2,00;2,25;2,50;2,75;3,00;3,25;3,50;3,75;4,00;;effect',
  'Air: stroke cost;costPerUse-air;75;1.6;8;8,00;7,50;7,00;6,50;6,00;5,50;5,00;4,50;4,00;;economy',
  'Air: zone duration;air.duration;110;1.6;8;5,00;5,50;6,00;6,50;7,00;7,50;8,00;8,50;9,00;;effect',
  'Air: status duration;air.airDuration;110;1.6;8;5,00;5,50;6,00;6,50;7,00;7,50;8,00;8,50;9,00;;effect',
  'Earth: cell durability;earth.bites;450;1.6;5;5,00;9,00;13,00;16,00;20,00;20,00;;;;;effect',
  'Earth: mana capacity;capacity-earth;75;1.6;8;20,00;25,00;30,00;35,00;40,00;45,00;50,00;55,00;60,00;;economy',
  'Earth: mana per kill;gainPerKill-earth;75;1.6;8;0.3;0.4;0.5;0.6;0.7;0.8;0.9;0.95;1.0;;economy',
  'Earth: stroke cost;costPerUse-earth;75;1.6;8;8,00;7,50;7,00;6,50;6,00;5,50;5,00;4,50;4,00;;economy',
  'Fire: burn duration;fire.burnDuration;110;1.6;8;2,00;2,25;2,50;2,75;3,00;3,25;3,50;3,75;4,00;;effect',
  'Fire: chain ignite;fire.maxIgnite;130;1.6;8;1,00;2,00;3,00;4,00;5,00;6,00;7,00;8,00;9,00;;effect',
  'Fire: mana capacity;capacity-fire;75;1.6;8;20,00;25,00;30,00;35,00;40,00;45,00;50,00;55,00;60,00;;economy',
  'Fire: mana per kill;gainPerKill-fire;75;1.6;8;0.3;0.4;0.5;0.6;0.7;0.8;0.9;0.95;1.0;;economy',
  'Fire: stroke cost;costPerUse-fire;75;1.6;8;8,00;7,50;7,00;6,50;6,00;5,50;5,00;4,50;4,00;;economy',
  'Fire: zone duration;fire.duration;110;1.6;8;5,00;5,50;6,00;6,50;7,00;7,50;8,00;8,50;9,00;;effect',
  'God: charge required;god.superCharge;110;1.6;8;80;76;72;69;65;61;58;54;50;;god',
  'God: kills per lightning;god.lightning;600;1.6;5;1,00;2,00;3,00;4,00;5,00;;;;;;god',
  'God: super radius;god.superRadius;130;1.6;8;80,00;100,00;120,00;140,00;160,00;180,00;200,00;220,00;240,00;;god',
  'Water: mana capacity;capacity-water;75;1.6;8;20,00;25,00;30,00;35,00;40,00;45,00;50,00;55,00;60,00;;economy',
  'Water: mana per kill;gainPerKill-water;75;1.6;8;0.3;0.4;0.5;0.6;0.7;0.8;0.9;0.95;1.0;;economy',
  'Water: slow factor;water.slowFactor;130;1.6;8;0,50;0,45;0,40;0,35;0,30;0,25;0,20;0,15;0,10;;effect',
  'Water: status duration;water.wetDuration;110;1.6;8;5,00;5,50;6,00;6,50;7,00;7,50;8,00;8,50;9,00;;effect',
  'Water: stroke cost;costPerUse-water;75;1.6;8;8,00;7,50;7,00;6,50;6,00;5,50;5,00;4,50;4,00;;economy',
  'Water: zone duration;water.duration;110;1.6;8;5,00;5,50;6,00;6,50;7,00;7,50;8,00;8,50;9,00;;effect'
].join('\n');

describe('parseBalance', () => {
  it('парсит все 25 параметров из balance_1.csv', () => {
    const entries = parseBalance(BALANCE_CSV);
    expect(entries.length).toBe(25);
  });

  it('нормализует десятичные запятые и точки', () => {
    const byKey = Object.fromEntries(parseBalance(BALANCE_CSV).map((e) => [e.key, e]));
    expect(byKey['capacity-fire'].values).toEqual([20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(byKey['air.push'].values[1]).toBe(2.25);
    expect(byKey['gainPerKill-fire'].values[1]).toBe(0.4);
    expect(byKey['fire.duration'].values[1]).toBe(5.5);
  });

  it('читает costBase, costRatio и maxLevel из CSV', () => {
    const byKey = Object.fromEntries(parseBalance(BALANCE_CSV).map((e) => [e.key, e]));
    expect(byKey['god.lightning'].costBase).toBe(600);
    expect(byKey['god.superRadius'].costBase).toBe(130);
    expect(byKey['capacity-fire'].costBase).toBe(75);
    expect(byKey['earth.bites'].costBase).toBe(450);
    expect(byKey['fire.maxIgnite'].costBase).toBe(130);
    expect(byKey['god.superCharge'].costBase).toBe(110);
    expect(byKey['fire.duration'].costBase).toBe(110);
    expect(byKey['capacity-fire'].costRatio).toBe(1.6);
    // god.lightning: 5 значений (1..5) -> 4 уровня «как заполнено»
    expect(byKey['god.lightning'].maxLevel).toBe(4);
    expect(byKey['god.superRadius'].maxLevel).toBe(8);
    expect(byKey['air.push'].maxLevel).toBe(8);
    expect(byKey['water.slowFactor'].maxLevel).toBe(8);
    // fire.maxIgnite: maxLevel=8 (9 значений)
    expect(byKey['fire.maxIgnite'].maxLevel).toBe(8);
    expect(byKey['fire.maxIgnite'].values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // заряд бога: обратная прокачка 80 -> 50
    expect(byKey['god.superCharge'].values).toEqual([80, 76, 72, 69, 65, 61, 58, 54, 50]);
  });

  it('costRatio дефолтится к 1.6 при отсутствии/плохом значении', () => {
    const csv = 'title;key;costBase;costRatio;maxLevel;v0;v1;;group\nTest;test.x;50;;3;1;2;;effect';
    const entries = parseBalance(csv);
    expect(entries[0].costRatio).toBe(1.6);
  });

  it('maxLevel не превышает числа значений − 1 (защита)', () => {
    const csv = 'title;key;costBase;costRatio;maxLevel;v0;v1;v2;;group\nTest;test.x;50;1.6;99;1;2;3;;effect';
    const entries = parseBalance(csv);
    expect(entries[0].maxLevel).toBe(2);
    expect(entries[0].values).toEqual([1, 2, 3]);
  });

  it('пропускает шапку и пустые строки', () => {
    const entries = parseBalance('title;key;costBase;costRatio;maxLevel;v0;;group\n\nTest;test.y;50;1.6;1;1;2;;effect\n');
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe('test.y');
  });

  it('парсит CSV в формате файла на диске (разделитель "," без пустой колонки)', () => {
    const csv = [
      'title,key,costBase,costRatio,maxLevel,v0,v1,v2,v3,v4,v5,v6,v7,v8,group',
      'Air: mana capacity,capacity-air,75,1.6,8,20.00,25.00,30.00,35.00,40.00,45.00,50.00,55.00,60.00,economy',
      'God: kills per lightning,god.lightning,600,1.6,5,1.00,2.00,3.00,4.00,5.00,god',
      'Earth: cell durability,earth.bites,450,1.6,5,5,9,13,16,20,-,-,-,-,effect'
    ].join('\n');
    const byKey = Object.fromEntries(parseBalance(csv).map((e) => [e.key, e]));
    expect(Object.keys(byKey).sort()).toEqual(['capacity-air', 'earth.bites', 'god.lightning']);
    expect(byKey['capacity-air'].costBase).toBe(75);
    expect(byKey['capacity-air'].values).toEqual([20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(byKey['capacity-air'].group).toBe('economy');
    expect(byKey['god.lightning'].maxLevel).toBe(4);
    expect(byKey['earth.bites'].group).toBe('effect');
  });

  it('устойчив к произвольному порядку колонок и табам как разделителю', () => {
    const csv = 'key\ttitle\tmaxLevel\tcostBase\tcostRatio\tgroup\tv0\tv1\n' +
      'test.z\tX\t3\t50\t1.5\teffect\t1\t2\n';
    const entries = parseBalance(csv);
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe('test.z');
    expect(entries[0].group).toBe('effect');
    expect(entries[0].costRatio).toBe(1.5);
    expect(entries[0].maxLevel).toBe(1);
    expect(entries[0].values).toEqual([1, 2]);
  });

  it('читает реальный docs/balance_1.csv с диска (формат "," и плейсхолдеры "-")', () => {
    // Разделитель и плейсхолдеры не должны ломать парсинг рабочего файла
    const csv = readFileSync(resolve(__dirname, '../../../docs/balance_1.csv'), 'utf8');
    const entries = parseBalance(csv);
    expect(entries.length).toBe(25);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey['capacity-fire'].values).toEqual([20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(byKey['earth.bites'].values).toEqual([5, 9, 13, 16, 20]);
    expect(byKey['earth.bites'].group).toBe('effect');
    expect(byKey['earth.bites'].maxLevel).toBe(4);
  });
});

describe('buildUpgradeDefs', () => {
  const defs = buildUpgradeDefs(parseBalance(BALANCE_CSV));
  const byKey = Object.fromEntries(defs.map((d) => [d.key, d]));

  it('прикрепляет element из ключа', () => {
    expect(byKey['capacity-fire'].element).toBe('fire');
    expect(byKey['water.slowFactor'].element).toBe('water');
    expect(byKey['earth.bites'].element).toBe('earth');
    expect(byKey['air.push'].element).toBe('air');
    expect(byKey['fire.duration'].element).toBe('fire');
    expect(byKey['water.wetDuration'].element).toBe('water');
    expect(byKey['god.lightning'].element).toBeUndefined();
    expect(byKey['god.superCharge'].element).toBeUndefined();
  });

  it('вычисляет precision по значениям', () => {
    expect(byKey['capacity-fire'].precision).toBe(0);
    // gainPerKill содержит 0.95 -> 2 знака
    expect(byKey['gainPerKill-fire'].precision).toBe(2);
    expect(byKey['water.slowFactor'].precision).toBe(2);
    expect(byKey['air.push'].precision).toBe(2);
    expect(byKey['fire.duration'].precision).toBe(1);
    expect(byKey['fire.burnDuration'].precision).toBe(2);
  });

  it('valueAt/displayValue/upgradeCost работают на CSV-значениях', () => {
    expect(valueAt(byKey['capacity-fire'], 1)).toBe(25);
    expect(displayValue(byKey['water.slowFactor'], 0.45)).toBe('0.45');
    expect(displayValue(byKey['fire.duration'], 5.5)).toBe('5.5');
    // cost(n) = round(costBase × ratio^(n−1))
    expect(upgradeCost(byKey['capacity-fire'], 0)).toBe(75);
    expect(upgradeCost(byKey['capacity-fire'], 1)).toBe(Math.round(75 * 1.6));
    expect(upgradeCost(byKey['god.lightning'], 0)).toBe(600);
    expect(upgradeCost(byKey['god.lightning'], 4)).toBeNull();
  });

  it('apply пишет значения CSV-баланса в GameConfig', () => {
    byKey['fire.maxIgnite'].apply(3);
    expect(GameConfig.elements.fire.maxIgnitePerDeath).toBe(4);
    byKey['water.slowFactor'].apply(1);
    expect(GameConfig.elements.water.slowFactor).toBe(0.45);
    byKey['god.lightning'].apply(2);
    expect(GameConfig.godPower.lightningKillCount).toBe(3);
    byKey['earth.bites'].apply(1);
    expect(GameConfig.earth.bitesPerCell).toBe(9);
    byKey['god.superRadius'].apply(1);
    expect(GameConfig.godPower.superRadius).toBe(100);
    byKey['costPerUse-fire'].apply(1);
    expect(GameConfig.elements.fire.costPerUse).toBe(7.5);
    // Новые ключи: заряд бога и длительности
    byKey['god.superCharge'].apply(1);
    expect(GameConfig.godPower.superChargeRequired).toBe(76);
    byKey['fire.duration'].apply(2);
    expect(GameConfig.elements.fire.duration).toBe(6);
    byKey['fire.burnDuration'].apply(1);
    expect(GameConfig.elements.fire.burnDuration).toBe(2.25);
    byKey['water.wetDuration'].apply(1);
    expect(GameConfig.elements.water.wetDuration).toBe(5.5);
    byKey['air.airDuration'].apply(1);
    expect(GameConfig.elements.air.airDuration).toBe(5.5);
  });

  it('полный макс всех параметров ≈ 166 тыс душ (бюджет прокачки)', () => {
    const defs2 = buildUpgradeDefs(parseBalance(BALANCE_CSV));
    let total = 0;
    for (const d of defs2) {
      for (let lvl = 0; lvl < d.maxLevel; lvl++) {
        total += upgradeCost(d, lvl)!;
      }
    }
    expect(total).toBe(165777);
  });
});