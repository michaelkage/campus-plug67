/**
 * Campus Plug — GPS spoof detection.
 *
 * Detection is advisory: suspicious movement is logged for trust scoring but
 * never blocks a legitimate meetup on its own.
 */

import { supabase } from '@/lib/supabase'

const MAX_SPEED_MS = 50
const MAX_JUMP_M = 10_000
const MIN_ACCURACY_M = 3
const SPOOF_LOG_THROTTLE = 60_000

let lastPosition = null
let lastPositionTime = 0
const lastLogTime = {}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function logSpoof({ userId, transactionId, reason, lat, lng, speedMs }) {
  const throttleKey = `${userId}:${reason}`
  const now = Date.now()
  if (lastLogTime[throttleKey] && now - lastLogTime[throttleKey] < SPOOF_LOG_THROTTLE) return
  lastLogTime[throttleKey] = now

  try {
    await supabase.from('gps_spoof_log').insert({
      user_id: userId,
      transaction_id: transactionId ?? null,
      reason,
      reported_lat: lat,
      reported_lng: lng,
      speed_ms: speedMs ?? null,
    })

    // Never fall back to read-then-write. The RPC is the sole mutation path,
    // so concurrent reports cannot lose increments.
    const { error } = await supabase.rpc('increment_spoof_flag', { p_user_id: userId })
    if (error) console.warn('[CampusPlug] Atomic spoof counter failed:', error.message)
  } catch {
    // Spoof telemetry must never break the location flow.
  }
}

export function analysePosition(coords, userId, transactionId) {
  const result = { clean: true, flags: [], speedMs: null }
  const now = Date.now()
  const lat = coords.latitude
  const lng = coords.longitude

  if (lastPosition && lastPositionTime > 0) {
    const elapsed = (now - lastPositionTime) / 1_000
    if (elapsed > 0 && elapsed < 3_600) {
      const dist = distanceM(lat, lng, lastPosition.latitude, lastPosition.longitude)
      const speedMs = dist / elapsed
      result.speedMs = Math.round(speedMs * 10) / 10

      if (speedMs > MAX_SPEED_MS) {
        result.clean = false
        result.flags.push({ reason: 'impossible_speed', severity: 'warning', detail: `Moved ${Math.round(dist)}m in ${Math.round(elapsed)}s (${Math.round(speedMs * 3.6)} km/h)` })
        if (userId) logSpoof({ userId, transactionId, reason: 'impossible_speed', lat, lng, speedMs })
      }

      if (dist > MAX_JUMP_M) {
        result.clean = false
        result.flags.push({ reason: 'position_jump', severity: 'warning', detail: `Position jumped ${Math.round(dist / 1000)}km in one reading` })
        if (userId) logSpoof({ userId, transactionId, reason: 'position_jump', lat, lng })
      }
    }
  }

  if (coords.accuracy < MIN_ACCURACY_M) {
    result.flags.push({ reason: 'perfect_accuracy', severity: 'note', detail: `Reported accuracy: ${coords.accuracy.toFixed(1)}m (unusually precise)` })
  }

  lastPosition = coords
  lastPositionTime = now
  return result
}

export function resetPositionState() {
  lastPosition = null
  lastPositionTime = 0
}

export function gpsWeight(spoofFlagCount) {
  if (spoofFlagCount >= 5) return 0.4
  if (spoofFlagCount >= 3) return 0.6
  if (spoofFlagCount >= 1) return 0.8
  return 1.0
}
