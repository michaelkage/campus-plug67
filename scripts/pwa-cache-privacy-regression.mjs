import fs from 'node:fs'

const read = (relativePath) =>
  fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function includes(source, value, message) {
  if (!source.includes(value)) fail(message)
}

const vite = read('vite.config.ts')
const banner = read('src/components/ui/OfflineSyncBanner.tsx')

const supabaseRouteAt = vite.indexOf("url.hostname.endsWith('.supabase.co')")
const supabaseNetworkOnlyAt = vite.indexOf("handler: 'NetworkOnly'", supabaseRouteAt)
const imageRouteAt = vite.indexOf("request.destination === 'image'")

if (supabaseRouteAt < 0 || supabaseNetworkOnlyAt < supabaseRouteAt) {
  fail('Every Supabase request must be routed through NetworkOnly')
}

if (vite.includes("cacheName: 'api-network-first-v2'")) {
  fail('Private Supabase API responses must not be cached in Cache Storage')
}

if (imageRouteAt < 0 || !vite.slice(imageRouteAt).includes("!url.hostname.endsWith('.supabase.co')")) {
  fail('The image cache must exclude Supabase Storage objects')
}

if (!vite.slice(supabaseRouteAt, imageRouteAt).includes("url.pathname.startsWith('/storage/v1/')")) {
  fail('Supabase Storage paths must be network-only even behind a custom domain')
}

includes(vite, "url.pathname.startsWith('/auth/v1/')", 'Supabase Auth responses must be network-only')
includes(vite, "url.pathname.startsWith('/rest/v1/')", 'Supabase REST responses must be network-only')
includes(vite, "url.pathname.startsWith('/functions/v1/')", 'Supabase Edge Function responses must be network-only')

if (banner.includes('cp-offline-pending') || banner.includes('Sync in progress')) {
  fail('Offline UI must not claim a queue is syncing when no replay worker exists')
}

includes(banner, 'require a live connection', 'Offline UI must disclose which actions require connectivity')
includes(banner, 'A locally saved draft is not a completed or synced action', 'Offline UI must distinguish local drafts from completed server actions')

if (process.exitCode) process.exit(process.exitCode)
console.log('PWA cache privacy regression checks passed')
