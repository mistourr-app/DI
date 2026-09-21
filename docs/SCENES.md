# Разделение экранов на сцены: GameScene + UpgradeScene

> **Статус:** реализовано (typecheck, тесты, сборка и смоук через Puppeteer пройдены)
> **Ветка:** `Scenes`
> **Цель:** разнести геймплей и экран прокачки на отдельные Phaser-сцены, добавить поп-апы победы/поражения и переработать UX экрана прокачки.

---

## 1. Флоу

1. **Сцена «Экран геймплея» (GameScene).** Игрок играет, может открыть поп-ап настроек (⚙).
   - Все монстры уничтожены и база выжила → **поп-ап победы** с надписью `Deus vivit` и двумя кнопками:
     - **«Играть дальше»** — запускает следующий уровень;
     - **«Прокачка»** — открывает сцену прокачки.
   - База погибла → **поп-ап поражения** с надписью `Deus mortuus est` и кнопкой **«Начать заново»** (забег с 1-го уровня).
2. **Сцена «Экран прокачки» (UpgradeScene).**
   - При покупке параметра — индикатор покупки (зелёный фон строки/кнопки).
   - Внизу вместо одной кнопки «Играть» — две рядом: **«Сброс»** и **«Сохранить и играть»**.
     - **«Сброс»** — сбрасывает все покупки и возвращает души (респек).
     - **«Сохранить и играть»** — сохраняет и начинает следующий уровень.
   - В шапке временно остаётся тестовая кнопка «↺ Сбросить прогресс» (полный fresh start).

---

## 2. Принятые решения

| Вопрос | Решение |
|---|---|
| Какие экраны выносим в сцены | Только геймплей и прокачка. Поп-апы победы/поражения/настроек остаются внутри GameScene. |
| Модель покупок и «Сброс» | Покупки мгновенные (сразу в localStorage, как сейчас). «Сброс» = респек: `UpgradeSystem.reset()` возвращает 100% вложенных душ, уровни в 0. |
| Смысл индикатора покупки | «Куплено за текущий визит» на экран прокачки. Сбрасывается при входе и по кнопке «Сброс». |
| Кнопка «Начать заново» | Забег с 1-го уровня (текущее поведение GAME OVER): `currentLevel = 1`, HP базы восстановлено, новый seed. |
| Совмещение сцен | GameScene уходит в `sleep`, UpgradeScene запускается поверх (`launch`). Прогресс — общий модульный синглтон. |
| Вид индикатора покупки | Зелёный фон строки/кнопки параметра. |
| Активация кнопок поп-апов | Кнопки становятся активными спустя ~1 сек после появления (защита от инерции быстрых тапов). |
| Старая кнопка «↺ Сбросить прогресс» | Оставляем (временная, для тестирования). |

---

## 3. Архитектура

### 3.1 Почему sleep, а не stop

- `sleep` сохраняет всё состояние забега бесплатно: `baseHealth`, `currentLevel`, живых монстров, нарисованную землю/эффекты, ману алтарей, заряд бога, геометрию уровня и воркер.
- Воркер физики не имеет собственного цикла — шагает только по вызову `FluidSimulationController.update()` из `GameScene.update()`. Пока сцена спит, физика и рендер не работают (фоновой нагрузки нет).
- `stop` потребовал бы вынести и вернуть run-state вручную, а `shutdown` GameScene уничтожает воркер, drawer, барьер, оверлеи — возврат в бой = полная переинициализация уровня. Плюс ловушка: `UpgradeSystem.addSouls()` не сохраняет, и несохранённые души потерялись бы.

### 3.2 Общий синглтон прогресса

`UpgradeSystem` выносится в модульный синглтон, чтобы GameScene и UpgradeScene работали с одним инстансом (нет перезагрузки из localStorage и рассинхрона душ).

### 3.3 Схема переходов

```
GameScene (active)
  ├─ победа → victoryPopup
  │     ├─ «Играть дальше» → nextLevel()                 [остаёмся в GameScene]
  │     └─ «Прокачка»     → launch(UpgradeScene) + sleep(GameScene)
  │                            └─ «Сохранить и играть» → requestNextLevel()
  │                                                       + wake(GameScene) + stop(UpgradeScene)
  └─ поражение → defeatPopup
        └─ «Начать заново» → currentLevel = 1; restartLevel(true)
```

Контракт между сценами — публичные методы GameScene:
- `requestNextLevel()` — `applyAllProgression()` + `nextLevel()`;
- `resetAllProgress()` — сделать `public` (текущий fresh start для тестовой кнопки).

UpgradeScene получает ссылку через `import type { GameScene }` + `this.scene.get('GameScene')` (без рантайм-цикла импортов).

---

## 4. Изменения по файлам

### 4.1 Новые файлы

1. **`src/game/progression/progressionStore.ts`** — синглтон:
   ```ts
   import { UpgradeSystem } from './UpgradeSystem';
   import { upgradeCatalog } from './upgradeCatalog';

   export const progression = new UpgradeSystem(upgradeCatalog);
   ```
2. **`src/game/config/layout.ts`** — общая функция `computeGameArea(screenWidth, screenHeight): Phaser.Geom.Rectangle` (математика игрового поля 9:19.5 выносится из `GameScene.setupScreenZones`, чтобы обе сцены считали границы одинаково).
3. **`src/scenes/UpgradeScene.ts`** — экран прокачки (портируется из GameScene).

### 4.2 GameScene

**Импорты и поля**
- Брать `progression` из синглтона вместо `new UpgradeSystem(upgradeCatalog)`.
- Оставить `upgradeCatalog` (для `applyAllProgression`); убрать `upgradeDefs`, `valueAt`, `displayValue`, `UpgradeDef`.
- Удалить поля экрана прокачки (`progressionRoot`, `progressionContent`, `progressionScrollY/MaxScroll`, `progressionViewportTop/Bottom`, `progDragging/DragStartY/ScrollStart/Moved`) и `endText`.
- Добавить `victoryPopup` / `defeatPopup`.

**Методы**
- Удалить (переезжают в UpgradeScene): `buildProgressionGroups`, `openProgressionScreen`, `closeProgressionScreen`, `setProgressionScroll`, `rebuildProgressionContent`, `renderProgressionRow`, `rowValue`, `showEndMessage`.
- `setupScreenZones` — использовать `computeGameArea`.
- `showVictory()` — `progression.completeLevel(currentLevel)` + `showVictoryPopup()`.
- `showGameOver()` — `showDefeatPopup()`.
- `openUpgradeScene()` — `this.scene.launch('UpgradeScene'); this.scene.sleep();`.
- `requestNextLevel()` — публичный: `applyAllProgression(); nextLevel();`.
- `resetAllProgress()` — сделать публичным.
- `setupInput()` — убрать обработчики скролла прокачки; при `gameOverShown` в обработчике поля просто `return` (рестарт теперь по кнопке).
- `restartLevel()` — убрать вызов `closeProgressionScreen()`.
- `create()` / `shutdown` — убрать очистку полей прокачки, уничтожать поп-апы.
- `handleResize()` — guard `if (!this.scene.isActive()) return;`, чтобы ресайз не перегенерировал уровень, пока сцена спит.

### 4.3 UpgradeScene

- `create()`:
  - полный непрозрачный фон на весь экран (GameScene спит и не рендерит) + панель в границах `computeGameArea`;
  - шапка: «ПРОКАЧКА», `Души: N`, тестовая «↺ Сбросить прогресс»;
  - список с маской и скроллом (drag + wheel), портируется из GameScene;
  - `purchasedThisVisit = new Set<string>()`.
- **Строка параметра**: если `purchasedThisVisit.has(key)` — зелёный полупрозрачный фон строки. `buyUpgrade`: `progression.buy(key)` → `purchasedThisVisit.add(key)` → `rebuildProgressionContent()`. GameConfig применяется в GameScene при пробуждении.
- **Нижняя панель** — две кнопки рядом:
  - «Сброс» → `progression.reset(); purchasedThisVisit.clear(); rebuildProgressionContent();` (остаёмся на экране);
  - «Сохранить и играть» → `progression.save(); gameScene.requestNextLevel(); this.scene.wake('GameScene'); this.scene.stop();`.
- Шапка «↺ Сбросить прогресс» → `gameScene.resetAllProgress(); this.scene.wake('GameScene'); this.scene.stop();`.
- `resize` / `shutdown`: пересборка layout и снятие листенеров.

### 4.4 Game.ts

- `scene: [GameScene, UpgradeScene]` (автостартует только первая сцена).

---

## 5. Поп-апы победы и поражения

- Контейнер `depth 1300`, `setScrollFactor(0)`.
- Затемнение игровой области, надпись по центру, кнопки на `zone` (интерактивные зоны поверх графики).
- Победа: `Deus vivit` (золото), кнопки «Играть дальше» и «Прокачка».
- Поражение: `Deus mortuus est` (красный), кнопка «Начать заново».
- **Задержка активации кнопок ~1 сек**: кнопки становятся интерактивными только спустя секунду после появления поп-апа. Причина: игрок быстро тапает по монстрам, игра внезапно заканчивается, и по инерции можно нажать не туда (например, случайно уйти на следующий уровень или в прокачку). До истечения задержки зоны кнопок не реагируют; при желании — визуально приглушены/полупрозрачны. Реализация: `setInteractive` включается через `this.time.delayedCall(1000, ...)` либо флаг `popupReady`.
- Сценарный обработчик `pointerdown` не мешает кнопкам: guard `if (this.victoryShown) return;` / `if (this.gameOverShown) return;` гасит только поле, а игровые объекты получают события независимо.
- Бонус +10·N душ начисляется в момент победы (до показа поп-апа), сохраняется через `completeLevel()`.

---

## 6. Краевые случаи и риски

- **Прокачка — только вперёд** (по ТЗ нет «Назад»): выходы — «Сброс» (остаёмся) и «Сохранить и играть» (следующий уровень).
- **Ресайз при спящей GameScene**: глобальный `scale.on('resize')` срабатывает и во сне — нужен guard, иначе уровень перегенерируется в фоне. UpgradeScene пересобирает свой layout сама.
- **Применение прокачки**: покупки в UpgradeScene мутируют только `UpgradeSystem`; в GameConfig всё применяется на пробуждении через `applyAllProgression()`.
- **Порядок launch/sleep**: запускать UpgradeScene и усыплять GameScene в одном тике (`launch` → `sleep`); Phaser обрабатывает операции сцен через очередь менеджера сцен.
- **Импорт-цикл** GameScene ↔ UpgradeScene: только `import type` для типа GameScene.
- **Инерция тапов**: игрок быстро тапает по монстрам в момент победы/поражения — кнопки поп-апа активируются с задержкой ~1 сек, чтобы случайный тап не увёл на следующий уровень/в прокачку/на рестарт.

---

## 7. План разработки

1. [x] **Общая основа**: создать `layout.ts` (`computeGameArea`) и `progressionStore.ts`; переключить GameScene на синглтон и общий layout. Проверка: `npm run build`.
2. [x] **Регистрация сцены**: добавить UpgradeScene-заглушку, зарегистрировать в `Game.ts`.
3. [x] **Перенос UI прокачки**: вынести из GameScene методы/поля экрана прокачки в UpgradeScene (фон, шапка, список, маска, скролл). Проверка: экран открывается поверх усыплённого геймплея.
4. [x] **Переходы**: `openUpgradeScene`, публичные `requestNextLevel`/`resetAllProgress`, wake/stop. Проверка: «Прокачка» → «Сохранить и играть» → следующий уровень с сохранённым HP.
5. [x] **Поп-ап победы**: `Deus vivit` + кнопки «Играть дальше» / «Прокачка»; убрать авто-открытие прокачки на победе; кнопки активны спустя ~1 сек после появления.
6. [x] **Поп-ап поражения**: `Deus mortuus est` + «Начать заново» (забег с 1-го уровня); убрать авто-рестарт по тапу; кнопки активны спустя ~1 сек после появления.
7. [x] **UX прокачки**: зелёный индикатор покупки за визит; нижние кнопки «Сброс» и «Сохранить и играть»; тестовая «↺ Сбросить прогресс» в шапке.
8. [x] **Чистка GameScene**: удалить перемещённый код, guard ресайза, обновить shutdown.
9. [x] **Проверка**: `npm test` (97/97), `npm run build` (tsc + vite) — проходят; `npm run lint` не запускается из-за отсутствующей конфигурации ESLint (проблема репозитория, не изменений); ручной смоук через `npm run preview` + Puppeteer: поп-апы, sleep/wake, покупка+индикатор, респек, рестарт — OK.
10. [x] **Документация**: обновить `docs/PROGRESSION.md` (раздел as-built) и `docs/GAME_DESIGN_DOCUMENT.md` при необходимости.

---

## 8. Проверка (критерии готовности)

- Победа: появляется поп-ап с `Deus vivit`; «Играть дальше» ведёт на следующий уровень; «Прокачка» открывает UpgradeScene.
- Поражение: появляется поп-ап с `Deus mortuus est`; «Начать заново» начинает забег с 1-го уровня.
- Кнопки обоих поп-апов не реагируют на тапы в течение ~1 сек после появления.
- UpgradeScene: покупка подсвечивает строку зелёным; «Сброс» возвращает души и гасит подсветку; «Сохранить и играть» сохраняет и запускает следующий уровень.
- HP базы и `currentLevel` не теряются при переходе в прокачку и обратно.
- `npm test`, `npm run build`, `npm run lint` проходят.

---

## 9. Ссылки

- [PROGRESSION.md](./PROGRESSION.md) — экономика, респек, `UpgradeSystem`.
- [GAME_DESIGN_DOCUMENT.md](./GAME_DESIGN_DOCUMENT.md) — алтари, сила бога.
- Код: `src/scenes/GameScene.ts`, `src/game/progression/UpgradeSystem.ts`, `src/game/progression/upgradeCatalog.ts`, `src/game/Game.ts`, `src/game/config/uiScale.ts`.

---

**Дата:** 21.09.2026

### История изменений

| Дата | Изменение |
|------|-----------|
| 21.09.2026 | Создан документ: план разнесения на GameScene + UpgradeScene, поп-апы, UX прокачки, план разработки |
| 21.09.2026 | Добавлена задержка активации кнопок поп-апов ~1 сек (защита от инерции быстрых тапов) |
| 21.09.2026 | Реализовано: `layout.ts`, `progressionStore.ts`, `UpgradeScene.ts`, поп-апы в GameScene, респек/индикатор покупки, переходы sleep/wake; `Game.ts` регистрирует обе сцены. `tsc --noEmit`, `npm test` (97/97), `npm run build` и Puppeteer-смоук пройдены |
| 21.09.2026 | Фикс: монстры продолжают доходить до базы при 0 HP, каждый вызов `handleEnemyReachedBase` пересоздавал поп-ап поражения и заново запускал секундную задержку — кнопка активировалась только с последним монстром. Добавлен guard `if (this.gameOverShown) return;` в `showGameOver()` |
| 21.09.2026 | Фикс: «Начать заново» не пересчитывал базовые плотность/размер структур уровня — 1-й уровень генерировался с настройками проигранного. Добавлен `applyLevelGenerationSettings()` (используется в `setLevel` и `onDefeatRestart`); `applyStoredTuning()` теперь всегда применяет базовые ген-параметры уровня (в т.ч. на чистой установке), оверрайды поп-апа — поверх |
