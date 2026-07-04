/**
 * Campus Plug v6.8.0 — LiveMeetupTracker
 * Component 4: Real-time P2P Handshake Tracking
 *
 * Strict TypeScript — all fields map directly to the hardened transactions schema:
 *   buyer_arrived, seller_arrived, buyer_arrival_time, seller_arrival_time,
 *   paystack_ref, disputed_at, meetup_latitude, meetup_longitude, escrow_status
 *
 * Dedicated realtime channel: `meetup_state_updates:<transactionId>`
 * "Complete Handshake" CTA is locked until BOTH arrival flags are true.
 * Paystack verification inline loader fires during escrow status polling.
 * AMOLED styling: bg-black, text-neutral-50, border-neutral-900.
 */

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react'
import { useNavigate }                        from 'react-router-dom'
import { useMutation, useQueryClient }        from '@tanstack/react-query'
import { motion, AnimatePresence }            from 'framer-motion'
import { supabase, updateBeacon, checkProximity, formatNaira } from '@/lib/supabase'
import type { Database }                      from '@/types/database'

// ── Strict type from hardened schema ─────────────────────────────────────────
type Transaction = Database['public']['Tables']['transactions']['Row']

// ── Proximity band enum ───────────────────────────────────────────────────────
type ProximityBand = 'immediate' | 'close' | 'near' | 'far' | 'unknown'

// ── Component props ───────────────────────────────────────────────────────────
interface LiveMeetupTrackerProps {
  transactionId: string
  userId:        string
  userRole:      'buyer' | 'seller'
  /** Optional: show inside a modal or full-page. Defaults to full-page. */
  compact?:      boolean
}

// ── Derived location data ─────────────────────────────────────────────────────
interface LocationData {
  latitude:  number
  longitude: number
  accuracy:  number
  timestamp: number
}

// ── Beacon response shape ─────────────────────────────────────────────────────
interface BeaconResponse {
  nearby_safe_zones: { zone_name: string; zone_type: string }[]
  nearby_buddies:    { user_id: string; distance: number; last_seen: string }[]
}

// ── Proximity check response ──────────────────────────────────────────────────
interface ProximityResponse {
  distance:     number
  within_range: boolean
  message:      string
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function proximityBand(distanceM: number): ProximityBand {
  if (distanceM <  50) return 'immediate'
  if (distanceM < 100) return 'close'
  if (distanceM < 300) return 'near'
  return 'far'
}

const BAND_STYLE: Record<ProximityBand, { ring: string; text: string; label: string }> = {
  immediate: { ring: 'border-emerald-400',  text: 'text-emerald-400',  label: 'IMMEDIATE'  },
  close:     { ring: 'border-yellow-400',   text: 'text-yellow-400',   label: 'CLOSE'      },
  near:      { ring: 'border-orange-400',   text: 'text-orange-400',   label: 'NEAR'       },
  far:       { ring: 'border-rose-500',     text: 'text-rose-500',     label: 'FAR'        },
  unknown:   { ring: 'border-neutral-700',  text: 'text-neutral-500',  label: 'NO DATA'    },
}

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:  return 'Location permission denied. Please enable GPS access.'
    case err.POSITION_UNAVAILABLE: return 'Position unavailable. Move to an open area.'
    case err.TIMEOUT:            return 'Location request timed out. Retrying…'
    default:                     return 'Unknown location error.'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/** Single arrival badge — green when arrived, neutral when pending */
function ArrivalBadge({
  role, arrived, arrivalTime,
}: {
  role: 'BUYER' | 'SELLER'
  arrived: boolean
  arrivalTime: string | null | undefined
}) {
  return (
    <motion.div
      layout
      animate={arrived ? { borderColor: '#34d399' } : { borderColor: '#262626' }}
      className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-colors
                  ${arrived ? 'bg-emerald-950/40' : 'bg-neutral-950'}`}
    >
      <div className="flex items-center gap-2.5">
        <motion.span
          animate={arrived ? { scale: [1, 1.4, 1], backgroundColor: '#34d399' } : { backgroundColor: '#404040' }}
          transition={{ duration: 0.4 }}
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        />
        <span className="text-xs font-bold tracking-widest text-neutral-300">{role}</span>
      </div>
      <div className="text-right">
        {arrived ? (
          <span className="text-xs font-bold text-emerald-400 tracking-wide">
            ✓ ARRIVED
            {arrivalTime && (
              <span className="ml-1.5 text-emerald-600 font-normal">
                {new Date(arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-neutral-600 tracking-wide">PENDING</span>
        )}
      </div>
    </motion.div>
  )
}

/** Paystack escrow verification inline loader */
function EscrowVerificationLoader({ escrowStatus }: { escrowStatus: Transaction['escrow_status'] }) {
  const isVerifying = escrowStatus === 'pending'
  const isHeld      = escrowStatus === 'held'
  const isReleased  = escrowStatus === 'released'
  const isRefunded  = escrowStatus === 'refunded'

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-neutral-950 border border-neutral-900">
      {/* Animated status dot */}
      <div className="relative flex-shrink-0">
        {isVerifying && (
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className="block w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full"
          />
        )}
        {isHeld && (
          <motion.span
            animate={{ opacity: [1, 0.4, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="block w-4 h-4 rounded-full bg-cyan-400"
          />
        )}
        {isReleased && <span className="block w-4 h-4 rounded-full bg-emerald-400" />}
        {isRefunded  && <span className="block w-4 h-4 rounded-full bg-rose-400" />}
        {!isVerifying && !isHeld && !isReleased && !isRefunded && (
          <span className="block w-4 h-4 rounded-full bg-neutral-600" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
          PLUGPAY ESCROW
        </p>
        <p className={`text-xs font-bold mt-0.5
          ${isVerifying ? 'text-amber-400' :
            isHeld      ? 'text-cyan-400'  :
            isReleased  ? 'text-emerald-400' :
            isRefunded  ? 'text-rose-400' : 'text-neutral-500'}`}>
          {isVerifying ? 'VERIFYING PAYMENT…' :
           isHeld      ? 'FUNDS LOCKED IN ESCROW' :
           isReleased  ? 'FUNDS RELEASED' :
           isRefunded  ? 'REFUND PROCESSED' : 'ESCROW INACTIVE'}
        </p>
      </div>
    </div>
  )
}

/** Coordinate display panel */
function CoordPanel({
  location, lastUpdate,
}: {
  location: LocationData | null
  lastUpdate: Date | null
}) {
  if (!location) {
    return (
      <div className="px-4 py-4 rounded-xl bg-neutral-950 border border-neutral-900">
        <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-600 mb-2">
          YOUR COORDINATES
        </p>
        <p className="text-xs text-neutral-600 font-mono">AWAITING GPS SIGNAL…</p>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 rounded-xl bg-neutral-950 border border-neutral-900 space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-2">
        YOUR COORDINATES
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <div>
          <span className="text-[9px] text-neutral-600 uppercase tracking-widest">LAT</span>
          <p className="font-mono text-sm text-neutral-100">{location.latitude.toFixed(7)}</p>
        </div>
        <div>
          <span className="text-[9px] text-neutral-600 uppercase tracking-widest">LNG</span>
          <p className="font-mono text-sm text-neutral-100">{location.longitude.toFixed(7)}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-1 border-t border-neutral-900">
        <span className="text-[10px] text-neutral-600 font-mono">
          ±{location.accuracy.toFixed(0)}m accuracy
        </span>
        {lastUpdate && (
          <span className="text-[10px] text-neutral-600 font-mono">
            {lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  )
}

/** Proximity ring visualiser */
function ProximityRing({
  proximity,
}: {
  proximity: ProximityResponse | null
}) {
  const band  = proximity ? proximityBand(proximity.distance) : 'unknown'
  const style = BAND_STYLE[band]

  return (
    <div className="flex flex-col items-center gap-3 py-6">
      {/* Animated rings */}
      <div className="relative flex items-center justify-center w-28 h-28">
        {/* Outer pulse ring */}
        {proximity?.within_range && (
          <motion.div
            animate={{ scale: [1, 1.5, 1], opacity: [0.4, 0, 0.4] }}
            transition={{ duration: 2, repeat: Infinity }}
            className={`absolute w-28 h-28 rounded-full border-2 ${style.ring}`}
          />
        )}
        {/* Mid ring */}
        <motion.div
          animate={proximity?.within_range
            ? { scale: [1, 1.15, 1] }
            : { scale: 1 }}
          transition={{ duration: 2, repeat: Infinity, delay: 0.3 }}
          className={`absolute w-20 h-20 rounded-full border-2 opacity-50 ${style.ring}`}
        />
        {/* Core */}
        <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center ${style.ring}`}>
          <span className={`text-[10px] font-black ${style.text}`}>
            {proximity ? `${proximity.distance}m` : '—'}
          </span>
        </div>
      </div>

      <div className="text-center">
        <p className={`text-xs font-black tracking-widest ${style.text}`}>
          {style.label}
        </p>
        {proximity && (
          <p className="text-[10px] text-neutral-600 mt-0.5">
            {proximity.message}
          </p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function LiveMeetupTracker({
  transactionId,
  userId,
  userRole,
  compact = false,
}: LiveMeetupTrackerProps) {
  const navigate = useNavigate()
  const qc       = useQueryClient()

  // ── Transaction state ──────────────────────────────────────────────────────
  const [tx,           setTx]           = useState<Transaction | null>(null)
  const [loadingTx,    setLoadingTx]    = useState(true)
  const [txError,      setTxError]      = useState<string | null>(null)

  // ── Location state ─────────────────────────────────────────────────────────
  const [isTracking,   setIsTracking]   = useState(false)
  const [location,     setLocation]     = useState<LocationData | null>(null)
  const [locationErr,  setLocationErr]  = useState<string | null>(null)
  const [lastUpdate,   setLastUpdate]   = useState<Date | null>(null)

  // ── Beacon / proximity ─────────────────────────────────────────────────────
  const [beacon,       setBeacon]       = useState<BeaconResponse | null>(null)
  const [proximity,    setProximity]    = useState<ProximityResponse | null>(null)

  // ── Handshake completion state ─────────────────────────────────────────────
  const [completing,   setCompleting]   = useState(false)

  const watchRef    = useRef<number | null>(null)
  const channelRef  = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // ── Derived from tx ────────────────────────────────────────────────────────
  const buyerArrived      = tx?.buyer_arrived  ?? false
  const sellerArrived     = tx?.seller_arrived ?? false
  const buyerArrivalTime  = tx?.buyer_arrival_time  ?? null
  const sellerArrivalTime = tx?.seller_arrival_time ?? null
  const escrowStatus      = tx?.escrow_status ?? 'pending'
  const paystackRef       = tx?.paystack_ref  ?? null
  const disputedAt        = tx?.disputed_at   ?? null
  const myRole            = userRole
  const myArrived         = myRole === 'buyer' ? buyerArrived : sellerArrived
  const bothArrived       = buyerArrived && sellerArrived

  // ── Load transaction ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadingTx(true)
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', transactionId)
        .single()

      if (cancelled) return
      if (error) { setTxError(error.message); setLoadingTx(false); return }
      setTx(data)
      setLoadingTx(false)
    }

    load()
    return () => { cancelled = true }
  }, [transactionId])

  // ── Dedicated realtime channel: meetup_state_updates ──────────────────────
  useEffect(() => {
    const ch = supabase
      .channel(`meetup_state_updates:${transactionId}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'transactions',
          filter: `id=eq.${transactionId}`,
        },
        (payload) => {
          const updated = payload.new as Transaction
          setTx(updated)
        }
      )
      .subscribe()

    channelRef.current = ch
    return () => { supabase.removeChannel(ch) }
  }, [transactionId])

  // ── Beacon + proximity update on each location fix ────────────────────────
  const pushBeacon = useCallback(async (loc: LocationData) => {
    try {
      const b = await updateBeacon(userId, loc.latitude, loc.longitude, 'meetup', transactionId, 500)
      setBeacon(b)

      if (tx?.meetup_latitude && tx?.meetup_longitude) {
        const p = await checkProximity(userId, transactionId, loc.latitude, loc.longitude, 500)
        setProximity(p)
      }
    } catch {
      // Non-fatal — beacon update should never break the UI
    }
  }, [userId, transactionId, tx?.meetup_latitude, tx?.meetup_longitude])

  // ── Start GPS watch ────────────────────────────────────────────────────────
  const startTracking = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationErr('Geolocation is not supported by this browser.')
      return
    }

    setIsTracking(true)
    setLocationErr(null)

    watchRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const loc: LocationData = {
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy:  pos.coords.accuracy,
          timestamp: pos.timestamp,
        }
        setLocation(loc)
        setLastUpdate(new Date())
        await pushBeacon(loc)
      },
      (err) => {
        setLocationErr(geolocationErrorMessage(err))
        setIsTracking(false)
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 4_000 }
    )
  }, [pushBeacon])

  // ── Stop GPS watch ─────────────────────────────────────────────────────────
  const stopTracking = useCallback(() => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current)
      watchRef.current = null
    }
    setIsTracking(false)
  }, [])

  useEffect(() => () => stopTracking(), [stopTracking])

  // ── Confirm arrival mutation ───────────────────────────────────────────────
  const arrivalMutation = useMutation({
    mutationFn: async () => {
      const arrivalField    = myRole === 'buyer' ? 'buyer_arrived'      : 'seller_arrived'
      const arrivalTimeField = myRole === 'buyer' ? 'buyer_arrival_time' : 'seller_arrival_time'

      const { data, error } = await supabase
        .from('transactions')
        .update({
          [arrivalField]:     true,
          [arrivalTimeField]: new Date().toISOString(),
        })
        .eq('id', transactionId)
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: (data) => setTx(data),
  })

  // ── Complete handshake mutation ────────────────────────────────────────────
  // Blocked at DB level unless both parties have arrived and escrow is held.
  const completeMutation = useMutation({
    mutationFn: async () => {
      setCompleting(true)
      const { data, error } = await supabase
        .from('transactions')
        .update({
          status:        'release_requested',
          meetup_time:   new Date().toISOString(),
        })
        .eq('id', transactionId)
        .eq('escrow_status', 'held')          // guard — DB also enforces
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: (data) => {
      setTx(data)
      setCompleting(false)
      qc.invalidateQueries({ queryKey: ['gear-active-txns'] })
    },
    onError: () => setCompleting(false),
  })

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loadingTx) {
    return (
      <div className="flex items-center justify-center py-20 bg-black">
        <div className="flex flex-col items-center gap-3">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full"
          />
          <p className="text-[10px] font-bold tracking-widest text-neutral-600 uppercase">
            SYNCING MEETUP STATE…
          </p>
        </div>
      </div>
    )
  }

  if (txError || !tx) {
    return (
      <div className="flex items-center justify-center py-20 bg-black">
        <p className="text-sm text-rose-400">
          {txError ?? 'Transaction not found.'}
        </p>
      </div>
    )
  }

  // ── Disputed guard ─────────────────────────────────────────────────────────
  if (disputedAt || tx.status === 'disputed') {
    return (
      <div className="bg-black border border-rose-900 rounded-2xl p-6 space-y-3">
        <div className="flex items-center gap-2 text-rose-400">
          <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
          <p className="text-sm font-bold tracking-widest uppercase">Transaction Disputed</p>
        </div>
        <p className="text-xs text-neutral-500">
          Disputed at {disputedAt ? new Date(disputedAt).toLocaleString() : '—'}
        </p>
        <button
          onClick={() => navigate(`/war-room?tx=${transactionId}`)}
          className="w-full py-3 bg-rose-950 border border-rose-800 text-rose-300
                     rounded-xl text-sm font-bold tracking-wide hover:bg-rose-900 transition-colors"
        >
          VIEW IN WAR ROOM →
        </button>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div className="bg-black text-neutral-50 rounded-2xl overflow-hidden border border-neutral-900">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-4 border-b border-neutral-900">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-neutral-600">
              LIVE MEETUP TRACKER
            </p>
            <h2 className="text-lg font-black tracking-tight mt-0.5">
              P2P Handshake
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <motion.span
              animate={isTracking
                ? { opacity: [1, 0.3, 1], backgroundColor: '#34d399' }
                : { backgroundColor: '#525252' }}
              transition={isTracking ? { duration: 1.2, repeat: Infinity } : {}}
              className="w-2 h-2 rounded-full flex-shrink-0"
            />
            <span className="text-[10px] font-bold tracking-widest text-neutral-500 uppercase">
              {isTracking ? 'LIVE' : 'IDLE'}
            </span>
          </div>
        </div>

        {/* TX ref + paystack ref */}
        <div className="flex items-center gap-4 mt-3">
          <span className="text-[10px] font-mono text-neutral-600">
            TX {transactionId.slice(0, 8).toUpperCase()}
          </span>
          {paystackRef && (
            <span className="text-[10px] font-mono text-neutral-600">
              REF {paystackRef}
            </span>
          )}
        </div>
      </div>

      <div className="p-5 space-y-5">

        {/* ── Escrow verification loader ───────────────────────────────── */}
        <EscrowVerificationLoader escrowStatus={escrowStatus} />

        {/* ── Error banner ──────────────────────────────────────────────── */}
        <AnimatePresence>
          {locationErr && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-start gap-2 px-4 py-3 rounded-xl
                         bg-rose-950/40 border border-rose-900 text-rose-400 text-xs"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 mt-1 flex-shrink-0" />
              {locationErr}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Arrival status ────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
            ARRIVAL STATUS
          </p>
          <ArrivalBadge
            role="BUYER"
            arrived={buyerArrived}
            arrivalTime={buyerArrivalTime}
          />
          <ArrivalBadge
            role="SELLER"
            arrived={sellerArrived}
            arrivalTime={sellerArrivalTime}
          />
        </div>

        {/* ── Mutual handshake lock state ───────────────────────────────── */}
        <AnimatePresence>
          {bothArrived && (
            <motion.div
              key="handshake-ready"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl
                         bg-emerald-950/40 border border-emerald-800"
            >
              <motion.span
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
                className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex-shrink-0"
              />
              <p className="text-xs font-bold text-emerald-400">
                BOTH PARTIES ON-SITE — HANDSHAKE ENABLED
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Proximity ring ────────────────────────────────────────────── */}
        {isTracking && (
          <div className="border border-neutral-900 rounded-2xl overflow-hidden">
            <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-600 px-4 pt-4">
              PROXIMITY TO MEETUP POINT
            </p>
            <ProximityRing proximity={proximity} />
          </div>
        )}

        {/* ── Coordinate panel ──────────────────────────────────────────── */}
        <CoordPanel location={location} lastUpdate={lastUpdate} />

        {/* ── Safe zones ────────────────────────────────────────────────── */}
        {beacon?.nearby_safe_zones && beacon.nearby_safe_zones.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              NEARBY SAFE ZONES
            </p>
            {beacon.nearby_safe_zones.map((z, i) => (
              <div key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg
                           bg-neutral-950 border border-neutral-900">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                <span className="text-xs text-neutral-300">{z.zone_name}</span>
                <span className="ml-auto text-[9px] text-neutral-600 uppercase">{z.zone_type}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Action buttons ────────────────────────────────────────────── */}
        <div className="space-y-2 pt-1">

          {/* Start / stop tracking */}
          {!isTracking ? (
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={startTracking}
              className="w-full py-3.5 rounded-xl border border-neutral-800 bg-neutral-950
                         text-sm font-bold text-neutral-200 tracking-wide
                         hover:border-emerald-700 hover:text-emerald-400 transition-all"
            >
              START LOCATION TRACKING
            </motion.button>
          ) : (
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={stopTracking}
              className="w-full py-3.5 rounded-xl border border-rose-900 bg-rose-950/30
                         text-sm font-bold text-rose-400 tracking-wide
                         hover:bg-rose-950/50 transition-all"
            >
              STOP TRACKING
            </motion.button>
          )}

          {/* Confirm arrival — only if not yet arrived */}
          {isTracking && !myArrived && (
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => arrivalMutation.mutate()}
              disabled={arrivalMutation.isPending}
              className="w-full py-3.5 rounded-xl bg-emerald-500 text-black
                         text-sm font-black tracking-wide
                         disabled:opacity-40 disabled:cursor-not-allowed
                         hover:bg-emerald-400 transition-all"
            >
              {arrivalMutation.isPending
                ? <span className="flex items-center justify-center gap-2">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                      className="block w-4 h-4 border-2 border-black border-t-transparent rounded-full"
                    />
                    CONFIRMING…
                  </span>
                : `CONFIRM ARRIVAL AS ${myRole.toUpperCase()}`}
            </motion.button>
          )}

          {/* Complete handshake — LOCKED until both arrived */}
          <motion.button
            whileTap={bothArrived ? { scale: 0.97 } : {}}
            onClick={() => bothArrived && completeMutation.mutate()}
            disabled={!bothArrived || completing || completeMutation.isPending}
            className={`w-full py-3.5 rounded-xl text-sm font-black tracking-wide
                        transition-all duration-300
                        ${bothArrived
                          ? 'bg-cyan-400 text-black hover:bg-cyan-300 cursor-pointer'
                          : 'bg-neutral-900 border border-neutral-800 text-neutral-600 cursor-not-allowed'
                        }`}
          >
            {completing || completeMutation.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                  className="block w-4 h-4 border-2 border-black border-t-transparent rounded-full"
                />
                FINALISING…
              </span>
            ) : bothArrived
              ? '⚡ COMPLETE HANDSHAKE'
              : '🔒 WAITING FOR BOTH PARTIES'}
          </motion.button>
        </div>

      </div>
    </div>
  )
}
