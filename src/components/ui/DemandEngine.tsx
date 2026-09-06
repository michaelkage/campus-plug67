import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence, useAnimationControls } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { Flame, MessageSquare, Eye, TrendingUp, Zap, Send } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { toast } from 'react-hot-toast'

// ── TRENDING BADGE ─────────────────────────────────────────────────────────────

export function TrendingBadge({ listingId, isPreloaded = false }) {
  const { data: trending } = useQuery({
    queryKey: ['trending', listingId],
    queryFn: async () => {
      const { data } = await supabase.from('trending_listings').select('views_1h, score').eq('listing_id', listingId).maybeSingle()
      return data
    },
    enabled: !!listingId && !isPreloaded,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  const activeTrending = trending as Record<string, any> | null

  if (!activeTrending && !isPreloaded) return null
  if (activeTrending && activeTrending.views_1h < 5) return null

  const isHot = activeTrending?.views_1h >= 20 || (activeTrending?.score || 0) >= 40

  return (
    <motion.div initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black border ${isHot ? 'bg-plug-red/20 text-plug-red border-plug-red/40' : 'bg-plug-amber/15 text-plug-amber border-plug-amber/30'}`}>
      <motion.span animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 1, repeat: Infinity, repeatDelay: 1.5 }}><Flame size={9} /></motion.span>
      {isHot ? 'HOT' : 'TRENDING'}
    </motion.div>
  )
}

export function NegotiationSignal({ listingId }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!listingId) return

    supabase.from('messages').select('sender_id').eq('listing_id', listingId).gte('created_at', new Date(Date.now() - 3600_000).toISOString()).eq('is_system_msg', false).then(({ data }) => {
      const unique = new Set(data?.map((m: any) => m.sender_id) || []).size
      setCount(unique)
    })

    const channel = supabase.channel(`negotiation:${listingId}`).on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages', filter: `listing_id=eq.${listingId}`,
    }, () => setCount(c => c + 1)).subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [listingId])

  if (count < 2) return null
  return (
    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1.5 text-xs text-purple font-semibold">
      <motion.div animate={{ scale: [1, 1.15, 1] }} transition={{ duration: 2, repeat: Infinity }}><MessageSquare size={12} /></motion.div>
      {count} student{count !== 1 ? 's' : ''} currently messaging about this
    </motion.div>
  )
}

export function LiveViewerGlow({ listingId, currentUserId, sellerId }) {
  const [count, setCount] = useState(0)
  const controls = useAnimationControls()

  useEffect(() => {
    if (!listingId) return

    supabase.from('listing_views').select('id', { count: 'exact', head: true }).eq('listing_id', listingId).gte('viewed_at', new Date(Date.now() - 300_000).toISOString()).then(({ count: c }) => setCount(c || 0))

    const channel = supabase.channel(`viewers:${listingId}`).on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'listing_views', filter: `listing_id=eq.${listingId}`,
    }, (payload) => {
      if (payload.new.viewer_id === currentUserId) return
      setCount(c => c + 1)
      controls.start({ scale: [1, 1.08, 1], opacity: [1, 0.7, 1], transition: { duration: 0.4 } })
    }).subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [listingId, currentUserId, controls])

  if (count <= 1 || currentUserId === sellerId) return null
  return (
    <motion.div animate={controls}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple/10 border border-purple/20 text-purple text-xs font-semibold">
      <Eye size={12} /> {count} viewing now
    </motion.div>
  )
}

export default function DemandEngine() { return null }
