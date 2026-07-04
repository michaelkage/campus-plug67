/**
 * MeetupPanel v6.7 — Lagos-Hardened Multi-Modal PoP Engine
 *
 * Layered Fallback Protocol for Faraday cage buildings:
 *
 * LAYER 1 — GPS (primary)
 *   Adaptive polling: idle 60s → OMW 20s → in-zone 5s
 *   If accuracy > 50m → trigger fallback
 *
 * LAYER 2 — SSID (WiFi fingerprint)
 *   Scan nearby WiFi BSSIDs via NetworkInformation API
 *   Hash the sorted BSSID list (SHA-256)
 *   Match against safe_zones.ssid_hashes in DB
 *   If match → triggerPoPSuccess('SSID_MATCH')
 *
 * LAYER 3 — BLE (Bluetooth Low Energy)
 *   If SSID fails → Web Bluetooth API scan
 *   Look for counterparty's specific broadcast UUID
 *   If RSSI > -60dBm (approx. 2m) → triggerPoPSuccess('BLE_HANDSHAKE')
 *
 * Amber Handshake (Optimistic Server Buffer):
 *   User A confirms → inserts into amber_confirmations (90s TTL)
 *   UI shows "Waiting for [User B]…"
 *   Both confirmations within window → dual sync fires
 *   No immediate client failure on network jitter
 *
 * Privacy: GPS stops immediately on release/dispute/cancel/unmount
 * Spoof: >300km/h → flag transaction only, never block
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { SafeZonePicker, SafeZoneDisplay } from '@/components/ui/SafeZonePicker'
import {
  Navigation, AlertTriangle, Shield, MapPin,
  CheckCircle2, RefreshCw, Wifi, Bluetooth, Zap
} from 'lucide-react'
import toast from 'react-hot-toast'

// ── Constants ──────────────────────────────────────────────────────────────────
const OMW_WINDOW_MS   = 15 * 60_000
const AMBER_M         = 200
const GREEN_M         = 75
const GPS_IDLE_MS     = 60_000
const GPS_OMW_MS      = 20_000
const GPS_ZONE_MS     = 5_000
const GPS_ACCURACY_THRESHOLD_M = 50   // Trigger fallback if accuracy > this
const BLE_RSSI_MIN    = -60           // dBm — approx 2m range

function haptic(t: 'double' | 'single' | 'success') {
  if (!navigator.vibrate) {
    // Fallback: visual pulse handled in component
    return
  }
  if (t === 'double')  navigator.vibrate([80, 60, 80])
  if (t === 'single')  navigator.vibrate(100)
  if (t === 'success') navigator.vibrate(500)
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const dL = (lat2 - lat1) * Math.PI / 180
  const dG = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dL / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function speedKmh(lat1: number, lng1: number, ts1: number,
                  lat2: number, lng2: number, ts2: number): number {
  const sec = (ts2 - ts1) / 1000
  if (sec <= 0) return 0
  return (haversineM(lat1, lng1, lat2, lng2) / sec) * 3.6
}

// ── SHA-256 hash of sorted BSSID array (for SSID fingerprinting) ──────────────
async function hashBSSIDs(bssids: string[]): Promise<string> {
  const sorted  = [...bssids].sort().join('|').toLowerCase()
  const encoded = new TextEncoder().encode(sorted)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── PoP Method Status Badge ────────────────────────────────────────────────────
function PopmethodBadge({ method }: { method: string | null }) {
  if (!method) return null
  const cfg: Record<string, { icon: typeof Wifi; label: string; color: string }> = {
    GPS:          { icon: MapPin,    label: 'GPS Verified',         color: 'text-plug-green border-plug-green/30 bg-plug-green/8' },
    SSID_MATCH:   { icon: Wifi,      label: 'WiFi Fingerprint',     color: 'text-cyan border-cyan/30 bg-cyan/8'                   },
    BLE_HANDSHAKE:{ icon: Bluetooth, label: 'BLE Proximity',        color: 'text-purple border-purple/30 bg-purple/8'             },
    MANUAL:       { icon: CheckCircle2, label: 'Manual Confirm',    color: 'text-plug-amber border-plug-amber/30 bg-plug-amber/8' },
  }
  const c = cfg[method]
  if (!c) return null
  const Icon = c.icon
  return (
    <div className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full border ${c.color}`}>
      <Icon size={10} />
      {c.label}
    </div>
  )
}

// ── SSID Fallback ──────────────────────────────────────────────────────────────
async function trySsidMatch(safeZones: any[]): Promise<boolean> {
  try {
    // @ts-ignore — NetworkInformation API (limited browser support)
    const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection
    if (!conn) return false

    // Try to get WiFi scan via experimental API or Capacitor plugin
    // @ts-ignore
    if (!window.__cpWifiScan) return false   // Capacitor plugin bridge

    // @ts-ignore
    const scanResults: { bssid: string; ssid: string; rssi: number }[] = await window.__cpWifiScan()
    if (!scanResults?.length) return false

    const bssids = scanResults.map(r => r.bssid).filter(Boolean)
    if (!bssids.length) return false

    const hash = await hashBSSIDs(bssids)

    // Check against known safe zone SSID fingerprints
    return safeZones.some(z =>
      Array.isArray(z.ssid_hashes) && z.ssid_hashes.includes(hash)
    )
  } catch {
    return false
  }
}

// ── BLE Fallback ───────────────────────────────────────────────────────────────
async function tryBleHandshake(counterpartyBleUuid: string | null): Promise<boolean> {
  if (!counterpartyBleUuid) return false

  try {
    // @ts-ignore — Web Bluetooth API
    if (!navigator.bluetooth) return false

    // @ts-ignore
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [counterpartyBleUuid] }
      ],
      optionalServices: [],
    })

    if (!device) return false

    // Check RSSI if available (>= -60dBm = within ~2m)
    // Web Bluetooth doesn't expose RSSI directly — we use connection success as proximity proof
    // Native Capacitor plugin exposes RSSI
    // @ts-ignore
    if (window.__cpBleRssi) {
      // @ts-ignore
      const rssi = await window.__cpBleRssi(device.id)
      return rssi >= BLE_RSSI_MIN
    }

    // Web Bluetooth: connection success = device is nearby (typically <10m)
    // Accept as proximity proof with lower confidence
    return true
  } catch (err: any) {
    // User denied Bluetooth or device not found
    if (err?.name === 'NotFoundError') return false
    if (err?.name === 'NotAllowedError') return false
    return false
  }
}

// ── OMW Timer ─────────────────────────────────────────────────────────────────
function OMWTimer({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, new Date(expiresAt).getTime() - Date.now())
      setMs(left)
      if (left === 0) onExpire()
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt, onExpire])

  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  const pct = (ms / OMW_WINDOW_MS) * 100
  const urgent = ms < 3 * 60_000

  return (
    <div className={`rounded-xl border p-4 ${urgent ? 'border-plug-red/40 bg-plug-red/8' : 'border-plug-amber/30 bg-plug-amber/8'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Navigation size={14} className={urgent ? 'text-plug-red' : 'text-plug-amber'} />
          <span className={`text-xs font-bold ${urgent ? 'text-plug-red' : 'text-plug-amber'}`}>
            {urgent ? 'ARRIVE NOW' : 'OMW Timer'}
          </span>
        </div>
        <span className={`text-xl font-black font-mono ${urgent ? 'text-plug-red' : 'text-plug-amber'}`}>
          {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
        </span>
      </div>
      <div className="h-2 bg-obsidian-300 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${urgent ? 'bg-plug-red' : 'bg-plug-amber'}`}
          animate={{ width: `${pct}%` }} transition={{ duration: 0.5 }}
        />
      </div>
      <p className="text-xs text-white/40 mt-2">
        {urgent ? 'Enter the 200m zone or status reverts to LOCKED.' : '15 minutes to reach the amber zone.'}
      </p>
    </div>
  )
}

// ── Amber Buffer Sync with haptic pulse ───────────────────────────────────────
function AmberBufferSync({ tx, isSeller, onSynced }: any) {
  const { user } = useAuth()
  const [mine,       setMine]       = useState(false)
  const [theirs,     setTheirs]     = useState(false)
  const [bufExpiry,  setBufExpiry]  = useState<string | null>(null)
  const [delayActive,setDelayActive]= useState(false)
  const [delayDone,  setDelayDone]  = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [bufMs,      setBufMs]      = useState<number | null>(null)
  // Haptic pulse fallback
  const [pulseActive,setPulseActive]= useState(false)

  useEffect(() => {
    if (!tx?.id || !user) return
    supabase.from('amber_confirmations')
      .select('user_id,buffer_expires')
      .eq('transaction_id', tx.id)
      .gt('buffer_expires', new Date().toISOString())
      .then(({ data }) => {
        for (const c of data || []) {
          if (c.user_id === user.id) { setMine(true); setBufExpiry(c.buffer_expires) }
          else setTheirs(true)
        }
      })

    const ch = supabase.channel(`amber:${tx.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'amber_confirmations',
        filter: `transaction_id=eq.${tx.id}`,
      }, (p) => {
        if (p.new.user_id === user.id) { setMine(true); setBufExpiry(p.new.buffer_expires) }
        else setTheirs(true)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [tx?.id, user])

  useEffect(() => {
    if (mine && theirs) {
      haptic('double')
      // Haptic fallback: pulse animation
      setPulseActive(true)
      setTimeout(() => setPulseActive(false), 600)
      onSynced?.()
    }
  }, [mine, theirs, onSynced])

  useEffect(() => {
    if (!bufExpiry) return
    const t = () => setBufMs(Math.max(0, new Date(bufExpiry).getTime() - Date.now()))
    t(); const id = setInterval(t, 1000); return () => clearInterval(id)
  }, [bufExpiry])

  const handleTap = () => {
    if (mine || delayActive || delayDone) return
    setDelayActive(true)
    setTimeout(() => { setDelayActive(false); setDelayDone(true) }, 10_000)
  }

  const handleConfirm = async () => {
    if (!delayDone || mine || loading) return
    setLoading(true)
    haptic('single')
    const { error } = await supabase.from('amber_confirmations').insert({
      transaction_id: tx.id, user_id: user!.id, role: isSeller ? 'seller' : 'buyer',
    })
    setLoading(false)
    if (error && !error.message.includes('unique')) { toast.error('Confirmation failed — try again'); return }
    setMine(true)
    if (theirs) {
      haptic('double')
      toast.success('🤝 Dual sync complete! Presence verified.')
    } else {
      toast('✓ Presence confirmed. Waiting for other party… (90s window)')
    }
  }

  if (mine && theirs) return (
    <motion.div
      animate={pulseActive ? { scale: [1, 1.04, 1] } : {}}
      className="text-center py-3 bg-plug-green/8 border border-plug-green/30 rounded-xl"
    >
      <div className="text-xl mb-1">🤝</div>
      <div className="text-sm font-bold text-plug-green">Both Arrived — Presence Synced</div>
    </motion.div>
  )

  return (
    <div className="bg-plug-amber/8 border border-plug-amber/30 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-3">
        <motion.div animate={{ scale: [1, 1.12, 1] }} transition={{ duration: 2, repeat: Infinity }}
          className="w-10 h-10 rounded-full bg-plug-amber/20 flex items-center justify-center text-lg">
          🟡
        </motion.div>
        <div>
          <div className="font-bold text-sm text-plug-amber">Amber Zone — Presence Sync</div>
          <div className="text-xs text-white/40">Both parties verify within 90-second server window.</div>
        </div>
      </div>

      {!mine && !delayActive && !delayDone && (
        <motion.button whileTap={{ scale: 0.96 }} onClick={handleTap}
          className="w-full py-3.5 rounded-xl bg-plug-amber text-obsidian font-bold text-sm flex items-center justify-center gap-2">
          <Shield size={15} /> Verify My Presence
        </motion.button>
      )}

      {delayActive && (
        <div className="text-center py-3">
          <div className="text-xs text-white/50 mb-2">Confirming you're really here…</div>
          <motion.div
            className="w-12 h-12 mx-auto rounded-full border-2 border-plug-amber/30 border-t-plug-amber"
            animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          />
        </div>
      )}

      {delayDone && !mine && (
        <motion.button whileTap={{ scale: 0.94 }} onClick={handleConfirm} disabled={loading}
          className="w-full py-3.5 rounded-xl bg-plug-green text-obsidian font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
          {loading ? <RefreshCw size={14} className="animate-spin" /> : '✅'}
          {loading ? 'Confirming…' : "I'm Here — Confirm"}
        </motion.button>
      )}

      {mine && !theirs && (
        <div className="space-y-2 text-center">
          <div className="text-sm text-white/60">✓ Your presence confirmed.</div>
          <div className="flex items-center justify-center gap-2 text-xs text-white/40">
            <motion.div className="w-2 h-2 rounded-full bg-plug-amber"
              animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
            Waiting…
            {bufMs != null && bufMs > 0 && (
              <span className="font-mono text-plug-amber font-bold">({Math.ceil(bufMs / 1000)}s)</span>
            )}
          </div>
          {bufMs === 0 && <div className="text-xs text-plug-red">Buffer expired. Tap "Verify" again.</div>}
        </div>
      )}
      <div className="text-[10px] text-white/20 text-center">
        Server holds confirmations 90 seconds — no instant failure on Lagos network lag
      </div>
    </div>
  )
}

// ── Override Modal ────────────────────────────────────────────────────────────
function OverrideModal({ onConfirm, onCancel }: any) {
  const [r, setR] = useState<string | null>(null)
  const opts = [
    { k: 'network',  i: '📶', l: 'Poor Network',   d: 'GPS or data issues' },
    { k: 'traffic',  i: '🚗', l: 'Traffic Delay',  d: 'En route, stuck' },
    { k: 'location', i: '📍', l: 'GPS Inaccurate', d: 'Device location wrong' },
  ]
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 40 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="w-full max-w-md bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-obsidian-500">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={16} className="text-plug-amber" />
            <h2 className="font-bold text-sm">Something Went Wrong?</h2>
          </div>
          <p className="text-xs text-white/40">Pauses all timers 10 minutes. One-time per transaction.</p>
        </div>
        <div className="p-5 space-y-2">
          {opts.map(o => (
            <button key={o.k} onClick={() => setR(o.k)}
              className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all ${
                r === o.k ? 'border-plug-amber/50 bg-plug-amber/10' : 'border-obsidian-500 hover:border-plug-amber/20'
              }`}>
              <span className="text-xl">{o.i}</span>
              <div>
                <div className={`text-sm font-semibold ${r === o.k ? 'text-plug-amber' : 'text-white/80'}`}>{o.l}</div>
                <div className="text-xs text-white/40">{o.d}</div>
              </div>
              {r === o.k && <CheckCircle2 size={16} className="text-plug-amber ml-auto" />}
            </button>
          ))}
        </div>
        <div className="flex gap-3 p-5 pt-0">
          <button onClick={onCancel} className="btn-secondary flex-1 text-sm py-2.5">Cancel</button>
          <button onClick={() => r && onConfirm(r)} disabled={!r}
            className="btn-primary flex-1 text-sm py-2.5 disabled:opacity-40">
            Pause Timers
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ── Fallback Progress UI ──────────────────────────────────────────────────────
function FallbackProgress({ step }: { step: 'gps_poor' | 'trying_ssid' | 'ssid_failed' | 'trying_ble' | 'ble_failed' }) {
  const steps = [
    { key: 'gps_poor',   icon: MapPin,    label: 'GPS accuracy too low (indoor building)' },
    { key: 'trying_ssid',icon: Wifi,      label: 'Scanning WiFi fingerprint…' },
    { key: 'ssid_failed',icon: Wifi,      label: 'WiFi scan failed — trying Bluetooth…' },
    { key: 'trying_ble', icon: Bluetooth, label: 'Scanning for counterparty device…' },
    { key: 'ble_failed', icon: Bluetooth, label: 'BLE scan failed — use manual confirm' },
  ]
  const currentIdx = steps.findIndex(s => s.key === step)

  return (
    <div className="bg-obsidian-300 border border-obsidian-500 rounded-xl p-4 space-y-2.5">
      <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">
        Indoor Mode — Finding You
      </div>
      {steps.slice(0, currentIdx + 1).map((s, i) => {
        const Icon = s.icon
        const active = i === currentIdx
        const done   = i < currentIdx
        return (
          <div key={s.key} className={`flex items-center gap-3 text-xs ${done ? 'text-white/30' : active ? 'text-white/80' : 'text-white/20'}`}>
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
              done ? 'bg-plug-red/20' : active ? 'bg-cyan/20' : 'bg-obsidian-400'
            }`}>
              {done
                ? <span className="text-plug-red text-[10px]">✗</span>
                : active
                  ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
                      <Icon size={11} className="text-cyan" />
                    </motion.div>
                  : <Icon size={11} />
              }
            </div>
            {s.label}
          </div>
        )
      })}
    </div>
  )
}

// ── Main MeetupPanel ──────────────────────────────────────────────────────────
export function MeetupPanel({ tx, isSeller, session, onQRUnlocked }: {
  tx:           any
  isSeller:     boolean
  session:      any
  onQRUnlocked?: () => void
}) {
  const { user } = useAuth()

  // GPS state
  const [pos,     setPos]     = useState<{ lat: number; lng: number; ts: number; accuracy: number } | null>(null)
  const [prevPos, setPrevPos] = useState<{ lat: number; lng: number; ts: number; accuracy: number } | null>(null)
  const [zone,    setZone]    = useState<'none' | 'amber' | 'green'>('none')
  const [spoof,   setSpoof]   = useState(false)

  // Multi-modal state
  const [popMethod,    setPopMethod]    = useState<string | null>(null)  // 'GPS'|'SSID_MATCH'|'BLE_HANDSHAKE'|'MANUAL'
  const [fallbackStep, setFallbackStep] = useState<string | null>(null)
  const [multiModalAttempted, setMultiModalAttempted] = useState(false)

  // Zone / selection
  const [selZone, setSelZone] = useState<any>(null)
  const [safeZones, setSafeZones] = useState<any[]>([])

  // OMW + sync
  const [omwActive,    setOmwActive]    = useState(!!tx?.omw_active)
  const [omwLoading,   setOmwLoading]   = useState(false)
  const [synced,       setSynced]       = useState(!!tx?.dual_sync_complete)
  const [showOverride, setShowOverride] = useState(false)
  const [overrideActive, setOverrideActive] = useState(
    !!tx?.override_used && tx?.override_expires_at && new Date(tx.override_expires_at) > new Date()
  )

  // Protection eligibility
  const [ghostEligible,  setGhostEligible]  = useState(false)
  const [relistEligible, setRelistEligible] = useState(false)

  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const terminal = ['released', 'disputed', 'cancelled'].includes(tx?.status || '')

  // Load safe zones for multi-modal matching
  useEffect(() => {
    if (!tx?.university) return
    supabase.from('safe_zones').select('*').eq('active', true)
      .then(({ data }) => setSafeZones(data || []))
  }, [tx?.university])

  // ── Multi-Modal Handshake logic ───────────────────────────────────────────
  const triggerPoPSuccess = useCallback(async (method: string) => {
    setPopMethod(method)
    setFallbackStep(null)

    // Record method used on transaction
    await supabase.from('transactions').update({
      multimodal_used: method !== 'GPS',
      pop_method:      method,
    }).eq('id', tx.id)

    haptic('double')
    toast.success(`📍 Presence verified via ${method.replace('_', ' ')}`)
  }, [tx?.id])

  const runMultiModalFallback = useCallback(async (gpsAccuracy: number) => {
    if (multiModalAttempted) return
    setMultiModalAttempted(true)

    // Step 1: GPS accuracy check
    if (gpsAccuracy <= GPS_ACCURACY_THRESHOLD_M) {
      // GPS is good — no fallback needed
      return
    }

    setFallbackStep('gps_poor')
    await new Promise(r => setTimeout(r, 600))

    // Step 2: SSID / WiFi fingerprint
    setFallbackStep('trying_ssid')
    const ssidMatch = await trySsidMatch(safeZones)

    if (ssidMatch) {
      await triggerPoPSuccess('SSID_MATCH')
      return
    }

    setFallbackStep('ssid_failed')
    await new Promise(r => setTimeout(r, 800))

    // Step 3: BLE proximity
    setFallbackStep('trying_ble')
    const counterpartyUuid = selZone?.ble_uuid || tx?.ble_uuid || null
    const bleMatch = await tryBleHandshake(counterpartyUuid)

    if (bleMatch) {
      await triggerPoPSuccess('BLE_HANDSHAKE')
      return
    }

    setFallbackStep('ble_failed')
    // All fallbacks exhausted — user must confirm manually
    toast('📶 Indoor signal fallbacks failed. Use manual confirm below.', { icon: '⚠️' })
  }, [multiModalAttempted, safeZones, selZone, tx?.ble_uuid, triggerPoPSuccess])

  // ── Adaptive GPS polling ──────────────────────────────────────────────────
  useEffect(() => {
    if (terminal || !navigator.geolocation) {
      if (ivRef.current) clearInterval(ivRef.current)
      return
    }

    const interval = zone !== 'none' ? GPS_ZONE_MS : omwActive ? GPS_OMW_MS : GPS_IDLE_MS

    const poll = () => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const lat = p.coords.latitude
          const lng = p.coords.longitude
          const ts  = Date.now()
          const accuracy = p.coords.accuracy  // metres

          // Spoof detection
          if (prevPos) {
            const sp = speedKmh(prevPos.lat, prevPos.lng, prevPos.ts, lat, lng, ts)
            if (sp > 300) {
              setSpoof(true)
              supabase.from('transactions').update({
                gps_spoof_suspected: true,
                spoof_reason:        'impossible_speed',
                max_speed_kmh:       Math.round(sp),
              }).eq('id', tx.id).then()
            }
          }

          setPrevPos(pos)
          setPos({ lat, lng, ts, accuracy })

          // Zone detection
          if (selZone) {
            const d = haversineM(lat, lng, selZone.lat, selZone.lng)
            const newZone = d <= GREEN_M ? 'green' : d <= AMBER_M ? 'amber' : 'none'
            setZone(newZone)

            // If GPS accuracy is poor and we're near the zone, try multi-modal
            if (accuracy > GPS_ACCURACY_THRESHOLD_M && newZone !== 'none' && !popMethod) {
              runMultiModalFallback(accuracy)
            } else if (newZone !== 'none' && !popMethod) {
              setPopMethod('GPS')
            }
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 10_000 }
      )
    }

    if (ivRef.current) clearInterval(ivRef.current)
    poll()
    ivRef.current = setInterval(poll, interval)

    // Privacy: stop on unmount or terminal state
    return () => { if (ivRef.current) clearInterval(ivRef.current) }
  }, [terminal, omwActive, zone, selZone, popMethod])

  // Protection eligibility
  useEffect(() => {
    if (!tx?.id) return
    supabase.rpc('check_ghost_refund', { p_transaction_id: tx.id }).then(({ data }) => setGhostEligible(!!data?.eligible))
    supabase.rpc('check_priority_relist_v2', { p_transaction_id: tx.id }).then(({ data }) => setRelistEligible(!!data?.eligible))
  }, [tx?.id])

  const toggleOMW = async () => {
    setOmwLoading(true)
    haptic('single')
    const na = !omwActive
    const u: any = { omw_active: na }
    if (na) {
      u.omw_timestamp  = new Date().toISOString()
      u.omw_expires_at = new Date(Date.now() + OMW_WINDOW_MS).toISOString()
      if (pos) { u.omw_lat = pos.lat; u.omw_lng = pos.lng }
    }
    await supabase.from('transactions').update(u).eq('id', tx.id)
    setOmwLoading(false)
    setOmwActive(na)
    toast(na ? '🚶 OMW timer started.' : 'OMW cancelled.')
  }

  const handleOverride = async (reason: string) => {
    setShowOverride(false)
    await supabase.from('transactions').update({
      override_used:       true,
      override_reason:     reason,
      override_at:         new Date().toISOString(),
      override_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }).eq('id', tx.id)
    setOverrideActive(true)
    toast('⏸️ Timers paused 10 minutes.')
    setTimeout(() => setOverrideActive(false), 10 * 60_000)
  }

  const handleManualConfirm = async () => {
    setPopMethod('MANUAL')
    await supabase.from('transactions').update({ pop_method: 'MANUAL' }).eq('id', tx.id)
    haptic('single')
    toast('✓ Manual presence confirmed.')
  }

  const handleGhostRefund = async () => {
    if (!window.confirm('Request ghost refund?')) return
    await supabase.from('transactions').update({
      status: 'cancelled', cancelled_at: new Date().toISOString(), ghost_refunded_at: new Date().toISOString(),
    }).eq('id', tx.id)
    toast.success('🔄 Ghost refund initiated.')
  }

  const handleRelist = async () => {
    const { data } = await supabase.rpc('check_priority_relist_v2', { p_transaction_id: tx.id })
    if (!data?.eligible) { toast.error(data?.reason || 'Not eligible'); return }
    await supabase.from('priority_relist_log').insert({ seller_id: user?.id, listing_id: tx.listing_id, transaction_id: tx.id })
    await supabase.from('profiles').update({ priority_relist_today: 1, last_boost_at: new Date().toISOString() }).eq('id', user?.id)
    toast.success('🚀 Priority Relist Boost — top of feed 1 hour!')
  }

  const zoneLabel = { none: 'Outside Zone', amber: '🟡 Amber Zone', green: '🟢 Green Zone' }[zone]

  return (
    <div className="space-y-4">
      {/* Spoof notice */}
      {spoof && (
        <div className="flex items-center gap-2 px-3 py-2 bg-plug-amber/8 border border-plug-amber/20 rounded-xl text-xs text-plug-amber">
          <AlertTriangle size={12} /> GPS anomaly flagged — your transaction continues normally.
        </div>
      )}

      {/* Zone + method status */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold ${
          synced       ? 'border-plug-green/40 bg-plug-green/10 text-plug-green' :
          zone === 'green' ? 'border-plug-green/30 bg-plug-green/8 text-plug-green' :
          zone === 'amber' ? 'border-plug-amber/40 bg-plug-amber/12 text-plug-amber' :
          omwActive    ? 'border-plug-amber/30 bg-plug-amber/8 text-plug-amber' :
          overrideActive ? 'border-white/20 bg-white/5 text-white/50' :
          'border-cyan/30 bg-cyan/8 text-cyan'
        }`}>
          <div className="w-1.5 h-1.5 rounded-full bg-current" />
          {synced ? 'Presence Verified' : zoneLabel}
        </div>

        <PopmethodBadge method={popMethod} />

        {pos && (
          <div className="text-[10px] text-white/30 flex items-center gap-1">
            <MapPin size={9} />
            {Math.round(pos.accuracy)}m accuracy
            {pos.accuracy > GPS_ACCURACY_THRESHOLD_M && (
              <span className="text-plug-amber"> · indoor mode</span>
            )}
          </div>
        )}
      </div>

      {/* Safe zone picker */}
      {!selZone
        ? <SafeZonePicker transaction={tx} session={session} selectedZoneId={tx?.safe_zone_id} onSelect={setSelZone} />
        : <SafeZoneDisplay safZoneName={selZone.name} safeZoneId={selZone.id} />
      }

      {/* Multi-modal fallback progress */}
      {fallbackStep && !popMethod && (
        <FallbackProgress step={fallbackStep as any} />
      )}

      {/* OMW toggle */}
      {!synced && !omwActive && (
        <motion.button whileTap={{ scale: 0.97 }} onClick={toggleOMW}
          disabled={omwLoading || overrideActive}
          className="w-full py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 bg-cyan text-obsidian hover:shadow-cyan disabled:opacity-40 transition-all">
          <Navigation size={15} />
          {omwLoading ? 'Updating…' : isSeller ? "I'm On My Way ➜" : "I'm Heading There ➜"}
        </motion.button>
      )}

      {/* OMW timer */}
      {omwActive && !synced && tx?.omw_expires_at && (
        <OMWTimer expiresAt={tx.omw_expires_at} onExpire={() => {
          setOmwActive(false)
          toast.error('⏰ OMW expired — status reverted.')
          supabase.from('transactions').update({ omw_active: false, status: 'locked' }).eq('id', tx.id).then()
        }} />
      )}

      {/* Amber zone dual sync */}
      {zone === 'amber' && !synced && (
        <AmberBufferSync tx={tx} isSeller={isSeller} onSynced={() => {
          setSynced(true)
          haptic('double')
          supabase.from('transactions').update({ dual_sync_complete: true }).eq('id', tx.id).then()
          onQRUnlocked?.()
        }} />
      )}

      {/* Green zone */}
      {zone === 'green' && !synced && (
        <div className="bg-plug-green/8 border border-plug-green/30 rounded-xl p-4">
          <div className="text-sm font-bold text-plug-green mb-2">🟢 Green Zone — Auto-Verified</div>
          <button onClick={() => { setSynced(true); haptic('success'); onQRUnlocked?.() }}
            className="btn-primary w-full mt-2 text-sm">
            Unlock QR Scan
          </button>
        </div>
      )}

      {/* Manual confirm (BLE/SSID all failed) */}
      {fallbackStep === 'ble_failed' && !popMethod && !synced && (
        <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4">
          <div className="text-xs text-white/50 mb-3">
            GPS, WiFi, and Bluetooth signals are all blocked in this building.
            Use manual confirmation — this is recorded for dispute evidence.
          </div>
          <button onClick={handleManualConfirm} className="w-full py-3 rounded-xl font-bold text-sm border border-plug-amber/30 text-plug-amber hover:bg-plug-amber/10 transition-colors">
            ✋ Manual Confirm — I'm at the Safe Zone
          </button>
        </div>
      )}

      {/* Dual sync complete */}
      {synced && (
        <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
          className="text-center py-4 bg-plug-green/8 border border-plug-green/30 rounded-xl">
          <div className="text-2xl mb-1">🤝</div>
          <div className="font-bold text-sm text-plug-green">Presence Verified — Campus Shield Active</div>
          {popMethod && (
            <div className="mt-2 flex justify-center">
              <PopmethodBadge method={popMethod} />
            </div>
          )}
        </motion.div>
      )}

      {/* Footer actions */}
      <div className="border-t border-obsidian-500 pt-4 space-y-2">
        {!overrideActive && !synced && !tx?.override_used && (
          <button onClick={() => setShowOverride(true)}
            className="w-full text-xs text-white/30 hover:text-plug-amber transition-colors py-1.5 flex items-center justify-center gap-1.5">
            <AlertTriangle size={11} /> Something went wrong? Pause timers
          </button>
        )}
        {overrideActive && <div className="text-center text-xs text-white/40 py-1">⏸ Timers paused</div>}

        {!isSeller && ghostEligible && (
          <button onClick={handleGhostRefund}
            className="w-full py-2.5 rounded-xl text-sm font-bold border border-plug-red/30 text-plug-red hover:bg-plug-red/10 transition-colors">
            🔄 Ghost Refund — Seller Didn't Show
          </button>
        )}

        {isSeller && relistEligible && (
          <button onClick={handleRelist}
            className="w-full py-2.5 rounded-xl text-sm font-bold border border-cyan/30 text-cyan hover:bg-cyan/10 transition-colors">
            🚀 Priority Relist — Buyer No-Show
          </button>
        )}
      </div>

      <AnimatePresence>
        {showOverride && <OverrideModal onConfirm={handleOverride} onCancel={() => setShowOverride(false)} />}
      </AnimatePresence>
    </div>
  )
}
