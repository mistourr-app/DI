import localforage from 'localforage';
import { v4 as uuidv4 } from 'uuid';

export interface PlayerProfile {
  id: string;
  resources: {
    mana: number;
    gold: number;
    wood: number;
  };
  technologies: string[];
  buildingSlots: Array<{
    id: string;
    type: string;
    level: number;
  }>;
  unlockedElements: string[];
  highScore: number;
  totalPlayTime: number;
  lastPlayed: number;
}

export interface GameState {
  profile: PlayerProfile;
  currentSeed: string;
  sessionStart: number;
  levelProgress: number;
}

export class SaveSystem {
  private store: LocalForage;
  private autosaveInterval: number = 30000; // 30 секунд
  private autosaveTimer: number | null = null;
  private currentState: GameState | null = null;
  
  constructor() {
    // Настраиваем localforage
    this.store = localforage.createInstance({
      name: 'fluid-crowd-game',
      storeName: 'game_saves'
    });
  }
  
  async initialize(): Promise<void> {
    try {
      // Пытаемся загрузить существующий профиль
      const savedState = await this.store.getItem<GameState>('current_game');
      
      if (savedState) {
        this.currentState = savedState;
        console.log('Game loaded from save:', savedState.profile.id);
      } else {
        // Создаем новый профиль
        await this.createNewProfile();
      }
      
      // Запускаем автосохранение
      this.startAutosave();
      
      // Сохраняем при закрытии страницы
      window.addEventListener('beforeunload', () => {
        this.saveSync();
      });
      
    } catch (error) {
      console.error('Failed to initialize save system:', error);
      // Создаем новый профиль в случае ошибки
      await this.createNewProfile();
    }
  }
  
  private async createNewProfile(): Promise<void> {
    const newProfile: PlayerProfile = {
      id: uuidv4(),
      resources: {
        mana: 100,
        gold: 50,
        wood: 30
      },
      technologies: ['basic_defense'],
      buildingSlots: [
        { id: 'slot_1', type: 'mana_generator', level: 1 },
        { id: 'slot_2', type: 'empty', level: 0 },
        { id: 'slot_3', type: 'empty', level: 0 }
      ],
      unlockedElements: ['fire', 'water'],
      highScore: 0,
      totalPlayTime: 0,
      lastPlayed: Date.now()
    };
    
    this.currentState = {
      profile: newProfile,
      currentSeed: Date.now().toString(),
      sessionStart: Date.now(),
      levelProgress: 0
    };
    
    await this.save();
    console.log('New profile created:', newProfile.id);
  }
  
  async save(): Promise<void> {
    if (!this.currentState) return;
    
    try {
      // Обновляем время последней игры
      this.currentState.profile.lastPlayed = Date.now();
      
      await this.store.setItem('current_game', this.currentState);
      console.log('Game saved successfully');
    } catch (error) {
      console.error('Failed to save game:', error);
    }
  }
  
  saveSync(): void {
    if (!this.currentState) return;
    
    try {
      // Синхронное сохранение (для beforeunload)
      this.currentState.profile.lastPlayed = Date.now();
      
      // Используем localStorage как fallback
      localStorage.setItem('fluid_crowd_game_backup', JSON.stringify(this.currentState));
    } catch (error) {
      console.error('Failed to save game synchronously:', error);
    }
  }
  
  async load(): Promise<GameState | null> {
    try {
      const savedState = await this.store.getItem<GameState>('current_game');
      
      if (savedState) {
        this.currentState = savedState;
        return savedState;
      }
      
      // Пробуем загрузить из backup
      const backup = localStorage.getItem('fluid_crowd_game_backup');
      if (backup) {
        this.currentState = JSON.parse(backup);
        return this.currentState;
      }
      
      return null;
    } catch (error) {
      console.error('Failed to load game:', error);
      return null;
    }
  }
  
  getCurrentState(): GameState | null {
    return this.currentState;
  }
  
  updateResources(resources: Partial<PlayerProfile['resources']>): void {
    if (!this.currentState) return;
    
    Object.assign(this.currentState.profile.resources, resources);
  }
  
  unlockTechnology(techId: string): void {
    if (!this.currentState) return;
    
    if (!this.currentState.profile.technologies.includes(techId)) {
      this.currentState.profile.technologies.push(techId);
    }
  }
  
  unlockElement(elementId: string): void {
    if (!this.currentState) return;
    
    if (!this.currentState.profile.unlockedElements.includes(elementId)) {
      this.currentState.profile.unlockedElements.push(elementId);
    }
  }
  
  updateBuildingSlot(slotId: string, type: string, level: number): void {
    if (!this.currentState) return;
    
    const slot = this.currentState.profile.buildingSlots.find(s => s.id === slotId);
    if (slot) {
      slot.type = type;
      slot.level = level;
    }
  }
  
  updateHighScore(score: number): void {
    if (!this.currentState) return;
    
    if (score > this.currentState.profile.highScore) {
      this.currentState.profile.highScore = score;
    }
  }
  
  updateLevelProgress(progress: number): void {
    if (!this.currentState) return;
    
    this.currentState.levelProgress = progress;
  }
  
  setCurrentSeed(seed: string): void {
    if (!this.currentState) return;
    
    this.currentState.currentSeed = seed;
  }
  
  private startAutosave(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
    }
    
    this.autosaveTimer = window.setInterval(() => {
      this.save().catch(error => {
        console.error('Autosave failed:', error);
      });
    }, this.autosaveInterval);
  }
  
  stopAutosave(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }
  
  async resetProfile(): Promise<void> {
    await this.createNewProfile();
  }
  
  async exportSave(): Promise<string> {
    if (!this.currentState) return '';
    
    return JSON.stringify(this.currentState, null, 2);
  }
  
  async importSave(saveData: string): Promise<boolean> {
    try {
      const importedState = JSON.parse(saveData) as GameState;
      
      // Базовая валидация
      if (!importedState.profile || !importedState.profile.id) {
        throw new Error('Invalid save data');
      }
      
      this.currentState = importedState;
      await this.save();
      return true;
    } catch (error) {
      console.error('Failed to import save:', error);
      return false;
    }
  }
}