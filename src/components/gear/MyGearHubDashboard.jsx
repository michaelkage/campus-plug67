/**
 * Campus Plug v6.8.0 — My Gear Hub Dashboard
 * Component 2 of Phase 1: Heartbeat Rental Escrow
 *
 * Architecture:
 *   - Supabase Realtime subscriptions on both `listings` and `transactions`
 *     tables so escrow state shifts sync without a page refresh
 *   - Per-card heartbeat countdown: calculates remaining time client-side,
 *     ticks every second via setInterval inside a custom hook
 *   - 7-state escrow machine surfaced through useEscrow:
 *       pending → locked → meetup_initiated → release_requested
 *                                           → released
 *                                           → disputed
 *                                           → cancelled
 *   - Visual state indicator strip:
 *       Green  (#00ff88)  — Active / on-time
 *       Amber  (#f59e0b)  — Grace period (overdue ≤ 24 h)
 *       Red    (#ef4444)  — Penalty triggered (overdue > 24 h)
 *   - TanStack Query `useMutation` for: lock-funds, confirm-safe-drop,
 *     request-release, confirm-arrival, and open-dispute
 *   - Dispute CTA routes directly to /war-room?tx=<id>
 *   - All imports: extensionless or @/ alias — no .js / .ts
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate }                               from 'react-router-dom'
import { useQuery, useMutation, useQueryClient }     from '@tanstack/react-query'
import { motion, AnimatePresence }                   from 'framer-motion'
import { supabase, formatNaira, timeAgo }            from '@/lib/supabase'
import { useAuth }                                   from '@/contexts/AuthContext'
import { useEscrow, TX_STATUS_META, TX_STEPS }       from '@/hooks/useEscrow'
import { useRealtimeTable }                          from '@/hooks/useRealtime'
import toast                                         from 'react-hot-toast'
import {
  Package, Clock, Shield, AlertTriangle, CheckCircle2,
  Zap, RefreshCw, Lock, Unlock, MapPin, ArrowRight,
  AlertOctagon, ChevronDown, ChevronUp, Timer, Flame,
  Check, X, FileText,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// 1. HEARTBEAT COUNTDOWN HOOK
// Returns { days, hours, mins, secs, expired, urgency }
// urgency: 'ok' | 'grace' | 'penalty'
// ─────────────────────────────────────────────────────────────────────────────
function useHeartbeatCountdown(expiresAt) {
  const [remaining, setRemaining] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    if (!expiresAt) { setRemaining(null); return }

    const compute = () => {
      const ms = new Date(expiresAt).getTime() - Date.now()

      if (ms <= 0) {
        const overMs  = Math.abs(ms)
        const overH   = Math.floor(overMs / 3_600_000)
        setRemaining({
          expired:  true,
          overMs,
          urgency:  overH >= 24 ? 'penalty' : 'grace',
          days:  0, hours: 0, mins: 0, secs: 0,
        })
        return
      }

      const days  = Math.floor(ms / 86_400_000)
      const hours = Math.floor((ms % 86_400_000) / 3_600_000)
      const mins  = Math.floor((ms % 3_600_000)  / 60_000)
      const secs  = Math.floor((ms % 60_000)      / 1_000)
      setRemaining({ expired: false, urgency: 'ok', days, hours, mins, secs })
    }

    compute()
    ref.current = setInterval(compute, 1_000)
    return () => clearInterval(ref.current)
  }, [expiresAt])

  return remaining
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DATA FETCHERS
// ─────────────────────────────────────────────────────────────────────────────
async function fetchActiveTransactions(userId) {
  const { data, error } = await supabase
    .from('transactions')
    .select(`
      *,
      listing:listings(id, title, images, category, price, expires_at, condition),
      buyer:profiles!transactions_buyer_id_fkey(id, full_name, username, avatar_url, plug_score),
      seller:profiles!transactions_seller_id_fkey(id, full_name, username, avatar_url, plug_score)
    `)
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .not('status', 'in', '("released","cancelled")')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

async function fetchUserInventory(userId) {
  const { data, error } = await supabase
    .from('listings')
    .select(`
      id, title, images, category, price, status, condition,
      expires_at, created_at, view_count, exif_flagged,
      is_trending
    `)
    .eq('seller_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ESCROW STATE COLOUR + LABEL MAP
// ─────────────────────────────────────────────────────────────────────────────
const ESCROW_STATE = {
  pending: {
    label:  'AWAITING PAYMENT',
    border: 'border-white/10',
    bg:     'bg-white/3',
    dot:    'bg-white/30',
    text:   'text-white/40',
  },
  locked: {
    label:  'FUNDS LOCKED',
    border: 'border-cyan/40',
    bg:     'bg-cyan/5',
    dot:    'bg-cyan animate-pulse',
    text:   'text-cyan',
  },
  meetup_initiated: {
    label:  'MEETUP ACTIVE',
    border: 'border-plug-green/40',
    bg:     'bg-plug-green/5',
    dot:    'bg-plug-green animate-pulse',
    text:   'text-plug-green',
  },
  release_requested: {
    label:  'RELEASE REQUESTED',
    border: 'border-plug-amber/40',
    bg:     'bg-plug-amber/5',
    dot:    'bg-plug-amber animate-pulse',
    text:   'text-plug-amber',
  },
  released: {
    label:  'RELEASED',
    border: 'border-plug-green/30',
    bg:     'bg-plug-green/5',
    dot:    'bg-plug-green',
    text:   'text-plug-green',
  },
  disputed: {
    label:  'UNDER DISPUTE',
    border: 'border-plug-red/50',
    bg:     'bg-plug-red/5',
    dot:    'bg-plug-red animate-pulse',
    text:   'text-plug-red',
  },
  cancelled: {
    label:  'CANCELLED',
    border: 'border-white/10',
    bg:     'bg-white/3',
    dot:    'bg-white/20',
    text:   'text-white/30',
  },
}

const URGENCY_STYLE = {
  ok:      { bar: 'bg-plug-green', label: 'text-plug-green',  icon: Clock,         text: 'ON TIME'      },
  grace:   { bar: 'bg-plug-amber', label: 'text-plug-amber',  icon: AlertTriangle, text: 'GRACE PERIOD' },
  penalty: { bar: 'bg-plug-red',   label: 'text-plug-red',    icon: Flame,         text: 'PENALTY ZONE' },
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HEARTBEAT CLOCK DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
function HeartbeatClock({ expiresAt, compact = false }) {
  const cd = useHeartbeatCountdown(expiresAt)
  if (!cd) return null

  const urgency = cd.urgency
  const style   = URGENCY_STYLE[urgency]
  const Icon    = style.icon

  if (cd.expired) {
    const overH = Math.floor(cd.overMs / 3_600_000)
    const overM = Math.floor((cd.overMs % 3_600_000) / 60_000)

    return (
      <div className={`flex items-center gap-1.5 ${style.label}`}>
        <Icon size={compact ? 11 : 13} />
        <span className={`font-mono font-bold ${compact ? 'text-xs' : 'text-sm'}`}>
          {style.text} +{overH}h {overM}m
        </span>
      </div>
    )
  }

  if (compact) {
    return (
      <div className={`flex items-center gap-1 font-mono text-xs font-bold ${style.label}`}>
        <Icon size={10} />
        {cd.days > 0 ? `${cd.days}d ` : ''}{String(cd.hours).padStart(2,'0')}:{String(cd.mins).padStart(2,'0')}:{String(cd.secs).padStart(2,'0')}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className={`flex items-center gap-1.5 ${style.label} text-xs font-bold uppercase tracking-widest`}>
        <Icon size={11} />
        {style.text}
      </div>
      <div className={`flex items-center gap-2 font-mono font-black ${style.label}`}>
        {cd.days > 0 && (
          <ClockUnit value={cd.days}  label="D" style={style} />
        )}
        <ClockUnit value={cd.hours} label="H" style={style} />
        <ClockUnit value={cd.mins}  label="M" style={style} />
        <ClockUnit value={cd.secs}  label="S" style={style} />
      </div>
    </div>
  )
}

function ClockUnit({ value, label, style }) {
  return (
    <div className="flex flex-col items-center">
      <span className={`text-2xl font-black font-mono leading-none ${style.label}`}>
        {String(value).padStart(2, '0')}
      </span>
      <span className="text-[9px] text-white/30 font-bold tracking-widest">{label}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ESCROW PROGRESS BAR
// ─────────────────────────────────────────────────────────────────────────────
function EscrowProgressBar({ status }) {
  const activeIdx = TX_STEPS.findIndex(s => s.key === status)
  const isError   = status === 'disputed' || status === 'cancelled'

  return (
    <div className="flex items-center gap-0 w-full">
      {TX_STEPS.map((step, idx) => {
        const done    = !isError && idx < activeIdx
        const current = !isError && idx === activeIdx
        const ahead   = idx > activeIdx
        return (
          <div key={step.key} className="flex items-center flex-1">
            <div className={`flex flex-col items-center gap-1 flex-shrink-0 ${ahead ? 'opacity-25' : ''}`}>
              <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-bold transition-all
                ${done    ? 'border-plug-green bg-plug-green text-obsidian' :
                  current ? 'border-cyan bg-cyan/20 text-cyan' :
                            'border-white/15 bg-transparent text-white/20'}`}>
                {done ? <Check size={10} /> : idx + 1}
              </div>
              <span className={`text-[8px] uppercase tracking-wider font-bold whitespace-nowrap
                ${current ? 'text-cyan' : done ? 'text-plug-green' : 'text-white/20'}`}>
                {step.label}
              </span>
            </div>
            {idx < TX_STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-1 transition-colors
                ${done ? 'bg-plug-green' : current ? 'bg-cyan/30' : 'bg-white/10'}`} />
            )}
          </div>
        )
      })}
      {isError && (
        <div className="flex items-center gap-1 ml-2 text-plug-red text-xs font-bold">
          <AlertOctagon size={12} />
          {status === 'disputed' ? 'DISPUTED' : 'VOID'}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. INDIVIDUAL TRANSACTION CARD (uses useEscrow internally)
// ─────────────────────────────────────────────────────────────────────────────
function TransactionCard({ tx: initialTx, userId, onInvalidate }) {
  const { session } = useAuth()
  const navigate    = useNavigate()
  const [expanded,  setExpanded]  = useState(false)
  const [qrInput,   setQrInput]   = useState('')
  const [dispReason, setDispReason] = useState('')

  const isSeller = initialTx.seller_id === userId

  const escrow = useEscrow({
    transactionId: initialTx.id,
    session,
    isSeller,
    onRelease:     () => { onInvalidate(); toast.success('🎉 Funds released! Check your wallet.') },
    onDispute:     () => { onInvalidate() },
    onStatusChange: () => onInvalidate(),
  })

  const tx      = escrow.tx ?? initialTx
  const status  = tx.status ?? 'pending'
  const stateUi = ESCROW_STATE[status] ?? ESCROW_STATE.pending
  const counterpart = isSeller ? tx.buyer : tx.seller

  // ── Mutations that wrap useEscrow actions ─────────────────────────────────
  const lockMutation = useMutation({
    mutationFn: () => escrow.actions.initiateMeetup(),
    onSuccess:  (res) => { if (!res?.success) return; onInvalidate() },
  })
  const releaseMutation = useMutation({
    mutationFn: () => escrow.actions.release(qrInput),
    onSuccess:  (res) => { if (!res?.success) return; setQrInput(''); onInvalidate() },
  })
  const requestReleaseMutation = useMutation({
    mutationFn: () => escrow.actions.requestRelease(),
    onSuccess:  (res) => { if (!res?.success) return; onInvalidate() },
  })
  const disputeMutation = useMutation({
    mutationFn: () => escrow.actions.dispute(dispReason),
    onSuccess:  (res) => { if (!res?.success) return; navigate(`/war-room?tx=${tx.id}`) },
  })

  const anyLoading = escrow.isAnyLoading || lockMutation.isPending ||
                     releaseMutation.isPending || requestReleaseMutation.isPending ||
                     disputeMutation.isPending

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-xl border-2 transition-colors duration-300 overflow-hidden
                  ${stateUi.border} ${stateUi.bg}`}
    >
      {/* ── Card header ──────────────────────────────────────────────────── */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Item thumbnail */}
          <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-obsidian-300">
            {tx.listing?.images?.[0]
              ? <img src={tx.listing.images[0]} alt={tx.listing.title}
                     className="w-full h-full object-cover" />
              : <Package size={22} className="m-auto text-white/20 mt-3" />
            }
          </div>

          <div className="flex-1 min-w-0">
            {/* Title + amount */}
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="font-bold text-sm text-white leading-tight line-clamp-1">
                {tx.listing?.title ?? 'Listing'}
              </h3>
              <span className="font-mono font-black text-cyan text-sm flex-shrink-0">
                {formatNaira(tx.amount)}
              </span>
            </div>

            {/* Role + counterpart */}
            <p className="text-[10px] text-white/40 mb-2">
              {isSeller ? 'You are selling to' : 'You are buying from'}{' '}
              <span className="text-white/70 font-semibold">
                {counterpart?.full_name ?? '—'}
              </span>
            </p>

            {/* State indicator dot + label */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${stateUi.dot}`} />
                <span className={`text-[10px] font-bold uppercase tracking-widest ${stateUi.text}`}>
                  {stateUi.label}
                </span>
              </div>
              <button
                onClick={() => setExpanded(v => !v)}
                className="text-white/30 hover:text-white transition-colors"
                aria-label={expanded ? 'Collapse' : 'Expand'}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
          </div>
        </div>

        {/* Heartbeat clock — compact in collapsed view */}
        {tx.listing?.expires_at && status !== 'released' && status !== 'cancelled' && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <HeartbeatClock expiresAt={tx.listing.expires_at} compact={!expanded} />
          </div>
        )}
      </div>

      {/* ── Expanded panel ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-4">

              {/* Progress bar */}
              <EscrowProgressBar status={status} />

              {/* Full heartbeat clock */}
              {tx.listing?.expires_at && !['released','cancelled'].includes(status) && (
                <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-white/30 mb-3">
                    RETURN DEADLINE
                  </p>
                  <HeartbeatClock expiresAt={tx.listing.expires_at} />
                </div>
              )}

              {/* Escrow ID + timestamps */}
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div className="bg-obsidian-400 rounded-lg p-2">
                  <span className="text-white/30 block">Escrow ID</span>
                  <span className="text-white font-mono">{tx.id.slice(0,8).toUpperCase()}</span>
                </div>
                <div className="bg-obsidian-400 rounded-lg p-2">
                  <span className="text-white/30 block">Started</span>
                  <span className="text-white">{timeAgo(tx.created_at)}</span>
                </div>
                {tx.paystack_ref && (
                  <div className="bg-obsidian-400 rounded-lg p-2 col-span-2">
                    <span className="text-white/30 block">Payment Ref</span>
                    <span className="text-white font-mono text-[11px]">{tx.paystack_ref}</span>
                  </div>
                )}
              </div>

              {/* ── ACTIONS ──────────────────────────────────────────────── */}

              {/* SELLER: Initiate meetup (locked → meetup_initiated) */}
              {escrow.can.initiateMeetup && (
                <ActionButton
                  icon={MapPin}
                  label="CONFIRM MEETUP"
                  description="Start the physical handover window"
                  color="cyan"
                  loading={lockMutation.isPending}
                  disabled={anyLoading}
                  onClick={() => lockMutation.mutate()}
                />
              )}

              {/* BUYER: Release funds with QR code */}
              {escrow.can.release && (
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                    SELLER'S RELEASE CODE
                  </label>
                  <div className="flex gap-2">
                    <input
                      className="input flex-1 font-mono uppercase tracking-widest"
                      placeholder="Enter 6-char code"
                      value={qrInput}
                      maxLength={12}
                      onChange={e => setQrInput(e.target.value.toUpperCase())}
                    />
                    <ActionButton
                      icon={Unlock}
                      label="RELEASE"
                      color="green"
                      loading={releaseMutation.isPending}
                      disabled={!qrInput.trim() || anyLoading}
                      onClick={() => releaseMutation.mutate()}
                      compact
                    />
                  </div>
                </div>
              )}

              {/* SELLER: Request release after timeout */}
              {escrow.can.requestRelease && (
                <ActionButton
                  icon={Timer}
                  label="REQUEST RELEASE"
                  description="Ask for funds after the meetup window"
                  color="amber"
                  loading={requestReleaseMutation.isPending}
                  disabled={anyLoading}
                  onClick={() => requestReleaseMutation.mutate()}
                />
              )}

              {/* BUYER: File dispute within 48h window */}
              {escrow.can.dispute && (
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-plug-red/70">
                    FILE A DISPUTE
                  </label>
                  <textarea
                    className="input resize-none text-sm"
                    rows={3}
                    placeholder="Describe the issue (min 20 characters)…"
                    value={dispReason}
                    onChange={e => setDispReason(e.target.value)}
                  />
                  <ActionButton
                    icon={AlertOctagon}
                    label="OPEN DISPUTE → WAR ROOM"
                    color="red"
                    loading={disputeMutation.isPending}
                    disabled={dispReason.trim().length < 20 || anyLoading}
                    onClick={() => disputeMutation.mutate()}
                  />
                </div>
              )}

              {/* Disputed: view in War Room */}
              {status === 'disputed' && (
                <button
                  onClick={() => navigate(`/war-room?tx=${tx.id}`)}
                  className="btn-danger w-full flex items-center justify-center gap-2 text-sm font-bold"
                >
                  <FileText size={14} />
                  VIEW IN WAR ROOM
                  <ArrowRight size={13} />
                </button>
              )}

              {/* Auto-release countdown (release_requested state) */}
              {status === 'release_requested' && escrow.countdown.label && (
                <div className="flex items-center gap-2 bg-plug-amber/10 border border-plug-amber/25
                                rounded-lg px-3 py-2 text-xs text-plug-amber">
                  <Timer size={12} />
                  Auto-release in: <span className="font-mono font-bold ml-1">
                    {escrow.countdown.label}
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ACTION BUTTON (shared sub-component)
// ─────────────────────────────────────────────────────────────────────────────
const COLOR_MAP = {
  cyan:  'bg-cyan/10 border-cyan/30 text-cyan hover:bg-cyan/20',
  green: 'bg-plug-green/10 border-plug-green/30 text-plug-green hover:bg-plug-green/20',
  amber: 'bg-plug-amber/10 border-plug-amber/30 text-plug-amber hover:bg-plug-amber/20',
  red:   'bg-plug-red/10 border-plug-red/30 text-plug-red hover:bg-plug-red/20',
}

function ActionButton({ icon: Icon, label, description, color, loading, disabled, onClick, compact = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border
                  font-bold transition-all duration-150
                  disabled:opacity-40 disabled:cursor-not-allowed
                  ${compact ? 'text-xs px-3 py-2' : 'text-sm'}
                  ${COLOR_MAP[color] ?? COLOR_MAP.cyan}`}
    >
      {loading
        ? <RefreshCw size={compact ? 12 : 14} className="animate-spin flex-shrink-0" />
        : <Icon     size={compact ? 12 : 14} className="flex-shrink-0" />
      }
      <div className="flex-1 text-left">
        <span className="font-bold tracking-wide block">{label}</span>
        {description && !compact && (
          <span className="text-[10px] opacity-60 font-normal block mt-0.5">{description}</span>
        )}
      </div>
      {!compact && <ArrowRight size={13} className="opacity-50 flex-shrink-0" />}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. INVENTORY CARD (listings, no escrow)
// ─────────────────────────────────────────────────────────────────────────────
function InventoryCard({ listing }) {
  const cd = useHeartbeatCountdown(listing.expires_at)
  const urgency = cd?.urgency ?? 'ok'
  const style   = URGENCY_STYLE[urgency]

  return (
    <div className={`bg-obsidian-400 border rounded-xl overflow-hidden transition-colors
                     ${urgency === 'penalty' ? 'border-plug-red/40'
                       : urgency === 'grace' ? 'border-plug-amber/30'
                       : 'border-obsidian-500'}`}>
      {/* Image */}
      <div className="aspect-video bg-obsidian-300 relative overflow-hidden">
        {listing.images?.[0]
          ? <img src={listing.images[0]} alt={listing.title}
                 className="w-full h-full object-cover" />
          : <Package size={28} className="absolute inset-0 m-auto text-white/15" />
        }
        {/* Urgency strip */}
        {cd && (
          <div className={`absolute bottom-0 inset-x-0 h-1 ${style.bar}`} />
        )}
        {listing.is_trending && (
          <span className="absolute top-2 left-2 tag tag-cyan text-[9px] flex items-center gap-1">
            <Zap size={8} /> TRENDING
          </span>
        )}
        {listing.exif_flagged && (
          <span className="absolute top-2 right-2 tag tag-red text-[9px] flex items-center gap-1">
            <AlertTriangle size={8} /> UNVERIFIED
          </span>
        )}
      </div>

      <div className="p-3 space-y-2">
        <h3 className="font-bold text-sm text-white line-clamp-1">{listing.title}</h3>

        <div className="flex items-center justify-between">
          <span className="font-mono font-black text-cyan text-sm">{formatNaira(listing.price)}</span>
          <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full
                            border ${listing.status === 'active'
                              ? 'border-plug-green/30 text-plug-green bg-plug-green/10'
                              : 'border-white/10 text-white/30'}`}>
            {listing.status}
          </span>
        </div>

        {/* Heartbeat clock — compact */}
        {cd && (
          <HeartbeatClock expiresAt={listing.expires_at} compact />
        )}

        <div className="flex items-center justify-between text-[10px] text-white/30">
          <span>{listing.category}</span>
          <span>{listing.view_count ?? 0} views</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. MAIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function MyGearHubDashboard() {
  const { user } = useAuth()
  const qc       = useQueryClient()
  const [tab, setTab] = useState('escrow')

  // ── Queries ────────────────────────────────────────────────────────────────
  const {
    data:      activeTxns  = [],
    isLoading: loadingTxns,
    error:     txError,
  } = useQuery({
    queryKey: ['gear-active-txns', user?.id],
    queryFn:  () => fetchActiveTransactions(user?.id),
    enabled:  !!user?.id,
    staleTime: 30_000,
  })

  const {
    data:      inventory   = [],
    isLoading: loadingInv,
  } = useQuery({
    queryKey: ['gear-inventory', user?.id],
    queryFn:  () => fetchUserInventory(user?.id),
    enabled:  !!user?.id,
    staleTime: 60_000,
  })

  // ── Realtime: re-fetch when any transaction for this user changes ───────────
  useRealtimeTable({
    table:    'transactions',
    onUpdate: () => qc.invalidateQueries({ queryKey: ['gear-active-txns', user?.id] }),
    onInsert: () => qc.invalidateQueries({ queryKey: ['gear-active-txns', user?.id] }),
  })

  useRealtimeTable({
    table:    'listings',
    filter:   { column: 'seller_id', value: user?.id },
    onUpdate: () => qc.invalidateQueries({ queryKey: ['gear-inventory', user?.id] }),
    onInsert: () => qc.invalidateQueries({ queryKey: ['gear-inventory', user?.id] }),
  })

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['gear-active-txns', user?.id] })
  }, [qc, user?.id])

  // ── Derived stats ──────────────────────────────────────────────────────────
  const escrowTotal     = activeTxns.reduce((s, t) => s + (t.amount ?? 0), 0)
  const overdueCount    = activeTxns.filter(t => {
    if (!t.listing?.expires_at) return false
    return new Date(t.listing.expires_at) < new Date() &&
           !['released','cancelled'].includes(t.status)
  }).length

  const TABS = [
    { id: 'escrow',    label: 'ESCROW',    count: activeTxns.length },
    { id: 'inventory', label: 'INVENTORY', count: inventory.length  },
  ]

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div>
        <p className="section-label">GEAR HUB</p>
        <h1 className="text-2xl font-black tracking-tight">Escrow Dashboard</h1>
      </div>

      {/* ── Stat strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="ACTIVE ESCROW"
          value={activeTxns.length}
          sub="transactions"
          color="cyan"
        />
        <StatCard
          label="TOTAL LOCKED"
          value={formatNaira(escrowTotal)}
          sub="in custody"
          color="plug-green"
          mono
        />
        <StatCard
          label="OVERDUE"
          value={overdueCount}
          sub={overdueCount > 0 ? 'need attention' : 'all on time'}
          color={overdueCount > 0 ? 'plug-red' : 'plug-green'}
        />
      </div>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-obsidian-400 border border-obsidian-500 rounded-xl p-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg
                        text-xs font-bold uppercase tracking-widest transition-all
                        ${tab === t.id
                          ? 'bg-cyan text-obsidian shadow-sm'
                          : 'text-white/40 hover:text-white'}`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold
                                ${tab === t.id ? 'bg-obsidian/20 text-obsidian' : 'bg-white/10 text-white/50'}`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────── */}
      {txError && (
        <div className="flex items-center gap-2 bg-plug-red/10 border border-plug-red/30
                        rounded-xl p-3 text-sm text-plug-red">
          <AlertTriangle size={14} />
          Failed to load transactions. Check your connection.
        </div>
      )}

      {/* ── Escrow tab ────────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {tab === 'escrow' && (
          <motion.div
            key="escrow"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="space-y-3"
          >
            {loadingTxns ? (
              <div className="space-y-3">
                {[0, 1, 2].map(i => (
                  <div key={i} className="h-24 bg-obsidian-400 border border-obsidian-500
                                          rounded-xl animate-pulse" />
                ))}
              </div>
            ) : activeTxns.length === 0 ? (
              <EmptyState
                icon={Shield}
                title="No active escrow"
                sub="Your transactions will appear here once a buyer locks funds."
              />
            ) : (
              <AnimatePresence>
                {activeTxns.map(tx => (
                  <TransactionCard
                    key={tx.id}
                    tx={tx}
                    userId={user?.id}
                    onInvalidate={invalidate}
                  />
                ))}
              </AnimatePresence>
            )}
          </motion.div>
        )}

        {/* ── Inventory tab ───────────────────────────────────────────────── */}
        {tab === 'inventory' && (
          <motion.div
            key="inventory"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            {loadingInv ? (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="h-48 bg-obsidian-400 border border-obsidian-500
                                          rounded-xl animate-pulse" />
                ))}
              </div>
            ) : inventory.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No listings yet"
                sub="List your first item on the Marketplace."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {inventory.map(item => (
                  <InventoryCard key={item.id} listing={item} />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. SHARED SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, mono = false }) {
  return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-3">
      <p className="text-[9px] font-bold uppercase tracking-widest text-white/30 mb-1">{label}</p>
      <p className={`font-black text-lg leading-none mb-0.5 text-${color} ${mono ? 'font-mono' : ''}`}>
        {value}
      </p>
      <p className="text-[9px] text-white/25">{sub}</p>
    </div>
  )
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon size={36} className="text-white/10 mb-4" />
      <p className="font-bold text-white/40 text-sm">{title}</p>
      <p className="text-xs text-white/20 mt-1 max-w-xs">{sub}</p>
    </div>
  )
}
