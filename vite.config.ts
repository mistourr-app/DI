import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';

/** Абсолютный путь к docs/balance_1.csv (ESM-safe, без __dirname) */
const balancePath = fileURLToPath(new URL('./docs/balance_1.csv', import.meta.url));

/**
 * Виртуальный модуль virtual:balance — содержимое docs/balance_1.csv
 * (единственный источник баланса). ?raw-импорт из docs/ Vite'ом напрямую
 * не резолвится, поэтому файл читается плагином на этапе сборки.
 * addWatchFile: dev-сервер перечитывает CSV при его изменении (иначе
 * показывались устаревшие цены).
 */
function balanceCsvPlugin(): Plugin {
  return {
    name: 'balance-csv',
    resolveId(id) {
      if (id === 'virtual:balance') return '\0virtual:balance';
    },
    load(id) {
      if (id !== '\0virtual:balance') return;
      this.addWatchFile(balancePath);
      const csv = readFileSync(balancePath, 'utf8');
      return `export default ${JSON.stringify(csv)};`;
    }
  };
}

export default defineConfig({
  // GitHub Pages публикует репозиторий в подкаталог: /DI/
  base: '/DI/',
  plugins: [
    balanceCsvPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Fluid Crowd Defense',
        short_name: 'FluidGame',
        description: 'A strategy game with fluid crowd simulation',
        theme_color: '#1a1a2e',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globDirectory: 'dist/',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.github\.io\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'github-pages-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 дней
              }
            }
          }
        ]
      }
    })
  ],
  build: {
    target: 'es2020',
    outDir: 'dist'
  },
  server: {
    port: 3000,
    open: true
  }
});
