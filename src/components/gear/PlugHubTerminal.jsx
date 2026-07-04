/**
 * Campus Plug v6.8.0 — PlugHub Terminal
 * Component 3 of Phase 1: Asynchronous P2P Custody Hub
 *
 * Architecture:
 *   Dual-token cryptographic handshake:
 *     • Seller presents DropToken  → transaction status: custody_held
 *     • Buyer  presents PickToken  → transaction status: completed | release_requested
 *
 *   Hardware state machine (7 visual states):
 *     IDLE → AWAITING_DROP → SCANNING → VAULT_OPEN →
 *     CUSTODY_HELD → AWAITING_PICK → COMPLETED
 *     Any invalid token path → TAMPER_LOCKOUT (60 s)
 *
 *   Tamper detection:
 *     3 consecutive failed attempts → log to terminal_alerts →
 *     lock interface for exactly 60 seconds
 *
 *   All imports: extensionless / @/ alias — no .js / .ts extensions
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams }              from 'react-router-dom'
import { useQuery, useMutation, useQueryClient }     from '@tanstack/react-query'
import { motion, AnimatePresence, useSpring,
         useTransform }                              from 'framer-motion'
import { supabase, formatNaira }                     from '@/lib/supabase'
import { useAuth }                                   from '@/contexts/AuthContext'
import { useRealtimeTable }                          from '@/hooks/useRealtime'
import toast                                         from 'react-hot-toast'
import { QRCodeSVG }                                 from 'qrcode.react'
import {
  Lock, Unlock, Shield, CheckCircle2, AlertTriangle,
  AlertOctagon, Timer, ArrowRight, RefreshCw,
  Package, Scan, Eye, EyeOff, Fingerprint,
  ChevronLeft, FileWarning,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS   = 3
const LOCKOUT_SECS   = 60
const TOKEN_MIN_LEN  = 6

/** Hardware visual states */
const HW = {
  IDLE:            'IDLE',
  AWAITING_DROP:   'AWAITING_DROP',
  SCANNING:        'SCANNING',
  VAULT_OPEN:      'VAULT_OPEN',
  CUSTODY_HELD:    'CUSTODY_HELD',
  AWAITING_PICK:   'AWAITING_PICK',
  COMPLETED:       'COMPLETED',
  TAMPER_LOCKOUT:  'TAMPER_LOCKOUT',
}

const HW_META = {
  IDLE:           { label: 'TERMINAL READY',        color: 'cyan',       pulse: false },
  AWAITING_DROP:  { label: 'AWAITING DROP-OFF',      color: 'plug-amber', pulse: true  },
  SCANNING:       { label: 'SCANNING TOKEN',         color: 'cyan',       pulse: true  },
  VAULT_OPEN:     { label: 'VAULT OPEN — ACT NOW',   color: 'plug-green', pulse: true  },
  CUSTODY_HELD:   { label: 'ITEM IN CUSTODY',        color: 'cyan',       pulse: false },
  AWAITING_PICK:  { label: 'AWAITING COLLECTION',    color: 'plug-amber', pulse: true  },
  COMPLETED:      { label: 'HANDOVER COMPLETE',      color: 'plug-green', pulse: false },
  TAMPER_LOCKOUT: { label: 'TERMINAL LOCKED',        color: 'plug-red',   pulse: true  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DATA LAYER
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTransaction(txId) {
  const { data, error } = await supabase
    .from('transactions')
    .select(`
      *,
      listing:listings(id, title, images, price, category, condition),
      buyer:profiles!transactions_buyer_id_fkey(id, full_name, username, avatar_url),
      seller:profiles!transactions_seller_id_fkey(id, full_name, username, avatar_url)
    `)
    .eq('id', txId)
    .single()

  if (error) throw error
  return data
}

/** Validate a DropToken or PickToken — returns { valid, token_type, token_id } */
async function validateToken(txId, tokenValue, expectedType) {
  const { data, error } = await supabase.rpc('validate_custody_token', {
    p_transaction_id: txId,
    p_token:          tokenValue.trim().toUpperCase(),
    p_token_type:     expectedType,   // 'drop' | 'pick'
  })

  if (error) return { valid: false, reason: error.message }
  return data ?? { valid: false, reason: 'No response from validator' }
}

/** Log a tamper/security event to terminal_alerts */
async function logTamperAlert({ txId, userId, attemptCount, tokenType, terminalId }) {
  try {
    await supabase.from('terminal_alerts').insert({
      transaction_id: txId,
      user_id:        userId ?? null,
      alert_type:     'repeated_invalid_token',
      token_type:     tokenType,
      attempt_count:  attemptCount,
      terminal_id:    terminalId ?? null,
      severity:       'high',
    })
  } catch {
    // Non-fatal — tamper log must never block the UI
  }
}

/** Upgrade transaction to custody_held after successful drop */
async function confirmDropOff(txId, tokenId) {
  const { data, error } = await supabase
    .from('transactions')
    .update({
      status:            'locked',       // triggers reconcile_student_escrow on completed
      escrow_status:     'held',
      custody_stage:     'custody_held',
      drop_token_id:     tokenId,
      drop_confirmed_at: new Date().toISOString(),
    })
    .eq('id', txId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Upgrade transaction to completed/release_requested after successful pick-up */
async function confirmPickUp(txId, tokenId, category) {
  // Physical items release immediately; rental categories go to release_requested
  const rentalCategories = ['Hostels', 'Lab Equipment']
  const nextStatus = rentalCategories.includes(category)
    ? 'release_requested'
    : 'completed'

  const { data, error } = await supabase
    .from('transactions')
    .update({
      status:            nextStatus,
      custody_stage:     'handoff_complete',
      pick_token_id:     tokenId,
      pick_confirmed_at: new Date().toISOString(),
      ...(nextStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq('id', txId)
    .select()
    .single()

  if (error) throw error
  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. VAULT DOOR ANIMATION
// ─────────────────────────────────────────────────────────────────────────────

function VaultDoor({ hwState }) {
  const isOpen = hwState === HW.VAULT_OPEN
  const meta   = HW_META[hwState] ?? HW_META.IDLE

  // Spring physics for vault rotation (simulates a heavy door)
  const springRot = useSpring(isOpen ? -75 : 0, { stiffness: 60, damping: 16 })
  useEffect(() => { springRot.set(isOpen ? -75 : 0) }, [isOpen, springRot])

  const colorMap = {
    'plug-green': '#00ff88',
    'cyan':       '#00f2ff',
    'plug-amber': '#f59e0b',
    'plug-red':   '#ef4444',
  }
  const glow = colorMap[meta.color] ?? '#00f2ff'

  return (
    <div className="relative flex items-center justify-center my-4 select-none">
      {/* Outer ring */}
      <motion.div
        animate={{
          boxShadow: meta.pulse
            ? [`0 0 0 0 ${glow}44`, `0 0 32px 8px ${glow}33`, `0 0 0 0 ${glow}44`]
            : `0 0 20px 2px ${glow}22`,
        }}
        transition={{ duration: 2, repeat: meta.pulse ? Infinity : 0 }}
        className="w-36 h-36 rounded-full border-4 flex items-center justify-center"
        style={{ borderColor: glow }}
      >
        {/* Vault door panel */}
        <motion.div
          style={{ rotateY: springRot }}
          className="w-28 h-28 rounded-full flex items-center justify-center"
          style={{ background: `radial-gradient(circle, #1a1a2e 60%, ${glow}22 100%)` }}
        >
          <motion.div
            animate={{ rotate: isOpen ? 360 : 0 }}
            transition={{ duration: 0.8, ease: 'easeInOut' }}
          >
            {hwState === HW.COMPLETED ? (
              <CheckCircle2 size={40} style={{ color: glow }} />
            ) : hwState === HW.TAMPER_LOCKOUT ? (
              <AlertOctagon size={40} style={{ color: glow }} />
            ) : hwState === HW.SCANNING ? (
              <Scan size={40} style={{ color: glow }} />
            ) : (
              <Lock size={40} style={{ color: glow }} />
            )}
          </motion.div>
        </motion.div>
      </motion.div>

      {/* State label below */}
      <div
        className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap
                   text-[10px] font-bold tracking-widest uppercase"
        style={{ color: glow }}
      >
        {meta.label}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SCAN LINE ANIMATION (active during SCANNING state)
// ─────────────────────────────────────────────────────────────────────────────

function ScanBeam() {
  return (
    <motion.div
      className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan to-transparent"
      initial={{ top: '0%' }}
      animate={{ top: ['0%', '100%', '0%'] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. TOKEN INPUT FIELD
// ─────────────────────────────────────────────────────────────────────────────

function TokenInput({ label, value, onChange, onSubmit, loading, masked, onToggleMask, disabled }) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] font-bold uppercase tracking-widest text-white/40">
        {label}
      </label>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <input
            className="input w-full font-mono tracking-[0.25em] uppercase pr-10
                       disabled:opacity-40 disabled:cursor-not-allowed"
            type={masked ? 'password' : 'text'}
            value={value}
            onChange={e => onChange(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && !disabled && value.length >= TOKEN_MIN_LEN && onSubmit()}
            placeholder="● ● ● ● ● ●"
            maxLength={16}
            disabled={disabled || loading}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onToggleMask}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white"
            tabIndex={-1}
          >
            {masked ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </div>
        <motion.button
          whileTap={{ scale: 0.95 }}
          type="button"
          onClick={onSubmit}
          disabled={disabled || loading || value.length < TOKEN_MIN_LEN}
          className="px-4 py-2 bg-cyan text-obsidian rounded-xl font-bold text-sm
                     disabled:opacity-30 disabled:cursor-not-allowed
                     hover:bg-cyan/90 transition-colors flex-shrink-0"
        >
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Fingerprint size={14} />}
        </motion.button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LOCKOUT COUNTDOWN TIMER
// ─────────────────────────────────────────────────────────────────────────────

function LockoutTimer({ seconds, onExpire }) {
  const [remaining, setRemaining] = useState(seconds)
  const ref = useRef(null)

  useEffect(() => {
    setRemaining(seconds)
    ref.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(ref.current); onExpire(); return 0 }
        return r - 1
      })
    }, 1_000)
    return () => clearInterval(ref.current)
  }, [seconds])

  const pct = (remaining / seconds) * 100

  return (
    <div className="space-y-2 text-center">
      <p className="font-mono font-black text-plug-red text-4xl">{remaining}s</p>
      <div className="h-1.5 bg-obsidian-300 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-plug-red rounded-full"
          initial={{ width: '100%' }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: 'linear' }}
        />
      </div>
      <p className="text-xs text-plug-red/70">Terminal resumes automatically</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. STEP INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'drop',    label: 'DROP-OFF' },
  { id: 'custody', label: 'IN CUSTODY' },
  { id: 'pick',    label: 'COLLECTION' },
  { id: 'done',    label: 'COMPLETE' },
]

function StepIndicator({ activeStep }) {
  const idx = STEPS.findIndex(s => s.id === activeStep)
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center flex-1">
          <div className="flex flex-col items-center gap-1 flex-shrink-0">
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-bold transition-all
              ${i < idx  ? 'border-plug-green bg-plug-green text-obsidian' :
                i === idx ? 'border-cyan bg-cyan/20 text-cyan' :
                            'border-white/15 text-white/20'}`}>
              {i < idx ? '✓' : i + 1}
            </div>
            <span className={`text-[8px] font-bold uppercase tracking-wider whitespace-nowrap
              ${i === idx ? 'text-cyan' : i < idx ? 'text-plug-green' : 'text-white/20'}`}>
              {step.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`flex-1 h-px mx-1 ${i < idx ? 'bg-plug-green' : 'bg-white/10'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. MAIN TERMINAL COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Props:
 *   transactionId  — UUID of the transaction (can also be read from ?tx= search param)
 *   onClose        — optional dismiss callback
 */
export default function PlugHubTerminal({ transactionId: propTxId, onClose }) {
  const { user }        = useAuth()
  const navigate        = useNavigate()
  const [params]        = useSearchParams()
  const qc              = useQueryClient()

  const txId = propTxId ?? params.get('tx') ?? ''

  // ── Hardware state ─────────────────────────────────────────────────────────
  const [hwState, setHwState] = useState(HW.IDLE)

  // ── Token inputs ───────────────────────────────────────────────────────────
  const [dropToken, setDropToken] = useState('')
  const [pickToken, setPickToken] = useState('')
  const [maskDrop,  setMaskDrop]  = useState(true)
  const [maskPick,  setMaskPick]  = useState(true)

  // ── Tamper detection ───────────────────────────────────────────────────────
  const [failCount,  setFailCount]  = useState(0)     // consecutive failures
  const [lockedUntil, setLockedUntil] = useState(null) // Date | null
  const [activeTokenType, setActiveTokenType] = useState(null) // 'drop' | 'pick'

  // ── Dispute ────────────────────────────────────────────────────────────────
  const [showDispute, setShowDispute] = useState(false)
  const [dispReason,  setDispReason]  = useState('')

  // ── Load transaction ───────────────────────────────────────────────────────
  const {
    data:      tx,
    isLoading: loadingTx,
    error:     txError,
  } = useQuery({
    queryKey: ['plughub-tx', txId],
    queryFn:  () => fetchTransaction(txId),
    enabled:  !!txId,
    staleTime: 10_000,
  })

  // ── Realtime: sync state when DB changes ───────────────────────────────────
  useRealtimeTable({
    table:    'transactions',
    filter:   { column: 'id', value: txId },
    onUpdate: (updated) => {
      qc.setQueryData(['plughub-tx', txId], old => ({ ...old, ...updated }))
      syncHwState(updated.status, updated.custody_stage)
    },
    enabled: !!txId,
  })

  // ── Derive hardware state from DB status ───────────────────────────────────
  const syncHwState = useCallback((status, custodyStage) => {
    if (custodyStage === 'handoff_complete' || status === 'completed') {
      setHwState(HW.COMPLETED); return
    }
    if (custodyStage === 'custody_held') {
      setHwState(HW.CUSTODY_HELD); return
    }
    if (status === 'locked' || status === 'pending') {
      setHwState(HW.AWAITING_DROP); return
    }
  }, [])

  useEffect(() => {
    if (tx) syncHwState(tx.status, tx.custody_stage)
  }, [tx, syncHwState])

  // ── Derived values ─────────────────────────────────────────────────────────
  const isLocked    = !!lockedUntil && lockedUntil > new Date()
  const isSeller    = tx?.seller_id === user?.id
  const isBuyer     = tx?.buyer_id  === user?.id
  const category    = tx?.listing?.category ?? ''

  const activeStep =
    hwState === HW.COMPLETED   ? 'done' :
    hwState === HW.AWAITING_PICK ||
    hwState === HW.CUSTODY_HELD ? 'custody' :
    hwState === HW.VAULT_OPEN  ? 'drop' : 'drop'

  // ── Failure handler ────────────────────────────────────────────────────────
  const handleFailedAttempt = useCallback(async (tokenType) => {
    const next = failCount + 1
    setFailCount(next)

    if (next >= MAX_ATTEMPTS) {
      // Lock the terminal
      const until = new Date(Date.now() + LOCKOUT_SECS * 1_000)
      setLockedUntil(until)
      setHwState(HW.TAMPER_LOCKOUT)

      await logTamperAlert({
        txId,
        userId:       user?.id,
        attemptCount: next,
        tokenType,
        terminalId:   `term-${window.navigator.userAgent.slice(0, 16)}`,
      })

      toast.error(`🚨 Terminal locked for ${LOCKOUT_SECS} seconds after ${MAX_ATTEMPTS} failed attempts.`)
    } else {
      toast.error(`Invalid token. ${MAX_ATTEMPTS - next} attempt${MAX_ATTEMPTS - next !== 1 ? 's' : ''} remaining.`)
    }
  }, [failCount, txId, user?.id])

  const handleLockoutExpire = useCallback(() => {
    setLockedUntil(null)
    setFailCount(0)
    syncHwState(tx?.status, tx?.custody_stage)
  }, [tx, syncHwState])

  // ── DROP TOKEN MUTATION ────────────────────────────────────────────────────
  const dropMutation = useMutation({
    mutationFn: async () => {
      setHwState(HW.SCANNING)
      setActiveTokenType('drop')

      const result = await validateToken(txId, dropToken, 'drop')
      if (!result.valid) {
        setHwState(HW.AWAITING_DROP)
        await handleFailedAttempt('drop')
        throw new Error(result.reason ?? 'Invalid DropToken')
      }

      // Token valid — open vault briefly then commit
      setHwState(HW.VAULT_OPEN)
      await new Promise(r => setTimeout(r, 1_800)) // vault open for 1.8s

      return confirmDropOff(txId, result.token_id)
    },
    onSuccess: () => {
      setDropToken('')
      setFailCount(0)
      setHwState(HW.CUSTODY_HELD)
      qc.invalidateQueries({ queryKey: ['plughub-tx', txId] })
      toast.success('📦 Item secured in PlugHub custody.')
    },
    onError: (err) => {
      if (!isLocked) toast.error(err.message)
    },
  })

  // ── PICK TOKEN MUTATION ────────────────────────────────────────────────────
  const pickMutation = useMutation({
    mutationFn: async () => {
      setHwState(HW.SCANNING)
      setActiveTokenType('pick')

      const result = await validateToken(txId, pickToken, 'pick')
      if (!result.valid) {
        setHwState(HW.CUSTODY_HELD)
        await handleFailedAttempt('pick')
        throw new Error(result.reason ?? 'Invalid PickToken')
      }

      setHwState(HW.VAULT_OPEN)
      await new Promise(r => setTimeout(r, 1_800))

      return confirmPickUp(txId, result.token_id, category)
    },
    onSuccess: () => {
      setPickToken('')
      setFailCount(0)
      setHwState(HW.COMPLETED)
      qc.invalidateQueries({ queryKey: ['plughub-tx', txId] })
      toast.success('✅ Item collected. Handover complete!')
    },
    onError: (err) => {
      if (!isLocked) toast.error(err.message)
    },
  })

  // ── DISPUTE MUTATION ───────────────────────────────────────────────────────
  const disputeMutation = useMutation({
    mutationFn: async () => {
      if (dispReason.trim().length < 20) throw new Error('Reason must be at least 20 characters')
      const { error } = await supabase
        .from('transactions')
        .update({
          status:              'disputed',
          dispute_reason:      dispReason.trim(),
          disputed_at:         new Date().toISOString(),
        })
        .eq('id', txId)
      if (error) throw error
    },
    onSuccess: () => {
      setShowDispute(false)
      qc.invalidateQueries({ queryKey: ['plughub-tx', txId] })
      navigate(`/war-room?tx=${txId}`)
    },
  })

  // ── Loading / error screens ────────────────────────────────────────────────
  if (!txId) {
    return (
      <TerminalShell>
        <EmptyTerminal icon={Package} msg="No transaction ID provided." />
      </TerminalShell>
    )
  }

  if (loadingTx) {
    return (
      <TerminalShell>
        <div className="flex flex-col items-center gap-4 py-16">
          <div className="w-10 h-10 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-white/40 font-mono">CONNECTING TO TERMINAL…</p>
        </div>
      </TerminalShell>
    )
  }

  if (txError || !tx) {
    return (
      <TerminalShell>
        <EmptyTerminal icon={AlertTriangle} msg="Transaction not found or access denied." />
      </TerminalShell>
    )
  }

  const isProcessing = dropMutation.isPending || pickMutation.isPending

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <TerminalShell onBack={onClose ?? (() => navigate(-1))}>

      {/* ── Terminal ID banner ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="section-label">PLUGHUB TERMINAL</p>
          <h1 className="text-xl font-black tracking-tight">
            Custody Handover
          </h1>
        </div>
        <div className="text-right">
          <p className="text-[9px] font-mono text-white/30">TX REF</p>
          <p className="font-mono font-bold text-xs text-cyan">
            {txId.slice(0, 8).toUpperCase()}
          </p>
        </div>
      </div>

      {/* ── Step indicator ───────────────────────────────────────────────── */}
      <StepIndicator activeStep={activeStep} />

      {/* ── Vault door ───────────────────────────────────────────────────── */}
      <div className="relative flex justify-center py-10">
        <VaultDoor hwState={hwState} />
        {hwState === HW.SCANNING && (
          <div className="absolute inset-x-0 inset-y-4 overflow-hidden pointer-events-none">
            <ScanBeam />
          </div>
        )}
      </div>

      {/* ── Item card ────────────────────────────────────────────────────── */}
      <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-lg overflow-hidden bg-obsidian-300 flex-shrink-0">
          {tx.listing?.images?.[0]
            ? <img src={tx.listing.images[0]} alt={tx.listing.title}
                   className="w-full h-full object-cover" />
            : <Package size={20} className="m-auto mt-3 text-white/20" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-white line-clamp-1">{tx.listing?.title}</p>
          <p className="text-xs text-white/40">{tx.listing?.category} · {tx.listing?.condition}</p>
        </div>
        <span className="font-mono font-black text-cyan text-sm flex-shrink-0">
          {formatNaira(tx.amount)}
        </span>
      </div>

      {/* ── Tamper lockout screen ─────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {hwState === HW.TAMPER_LOCKOUT && (
          <motion.div
            key="lockout"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-plug-red/8 border border-plug-red/30 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center gap-3 text-plug-red">
              <AlertOctagon size={20} />
              <div>
                <p className="font-bold text-sm">SECURITY LOCKOUT</p>
                <p className="text-xs opacity-70">
                  {MAX_ATTEMPTS} consecutive failures detected. Alert dispatched.
                </p>
              </div>
            </div>
            <LockoutTimer seconds={LOCKOUT_SECS} onExpire={handleLockoutExpire} />
          </motion.div>
        )}

        {/* ── AWAITING_DROP: seller enters DropToken ────────────────────── */}
        {hwState === HW.AWAITING_DROP && isSeller && !isLocked && (
          <motion.div
            key="drop-form"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
            <InfoBanner
              color="amber"
              icon={Lock}
              title="SELLER: ENTER DROP TOKEN"
              body="Enter your DropToken to open the vault and place the item inside."
            />
            <TokenInput
              label="Drop Token"
              value={dropToken}
              onChange={setDropToken}
              onSubmit={() => dropMutation.mutate()}
              loading={dropMutation.isPending}
              masked={maskDrop}
              onToggleMask={() => setMaskDrop(v => !v)}
              disabled={isLocked || isProcessing}
            />
            {failCount > 0 && (
              <FailurePips current={failCount} max={MAX_ATTEMPTS} />
            )}
          </motion.div>
        )}

        {/* ── AWAITING_DROP: buyer is waiting ───────────────────────────── */}
        {hwState === HW.AWAITING_DROP && !isSeller && (
          <motion.div key="buyer-wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <InfoBanner
              color="amber"
              icon={Timer}
              title="WAITING FOR SELLER"
              body="The seller has not yet dropped off the item. You'll be notified when it's ready for collection."
            />
          </motion.div>
        )}

        {/* ── CUSTODY_HELD: buyer enters PickToken ──────────────────────── */}
        {hwState === HW.CUSTODY_HELD && isBuyer && !isLocked && (
          <motion.div
            key="pick-form"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
            <InfoBanner
              color="cyan"
              icon={Unlock}
              title="BUYER: ENTER PICK TOKEN"
              body="Item is secured inside. Enter your PickToken to open the vault and collect."
            />
            <TokenInput
              label="Pick Token"
              value={pickToken}
              onChange={setPickToken}
              onSubmit={() => pickMutation.mutate()}
              loading={pickMutation.isPending}
              masked={maskPick}
              onToggleMask={() => setMaskPick(v => !v)}
              disabled={isLocked || isProcessing}
            />
            {failCount > 0 && (
              <FailurePips current={failCount} max={MAX_ATTEMPTS} />
            )}
          </motion.div>
        )}

        {/* ── CUSTODY_HELD: seller waiting for buyer ─────────────────────── */}
        {hwState === HW.CUSTODY_HELD && !isBuyer && (
          <motion.div key="seller-wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <InfoBanner
              color="cyan"
              icon={Package}
              title="ITEM IN CUSTODY"
              body="Your item is secured. The buyer will collect using their PickToken. Funds release upon successful pickup."
            />
          </motion.div>
        )}

        {/* ── VAULT_OPEN ────────────────────────────────────────────────── */}
        {hwState === HW.VAULT_OPEN && (
          <motion.div
            key="vault-open"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-4"
          >
            <motion.p
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 0.5, repeat: Infinity }}
              className="text-plug-green font-black text-lg tracking-widest"
            >
              ⚡ VAULT OPEN — PROCEED NOW
            </motion.p>
            <p className="text-xs text-white/40 mt-1">
              Token verified. Vault will auto-lock in 1.8 seconds.
            </p>
          </motion.div>
        )}

        {/* ── COMPLETED ─────────────────────────────────────────────────── */}
        {hwState === HW.COMPLETED && (
          <motion.div
            key="completed"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-plug-green/8 border border-plug-green/25 rounded-xl p-6 text-center space-y-3"
          >
            <CheckCircle2 size={36} className="text-plug-green mx-auto" />
            <p className="font-bold text-plug-green">HANDOVER COMPLETE</p>
            <p className="text-xs text-white/50">
              The item has been collected and the transaction is{' '}
              {tx.status === 'release_requested' ? 'pending release approval' : 'fully closed'}.
            </p>
            <button
              onClick={() => navigate('/marketplace')}
              className="btn-primary text-sm mx-auto"
            >
              Back to Marketplace
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── QR codes (DropToken / PickToken display) ─────────────────────── */}
      {isSeller && hwState === HW.AWAITING_DROP && tx.drop_token_display && (
        <QRDisplay
          label="YOUR DROP TOKEN QR"
          value={tx.drop_token_display}
          note="Show this to the terminal scanner or type the code manually."
        />
      )}
      {isBuyer && hwState === HW.CUSTODY_HELD && tx.pick_token_display && (
        <QRDisplay
          label="YOUR PICK TOKEN QR"
          value={tx.pick_token_display}
          note="Show this to the terminal scanner or type the code manually."
        />
      )}

      {/* ── Dispute link ─────────────────────────────────────────────────── */}
      {!['COMPLETED', 'TAMPER_LOCKOUT'].includes(hwState) &&
       tx.status !== 'disputed' && (
        <button
          onClick={() => setShowDispute(true)}
          className="w-full mt-4 flex items-center justify-center gap-2
                     text-xs text-plug-red/60 hover:text-plug-red transition-colors"
        >
          <FileWarning size={12} />
          Report an issue with this handover
        </button>
      )}

      {/* ── Dispute modal ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showDispute && (
          <motion.div
            key="dispute-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
            onClick={() => setShowDispute(false)}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="relative z-10 w-full max-w-sm bg-obsidian-400 border border-obsidian-500
                         rounded-2xl p-6 space-y-4"
            >
              <div className="flex items-center gap-2 text-plug-red">
                <AlertOctagon size={16} />
                <h3 className="font-bold text-sm">FILE A TERMINAL DISPUTE</h3>
              </div>
              <p className="text-xs text-white/40">
                This will lock the transaction and route it to the War Room for review.
              </p>
              <textarea
                className="input resize-none text-sm w-full"
                rows={4}
                placeholder="Describe exactly what happened (min 20 chars)…"
                value={dispReason}
                onChange={e => setDispReason(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowDispute(false)}
                  className="flex-1 py-2 bg-obsidian-300 text-white/60 rounded-xl text-sm font-bold
                             hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => disputeMutation.mutate()}
                  disabled={dispReason.trim().length < 20 || disputeMutation.isPending}
                  className="flex-1 py-2 bg-plug-red/20 border border-plug-red/30 text-plug-red
                             rounded-xl text-sm font-bold hover:bg-plug-red/30
                             disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {disputeMutation.isPending
                    ? <RefreshCw size={13} className="animate-spin mx-auto" />
                    : 'OPEN DISPUTE'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </TerminalShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SHARED SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function TerminalShell({ children, onBack }) {
  return (
    <div className="min-h-screen bg-obsidian">
      <div className="sticky top-0 z-10 bg-obsidian-400 border-b border-obsidian-500">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          {onBack && (
            <button onClick={onBack}
              className="text-white/30 hover:text-white transition-colors">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-cyan" />
            <span className="font-black text-sm tracking-tight">
              PLUG<span className="text-cyan">HUB</span> TERMINAL
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-plug-green animate-pulse" />
            <span className="text-[9px] font-bold text-plug-green uppercase tracking-widest">
              SECURE
            </span>
          </div>
        </div>
      </div>
      <div className="max-w-lg mx-auto px-4 py-6">
        {children}
      </div>
    </div>
  )
}

function InfoBanner({ color, icon: Icon, title, body }) {
  const colorMap = {
    amber: 'bg-plug-amber/8 border-plug-amber/25 text-plug-amber',
    cyan:  'bg-cyan/8 border-cyan/25 text-cyan',
    green: 'bg-plug-green/8 border-plug-green/25 text-plug-green',
    red:   'bg-plug-red/8 border-plug-red/25 text-plug-red',
  }
  return (
    <div className={`flex items-start gap-3 border rounded-xl p-4 ${colorMap[color]}`}>
      <Icon size={16} className="flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-bold text-xs tracking-widest uppercase">{title}</p>
        <p className="text-xs opacity-70 mt-0.5 leading-relaxed">{body}</p>
      </div>
    </div>
  )
}

function FailurePips({ current, max }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: max }).map((_, i) => (
        <motion.div
          key={i}
          animate={i < current ? { scale: [1, 1.3, 1] } : {}}
          className={`w-2 h-2 rounded-full ${
            i < current ? 'bg-plug-red' : 'bg-white/15'
          }`}
        />
      ))}
      <span className="text-[10px] text-plug-red/70 ml-1">
        {max - current} attempt{max - current !== 1 ? 's' : ''} left
      </span>
    </div>
  )
}

function QRDisplay({ label, value, note }) {
  const [show, setShow] = useState(false)
  return (
    <div className="mt-4 bg-obsidian-400 border border-obsidian-500 rounded-xl overflow-hidden">
      <button
        onClick={() => setShow(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">{label}</span>
        {show ? <EyeOff size={13} className="text-white/30" /> : <Eye size={13} className="text-white/30" />}
      </button>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 flex flex-col items-center gap-3">
              <div className="bg-white p-3 rounded-xl">
                <QRCodeSVG value={value} size={140} level="H" />
              </div>
              <p className="font-mono font-black text-cyan tracking-[0.2em] text-sm">{value}</p>
              {note && <p className="text-[10px] text-white/30 text-center">{note}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function EmptyTerminal({ icon: Icon, msg }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon size={32} className="text-white/15" />
      <p className="text-sm text-white/30">{msg}</p>
    </div>
  )
}
