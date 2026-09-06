#!/usr/bin/env node
/** Campus Plug — Edge Function Keep-Alive Warmer v4 */
import 'dotenv/config'

const URL_ENV = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON_ENV = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const HEALTH_HEADERS = { 'x-health-check': 'true' }

if (!URL_ENV || !ANON_ENV) {
  console.error('\n❌ Missing Supabase credentials.\n')
  process.exit(1)
}

const FUNCTIONS = [
  { name: 'release-escrow', description: 'Escrow state machine' },
  { name: 'join-pool', description: 'Study pool atomic join' },
  { name: 'paystack-webhook', description: 'Payment confirmation handler' },
  { name: 'passkey-auth', description: 'WebAuthn challenge + verification' },
  { name: 'process-growth-events', description: 'Growth workers' },
  { name: 'process-dispute', description: 'Peer jury worker' },
  { name: 'calculate-trending', description: 'Marketplace ranking worker' },
]

async function pingFunction({ name }) {
  const start = Date.now()
  try {
    const res = await fetch(`${URL_ENV}/functions/v1/${name}/ping`, {
      headers: { apikey: ANON_ENV, Authorization: `Bearer ${ANON_ENV}`, ...HEALTH_HEADERS },
      signal: AbortSignal.timeout(8000),
    })
    const ms = Date.now() - start
    const body = await res.text().catch(() => '')
    console.log(`${res.ok ? '🟢' : '🔴'} ${name.padEnd(24)} ${String(ms).padStart(5)}ms  HTTP ${res.status}${body ? `  ${body.slice(0, 80)}` : ''}`)
    return { name, ok: res.ok, ms }
  } catch (error) {
    const ms = Date.now() - start
    console.log(`❌ ${name.padEnd(24)} ${String(ms).padStart(5)}ms  ${error instanceof Error ? error.message : String(error)}`)
    return { name, ok: false, ms }
  }
}

async function triggerWorker(path, action, timeout = 15000) {
  if (!SVC_KEY) return
  try {
    const res = await fetch(`${URL_ENV}/functions/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC_KEY}`, apikey: SVC_KEY },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(timeout),
    })
    const data = await res.json().catch(() => ({}))
    console.log(`  ${res.ok ? '✅' : '⚠️'} ${path}/${action}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 180)}`)
  } catch (error) {
    console.log(`  ❌ ${path}/${action}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║   Campus Plug — Edge Function Warmer v4                  ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log(`  Project: ${URL_ENV}`)
  console.log(`  Health header: x-health-check=true`)
  console.log(`  Pinging ${FUNCTIONS.length} functions...\n`)

  const results = await Promise.all(FUNCTIONS.map(pingFunction))
  const avg = Math.round(results.reduce((sum, r) => sum + r.ms, 0) / Math.max(results.length, 1))
  console.log(`\n  Average latency: ${avg}ms`)

  // These are intentional worker actions, never part of the health-check pings.
  await triggerWorker('release-escrow', 'auto_release')
  await triggerWorker('process-dispute', 'reclaim_silent_jurors', 10000)
  await triggerWorker('process-dispute', 'reclaim_jurors', 10000)

  const anyDown = results.some(r => !r.ok)
  if (anyDown) process.exit(1)
  console.log('  ✅ Warm-up complete.\n')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
