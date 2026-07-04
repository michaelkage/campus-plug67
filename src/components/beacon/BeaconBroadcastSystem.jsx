/**
 * Campus Plug v6.8.0 — BeaconBroadcastSystem
 * Component 5 of Phase 1: Reverse Demand Feed
 *
 * Reverses the listing funnel: buyers post what they WANT,
 * sellers see a live feed of matched demand and pitch directly.
 *
 * Architecture:
 *   - Buyer posts a structured demand (category, budget ceiling, keywords)
 *   - useMutation invokes background beacon matching (beacon-matcher edge fn)
 *   - Realtime subscription on beacon_broadcasts surfaces new matches instantly
 *   - Framer Motion AnimatePresence cascades cards into the seller feed
 *   - Sellers pitch by opening a direct message thread via the chat system
 */

import { useState, useEffect, useRef }          from 'react'
import { useNavigate }                           from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence }               from 'framer-motion'
import { supabase, formatNaira, timeAgo }        from '@/lib/supabase'
import { useAuth }                               from '@/contexts/AuthContext'
import { useFeature }                            from '@/contexts/FeatureFlagContext'
import toast                                     from 'react-hot-toast'
import {
  Zap, Search, Plus, X, Send, ChevronRight,
  TrendingUp, Clock, Tag, DollarSign, MessageSquare,
  Radio, AlertTriangle, Check,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'Textbooks', 'Electronics', 'Hostels', 'Gadgets',
  'Clothing', 'Lab Equipment', 'Furniture', 'Other',
]

const MAX_KEYWORDS = 5

// ─────────────────────────────────────────────────────────────────────────────
// DATA LAYER
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch active demand broadcasts (all users — seller feed view) */
async function fetchBeaconFeed(university) {
  const { data, error } = await supabase
    .from('beacon_broadcasts')
    .select(`
      *,
      requester:profiles!beacon_broadcasts_requester_id_fkey(
        id, full_name, username, avatar_url, plug_score, university
      )
    `)
    .eq('status', 'active')
    .eq('university', university)
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) throw error
  return data ?? []
}

/** Fetch the current user's own demand broadcasts */
async function fetchMyDemands(userId) {
  const { data, error } = await supabase
    .from('beacon_broadcasts')
    .select('*')
    .eq('requester_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  return data ?? []
}

/** Post a new demand beacon and trigger background matching */
async function postDemand({ userId, university, category, maxBudgetKobo, keywords, description }) {
  // 1. Insert demand record
  const { data: broadcast, error } = await supabase
    .from('beacon_broadcasts')
    .insert({
      requester_id: userId,
      university,
      category,
      max_budget:   maxBudgetKobo,
      keywords:     keywords.filter(Boolean),
      description:  description.trim(),
      status:       'active',
    })
    .select()
    .single()

  if (error) throw error

  // 2. Fire-and-forget: trigger beacon-matcher edge function for historical matching
  supabase.functions
    .invoke('beacon-matcher', {
      body: {
        action:        'broadcast_demand',
        broadcast_id:  broadcast.id,
        user_id:       userId,
        university,
        category,
        max_budget:    maxBudgetKobo,
        keywords,
      },
    })
    .catch(() => {
      // Non-fatal — historical match is best-effort
    })

  return broadcast
}

/** Cancel / close a demand beacon */
async function closeDemand(broadcastId, userId) {
  const { error } = await supabase
    .from('beacon_broadcasts')
    .update({ status: 'closed' })
    .eq('id', broadcastId)
    .eq('requester_id', userId)

  if (error) throw error
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/** Keyword tag pill */
function KeywordTag({ text, onRemove }) {
  return (
    <motion.span
      layout
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.8, opacity: 0 }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                 bg-cyan/10 border border-cyan/25 text-cyan text-xs font-semibold"
    >
      {text}
      {onRemove && (
        <button onClick={onRemove} className="hover:text-white transition-colors">
          <X size={10} />
        </button>
      )}
    </motion.span>
  )
}

/** Budget bar — visual ratio against a soft reference ceiling */
function BudgetBar({ budgetKobo, ceilingKobo = 50_000_00 }) {
  const pct = Math.min(100, Math.round((budgetKobo / ceilingKobo) * 100))
  const color =
    pct > 70 ? 'bg-emerald-400' :
    pct > 35 ? 'bg-cyan'        : 'bg-plug-amber'

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[9px] text-white/30">
        <span>BUDGET</span>
        <span className="font-mono font-bold text-white">{formatNaira(budgetKobo)}</span>
      </div>
      <div className="h-1 bg-obsidian-300 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${color}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
    </div>
  )
}

/** Single demand card in the feed */
function DemandCard({ broadcast, isMine, onClose, onPitch }) {
  const [pitching, setPitching] = useState(false)

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 340, damping: 28 }}
      className={`rounded-xl border-2 p-4 space-y-3 transition-colors
                  ${isMine
                    ? 'border-cyan/30 bg-cyan/3'
                    : 'border-obsidian-500 bg-obsidian-400 hover:border-obsidian-400'}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {broadcast.requester?.avatar_url ? (
            <img src={broadcast.requester.avatar_url}
                 alt={broadcast.requester.full_name}
                 className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-obsidian-300 flex items-center justify-center
                            text-xs font-bold text-white/50 flex-shrink-0">
              {(broadcast.requester?.full_name ?? '?')[0].toUpperCase()}
            </div>
          )}
          <div>
            <p className="text-sm font-bold text-white leading-tight">
              {isMine ? 'You' : broadcast.requester?.full_name ?? 'Student'}
            </p>
            <p className="text-[10px] text-white/30">
              {broadcast.requester?.university ?? '—'} · {timeAgo(broadcast.created_at)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="tag tag-cyan text-[9px]">{broadcast.category}</span>
          {isMine && (
            <button
              onClick={() => onClose(broadcast.id)}
              className="text-white/30 hover:text-plug-red transition-colors"
              title="Cancel demand"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      {broadcast.description && (
        <p className="text-sm text-white/70 leading-relaxed">
          "{broadcast.description}"
        </p>
      )}

      {/* Keywords */}
      {broadcast.keywords?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {broadcast.keywords.map((kw, i) => (
            <KeywordTag key={i} text={kw} />
          ))}
        </div>
      )}

      {/* Budget bar */}
      <BudgetBar budgetKobo={broadcast.max_budget} />

      {/* Match count badge */}
      {broadcast.match_count > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] text-plug-green">
          <Check size={10} />
          {broadcast.match_count} seller match{broadcast.match_count !== 1 ? 'es' : ''} found
        </div>
      )}

      {/* CTA */}
      {!isMine && (
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => { setPitching(true); onPitch(broadcast) }}
          disabled={pitching}
          className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl
                     bg-plug-green/10 border border-plug-green/25 text-plug-green
                     hover:bg-plug-green/20 transition-all text-sm font-bold
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="flex items-center gap-2">
            <MessageSquare size={13} />
            SEND PITCH
          </span>
          <ChevronRight size={13} />
        </motion.button>
      )}

      {isMine && (
        <p className="text-[10px] text-cyan/50 text-center">
          Your broadcast is live — matching sellers will message you
        </p>
      )}
    </motion.div>
  )
}

/** Demand creation form */
function DemandForm({ onSuccess, onCancel, profile }) {
  const [category,    setCategory]    = useState('')
  const [budgetStr,   setBudgetStr]   = useState('')
  const [description, setDescription] = useState('')
  const [kwInput,     setKwInput]     = useState('')
  const [keywords,    setKeywords]    = useState([])
  const kwRef = useRef(null)

  const addKeyword = () => {
    const kw = kwInput.trim()
    if (!kw || keywords.includes(kw) || keywords.length >= MAX_KEYWORDS) return
    setKeywords(prev => [...prev, kw])
    setKwInput('')
    kwRef.current?.focus()
  }

  const removeKeyword = (kw) => setKeywords(prev => prev.filter(k => k !== kw))

  const qc = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => postDemand({
      userId:         profile.id,
      university:     profile.university,
      category,
      maxBudgetKobo:  Math.round(parseFloat(budgetStr) * 100),
      keywords,
      description,
    }),
    onSuccess: (data) => {
      toast.success('📡 Demand broadcast sent to sellers!')
      qc.invalidateQueries({ queryKey: ['beacon-feed'] })
      qc.invalidateQueries({ queryKey: ['my-demands'] })
      onSuccess(data)
    },
    onError: (err) => toast.error(err.message || 'Failed to post demand'),
  })

  const valid = category && parseFloat(budgetStr) > 0 && description.trim().length >= 10

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-cyan" />
          <h3 className="font-bold text-sm">POST A DEMAND</h3>
        </div>
        <button onClick={onCancel} className="text-white/30 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
          What do you need? *
        </label>
        <textarea
          className="input resize-none text-sm w-full"
          rows={3}
          placeholder='e.g. "Looking for a clean 3-in-1 mattress, preferably Vitafoam, under ₦12k"'
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={200}
        />
        <p className="text-[9px] text-white/20 text-right">{description.length}/200</p>
      </div>

      {/* Category + budget */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
            Category *
          </label>
          <select className="input text-sm" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Select…</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
            Max Budget (₦) *
          </label>
          <input
            className="input text-sm font-mono"
            type="number"
            min="1"
            placeholder="0"
            value={budgetStr}
            onChange={e => setBudgetStr(e.target.value)}
          />
        </div>
      </div>

      {/* Keywords */}
      <div className="space-y-2">
        <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
          Keywords ({keywords.length}/{MAX_KEYWORDS})
        </label>
        <div className="flex gap-2">
          <input
            ref={kwRef}
            className="input text-sm flex-1"
            placeholder='e.g. "Vitafoam", "256GB", "clean"'
            value={kwInput}
            onChange={e => setKwInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
            maxLength={30}
          />
          <button
            type="button"
            onClick={addKeyword}
            disabled={!kwInput.trim() || keywords.length >= MAX_KEYWORDS}
            className="px-3 py-2 bg-obsidian-300 border border-obsidian-500 rounded-xl
                       text-white/50 hover:text-white disabled:opacity-30 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>

        <AnimatePresence>
          {keywords.length > 0 && (
            <motion.div layout className="flex flex-wrap gap-1.5">
              <AnimatePresence>
                {keywords.map(kw => (
                  <KeywordTag key={kw} text={kw} onRemove={() => removeKeyword(kw)} />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Submit */}
      <motion.button
        whileTap={valid ? { scale: 0.97 } : {}}
        onClick={() => valid && mutation.mutate()}
        disabled={!valid || mutation.isPending}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl
                   font-bold text-sm tracking-wide transition-all
                   disabled:opacity-40 disabled:cursor-not-allowed
                   bg-cyan text-obsidian hover:bg-cyan/90"
      >
        {mutation.isPending ? (
          <>
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
              className="block w-4 h-4 border-2 border-obsidian border-t-transparent rounded-full"
            />
            BROADCASTING…
          </>
        ) : (
          <>
            <Zap size={14} />
            BROADCAST DEMAND
          </>
        )}
      </motion.button>
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function BeaconBroadcastSystem() {
  const { user, profile } = useAuth()
  const navigate          = useNavigate()
  const qc                = useQueryClient()
  const { enabled: beaconEnabled } = useFeature('beacon_broadcast')

  const [tab,         setTab]         = useState('feed')   // 'feed' | 'mine'
  const [showForm,    setShowForm]    = useState(false)
  const [search,      setSearch]      = useState('')
  const [filterCat,   setFilterCat]   = useState('')

  // ── Feed query ─────────────────────────────────────────────────────────────
  const {
    data:      feed       = [],
    isLoading: loadingFeed,
    error:     feedError,
  } = useQuery({
    queryKey: ['beacon-feed', profile?.university],
    queryFn:  () => fetchBeaconFeed(profile?.university),
    enabled:  !!profile?.university,
    staleTime: 30_000,
  })

  // ── My demands query ───────────────────────────────────────────────────────
  const {
    data:      myDemands    = [],
    isLoading: loadingMine,
  } = useQuery({
    queryKey: ['my-demands', user?.id],
    queryFn:  () => fetchMyDemands(user?.id),
    enabled:  !!user?.id,
    staleTime: 20_000,
  })

  // ── Realtime: push new broadcasts into feed instantly ─────────────────────
  useEffect(() => {
    if (!profile?.university) return

    const ch = supabase
      .channel('beacon-broadcasts-feed')
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'beacon_broadcasts',
          filter: `university=eq.${profile.university}`,
        },
        (payload) => {
          qc.setQueryData(
            ['beacon-feed', profile.university],
            (old) => [payload.new, ...(old ?? [])]
          )
        }
      )
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'beacon_broadcasts',
        },
        () => {
          qc.invalidateQueries({ queryKey: ['beacon-feed', profile.university] })
          qc.invalidateQueries({ queryKey: ['my-demands', user?.id] })
        }
      )
      .subscribe()

    return () => supabase.removeChannel(ch)
  }, [profile?.university, user?.id, qc])

  // ── Close demand mutation ──────────────────────────────────────────────────
  const closeMutation = useMutation({
    mutationFn: (broadcastId) => closeDemand(broadcastId, user?.id),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['beacon-feed',  profile?.university] })
      qc.invalidateQueries({ queryKey: ['my-demands', user?.id] })
      toast.success('Demand broadcast closed.')
    },
  })

  // ── Pitch handler: open DM thread with requester ──────────────────────────
  const handlePitch = (broadcast) => {
    navigate(`/messages?to=${broadcast.requester_id}&ref=beacon&bid=${broadcast.id}`)
  }

  // ── Filter feed ────────────────────────────────────────────────────────────
  const filteredFeed = feed.filter(b => {
    if (b.status !== 'active') return false
    if (filterCat && b.category !== filterCat) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        b.description?.toLowerCase().includes(q) ||
        b.keywords?.some(k => k.toLowerCase().includes(q)) ||
        b.category?.toLowerCase().includes(q)
      )
    }
    return true
  })

  // ── Feature gate ──────────────────────────────────────────────────────────
  if (!beaconEnabled && beaconEnabled !== undefined) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center px-4">
        <Radio size={32} className="text-white/10 mb-4" />
        <p className="font-bold text-white/40 text-sm">Beacon Broadcasts</p>
        <p className="text-xs text-white/20 mt-1 max-w-xs">
          This feature is rolling out soon. Check back shortly.
        </p>
      </div>
    )
  }

  const activeDemands = myDemands.filter(d => d.status === 'active')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <p className="section-label flex items-center gap-1.5">
            <Radio size={10} className="text-cyan" />
            REVERSE DEMAND ENGINE
          </p>
          <h1 className="text-2xl font-black tracking-tight">Beacon Broadcasts</h1>
          <p className="text-xs text-white/30 mt-1">
            Post what you need. Sellers come to you.
          </p>
        </div>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowForm(v => !v)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold
                      transition-all self-start mt-1
                      ${showForm
                        ? 'bg-obsidian-300 border border-obsidian-500 text-white/50'
                        : 'bg-cyan text-obsidian hover:bg-cyan/90'}`}
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'CANCEL' : 'POST DEMAND'}
        </motion.button>
      </div>

      {/* ── My active demand badge ────────────────────────────────────────── */}
      <AnimatePresence>
        {activeDemands.length > 0 && !showForm && (
          <motion.button
            key="active-badge"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            onClick={() => setTab('mine')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
                       bg-cyan/5 border border-cyan/20 text-left"
          >
            <motion.span
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-2 h-2 rounded-full bg-cyan flex-shrink-0"
            />
            <div className="flex-1">
              <p className="text-xs font-bold text-cyan">
                {activeDemands.length} active broadcast{activeDemands.length !== 1 ? 's' : ''} live
              </p>
              <p className="text-[10px] text-white/30">Tap to manage your demands</p>
            </div>
            <ChevronRight size={13} className="text-white/30" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Demand creation form ──────────────────────────────────────────── */}
      <AnimatePresence>
        {showForm && (
          <DemandForm
            key="form"
            profile={profile}
            onSuccess={() => { setShowForm(false); setTab('mine') }}
            onCancel={() => setShowForm(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-obsidian-400 border border-obsidian-500 rounded-xl p-1">
        {[
          { id: 'feed', label: 'DEMAND FEED', count: filteredFeed.length },
          { id: 'mine', label: 'MY DEMANDS',  count: myDemands.length    },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg
                        text-xs font-bold uppercase tracking-widest transition-all
                        ${tab === t.id
                          ? 'bg-cyan text-obsidian'
                          : 'text-white/40 hover:text-white'}`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold
                                ${tab === t.id
                                  ? 'bg-obsidian/20 text-obsidian'
                                  : 'bg-white/10 text-white/40'}`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── FEED TAB ─────────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {tab === 'feed' && (
          <motion.div
            key="feed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {/* Search + filter */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <input
                  className="input pl-8 text-sm w-full"
                  placeholder="Search demands…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <select
                className="input text-sm w-36 flex-shrink-0"
                value={filterCat}
                onChange={e => setFilterCat(e.target.value)}
              >
                <option value="">All categories</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Feed error */}
            {feedError && (
              <div className="flex items-center gap-2 text-xs text-plug-red
                              bg-plug-red/5 border border-plug-red/20 rounded-xl px-4 py-3">
                <AlertTriangle size={13} />
                Failed to load feed. Check your connection.
              </div>
            )}

            {/* Loading skeletons */}
            {loadingFeed && (
              <div className="space-y-3">
                {[0, 1, 2].map(i => (
                  <div key={i}
                    className="h-32 bg-obsidian-400 border border-obsidian-500 rounded-xl animate-pulse" />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!loadingFeed && filteredFeed.length === 0 && (
              <div className="flex flex-col items-center py-16 text-center">
                <Radio size={32} className="text-white/10 mb-4" />
                <p className="font-bold text-white/40 text-sm">No active demands yet</p>
                <p className="text-xs text-white/20 mt-1">
                  Be the first to broadcast what you need.
                </p>
              </div>
            )}

            {/* Cards */}
            <AnimatePresence>
              {filteredFeed.map(b => (
                <DemandCard
                  key={b.id}
                  broadcast={b}
                  isMine={b.requester_id === user?.id}
                  onClose={(id) => closeMutation.mutate(id)}
                  onPitch={handlePitch}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}

        {/* ── MY DEMANDS TAB ───────────────────────────────────────────────── */}
        {tab === 'mine' && (
          <motion.div
            key="mine"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {loadingMine ? (
              <div className="space-y-3">
                {[0, 1].map(i => (
                  <div key={i}
                    className="h-28 bg-obsidian-400 border border-obsidian-500 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : myDemands.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center">
                <Zap size={32} className="text-white/10 mb-4" />
                <p className="font-bold text-white/40 text-sm">No demands posted yet</p>
                <p className="text-xs text-white/20 mt-1">
                  Post your first demand and watch sellers come to you.
                </p>
                <button
                  onClick={() => setShowForm(true)}
                  className="mt-4 btn-primary text-sm"
                >
                  Post Demand
                </button>
              </div>
            ) : (
              <AnimatePresence>
                {myDemands.map(b => (
                  <DemandCard
                    key={b.id}
                    broadcast={b}
                    isMine
                    onClose={(id) => closeMutation.mutate(id)}
                    onPitch={handlePitch}
                  />
                ))}
              </AnimatePresence>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
