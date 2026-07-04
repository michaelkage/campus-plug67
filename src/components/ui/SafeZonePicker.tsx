import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, callEdgeFunction } from '@/lib/supabase'
import { MapPin, Shield, ChevronDown, CheckCircle2, Navigation } from 'lucide-react'
import toast from 'react-hot-toast'

/**
 * SafeZonePicker — dropdown for selecting a campus safe zone during meetup initiation.
 * Saves the safe_zone_id to the transaction when confirmed.
 */
export function SafeZonePicker({ transaction, session, onSelect, selectedZoneId }) {
  const [open, setOpen] = useState(false)

  const { data: zones = [] } = useQuery({
    queryKey: ['safe-zones', transaction?.university],
    queryFn: async () => {
      const { data } = await supabase
        .from('safe_zones')
        .select('*')
        .eq('active', true)
        .order('name')
      return data || []
    },
    staleTime: 300_000,
  })

  const selected = zones.find(z => z.id === selectedZoneId)

  const handleSelect = async (zone: any) => {
    setOpen(false)
    onSelect?.(zone)

    // Persist safe zone choice to transaction
    if (transaction?.id) {
      await supabase.from('transactions').update({
        safe_zone_id:   zone.id,
        safe_zone_name: zone.name,
      }).eq('id', transaction.id)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 p-3.5 bg-obsidian-300 border border-obsidian-500
                   rounded-xl hover:border-cyan/30 transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-lg bg-cyan/10 border border-cyan/20 flex items-center justify-center flex-shrink-0">
          <MapPin size={14} className="text-cyan" />
        </div>
        <div className="flex-1 min-w-0">
          {selected ? (
            <>
              <div className="text-sm font-semibold truncate">{selected.name}</div>
              <div className="text-xs text-white/40 truncate">{selected.description}</div>
            </>
          ) : (
            <div className="text-sm text-white/40">Select a Safe Exchange Zone…</div>
          )}
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown size={14} className="text-white/30 flex-shrink-0" />
        </motion.div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 right-0 mt-2 z-50
                       bg-obsidian-400 border border-obsidian-500 rounded-xl overflow-hidden shadow-card"
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-obsidian-500 bg-cyan/5">
              <Shield size={12} className="text-cyan" />
              <span className="text-xs font-bold text-cyan uppercase tracking-wider">
                Campus Safe Exchange Zones
              </span>
            </div>

            {zones.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-white/30">
                No safe zones configured for your campus yet.
              </div>
            ) : (
              zones.map(zone => (
                <button
                  key={zone.id}
                  onClick={() => handleSelect(zone)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left
                               hover:bg-obsidian-300 transition-colors border-b border-obsidian-500 last:border-0 ${
                    selectedZoneId === zone.id ? 'bg-cyan/5' : ''
                  }`}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                    selectedZoneId === zone.id ? 'bg-cyan/20 border border-cyan/30' : 'bg-obsidian-300'
                  }`}>
                    {selectedZoneId === zone.id
                      ? <CheckCircle2 size={13} className="text-cyan" />
                      : <MapPin size={13} className="text-white/30" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-semibold ${selectedZoneId === zone.id ? 'text-cyan' : 'text-white/80'}`}>
                      {zone.name}
                    </div>
                    {zone.description && (
                      <div className="text-xs text-white/40 mt-0.5 line-clamp-2">{zone.description}</div>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-plug-green" />
                      <span className="text-[10px] text-plug-green font-semibold">Verified Safe Zone</span>
                      <span className="text-[10px] text-white/25">· {zone.radius_m}m radius</span>
                    </div>
                  </div>
                </button>
              ))
            )}

            {/* Footer */}
            <div className="px-4 py-2.5 bg-obsidian-300 border-t border-obsidian-500">
              <div className="text-[10px] text-white/25 flex items-center gap-1.5">
                <Shield size={9} />
                Safe zones are monitored campus locations. Only meet in these spots.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * SafeZoneDisplay — read-only display of the agreed safe zone on a transaction.
 */
export function SafeZoneDisplay({ safZoneName, safeZoneId }) {
  const { data: zone } = useQuery({
    queryKey: ['safe-zone', safeZoneId],
    queryFn:  async () => {
      if (!safeZoneId) return null
      const { data } = await supabase
        .from('safe_zones').select('*').eq('id', safeZoneId).single()
      return data
    },
    enabled: !!safeZoneId,
    staleTime: 300_000,
  })

  const display = zone || (safZoneName ? { name: safZoneName, description: null } : null)
  if (!display) return null

  return (
    <div className="flex items-center gap-3 p-3 bg-cyan/5 border border-cyan/20 rounded-xl">
      <div className="w-8 h-8 rounded-lg bg-cyan/15 border border-cyan/25 flex items-center justify-center flex-shrink-0">
        <MapPin size={14} className="text-cyan" />
      </div>
      <div>
        <div className="text-sm font-semibold text-cyan">{display.name}</div>
        {display.description && (
          <div className="text-xs text-white/40 mt-0.5">{display.description}</div>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1 text-[10px] text-plug-green font-semibold">
        <Shield size={10} />
        Safe Zone
      </div>
    </div>
  )
}
