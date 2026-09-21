import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-var-requires */
const puppeteer = require('puppeteer');

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/DI/`;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_KEY = 'fluid-crowd-defense.progression.v1';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Проверка, что dev-сервер отвечает (< 500) */
function ping(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await wait(300);
  }
  throw new Error(`Vite dev server не поднялся за ${timeoutMs} мс: ${BASE_URL}`);
}

describe('сцены: геймплей <-> прокачка (e2e)', () => {
  let server: ChildProcess;
  let browser: any;
  let page: any;
  let pageErrors: string[] = [];

  beforeAll(async () => {
    const viteBin = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    server = spawn(
      process.execPath,
      [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--no-open'],
      { cwd: PROJECT_ROOT, stdio: 'ignore', env: { ...process.env, BROWSER: 'none' } }
    );
    await waitForServer();

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1600 });
    pageErrors = [];
    page.on('pageerror', (err: Error) => pageErrors.push(String(err)));
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction('!!window.__di && !!window.__gc && !!window.__prog', { timeout: 30000 });
  }, 180000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server && !server.killed) server.kill();
  });

  test('победа открывает UpgradeScene, «Сохранить и играть» возвращает в геймплей', async () => {
    await page.evaluate(() => {
      (window as any).__di.showVictory();
    });
    await page.waitForFunction(
      'window.__di.victoryPopup && window.__di.victoryPopup.active',
      { timeout: 10000 }
    );

    await page.evaluate(() => {
      (window as any).__di.onVictoryUpgrade();
    });
    await page.waitForFunction(
      "window.__di.scene.isSleeping('GameScene') && window.__di.scene.isActive('UpgradeScene')",
      { timeout: 10000 }
    );

    await page.evaluate(() => {
      (window as any).__di.scene.get('UpgradeScene').onSaveAndPlay();
    });
    await page.waitForFunction(
      "window.__di.scene.isActive('GameScene') && !window.__di.scene.isActive('UpgradeScene')",
      { timeout: 10000 }
    );
  });

  test('поражение: души за забег сохраняются, бейдж +N, рестарт на 1-й уровень', async () => {
    const result = await page.evaluate((storageKey: string) => {
      const di = (window as any).__di;
      const p = (window as any).__prog;
      // Детерминируем награду: точка отсчёта = текущему балансу, затем +42
      di.soulsRunStart = p.totalSouls;
      p.addSouls(42);
      const dirtyBefore = p.hasUnsaved;

      di.showGameOver();

      const texts = (di.defeatPopup?.list ?? [])
        .filter((o: any) => typeof o.text === 'string')
        .map((o: any) => o.text);
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw).souls : null;
      return {
        dirtyBefore,
        texts,
        saved,
        total: p.totalSouls,
        dirtyAfter: p.hasUnsaved
      };
    }, STORAGE_KEY);

    expect(result.dirtyBefore).toBe(true);
    expect(result.texts.join(' ')).toContain('Души за забег: +42');
    expect(result.saved).toBe(result.total);
    expect(result.dirtyAfter).toBe(false);

    const after = await page.evaluate(() => {
      const di = (window as any).__di;
      di.onDefeatRestart();
      return {
        level: di.currentLevel,
        popup: di.defeatPopup,
        gameOverShown: di.gameOverShown
      };
    });

    expect(after.level).toBe(1);
    expect(after.popup).toBeNull();
    expect(after.gameOverShown).toBe(false);
  });

  test('без ошибок на странице за прогон', () => {
    expect(pageErrors).toEqual([]);
  });
});
