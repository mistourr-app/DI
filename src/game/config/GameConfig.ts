// Конфигурация игры

export const GameConfig = {
  // Общие настройки
  game: {
    title: 'Fluid Crowd Defense',
    version: '0.1.0-alpha',
    debug: true // Включаем debug для счетчика FPS
  },
  
  // Настройки производительности
  performance: {
    targetFPS: 60,
    maxEnemies: 1000,
    initialEnemies: 20,
    objectPoolSize: {
      enemies: 200,
      particles: 500,
      elements: 100
    }
  },
  
  // Настройки врагов
  enemies: {
    baseSpeed: 1.5,
    speedVariation: 0.5,
    size: 8,
    health: 10,
    
    // Fluid simulation параметры
    fluid: {
      density: 1.0,
      pressure: 0.1,
      viscosity: 0.01,
      separation: 1.5,
      cohesion: 0.5,
      alignment: 0.3
    }
  },
  
  // Супер сила бога (ГДД 2.5): радиусы в css-px дизайна (умножаются на UI_SCALE)
  godPower: {
    lightningKillCount: 2,    // Монстров уничтожает одна молния
    lightningRadius: 60,      // Радиус поражения молнии
    superRadius: 100,         // Радиус зоны супер атаки
    superChargeRequired: 80   // Убийств молнией для полной зарядки бара (в 2 раза медленнее прежнего 40)
  },

  // Настройки стихий (Итерация 1 системы стихий).
  // capacity/gainPerKill/costPerUse — независимая мана алтарей
  // (накопление от убийств, списание за штрих). Прокачиваются в будущем.
  elements: {
    fire: {
      color: 0xff5500,
      damage: 5,
      duration: 5.0,
      radius: 25,
      cost: 10,
      capacity: 20,
      gainPerKill: 0.3,
      costPerUse: 7,
      // Эффект «горение» (Итерация 4): горит, пока существует зона огня.
      // Монстр в огне поджигается, умирает после burnDuration в огне.
      // При смерти — цепной поджог СТРОГО ОДНОГО соседа (шанс spreadChance);
      // maxIgnitePerDeath — прокачиваемый лимит поджигов за смерть (сейчас 1,
      // «огонь передаётся от одного монстра только к одному»). Ожидаемое
      // поджигов = 0.2·1 < 1 — цепь субкритична
      burnDuration: 2.0,
      burnRadius: 40,
      spreadChance: 0.2,
      maxIgnitePerDeath: 1
    },
    water: {
      color: 0x0066ff,
      damage: 3,
      duration: 5.0,
      radius: 25,
      cost: 8,
      capacity: 20,
      gainPerKill: 0.3,
      costPerUse: 7,
      // Эффект «замедление» (Итерация 4): скорость × slowFactor в зоне,
      // пока зона воды существует (статус Мокрый — голубой); после выхода
      // из воды монстр остаётся мокрым wetDuration с (замедление держится).
      // 0.3 — заметное замедление (слабее «почти стоп», сильнее половины)
      slowFactor: 0.3,
      wetDuration: 5.0
    },
    earth: {
      color: 0x8b4513,
      damage: 4,
      duration: 4.0,
      radius: 25,
      cost: 12,
      capacity: 20,
      gainPerKill: 0.3,
      costPerUse: 8
    },
    air: {
      color: 0x87ceeb,
      damage: 2,
      duration: 5.0,
      radius: 25,
      cost: 6,
      capacity: 20,
      gainPerKill: 0.3,
      costPerUse: 7,
      // Эффект «отброс» (Итерация 4): сдувает монстров, вошедших в зону,
      // пока зона существует; направление — вектор жеста, сила pushStrength.
      // После выхода монстр сохраняет инерцию (дрейф затухает постепенно),
      // статус «сдутый» держится airDuration с
      pushStrength: 2.0,
      airDuration: 5.0
    }
  },

  // Длина одного «юнита» штриха стихии, css-px: costPerUse = цена за юнит.
  // Рисование N юнитов списывает N × costPerUse маны в реальном времени.
  elementStrokeUnit: 50,

  // Земля-барьер (Итерация 3): монстр, касающийся земли, атакует и гибнет,
  // грызя ячейки в радиусе biteRadius (css-px): каждая -1 HP.
  // Ячейка исчезает, когда HP = 0; bitesPerCell — прокачиваемый атрибут
  // (выше = землю грызут медленнее).
  earth: {
    biteRadius: 24,
    bitesPerCell: 5
  },

  // Комбинации стихий
  combinations: {
    // Огонь + Вода = Пар
    fire_water: {
      result: 'steam',
      color: 0xcccccc,
      damage: 3,
      duration: 4.0,
      radius: 80,
      effect: 'area_damage'
    },
    // Вода + Земля = Грязь
    water_earth: {
      result: 'mud',
      color: 0x8b7355,
      damage: 1,
      duration: 5.0,
      radius: 70,
      effect: 'slow'
    },
    // Огонь + Воздух = Огненный смерч
    fire_air: {
      result: 'fire_tornado',
      color: 0xff3300,
      damage: 6,
      duration: 3.0,
      radius: 60,
      effect: 'push'
    }
  },
  
  // Настройки ресурсов
  resources: {
    initial: {
      mana: 100,
      gold: 50,
      wood: 30
    },
    generation: {
      mana: 1, // в секунду
      gold: 0.5,
      wood: 0.3
    }
  },
  
  // Настройки построек
  buildings: {
    slotCount: 3,
    types: {
      mana_generator: {
        name: 'Mana Generator',
        cost: { gold: 20, wood: 10 },
        generation: { mana: 2 },
        buildTime: 5
      },
      defense_tower: {
        name: 'Defense Tower',
        cost: { gold: 30, wood: 20 },
        damage: 2,
        range: 100,
        buildTime: 8
      },
      research_center: {
        name: 'Research Center',
        cost: { gold: 50, wood: 30 },
        researchSpeed: 1.5,
        buildTime: 10
      }
    }
  },
  
  // Настройки технологий
  technologies: {
    unlockCost: {
      element: { gold: 25, mana: 20 },
      building: { gold: 40, wood: 25 },
      upgrade: { gold: 30, mana: 15 }
    }
  },
  
  // Настройки зон экрана
  screenZones: {
    // Портретная ориентация 9:16
    portrait: {
      totalHeight: 1920,
      totalWidth: 1080,
      
      // Поле боя: 5/6 экрана (83.3%)
      battlefield: {
        heightRatio: 5/6, // 1600px из 1920px
        y: 0, // Начинается сверху
        backgroundColor: 0x1a1a2e,
        spawnZoneHeight: 300, // Верхние 300px для спауна
        monsterSpawnMargin: 50 // Отступ от краев
      },
      
      // Зона базы: 1/6 экрана (16.7%)
      baseZone: {
        heightRatio: 1/6, // 320px из 1920px
        y: 1600, // Начинается после поля боя
        backgroundColor: 0x16213e,
        baseSize: 100,
        slotCount: 4,
        slotSpacing: 20,
        resourcePanelHeight: 60,
        elementPanelHeight: 80
      }
    },
    
    // Адаптивные breakpoints
    breakpoints: {
      small: { width: 360, scale: 0.8 },
      medium: { width: 768, scale: 1.0 },
      large: { width: 1024, scale: 1.2 }
    }
  },
  
  // Настройки уровней (обновленные с учетом зон)
  levels: {
    default: {
      width: 1080, // Ширина поля боя
      height: 1600, // Высота поля боя (5/6 от 1920)
      passageWidth: 60,
      obstacleDensity: 0.4,
      monsterCount: 100,
      spawnPoints: 5 // Количество точек спауна сверху
    },
    difficulty: {
      easy: { monsterCount: 50, obstacleDensity: 0.3, spawnPoints: 3 },
      normal: { monsterCount: 100, obstacleDensity: 0.4, spawnPoints: 5 },
      hard: { monsterCount: 150, obstacleDensity: 0.5, spawnPoints: 7 }
    }
  },
  
  // Настройки управления
  controls: {
    touch: {
      minTapSize: 44, // минимальный размер тапа в пикселях
      swipeThreshold: 20, // порог для определения свайпа
      longPressDuration: 500 // длительность долгого нажатия в мс
    },
    camera: {
      minZoom: 0.5,
      maxZoom: 3.0,
      defaultZoom: 1.0,
      moveSpeed: 0.1
    }
  },
  
  // Настройки визуальных эффектов
  visuals: {
    particles: {
      enemyDeath: { count: 5, speed: 2, lifespan: 1000 },
      elementCast: { count: 10, speed: 3, lifespan: 1500 },
      buildingComplete: { count: 20, speed: 1, lifespan: 2000 }
    },
    colors: {
      background: 0x1a1a2e,
      uiBackground: 0x16213e,
      uiText: 0xffffff,
      uiAccent: 0x00ffff
    }
  },
  
  // Настройки сохранения
  save: {
    autosaveInterval: 30000, // 30 секунд
    maxBackupSaves: 3
  }
};

// Типы для TypeScript
export type ElementType = 'fire' | 'water' | 'earth' | 'air';
export type CombinationType = 'fire_water' | 'water_earth' | 'fire_air';

// Полный конфиг одной стихии (цвет/эффект + мана алтаря)
export interface ElementConfig {
  color: number;
  damage: number;
  duration: number;
  radius: number;
  cost: number;
  capacity: number;   // Ёмкость маны алтаря (потолок накопления)
  gainPerKill: number; // Порция маны алтарю за одного убитого монстра
  costPerUse: number; // Стоимость одного штриха
  // Эффекты (Итерация 4) — только для соответствующих стихий
  burnDuration?: number;   // Секунд горения до смерти (fire)
  burnRadius?: number;     // Радиус цепного поджога, css-px (fire)
  spreadChance?: number;   // Шанс заражения соседа (fire)
  maxIgnitePerDeath?: number; // Лимит поджигов за одну смерть (fire)
  slowFactor?: number;     // Доля скорости в зоне воды (water)
  wetDuration?: number;    // Секунд статуса «мокрый» после выхода (water)
  pushStrength?: number;   // Сила отброса воздуха, px/подшаг (air)
  airDuration?: number;    // Секунд статуса «сдутый» после выхода (air)
}
export type BuildingType = 'mana_generator' | 'defense_tower' | 'research_center';
export type ResourceType = 'mana' | 'gold' | 'wood';

// Вспомогательные функции
export function getElementConfig(type: ElementType) {
  return GameConfig.elements[type];
}

export function getCombinationConfig(type: CombinationType) {
  return GameConfig.combinations[type];
}

export function getBuildingConfig(type: BuildingType) {
  return GameConfig.buildings.types[type];
}

export function getResourceColor(type: ResourceType): number {
  const colors = {
    mana: 0x8a2be2, // фиолетовый
    gold: 0xffd700, // золотой
    wood: 0x8b4513  // коричневый
  };
  return colors[type];
}