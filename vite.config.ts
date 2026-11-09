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
        // Supabase responses can contain private profiles, wallets, chats,
        // transactions, and signed storage URLs. Cache keys do not vary by
        // Authorization header, so caching these responses can expose one
        // account's data to another account on a shared device.
        // Keep every Supabase API and Storage request network-only. Offline
        // escrow vouchers and receipts belong in the dedicated IndexedDB
        // outbox, never in the HTTP cache.
        {
          urlPattern: ({ url }) =>
            url.hostname.endsWith('.supabase.co') ||
            url.pathname.startsWith('/functions/v1/') ||
            url.pathname.startsWith('/rest/v1/') ||
            url.pathname.startsWith('/auth/v1/') ||
            url.pathname.startsWith('/storage/v1/'),
          handler: 'NetworkOnly',
        },
        // Never cache/replay mutations to any other origin either.
        {
          urlPattern: ({ request }) => !['GET', 'HEAD'].includes(request.method),
          handler: 'NetworkOnly',
        },
        {
          // Only cache images from non-Supabase origins. Supabase Storage
          // objects may be private or signed and must never enter Cache Storage.
          urlPattern: ({ request, url }) =>
            request.destination === 'image' && !url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/v1/'),
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
