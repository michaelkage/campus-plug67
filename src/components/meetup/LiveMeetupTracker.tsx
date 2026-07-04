import React, { useState, useEffect, useRef } from 'react'
import { supabase, updateBeacon, checkProximity } from '../../lib/supabase'
import { Database } from '../../types/database'

type Transaction = Database['public']['Tables']['transactions']['Row']

interface LiveMeetupTrackerProps {
  transactionId: string
  userId: string
  userRole: 'buyer' | 'seller'
}

interface LocationData {
  latitude: number
  longitude: number
  accuracy: number
  timestamp: number
}

interface ProximityData {
  distance: number
  within_range: boolean
  message: string
}

interface BeaconUpdate {
  nearby_safe_zones: any[]
  nearby_buddies: any[]
}

export default function LiveMeetupTracker({ transactionId, userId, userRole }: LiveMeetupTrackerProps) {
  const [transaction, setTransaction] = useState<Transaction | null>(null)
  const [currentLocation, setCurrentLocation] = useState<LocationData | null>(null)
  const [proximityData, setProximityData] = useState<ProximityData | null>(null)
  const [beaconData, setBeaconData] = useState<BeaconUpdate | null>(null)
  const [isTracking, setIsTracking] = useState(false)
  const [trackingError, setTrackingError] = useState<string | null>(null)
  const [arrivalStatus, setArrivalStatus] = useState<{
    buyer_arrived: boolean
    seller_arrived: boolean
  }>({
    buyer_arrived: false,
    seller_arrived: false,
  })
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  
  const watchIdRef = useRef<number | null>(null)
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    fetchTransaction()
    setupRealtimeSubscription()
    
    return () => {
      cleanup()
    }
  }, [transactionId])

  const fetchTransaction = async () => {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', transactionId)
        .single()

      if (error) throw error
      
      setTransaction(data)
      
      if (data) {
        setArrivalStatus({
          buyer_arrived: data.buyer_arrived || false,
          seller_arrived: data.seller_arrived || false,
        })
      }
    } catch (err: any) {
      console.error('Error fetching transaction:', err)
      setTrackingError(err.message)
    }
  }

  const setupRealtimeSubscription = () => {
    const subscription = supabase
      .channel(`transaction:${transactionId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'transactions',
          filter: `id=eq.${transactionId}`,
        },
        (payload) => {
          const updatedTransaction = payload.new as Transaction
          setTransaction(updatedTransaction)
          setArrivalStatus({
            buyer_arrived: updatedTransaction.buyer_arrived || false,
            seller_arrived: updatedTransaction.seller_arrived || false,
          })
        }
      )
      .subscribe()

    return () => {
      subscription.unsubscribe()
    }
  }

  const startLocationTracking = async () => {
    if (!navigator.geolocation) {
      setTrackingError('Geolocation is not supported by your browser')
      return
    }

    try {
      setIsTracking(true)
      setTrackingError(null)

      watchIdRef.current = navigator.geolocation.watchPosition(
        async (position) => {
          const locationData: LocationData = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          }

          setCurrentLocation(locationData)
          setLastUpdate(new Date())

          try {
            const beaconResult = await updateBeacon(
              userId,
              locationData.latitude,
              locationData.longitude,
              'meetup',
              transactionId,
              500
            )
            setBeaconData(beaconResult)

            if (transaction?.meetup_latitude && transaction?.meetup_longitude) {
              const proximityResult = await checkProximity(
                userId,
                transactionId,
                locationData.latitude,
                locationData.longitude,
                500
              )
              setProximityData(proximityResult)
            }
          } catch (err: any) {
            console.error('Error updating beacon:', err)
          }
        },
        (error) => {
          console.error('Geolocation error:', error)
          setTrackingError(getGeolocationErrorMessage(error))
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000,
        }
      )
    } catch (err: any) {
      setTrackingError(err.message)
      setIsTracking(false)
    }
  }

  const stopLocationTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    if (updateIntervalRef.current !== null) {
      clearInterval(updateIntervalRef.current)
      updateIntervalRef.current = null
    }
    setIsTracking(false)
  }

  const cleanup = () => {
    stopLocationTracking()
  }

  const getGeolocationErrorMessage = (error: GeolocationPositionError): string => {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        return 'Location permission denied. Please enable location access.'
      case error.POSITION_UNAVAILABLE:
        return 'Location information is unavailable.'
      case error.TIMEOUT:
        return 'Location request timed out.'
      default:
        return 'An unknown location error occurred.'
    }
  }

  const handleConfirmArrival = async () => {
    try {
      const arrivalField = userRole === 'buyer' ? 'buyer_arrived' : 'seller_arrived'
      
      const { error } = await supabase
        .from('transactions')
        .update({
          [arrivalField]: true,
          [`${userRole}_arrival_time`]: new Date().toISOString(),
        })
        .eq('id', transactionId)

      if (error) throw error

      setArrivalStatus((prev) => ({
        ...prev,
        [arrivalField]: true,
      }))
    } catch (err: any) {
      console.error('Error confirming arrival:', err)
      setTrackingError(err.message)
    }
  }

  const getProximityStatus = () => {
    if (!proximityData) return 'unknown'
    
    if (proximityData.distance < 50) return 'immediate'
    if (proximityData.distance < 100) return 'close'
    if (proximityData.distance < 300) return 'near'
    return 'far'
  }

  const getProximityColor = () => {
    const status = getProximityStatus()
    switch (status) {
      case 'immediate':
        return 'text-green-400 border-green-400'
      case 'close':
        return 'text-yellow-400 border-yellow-400'
      case 'near':
        return 'text-orange-400 border-orange-400'
      case 'far':
        return 'text-red-400 border-red-400'
      default:
        return 'text-[#666] border-[#333]'
    }
  }

  return (
    <div className="w-full">
      <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">LIVE MEETUP TRACKER</h2>
            <p className="text-xs text-[#666] font-mono tracking-widest">
              TRANSACTION: {transactionId.slice(0, 8).toUpperCase()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isTracking ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
            <span className="text-xs text-[#888] font-mono">
              {isTracking ? 'TRACKING ACTIVE' : 'TRACKING INACTIVE'}
            </span>
          </div>
        </div>

        {trackingError && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
            {trackingError}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-2">YOUR LOCATION</p>
            <div className="space-y-1">
              {currentLocation ? (
                <>
                  <p className="text-sm text-white font-mono">
                    LAT: {currentLocation.latitude.toFixed(6)}
                  </p>
                  <p className="text-sm text-white font-mono">
                    LNG: {currentLocation.longitude.toFixed(6)}
                  </p>
                  <p className="text-xs text-[#888] font-mono">
                    ACCURACY: ±{currentLocation.accuracy.toFixed(0)}m
                  </p>
                  {lastUpdate && (
                    <p className="text-xs text-[#888] font-mono">
                      UPDATED: {lastUpdate.toLocaleTimeString()}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-[#666] font-mono">LOCATION NOT AVAILABLE</p>
              )}
            </div>
          </div>

          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-2">PROXIMITY STATUS</p>
            <div className="space-y-1">
              {proximityData ? (
                <>
                  <p className="text-sm text-white font-mono">
                    DISTANCE: {proximityData.distance}m
                  </p>
                  <p className={`text-sm font-mono ${getProximityColor()}`}>
                    STATUS: {proximityData.message.toUpperCase()}
                  </p>
                  <div className={`mt-2 p-2 border ${getProximityColor()} text-xs font-mono text-center`}>
                    {getProximityStatus().toUpperCase()}
                  </div>
                </>
              ) : (
                <p className="text-sm text-[#666] font-mono">WAITING FOR LOCATION DATA</p>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-3">ARRIVAL STATUS</p>
            <div className="space-y-2">
              <div className={`flex items-center justify-between p-2 border ${
                arrivalStatus.buyer_arrived ? 'border-green-400 bg-green-900/10' : 'border-[#333]'
              }`}>
                <span className="text-sm text-white font-mono">BUYER</span>
                <span className={`text-xs font-mono ${arrivalStatus.buyer_arrived ? 'text-green-400' : 'text-[#666]'}`}>
                  {arrivalStatus.buyer_arrived ? '✓ ARRIVED' : 'PENDING'}
                </span>
              </div>
              <div className={`flex items-center justify-between p-2 border ${
                arrivalStatus.seller_arrived ? 'border-green-400 bg-green-900/10' : 'border-[#333]'
              }`}>
                <span className="text-sm text-white font-mono">SELLER</span>
                <span className={`text-xs font-mono ${arrivalStatus.seller_arrived ? 'text-green-400' : 'text-[#666]'}`}>
                  {arrivalStatus.seller_arrived ? '✓ ARRIVED' : 'PENDING'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-3">SAFE ZONES</p>
            <div className="space-y-1">
              {beaconData?.nearby_safe_zones && beaconData.nearby_safe_zones.length > 0 ? (
                beaconData.nearby_safe_zones.map((zone: any, index: number) => (
                  <div key={index} className="text-sm text-white font-mono">
                    ✓ {zone.zone_name}
                  </div>
                ))
              ) : (
                <p className="text-sm text-[#666] font-mono">NO SAFE ZONES NEARBY</p>
              )}
            </div>
          </div>
        </div>

        {proximityData?.within_range && (
          <div className="mb-6 p-4 bg-green-900/20 border border-green-400">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse" />
              <div>
                <p className="text-sm font-bold text-green-400 font-mono">PROXIMITY ALERT</p>
                <p className="text-xs text-green-300 font-mono">
                  Both parties are within the designated meetup range
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          {!isTracking ? (
            <button
              onClick={startLocationTracking}
              className="flex-1 px-4 py-3 bg-[#1a1a1a] border border-[#333] text-white text-sm font-mono hover:border-[#00ff88] hover:text-[#00ff88] transition-all"
            >
              START TRACKING
            </button>
          ) : (
            <button
              onClick={stopLocationTracking}
              className="flex-1 px-4 py-3 bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono hover:bg-red-900/30 transition-all"
            >
              STOP TRACKING
            </button>
          )}

          {isTracking && !arrivalStatus[userRole === 'buyer' ? 'buyer_arrived' : 'seller_arrived'] && (
            <button
              onClick={handleConfirmArrival}
              className="flex-1 px-4 py-3 bg-[#00ff88] border border-[#00ff88] text-black text-sm font-mono hover:bg-[#00cc6a] transition-all"
            >
              CONFIRM ARRIVAL
            </button>
          )}
        </div>
      </div>
    </div>
  )
}