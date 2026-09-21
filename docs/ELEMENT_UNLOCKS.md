# Прогрессия стихий — проектирование

> **📌 Статус:** ✅ РЕАЛИЗОВАНО
> **🎯 Цель:** внутризабеговая прогрессия с персистентной разлочкой: стихии открываются по мере достижения уровней забега, «открыл — открыл». Недоступны только на самом старте (первый запуск) и после сброса кнопкой «Сбросить прогресс».

---

## 1. Что делаем

| Стихия | Открывается при достижении уровня |
|---|---|
| Воздух | 2 |
| Вода | 4 |
| Земля | 6 |
| Огонь | 8 |
| Суперсила (⚡ Сила Бога — супер-заряд) | 10 |

**Правила поведения:**

- Кнопки стихий есть всегда. Закрытая стихия: подпись «Lvl. N» вместо названия; мана не копится (бар пуст); тап по алтарю не выбирает стихию; рисовать ей нельзя.
- Обычный тап-молния работает всегда (базовая атака бога не зависит от прогрессии). Супер-заряд Силы Бога копится только с 10 уровня: до этого `registerKills` — no-op, бар пуст, супер-режим недоступен, подпись иконки «Lvl. 10».
- Окно прокачки: закрытые стихии не скрываются, а показываются строкой-заглушкой «🔒 Откроется на Lvl. N» вместо строк покупки.
- **Уровень отсчёта — максимальный достигнутый уровень забега (персистентный)**, не текущий: GAME OVER не откатывает разлочку.
- Сброс разлочки — только «↺ Сбросить прогресс» (и полный fresh-start через `resetAll()`).

---

## 2. Как устроено в коде

### 2.1. `src/game/config/elementUnlocks.ts` (новый модуль)

```ts
export const ELEMENT_UNLOCK_LEVELS: Record<ElementType | 'god', number> = {
  air: 2, water: 4, earth: 6, fire: 8, god: 10
};
export function isElementUnlocked(key, maxLevel): boolean  // maxLevel >= ELEMENT_UNLOCK_LEVELS[key]
export function unlockLabel(key): string                   // `Lvl. ${level}`
```

Единственный источник правды для уровней открытия — используется GameScene (кнопки/подписи) и UpgradeScene (заглушки групп).

### 2.2. `UpgradeSystem.ts` — персистентный источник разлочки

- `ProgressionSave.maxLevelReached: number` (default 0).
- `recordMaxLevel(level)` — неотрицательный `max(cur, level)`, сохраняет.
- `reset()` (кнопка «Сбросить прогресс») и `resetAll()` — обнуляют `maxLevelReached` (стихии снова закрываются). `resetSouls()` — не трогает.
- `load()`/`save()` читают и пишут поле.

### 2.3. `ElementManaSystem.ts` — «мана не копится»

- Состояние `lockedKeys: Set<ElementType>` + `setLocked(keys)` / `isLocked(key)` (конструктор не меняется — бэк-компат с тестами).
- `gainFromKills()` пропускает заблокированные.
- `canUse`/`arm`/`use`/`spend` возвращают `false` для заблокированного ключа.

### 2.4. `GodPowerSystem.ts` — супер-заряд с 10 ур.

- `setLocked(bool)` / `isLocked`.
- `registerKills()` — no-op при lock; `arm()` — false при lock. Обычная молния вне системы — не затрагивается.

### 2.5. `GodPowerIcon.ts` — вид «заперто»

- `setLocked(locked, label)`: при lock подпись «Lvl. 10» вместо «СИЛА БОГА», без заливки/пульса/вспышек, иконка потушена.

### 2.6. `GameScene.ts`

- `createElements()`: подпись = название, если открыта, иначе «Lvl. N»; `onToggle` игнорирует тап по закрытой.
- `progression.recordMaxLevel(currentLevel)`: в `setLevel()` и в `applyStoredTuning()` после восстановления уровня (покрывает перезагрузку страницы в середине забега).
- `syncUnlocks()`: синхронит `lockedKeys` → `elementMana`, lock → `godPower`, обновляет подписи/бары/иконку. Вызовы: в `create()` после восстановления тюнинга и в `restartLevel()`.
- `toggleSuperMode()`: guard `if (godPower.isLocked) return`.

### 2.7. `UpgradeScene.ts` — окно прокачки

- Источник разлочки — `progression.maxLevelReached` (общий синглтон, передавать уровень не нужно).
- `buildGroups()` возвращает `{ name, defs, locked, unlockLevel }`.
- `rebuildContent()`: для закрытой группы — строка-заглушка «🔒 Откроется на Lvl. N» вместо строк покупки.

---

## 3. Крайние случаи

- **GAME OVER** → `currentLevel` сбрасывается в 1, разлочка НЕ откатывается (`maxLevelReached` персистентен).
- **Первый запуск / «Сбросить прогресс» / `resetAll()`** → `maxLevelReached = 0`, всё закрыто.
- **Ресайз окна**: `createElements()` пересоздаёт подписи по актуальным замкам.
- **Перезагрузка страницы mid-run**: `applyStoredTuning()` восстанавливает уровень → `recordMaxLevel` → `syncUnlocks()` выставляет замки/подписи.
- **Окно прокачки на ранних уровнях**: все группы показываются заглушками «Откроется на Lvl. N» (пустых секций нет).

---

## 4. Тесты (Jest)

- `UpgradeSystem.test.ts`: persist/load `maxLevelReached`; `recordMaxLevel` не уменьшает; `reset()`/`resetAll()` обнуляют; `resetSouls()` сохраняет.
- `ElementManaSystem.test.ts`: locked не копит ману, `arm`/`canUse`/`spend` — false, разлочка возобновляет накопление.
- Новый `GodPowerSystem.test.ts`: lock — `registerKills`/`arm` — no-op; разлочка работает как раньше.

**Проверка:** `npm run lint`, `npm test`, `npm run build`.