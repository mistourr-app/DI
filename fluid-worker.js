// Простой Web Worker для fluid simulation
// В будущем будет заменен на полноценную симуляцию

self.onmessage = function(event) {
  const { type, data, id } = event.data;
  
  try {
    switch (type) {
      case 'fluid_simulation':
        handleFluidSimulation(data, id);
        break;
        
      case 'pathfinding':
        handlePathfinding(data, id);
        break;
        
      case 'ping':
        self.postMessage({ type: 'pong', data: 'Worker is alive', id });
        break;
        
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      data: error.message,
      id
    });
  }
};

function handleFluidSimulation(data, taskId) {
  const { positions, velocities, obstacles, deltaTime } = data;
  
  // Упрощенная симуляция для прототипа
  // В реальной реализации здесь будет SPH или другой алгоритм fluid dynamics
  
  const resultPositions = new Float32Array(positions.length);
  const resultVelocities = new Float32Array(velocities.length);
  
  // Простое движение с небольшим случайным отклонением
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i];
    const y = positions[i + 1];
    const vx = velocities[i];
    const vy = velocities[i + 1];
    
    // Добавляем небольшой шум к скорости
    const noiseX = (Math.random() - 0.5) * 0.1;
    const noiseY = (Math.random() - 0.5) * 0.1;
    
    resultVelocities[i] = vx + noiseX;
    resultVelocities[i + 1] = vy + noiseY;
    
    // Обновляем позицию
    resultPositions[i] = x + resultVelocities[i] * deltaTime;
    resultPositions[i + 1] = y + resultVelocities[i + 1] * deltaTime;
    
    // Простая проверка столкновений с препятствиями
    for (const obstacle of obstacles) {
      if (isPointInObstacle(resultPositions[i], resultPositions[i + 1], obstacle)) {
        // Отталкиваем от препятствия
        const centerX = obstacle.x + obstacle.width / 2;
        const centerY = obstacle.y + obstacle.height / 2;
        const dx = resultPositions[i] - centerX;
        const dy = resultPositions[i + 1] - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 0) {
          resultVelocities[i] += dx / distance * 0.5;
          resultVelocities[i + 1] += dy / distance * 0.5;
        }
        
        // Корректируем позицию
        resultPositions[i] = x;
        resultPositions[i + 1] = y;
      }
    }
  }
  
  self.postMessage({
    type: 'result',
    data: {
      positions: resultPositions,
      velocities: resultVelocities
    },
    id: taskId
  });
}

function handlePathfinding(data, taskId) {
  const { start, end, obstacles } = data;
  
  // Упрощенный pathfinding для прототипа
  // В реальной реализации здесь будет A* или другой алгоритм
  
  const path = [];
  
  // Простой линейный путь с обходом препятствий
  let currentX = start.x;
  let currentY = start.y;
  
  const steps = 10;
  const dx = (end.x - start.x) / steps;
  const dy = (end.y - start.y) / steps;
  
  for (let i = 0; i <= steps; i++) {
    path.push({ x: currentX, y: currentY });
    
    // Проверяем столкновение с препятствиями
    let hasCollision = false;
    for (const obstacle of obstacles) {
      if (isPointInObstacle(currentX, currentY, obstacle)) {
        hasCollision = true;
        break;
      }
    }
    
    if (hasCollision) {
      // Обходим препятствие
      currentX += dx + (Math.random() - 0.5) * 50;
      currentY += dy + (Math.random() - 0.5) * 50;
    } else {
      currentX += dx;
      currentY += dy;
    }
  }
  
  // Добавляем конечную точку
  path.push({ x: end.x, y: end.y });
  
  self.postMessage({
    type: 'result',
    data: { path },
    id: taskId
  });
}

function isPointInObstacle(x, y, obstacle) {
  return x >= obstacle.x && 
         x <= obstacle.x + obstacle.width && 
         y >= obstacle.y && 
         y <= obstacle.y + obstacle.height;
}

// Сообщаем, что воркер готов
self.postMessage({ type: 'ready', data: 'Fluid simulation worker initialized' });