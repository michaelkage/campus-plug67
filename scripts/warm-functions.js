#!/usr/bin/env node
/**
 * Campus Plug — Edge Function Keep-Alive Warmer v3
 *
 * Pings all Edge Functions' GET /ping endpoint to prevent Deno cold starts.
 * Run manually:   npm run warm
 * Run in CI/CD:   via .github/workflows/keep-warm.yml every 5 minutes
 *
 * Also triggers the auto-release cron to process timed-out transactions.
 *
 * Environment variables (read from process.env or .env.local):
 *   VITE_SUPABASE_URL          or SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY     or SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY  (optional — needed for auto-release)
 */

import 'dotenv/config'

const URL_ENV  = process.env.VITE_SUPABASE_URL        || process.env.SUPABASE_URL
const ANON_ENV = process.env.VITE_SUPABASE_ANON_KEY   || process.env.SUPABASE_ANON_KEY
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL_ENV || !ANON_ENV) {
  console.error('\n❌  Missing Supabase credentials.')
  console.error('    Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your environment.\n')
  process.exit(1)
}

// All Edge Functions to warm
const FUNCTIONS = [
  { name: 'release-escrow',        description: 'Escrow state machine + auto-release'       },
  { name: 'join-pool',             description: 'Study pool atomic join'                    },
  { name: 'paystack-webhook',      description: 'Payment confirmation handler'              },
  { name: 'passkey-auth',          description: 'WebAuthn challenge + verification'         },
  { name: 'process-growth-events', description: 'Streaks, referrals, check-ins, flash deals'},
  { name: 'process-dispute',       description: 'Peer jury: open cases, votes, rewards, reclaim'},
  { name: 'calculate-trending',    description: 'Weighted gravity, anti-collusion, rookie boost' },
]

async function triggerReclaimSilentJurors() {
  if (!SVC_KEY) return
  try {
    const res = await fetch(`${URL_ENV}/functions/v1/process-dispute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC_KEY}`, apikey: SVC_KEY },
      body: JSON.stringify({ action: 'reclaim_silent' }),
      signal: AbortSignal.timeout(20_000),
    })
    const d = await res.json().catch(() => ({}))
    console.log(`\n  ⚖️  Juror reclaim: ${d.reclaimed ?? 0} reclaimed, ${d.escalations ?? 0} escalated`)
  } catch (e) {
    console.log(`\n  ❌ Juror reclaim failed: ${e.message}`)
  }
}

function grade(ms) {
  if (ms <  150) return { icon: '🟢', label: 'HOT',  note: 'warm function' }
  if (ms <  400) return { icon: '🟡', label: 'WARM', note: 'acceptable'    }
  if (ms < 1000) return { icon: '🟠', label: 'COLD', note: 'cold start'    }
  return               { icon: '🔴', label: 'SLOW', note: 'very cold / timeout' }
}

async function pingFunction({ name, description }) {
  const url   = `${URL_ENV}/functions/v1/${name}/ping`
  const start = Date.now()

  try {
    const res = await fetch(url, {
      headers: {
        'apikey':        ANON_ENV,
        'Authorization': `Bearer ${ANON_ENV}`,
      },
      signal: AbortSignal.timeout(8000),
    })

    const ms      = Date.now() - start
    const { icon, label, note } = grade(ms)
    const body    = await res.json().catch(() => ({}))
    const ts      = body.ts ? `  ts=${body.ts}` : ''

    console.log(
      `  ${icon} ${name.padEnd(22)} ${String(ms).padStart(5)}ms  [${label.padEnd(4)}]  ${note}${ts}`
    )

    return { name, ok: res.ok, ms }
  } catch (err) {
    const ms = Date.now() - start
    console.log(
      `  ❌ ${name.padEnd(22)} ${String(ms).padStart(5)}ms  [ERR ]  ${err.message}`
    )
    return { name, ok: false, ms, error: err.message }
  }
}

async function triggerAutoRelease() {
  if (!SVC_KEY) {
    console.log('\n  ⚠️  SUPABASE_SERVICE_ROLE_KEY not set — skipping auto-release trigger')
    return
  }

  const start = Date.now()
  try {
    const res = await fetch(`${URL_ENV}/functions/v1/release-escrow`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SVC_KEY}`,
        'apikey':        SVC_KEY,
      },
      body:   JSON.stringify({ action: 'auto_release' }),
      signal: AbortSignal.timeout(15_000),
    })

    const data = await res.json().catch(() => ({}))
    const ms   = Date.now() - start

    if (res.ok) {
      const released  = data.released  ?? 0
      const processed = data.processed ?? 0
      console.log(
        `\n  🤖 Auto-release processed ${processed} job(s), released ${released} transaction(s)  (${ms}ms)`
      )
    } else {
      console.log(`\n  ⚠️  Auto-release returned HTTP ${res.status}: ${JSON.stringify(data)}`)
    }
  } catch (err) {
    console.log(`\n  ❌ Auto-release failed: ${err.message}`)
  }
}

async function main() {
  const ts = new Date().toLocaleString('en-NG', {
    weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  console.log(`\n╔══════════════════════════════════════════════════════════╗`)
  console.log(`║   Campus Plug — Edge Function Warmer v3                  ║`)
  console.log(`╚══════════════════════════════════════════════════════════╝`)
  console.log(`  Project:  ${URL_ENV}`)
  console.log(`  Time:     ${ts}`)
  console.log(`  Pinging ${FUNCTIONS.length} functions...\n`)

  const results = await Promise.all(FUNCTIONS.map(pingFunction))

  const allWarm = results.every(r => r.ok && r.ms < 400)
  const avgMs   = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length)

  console.log(`\n  Average latency: ${avgMs}ms`)
  console.log(allWarm
    ? `  ✅ All functions warm — ready for meetups`
    : `  ⚠️  Some functions need warming — retry in 30s`)

  await triggerAutoRelease()
  await triggerReclaimSilentJurors()
  await reclaimJurors()

  console.log('\n  Done.\n')

  // Exit with error if any function is down (useful for CI alerting)
  const anyDown = results.some(r => !r.ok)
  if (anyDown) process.exit(1)
}

main()

// v6.3: Juror reclaim function (appended — called from main)
async function reclaimJurors() {
  if (!SVC_KEY) return
  try {
    const res = await fetch(`${URL_ENV}/functions/v1/process-dispute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC_KEY}`, apikey: SVC_KEY },
      body:   JSON.stringify({ action: 'reclaim_jurors' }),
      signal: AbortSignal.timeout(10_000),
    })
    const d = await res.json().catch(() => ({}))
    if ((d.reclaimed || 0) > 0 || (d.escalated || 0) > 0) {
      console.log(`  ⚖️  Jury reclaim: ${d.reclaimed ?? 0} jurors reclaimed, ${d.escalated ?? 0} cases escalated`)
    }
  } catch {}
}
