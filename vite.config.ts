import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/DI/', // ✅ Base path для GitHub Pages (https://mistourr-app.github.io/DI/)
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Fluid Crowd Defense',
        short_name: 'FluidGame',
        description: 'A strategy game with fluid crowd simulation',
        theme_color: '#1a1a2e',
        icons: [
          {
            src: '/DI/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/DI/pwa-512x512.png',
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