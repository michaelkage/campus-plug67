import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// GitHub Pages serves the app from /campus-plug67/; local development,
// preview and CI/E2E runs serve it from the root.
const base = process.env.VITE_BASE_PATH || '/'

export default defineConfig(({ mode }) => ({
  base,
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    cleanupOutdatedCaches: true,
    manifest: { name: 'Campus Plug', short_name: 'Campus Plug', description: 'Tactical-aesthetic student marketplace', theme_color: '#0a0a0a', background_color: '#0a0a0a', display: 'standalone', icons: [{ src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' }, { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }] },
    workbox: {
      skipWaiting: true,
      clientsClaim: true,
      runtimeCaching: [
        {
          urlPattern: ({ url }) => url.hostname.includes('supabase.co') || url.pathname.startsWith('/functions/v1/') || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/'),
          handler: 'NetworkFirst',
          options: { cacheName: 'api-network-first', networkTimeoutSeconds: 5, expiration: { maxEntries: 64, maxAgeSeconds: 300 }, cacheableResponse: { statuses: [0, 200] } },
        },
        {
          urlPattern: ({ url, request }) => (url.hostname.includes('supabase.co') || url.pathname.startsWith('/functions/v1/') || url.pathname.startsWith('/rest/v1/')) && ['POST', 'PUT', 'PATCH'].includes(request.method),
          handler: 'NetworkOnly',
          options: { backgroundSync: { name: 'campus-plug-mutations', options: { maxRetentionTime: 24 * 60 } }, },
        },
        {
          urlPattern: ({ request }) => request.destination === 'image',
          handler: 'StaleWhileRevalidate',
          options: { cacheName: 'image-swr', expiration: { maxEntries: 120, maxAgeSeconds: 604800 }, cacheableResponse: { statuses: [0, 200] } },
        },
        {
          // Hashed JS/CSS/worker files are immutable for a given build, but
          // stale cross-build caches can leave an old HTML shell pointing at
          // chunks that no longer exist. Always prefer the network for these
          // assets so a fresh deployment wins immediately.
          urlPattern: ({ request }) => request.destination === 'style' || request.destination === 'script' || request.destination === 'worker',
          handler: 'NetworkFirst',
          options: {
            cacheName: 'static-network-first-v2',
            networkTimeoutSeconds: 3,
            expiration: { maxEntries: 120, maxAgeSeconds: 86400 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
      ],
    },
  })],
  server: { port: 5173, host: true },
  build: { outDir: 'dist', sourcemap: mode === 'development', rollupOptions: { output: { manualChunks: { 'react-vendor': ['react', 'react-dom', 'react-router-dom'], supabase: ['@supabase/supabase-js'], ui: ['framer-motion', 'lucide-react'] } } } },
}))
