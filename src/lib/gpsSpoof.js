/**
 * Campus Plug — GPS Spoof Detection
 *
 * FIX: Removed explicit `.js` extension from the supabase import.
 *      The old code used `import { supabase } from './supabase.js'` which breaks
 *      Vite's pre-bundling when the project has `"type": "module"` and the alias
 *      framework is configured for extensionless imports.
 *
 * FIX: Removed the broken fallback RPC call:
 *      `supabase.rpc('gps_spoof_flags + 1' as any)` — this is not a valid RPC name.
 *      The fallback now uses a proper read-then-write increment.
 *
 * Detects and flags (never blocks) suspicious GPS behaviour:
 *   1. Impossible speed  — movement faster than 50 m/s (~180 km/h)
 *   2. Position jump     — sudden teleport > 10 km between readings
 *   3. Accuracy gaming   — reported accuracy < 3 m (suspiciously perfect)
 */

import { supabase } from '@/lib/supabase'

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_SPEED_MS       = 50        // m/s — ~180 km/h, impossible on campus
const MAX_JUMP_M         = 10_000    // 10 km teleport = spoof
const MIN_ACCURACY_M     = 3         // < 3 m reported accuracy is suspicious
const SPOOF_LOG_THROTTLE = 60_000    // ms — max one log per reason per minute

// ── In-memory state (reset on page load) ─────────────────────────────────────
let _lastPosition     = null   // GeolocationCoordinates | null
let _lastPositionTime = 0
let _lastLogTime      = {}     // Record<string, number>

// ── Haversine distance (metres) ───────────────────────────────────────────────
function distanceM(lat1, lng1, lat2, lng2) {
  const R    = 6_371_000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Server-side log (fire-and-forget) ─────────────────────────────────────────
async function logSpoof({ userId, transactionId, reason, lat, lng, speedMs }) {
  const throttleKey = `${userId}:${reason}`
  const now = Date.now()
  if (_lastLogTime[throttleKey] && now - _lastLogTime[throttleKey] < SPOOF_LOG_THROTTLE) return
  _lastLogTime[throttleKey] = now

  try {
    await supabase.from('gps_spoof_log').insert({
      user_id:        userId,
      transaction_id: transactionId ?? null,
      reason,
      reported_lat:   lat,
      reported_lng:   lng,
      speed_ms:       speedMs ?? null,
    })

    // Attempt to use a DB-level RPC for atomic increment
    const { error: rpcErr } = await supabase.rpc('increment_spoof_flag', {
      p_user_id: userId,
    })

    if (rpcErr) {
      // Fallback: read current value then write incremented value
      const { data: profile } = await supabase
        .from('profiles')
        .select('gps_spoof_flags')
        .eq('id', userId)
        .single()

      if (profile !== null) {
        await supabase
          .from('profiles')
          .update({ gps_spoof_flags: (profile.gps_spoof_flags ?? 0) + 1 })
          .eq('id', userId)
      }
    }
  } catch {
    // Never throw — spoof detection must not break the core flow
  }
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyse a new GPS position for spoof signals.
 * @returns {{ clean: boolean, flags: Array, speedMs: number|null }}
 */
export function analysePosition(coords, userId, transactionId) {
  const result = { clean: true, flags: [], speedMs: null }
  const now    = Date.now()
  const lat    = coords.latitude
  const lng    = coords.longitude

  // Check 1: impossible speed
  if (_lastPosition && _lastPositionTime > 0) {
    const elapsed = (now - _lastPositionTime) / 1_000  // seconds
    if (elapsed > 0 && elapsed < 3_600) {
      const dist    = distanceM(lat, lng, _lastPosition.latitude, _lastPosition.longitude)
      const speedMs = dist / elapsed
      result.speedMs = Math.round(speedMs * 10) / 10

      if (speedMs > MAX_SPEED_MS) {
        result.clean = false
        result.flags.push({
          reason:   'impossible_speed',
          severity: 'warning',
          detail:   `Moved ${Math.round(dist)}m in ${Math.round(elapsed)}s (${Math.round(speedMs * 3.6)} km/h)`,
        })
        if (userId) logSpoof({ userId, transactionId, reason: 'impossible_speed', lat, lng, speedMs })
      }

      // Check 2: position jump
      if (dist > MAX_JUMP_M) {
        result.clean = false
        result.flags.push({
          reason:   'position_jump',
          severity: 'warning',
          detail:   `Position jumped ${Math.round(dist / 1000)}km in one reading`,
        })
        if (userId) logSpoof({ userId, transactionId, reason: 'position_jump', lat, lng })
      }
    }
  }

  // Check 3: suspiciously perfect accuracy (note-level only — no server log)
  if (coords.accuracy < MIN_ACCURACY_M) {
    result.flags.push({
      reason:   'perfect_accuracy',
      severity: 'note',
      detail:   `Reported accuracy: ${coords.accuracy.toFixed(1)}m (unusually precise)`,
    })
  }

  _lastPosition     = coords
  _lastPositionTime = now
  return result
}

/**
 * Reset position state (call on unmount or when transaction ends).
 */
export function resetPositionState() {
  _lastPosition     = null
  _lastPositionTime = 0
}

/**
 * GPS trust weight based on cumulative spoof flags.
 * Used to discount proximity evidence — never to block.
 */
export function gpsWeight(spoofFlagCount) {
  if (spoofFlagCount >= 5) return 0.4
  if (spoofFlagCount >= 3) return 0.6
  if (spoofFlagCount >= 1) return 0.8
  return 1.0
}
