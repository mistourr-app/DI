// ============================================================
// progressionStore — единый инстанс UpgradeSystem на всё приложение.
// GameScene и UpgradeScene работают с одним и тем же объектом прогресса
// (души, уровни параметров, пройденные уровни): нет перезагрузки из
// localStorage и рассинхрона душ между сценами.
// ============================================================

import { UpgradeSystem } from './UpgradeSystem';
import { upgradeCatalog } from './upgradeCatalog';

export const progression = new UpgradeSystem(upgradeCatalog);
