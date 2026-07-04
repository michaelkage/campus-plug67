import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { supabase, callEdgeFunction } from '@/lib/supabase'
import { MapPin, CheckCircle2, Clock, Shield, Navigation } from 'lucide-react'
import toast from 'react-hot-toast'

/**
 * CheckIn — handles GPS-based arrival confirmation for both buyer and seller.
 *
 * Features:
 *   - "I've Arrived" button triggers GPS check via process-growth-events
 *   - Falls back to manual toggle if GPS unavailable
 *   - Real-time: both_arrived triggers animation + unlocks QR scan button
 *   - Shows nearby safe zones from the safe_zones table
 *   - Shows distance to nearest safe zone
 */
export function CheckIn({ transaction, isSeller, session, onBothArrived }) {
  const [gettingLocation, setGettingLocation] = useState(false)
  const [myArrived,       setMyArrived]        = useState(false)
  const [otherArrived,    setOtherArrived]      = useState(false)
  const [nearestZone,     setNearestZone]       = useState(null)
  const [distanceM,       setDistanceM]         = useState(null)

  // Sync from transaction prop
  useEffect(() => {
    if (!transaction) return
    setMyArrived(isSeller ? !!transaction.seller_arrived : !!transaction.buyer_arrived)
    setOtherArrived(isSeller ? !!transaction.buyer_arrived : !!transaction.seller_arrived)
  }, [transaction, isSeller])

  const bothArrived = myArrived && otherArrived

  useEffect(() => {
    if (bothArrived) onBothArrived?.()
  }, [bothArrived, onBothArrived])

  // Fetch safe zones for this university
  const { data: safeZones = [] } = useQuery({
    queryKey: ['safe-zones', transaction?.university],
    queryFn:  async () => {
      const { data } = await supabase
        .from('safe_zones')
        .select('*')
        .eq('university', transaction?.university || '')
        .eq('active', true)
      return data || []
    },
    enabled: !!transaction?.university,
  })

  // Calculate nearest zone from current position
  const updateNearestZone = useCallback((lat: number, lng: number) => {
    if (!safeZones.length) return
    let nearest = null
    let minDist = Infinity
    for (const z of safeZones) {
      const d = haversineM(lat, lng, z.lat, z.lng)
      if (d < minDist) { minDist = d; nearest = z }
    }
    setNearestZone(nearest)
    setDistanceM(Math.round(minDist))
  }, [safeZones])

  const handleArrive = async (manual = false) => {
    if (myArrived) return
    setGettingLocation(true)

    let lat: number | null = null
    let lng: number | null = null

    if (!manual) {
      // Try to get GPS
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout:            10_000,
            maximumAge:         30_000,
            enableHighAccuracy: true,
          })
        )
        lat = pos.coords.latitude
        lng = pos.coords.longitude
        updateNearestZone(lat, lng)
      } catch {
        // GPS unavailable — fall through to manual
        manual = true
      }
    }

    const { data, error } = await callEdgeFunction(
      'process-growth-events',
      {
        action:         'checkin',
        transaction_id: transaction.id,
        lat,
        lng,
        manual,
      },
      session?.access_token
    )

    setGettingLocation(false)

    if (error) {
      toast.error(error)
      return
    }

    setMyArrived(true)
    if (data?.other_arrived) setOtherArrived(true)
    toast.success(manual ? '✓ Marked as arrived!' : '📍 Location confirmed — you\'re at the safe zone!')
  }

  const roleLabel  = isSeller ? 'Seller' : 'Buyer'
  const otherLabel = isSeller ? 'Buyer'  : 'Seller'

  return (
    <div className="space-y-3">
      {/* Both arrived unlock */}
      <AnimatePresence>
        {bothArrived && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="relative overflow-hidden rounded-xl border border-plug-green/40 bg-plug-green/8 p-4"
          >
            <motion.div
              className="absolute inset-0"
              animate={{ boxShadow: ['inset 0 0 0 0 rgba(0,255,136,0)', 'inset 0 0 40px 0 rgba(0,255,136,0.06)', 'inset 0 0 0 0 rgba(0,255,136,0)'] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            <div className="flex items-center gap-3">
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 0.4 }}
              >
                <CheckCircle2 size={20} className="text-plug-green" />
              </motion.div>
              <div>
                <div className="font-bold text-sm text-plug-green">Both Parties Arrived!</div>
                <div className="text-xs text-white/50">QR scan is now unlocked. Complete your exchange.</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Arrival status for each party */}
      <div className="grid grid-cols-2 gap-2">
        {/* My status */}
        <div className={`border rounded-xl p-3 text-center transition-all ${
          myArrived
            ? 'border-plug-green/40 bg-plug-green/8'
            : 'border-obsidian-500 bg-obsidian-400'
        }`}>
          <div className={`text-xs font-bold mb-1 ${myArrived ? 'text-plug-green' : 'text-white/40'}`}>
            {roleLabel} (You)
          </div>
          <div className="text-lg">
            {myArrived ? '✅' : '⏳'}
          </div>
          <div className={`text-[10px] mt-0.5 ${myArrived ? 'text-plug-green/70' : 'text-white/25'}`}>
            {myArrived ? 'Arrived' : 'Not yet'}
          </div>
        </div>

        {/* Other party status */}
        <div className={`border rounded-xl p-3 text-center transition-all ${
          otherArrived
            ? 'border-plug-green/40 bg-plug-green/8'
            : 'border-obsidian-500 bg-obsidian-400'
        }`}>
          <div className={`text-xs font-bold mb-1 ${otherArrived ? 'text-plug-green' : 'text-white/40'}`}>
            {otherLabel}
          </div>
          <div className="text-lg">
            {otherArrived ? '✅' : '⏳'}
          </div>
          <div className={`text-[10px] mt-0.5 ${otherArrived ? 'text-plug-green/70' : 'text-white/25'}`}>
            {otherArrived ? 'Arrived' : 'Waiting'}
          </div>
        </div>
      </div>

      {/* Nearest safe zone */}
      {safeZones.length > 0 && (
        <div className="bg-obsidian-300 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-white/40 uppercase tracking-wider">
            <Shield size={11} />
            Safe Exchange Zones
          </div>
          {safeZones.slice(0, 3).map(zone => (
            <div key={zone.id} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-white/60">
                <MapPin size={10} className="text-cyan flex-shrink-0" />
                {zone.name}
              </div>
              {distanceM != null && nearestZone?.id === zone.id && (
                <div className={`font-mono font-bold text-[10px] ${
                  distanceM <= zone.radius_m ? 'text-plug-green' : 'text-white/30'
                }`}>
                  {distanceM <= zone.radius_m ? '✓ Within range' : `${distanceM}m away`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Arrive button */}
      {!myArrived && (
        <div className="space-y-2">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => handleArrive(false)}
            disabled={gettingLocation}
            className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2
                       bg-cyan text-obsidian hover:shadow-cyan transition-all disabled:opacity-50"
          >
            {gettingLocation ? (
              <>
                <Navigation size={15} className="animate-pulse" />
                Getting your location...
              </>
            ) : (
              <>
                <MapPin size={15} />
                I've Arrived at the Safe Zone
              </>
            )}
          </motion.button>

          <button
            onClick={() => handleArrive(true)}
            disabled={gettingLocation}
            className="w-full py-2 rounded-xl text-xs font-semibold text-white/40
                       hover:text-white/60 border border-obsidian-500 hover:border-obsidian-400
                       transition-colors disabled:opacity-30"
          >
            No GPS — Mark as arrived manually
          </button>
        </div>
      )}

      {myArrived && !bothArrived && (
        <div className="flex items-center gap-2 text-xs text-white/40 justify-center py-1">
          <Clock size={11} />
          Waiting for {otherLabel.toLowerCase()} to check in...
        </div>
      )}
    </div>
  )
}

// Haversine metres (client-side)
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6_371_000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
