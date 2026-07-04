import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira } from '@/lib/supabase'
import { TrendingUp, TrendingDown, Eye, Clock, Zap, BarChart3 } from 'lucide-react'

/**
 * MarketPulse — real-time market intelligence card for the Create Listing modal.
 *
 * Shows:
 *   - "Items like this sell in X days on average"
 *   - "You are pricing this X% above/below campus average"
 *   - Demand level (High / Medium / Low) with colour coding
 *   - Live viewer count glow (how many people are browsing this category right now)
 */
export function MarketPulse({ category, university, currentPrice, className = '' }) {
  const [liveViewers, setLiveViewers] = useState(null)

  // Fetch market intelligence from DB function
  const { data: intel, isLoading } = useQuery({
    queryKey:  ['market-intel', category, university],
    queryFn:   async () => {
      if (!category || !university) return null
      const { data, error } = await supabase.rpc('get_market_intelligence', {
        p_category:   category,
        p_university: university,
      })
      if (error) return null
      return data
    },
    enabled:   !!(category && university),
    staleTime: 60_000,
  })

  // Approximate live viewer count (people browsing same category right now)
  useQuery({
    queryKey:  ['live-viewers', category, university],
    queryFn:   async () => {
      const { count } = await supabase
        .from('listing_views')
        .select('id', { count: 'exact', head: true })
        .gte('viewed_at', new Date(Date.now() - 5 * 60_000).toISOString())
        .in('listing_id',
          supabase
            .from('listings')
            .select('id')
            .eq('category', category)
            .eq('university', university)
            .eq('status', 'active')
        )
      setLiveViewers(count || 0)
      return count
    },
    enabled:    !!(category && university),
    refetchInterval: 30_000,
  })

  if (!category || !university) return null
  if (isLoading) return (
    <div className={`bg-obsidian-300 border border-obsidian-500 rounded-xl p-4 animate-pulse ${className}`}>
      <div className="h-4 bg-obsidian-400 rounded w-1/2 mb-3" />
      <div className="h-3 bg-obsidian-400 rounded w-3/4" />
    </div>
  )
  if (!intel) return null

  const avgPrice    = intel.price_data?.avg_price || 0
  const medianPrice = intel.price_data?.median_price || 0
  const priceDiff   = currentPrice && medianPrice
    ? Math.round(((currentPrice * 100 - medianPrice) / medianPrice) * 100)
    : null

  const demandConfig = {
    high:   { color: 'text-plug-green', bg: 'bg-plug-green/10 border-plug-green/20', label: '🔥 High Demand', icon: TrendingUp  },
    medium: { color: 'text-plug-amber', bg: 'bg-plug-amber/10 border-plug-amber/20', label: '📊 Medium Demand', icon: BarChart3  },
    low:    { color: 'text-white/40',   bg: 'bg-obsidian-300 border-obsidian-500',   label: '📉 Low Demand',   icon: TrendingDown },
  }
  const demand = demandConfig[intel.demand_level] || demandConfig.low

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`border rounded-xl overflow-hidden ${demand.bg} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-cyan" />
          <span className="text-xs font-bold uppercase tracking-widest text-cyan">Market Pulse</span>
        </div>
        {liveViewers != null && liveViewers > 0 && (
          <motion.div
            animate={{ opacity: [1, 0.6, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="flex items-center gap-1.5 text-xs text-white/50"
          >
            <Eye size={11} />
            <span>{liveViewers} browsing now</span>
          </motion.div>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* Sell time */}
        {intel.avg_days_to_sell > 0 && (
          <div className="flex items-start gap-3">
            <Clock size={14} className="text-white/40 flex-shrink-0 mt-0.5" />
            <div>
              <span className="text-sm text-white/70">Items like this usually sell in </span>
              <span className="text-sm font-bold text-white">
                {intel.avg_days_to_sell < 1
                  ? `${Math.round(intel.avg_days_to_sell * 24)} hours`
                  : `${intel.avg_days_to_sell} day${intel.avg_days_to_sell !== 1 ? 's' : ''}`}
              </span>
              <span className="text-sm text-white/70"> on your campus.</span>
            </div>
          </div>
        )}

        {/* Price position */}
        <AnimatePresence mode="wait">
          {priceDiff !== null && (
            <motion.div
              key={priceDiff}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-start gap-3"
            >
              {priceDiff > 0
                ? <TrendingUp  size={14} className="text-plug-amber flex-shrink-0 mt-0.5" />
                : <TrendingDown size={14} className="text-plug-green flex-shrink-0 mt-0.5" />
              }
              <div className="text-sm">
                <span className="text-white/70">You are pricing this </span>
                <span className={`font-bold ${
                  Math.abs(priceDiff) > 30
                    ? priceDiff > 0 ? 'text-plug-red' : 'text-plug-green'
                    : 'text-plug-amber'
                }`}>
                  {Math.abs(priceDiff)}% {priceDiff > 0 ? 'above' : 'below'}
                </span>
                <span className="text-white/70"> the campus median </span>
                <span className="text-white font-semibold font-mono">({formatNaira(medianPrice)})</span>
                {priceDiff < -30 && (
                  <span className="text-plug-green"> — great deal, should sell fast!</span>
                )}
                {priceDiff > 30 && (
                  <span className="text-plug-red"> — consider lowering for faster sale.</span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Demand level */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <demand.icon size={13} className={demand.color} />
            <span className={`text-xs font-semibold ${demand.color}`}>{demand.label}</span>
          </div>
          <div className="text-xs text-white/30">
            {intel.total_sold_90d} sold in 90d
          </div>
        </div>

        {/* Active supply warning */}
        {intel.price_data?.active_count > 10 && (
          <div className="text-xs text-plug-amber flex items-center gap-1.5 pt-1 border-t border-white/5">
            <span>⚠️</span>
            <span>{intel.price_data.active_count} similar items active — price competitively.</span>
          </div>
        )}
      </div>
    </motion.div>
  )
}

/**
 * LiveViewerGlow — shows a pulsing glow on listings being viewed by others.
 * Mount this on ListingDetail to signal social proof.
 */
export function LiveViewerGlow({ listingId, sellerId, currentUserId }) {
  const [viewerCount, setViewerCount] = useState(0)

  useEffect(() => {
    if (!listingId) return

    // Subscribe to view inserts for this listing
    const channel = supabase
      .channel(`viewers:${listingId}`)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'listing_views',
        filter: `listing_id=eq.${listingId}`,
      }, () => {
        setViewerCount(c => c + 1)
      })
      .subscribe()

    // Get current viewer count (last 5 min)
    supabase.from('listing_views')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listingId)
      .gte('viewed_at', new Date(Date.now() - 5 * 60_000).toISOString())
      .then(({ count }) => setViewerCount(count || 0))

    return () => supabase.removeChannel(channel)
  }, [listingId])

  if (viewerCount <= 1 || currentUserId === sellerId) return null

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-center gap-2 text-xs"
    >
      <motion.div
        animate={{ scale: [1, 1.3, 1], opacity: [1, 0.6, 1] }}
        transition={{ duration: 1.5, repeat: Infinity }}
        className="w-2 h-2 rounded-full bg-plug-green"
      />
      <span className="text-plug-green font-semibold">
        {viewerCount} {viewerCount === 1 ? 'person' : 'people'} viewing this right now
      </span>
    </motion.div>
  )
}
