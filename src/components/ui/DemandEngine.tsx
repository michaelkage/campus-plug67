import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence, useAnimationControls } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { Flame, MessageSquare, Eye, TrendingUp, Zap, Send } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { toast } from 'react-hot-toast'

// ── TRENDING BADGE ─────────────────────────────────────────────────────────────

/**
 * TrendingBadge — shows on listing cards when the item is trending (>10 views/h).
 */
export function TrendingBadge({ listingId, isPreloaded = false }) {
  const { data: trending } = useQuery({
    queryKey: ['trending', listingId],
    queryFn:  async () => {
      const { data } = await supabase
        .from('trending_listings')
        .select('views_1h, score')
        .eq('listing_id', listingId)
        .maybeSingle()
      return data
    },
    enabled:       !!listingId && !isPreloaded,
    staleTime:     60_000,
    refetchInterval: 120_000,
  })

  if (!trending && !isPreloaded) return null
  if (trending && trending.views_1h < 5) return null

  const isHot = trending?.views_1h >= 20 || (trending?.score || 0) >= 40

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black border ${
        isHot
          ? 'bg-plug-red/20 text-plug-red border-plug-red/40'
          : 'bg-plug-amber/15 text-plug-amber border-plug-amber/30'
      }`}
    >
      <motion.span
        animate={{ scale: [1, 1.3, 1] }}
        transition={{ duration: 1, repeat: Infinity, repeatDelay: 1.5 }}
      >
        <Flame size={9} />
      </motion.span>
      {isHot ? 'HOT' : 'TRENDING'}
    </motion.div>
  )
}

// ── NEGOTIATION SIGNAL ─────────────────────────────────────────────────────────

/**
 * NegotiationSignal — "X students messaging about this" social proof.
 * Shows on listing detail when unique sender count > 1.
 */
export function NegotiationSignal({ listingId }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!listingId) return

    // Initial fetch
    supabase.from('messages')
      .select('sender_id')
      .eq('listing_id', listingId)
      .gte('created_at', new Date(Date.now() - 3600_000).toISOString())
      .eq('is_system_msg', false)
      .then(({ data }) => {
        const unique = new Set(data?.map((m: any) => m.sender_id) || []).size
        setCount(unique)
      })

    // Subscribe to new messages
    const channel = supabase
      .channel(`negotiation:${listingId}`)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `listing_id=eq.${listingId}`,
      }, () => {
        setCount(c => c + 1)   // approximate increment
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [listingId])

  if (count < 2) return null

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-1.5 text-xs text-purple font-semibold"
    >
      <motion.div
        animate={{ scale: [1, 1.15, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <MessageSquare size={12} />
      </motion.div>
      {count} student{count !== 1 ? 's' : ''} currently messaging about this
    </motion.div>
  )
}

// ── LIVE VIEWER GLOW ───────────────────────────────────────────────────────────

/**
 * LiveViewerGlow — animated "N people viewing" signal.
 * Subscribes to listing_views inserts in real-time.
 */
export function LiveViewerGlow({ listingId, currentUserId, sellerId }) {
  const [count, setCount] = useState(0)
  const controls = useAnimationControls()

  useEffect(() => {
    if (!listingId) return

    // Initial count (last 5 min)
    supabase.from('listing_views')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listingId)
      .gte('viewed_at', new Date(Date.now() - 300_000).toISOString())
      .then(({ count: c }) => setCount(c || 0))

    const channel = supabase.channel(`viewers:${listingId}`)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'listing_views',
        filter: `listing_id=eq.${listingId}`,
      }, (payload) => {
        if (payload.new.viewer_id === currentUserId) return
        setCount(c => c + 1)
        controls.start({
          scale:       [1, 1.08, 1],
          opacity:     [1, 0.7, 1],
          transition:  { duration: 0.4 },
        })
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [listingId, currentUserId, controls])

  if (count <= 1 || currentUserId === sellerId) return null

  return (
    <motion.div
      animate={controls}
      className="flex items-center gap-2 text-xs"
    >
      <motion.div
        animate={{ opacity: [1, 0.4, 1], scale: [1, 1.2, 1] }}
        transition={{ duration: 1.8, repeat: Infinity }}
        className="w-2 h-2 rounded-full bg-plug-green flex-shrink-0"
      />
      <span className="text-plug-green font-semibold">
        {count} {count === 1 ? 'person' : 'people'} viewing right now
      </span>
    </motion.div>
  )
}

// ── CAMPUS TICKER ──────────────────────────────────────────────────────────────

const TICKER_VARIANTS = {
  initial:  { opacity: 0, y: 20, scale: 0.96 },
  animate:  { opacity: 1, y: 0,  scale: 1, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] } },
  exit:     { opacity: 0, y: -12, scale: 0.96, transition: { duration: 0.25 } },
}

/**
 * CampusTicker — animated real-time activity ticker for the Home page.
 * Items slide in from the bottom, stay 4 seconds, slide out.
 */
export function CampusTicker({ university }) {
  const [items, setItems] = useState<any[]>([])
  const [current, setCurrent] = useState<any>(null)
  const queueRef = useRef<any[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load recent ticker events
  useEffect(() => {
    if (!university) return

    supabase.from('ticker_events')
      .select('*')
      .eq('university', university)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data?.length) {
          queueRef.current = [...data].reverse()
          rotate()
        }
      })

    // Real-time new ticker events
    const channel = supabase.channel(`ticker:${university}`)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'ticker_events',
        filter: `university=eq.${university}`,
      }, (payload) => {
        queueRef.current = [...queueRef.current, payload.new]
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [university])

  const rotate = () => {
    if (!queueRef.current.length) {
      timerRef.current = setTimeout(rotate, 8000)
      return
    }

    const [next, ...rest] = queueRef.current
    // Cycle: push current to end of queue
    queueRef.current = rest.length ? [...rest, next] : [next]
    setCurrent(next)

    timerRef.current = setTimeout(() => {
      setCurrent(null)
      timerRef.current = setTimeout(rotate, 800)  // gap between items
    }, 4500)
  }

  if (!university) return null

  return (
    <div className="relative h-12 overflow-hidden">
      <AnimatePresence mode="wait">
        {current && (
          <motion.div
            key={current.id}
            variants={TICKER_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 flex items-center"
          >
            <div className="flex items-center gap-2.5 px-4 py-2 bg-obsidian-400 border border-obsidian-500
                            rounded-xl text-sm w-full">
              <motion.span
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="flex-shrink-0 text-base"
              >
                {current.emoji}
              </motion.span>
              <span className="text-white/70 truncate">
                <span className="font-semibold text-white">{current.text}</span>
              </span>
              <div className="flex items-center gap-1 ml-auto flex-shrink-0">
                <div className="w-1.5 h-1.5 rounded-full bg-plug-green animate-pulse" />
                <span className="text-[10px] text-plug-green font-semibold">LIVE</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── DEMAND PULSE CARD ──────────────────────────────────────────────────────────

/**
 * DemandPulse — compact card showing all demand signals for a listing.
 * Used on ListingDetail to create FOMO.
 */
export function DemandPulse({ listingId, listing }) {
  const signals = []

  if (listing?.view_count > 20)      signals.push({ icon: Eye,           text: `${listing.view_count} total views`,    color: 'text-cyan'  })
  if (listing?.negotiation_count > 1) signals.push({ icon: MessageSquare, text: `${listing.negotiation_count} people messaging`, color: 'text-purple' })
  if (listing?.is_trending)          signals.push({ icon: Flame,         text: 'Trending on campus',                  color: 'text-plug-red' })
  if (listing?.is_flash_deal)        signals.push({ icon: Zap,           text: 'Flash deal — time limited',           color: 'text-plug-amber' })

  if (!signals.length) return null

  return (
    <div className="bg-obsidian-300 rounded-xl p-3 space-y-2">
      <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider">Demand Signals</div>
      {signals.map(({ icon: Icon, text, color }) => (
        <div key={text} className="flex items-center gap-2">
          <Icon size={12} className={color} />
          <span className={`text-xs font-semibold ${color}`}>{text}</span>
        </div>
      ))}
    </div>
  )
}

// ── TRUST BADGE ────────────────────────────────────────────────────────────────

/**
 * PlugPayBadge — shows trust status of a listing.
 * Green = protected, Red = stripped due to contact info in description.
 */
export function PlugPayBadge({ protected: isProtected }) {
  if (isProtected === undefined) return null

  return (
    <div className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
      isProtected
        ? 'bg-plug-green/10 text-plug-green border-plug-green/25'
        : 'bg-plug-red/10 text-plug-red border-plug-red/25'
    }`}>
      <div className={`w-1.5 h-1.5 rounded-full ${isProtected ? 'bg-plug-green' : 'bg-plug-red'}`} />
      {isProtected ? 'PlugPay Protected' : 'Protection Void'}
    </div>
  )
}

// ── DEMAND BROADCAST FORM (NEW) ────────────────────────────────────────────────

export function DemandBroadcastForm() {
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [budget, setBudget] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.from('buyer_broadcast_demands').insert({
        buyer_id: user?.id,
        title,
        max_budget: parseInt(budget, 10) * 100, // store in kobo
        category_id: parseInt(categoryId, 10)
      }).select();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Demand broadcasted to campus! Sellers will be notified.');
      setTitle('');
      setBudget('');
    },
    onError: (err: any) => {
      toast.error('Failed to broadcast demand.');
    }
  });

  return (
    <div className="bg-obsidian-400 p-4 rounded-xl border border-obsidian-500">
      <h3 className="font-bold text-white mb-2 flex items-center gap-2">
        <TrendingUp className="text-cyan" size={16}/> Broadcast a Demand
      </h3>
      <p className="text-xs text-white/50 mb-4">Looking for something specific? Alert all campus sellers instantly.</p>
      
      <div className="space-y-3">
        <input 
          type="text" 
          placeholder="What are you looking for?" 
          value={title} 
          onChange={e => setTitle(e.target.value)} 
          className="w-full bg-obsidian-500 border border-white/10 rounded px-3 py-2 text-sm text-white"
        />
        <div className="flex gap-2">
          <input 
            type="number" 
            placeholder="Max Budget (₦)" 
            value={budget} 
            onChange={e => setBudget(e.target.value)} 
            className="w-1/2 bg-obsidian-500 border border-white/10 rounded px-3 py-2 text-sm text-white"
          />
          <select 
            value={categoryId} 
            onChange={e => setCategoryId(e.target.value)}
            className="w-1/2 bg-obsidian-500 border border-white/10 rounded px-3 py-2 text-sm text-white"
          >
            <option value="">Category</option>
            <option value="1">Electronics</option>
            <option value="2">Textbooks</option>
            <option value="3">Furniture</option>
          </select>
        </div>
        <button 
          onClick={() => mutation.mutate()} 
          disabled={mutation.isPending || !title || !budget}
          className="w-full bg-cyan text-obsidian font-bold rounded py-2 text-sm flex justify-center items-center gap-2 hover:bg-cyan/80 transition disabled:opacity-50"
        >
          {mutation.isPending ? 'Broadcasting...' : <><Send size={14}/> Broadcast Request</>}
        </button>
      </div>
    </div>
  );
}

// ── DEMAND STREAM (NEW) ────────────────────────────────────────────────────────

export function DemandStream() {
  const [demands, setDemands] = useState<any[]>([]);

  useEffect(() => {
    supabase.from('buyer_broadcast_demands')
      .select('*, profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(5)
      .then(({ data }) => { if (data) setDemands(data); });

    const channel = supabase.channel('public:buyer_broadcast_demands')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'buyer_broadcast_demands' }, (payload) => {
        setDemands(prev => [payload.new, ...prev].slice(0, 5));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <div className="space-y-2 mt-4">
      <h3 className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3">Live Campus Demands</h3>
      <AnimatePresence>
        {demands.map(d => (
          <motion.div 
            key={d.id} 
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: 1, y: 0 }} 
            className="bg-obsidian-300 p-3 rounded-lg border border-obsidian-500 flex justify-between items-center"
          >
            <div>
              <p className="text-sm font-semibold text-white">{d.title}</p>
              <p className="text-xs text-white/40">Budget: ₦{(d.max_budget / 100).toLocaleString()}</p>
            </div>
            <button className="text-xs bg-cyan/10 text-cyan px-3 py-1.5 rounded-full font-bold hover:bg-cyan/20">
              Fulfill
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
