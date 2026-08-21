export interface WorkerMessage {
  type: string;
  data: any;
  id?: string;
}

export interface WorkerTask {
  id: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timestamp: number;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private taskQueue: Array<{
    task: WorkerMessage;
    resolve: (result: any) => void;
    reject: (error: any) => void;
  }> = [];
  private activeTasks: Map<string, WorkerTask> = new Map();
  private workerIndex: number = 0;
  
  constructor(
    private workerScript: string,
    private poolSize: number = navigator.hardwareConcurrency || 4
  ) {
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerScript, { type: 'module' });
      
      worker.onmessage = (event: MessageEvent) => {
        this.handleWorkerMessage(event.data, worker);
      };
      
      worker.onerror = (error) => {
        console.error(`Worker ${i} error:`, error);
        this.handleWorkerError(error, worker);
      };
      
      this.workers.push(worker);
    }
  }
  
  private handleWorkerMessage(message: WorkerMessage, worker: Worker): void {
    const { id, type, data } = message;
    
    if (id && this.activeTasks.has(id)) {
      const task = this.activeTasks.get(id)!;
      
      if (type === 'result') {
        task.resolve(data);
      } else if (type === 'error') {
        task.reject(new Error(data));
      }
      
      this.activeTasks.delete(id);
      
      // Обрабатываем следующую задачу из очереди
      this.processNextTask(worker);
    }
  }
  
  private handleWorkerError(error: ErrorEvent, worker: Worker): void {
    // Находим задачу, связанную с этим воркером
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (this.getWorkerForTask(taskId) === worker) {
        task.reject(error);
        this.activeTasks.delete(taskId);
        break;
      }
    }
    
    // Перезапускаем воркер
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) {
      worker.terminate();
      const newWorker = new Worker(this.workerScript, { type: 'module' });
      
      newWorker.onmessage = (event: MessageEvent) => {
        this.handleWorkerMessage(event.data, newWorker);
      };
      
      newWorker.onerror = (error) => {
        console.error(`Restarted worker ${workerIndex} error:`, error);
        this.handleWorkerError(error, newWorker);
      };
      
      this.workers[workerIndex] = newWorker;
    }
  }
  
  private getWorkerForTask(taskId: string): Worker | null {
    // Простая реализация - можно улучшить для отслеживания
    for (const worker of this.workers) {
      // В реальной реализации нужно отслеживать, какой воркер выполняет какую задачу
      return worker;
    }
    return null;
  }
  
  private processNextTask(worker: Worker): void {
    if (this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift()!;
      this.executeTask(nextTask.task, nextTask.resolve, nextTask.reject, worker);
    }
  }
  
  private executeTask(
    task: WorkerMessage,
    resolve: (result: any) => void,
    reject: (error: any) => void,
    worker: Worker
  ): void {
    const taskId = task.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.activeTasks.set(taskId, {
      id: taskId,
      resolve,
      reject,
      timestamp: Date.now()
    });
    
    worker.postMessage({
      ...task,
      id: taskId
    });
  }
  
  async execute(task: WorkerMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      // Находим свободного воркера
      const availableWorker = this.getAvailableWorker();
      
      if (availableWorker) {
        this.executeTask(task, resolve, reject, availableWorker);
      } else {
        // Все воркеры заняты, добавляем в очередь
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }
  
  private getAvailableWorker(): Worker | null {
    // Простая реализация round-robin
    // В реальном приложении нужно отслеживать занятость воркеров
    
    if (this.activeTasks.size < this.workers.length) {
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;
      return worker;
    }
    
    return null;
  }
  
  async executeFluidSimulation(
    positions: Float32Array,
    velocities: Float32Array,
    obstacles: Array<{ x: number; y: number; width: number; height: number }>,
    deltaTime: number
  ): Promise<{ positions: Float32Array; velocities: Float32Array }> {
    const task: WorkerMessage = {
      type: 'fluid_simulation',
      data: {
        positions,
        velocities,
        obstacles,
        deltaTime
      }
    };
    
    return this.execute(task);
  }
  
  async executePathfinding(
    start: { x: number; y: number },
    end: { x: number; y: number },
    obstacles: Array<{ x: number; y: number; width: number; height: number }>
  ): Promise<{ path: Array<{ x: number; y: number }> }> {
    const task: WorkerMessage = {
      type: 'pathfinding',
      data: {
        start,
        end,
        obstacles
      }
    };
    
    return this.execute(task);
  }
  
  getQueueSize(): number {
    return this.taskQueue.length;
  }
  
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }
  
  getWorkerCount(): number {
    return this.workers.length;
  }
  
  cleanup(): void {
    // Очищаем очередь
    this.taskQueue.forEach(({ reject }) => {
      reject(new Error('Worker pool terminated'));
    });
    this.taskQueue = [];
    
    // Отменяем активные задачи
    this.activeTasks.forEach((task) => {
      task.reject(new Error('Worker pool terminated'));
    });
    this.activeTasks.clear();
    
    // Завершаем воркеров
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
  }
}