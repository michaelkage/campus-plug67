/**
 * Campus Plug — useEscrow Hook
 *
 * The single interface for all PlugPay v2 escrow interactions.
 * Handles the complete state machine:
 *
 *   pending → locked → meetup_initiated → release_requested → released
 *                                                           ↘ disputed
 *
 * Features:
 * - Real-time transaction status updates via Supabase Realtime
 * - Live countdown timer for auto-release window (ticks every 10s)
 * - All Edge Function calls abstracted into named action methods
 * - Toast notifications on every state transition
 * - Optimistic UI updates + server sync
 * - Zero page-level knowledge of Edge Function URLs
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { supabase, callEdgeFunction, formatNaira } from '@/lib/supabase'
import { useTransactionStatus } from './useRealtime'

// ── Status metadata ────────────────────────────────────────────────────────────
export const TX_STATUS = {
  PENDING:           'pending',
  LOCKED:            'locked',
  MEETUP_INITIATED:  'meetup_initiated',
  RELEASE_REQUESTED: 'release_requested',
  RELEASED:          'released',
  DISPUTED:          'disputed',
  CANCELLED:         'cancelled',
}

export const TX_STATUS_META = {
  pending:           { label: 'Awaiting Payment',        icon: '⏳', color: 'amber', step: 0 },
  locked:            { label: 'Funds Locked in Escrow',  icon: '🔐', color: 'cyan',  step: 1 },
  meetup_initiated:  { label: 'Meetup Confirmed',        icon: '📍', color: 'cyan',  step: 2 },
  release_requested: { label: 'Release Requested',       icon: '⏰', color: 'amber', step: 3 },
  released:          { label: 'Exchange Complete',       icon: '✅', color: 'green', step: 4 },
  disputed:          { label: 'Under Dispute Review',    icon: '🚨', color: 'red',   step: -1 },
  cancelled:         { label: 'Transaction Cancelled',   icon: '❌', color: 'red',   step: -1 },
}

// Step labels for progress bar
export const TX_STEPS = [
  { key: 'pending',           label: 'Pay'     },
  { key: 'locked',            label: 'Locked'  },
  { key: 'meetup_initiated',  label: 'Meetup'  },
  { key: 'release_requested', label: 'Release' },
  { key: 'released',          label: 'Done'    },
]

// Toast messages per transition
const TRANSITION_TOASTS = {
  locked:            { msg: '🔐 Payment confirmed! Funds locked in escrow.',    type: 'success' },
  meetup_initiated:  { msg: '📍 Meetup initiated. QR code is now active.',      type: 'success' },
  release_requested: { msg: '⏰ Release requested. Buyer has 48h to respond.',  type: 'blank'   },
  released:          { msg: '🎉 Exchange complete! Funds have been released.',   type: 'success' },
  disputed:          { msg: '🚨 Dispute filed. Under review within 24 hours.',  type: 'blank'   },
  cancelled:         { msg: '❌ Transaction cancelled.',                         type: 'error'   },
}

/**
 * useEscrow — manages the full lifecycle of a single PlugPay transaction.
 *
 * @param {object} opts
 * @param {string}   opts.transactionId  - UUID of the transaction row
 * @param {object}   opts.session        - Supabase session object (from useAuth)
 * @param {boolean}  opts.isSeller       - Whether the current user is the seller
 * @param {Function} [opts.onRelease]    - Callback when status becomes 'released'
 * @param {Function} [opts.onDispute]    - Callback when status becomes 'disputed'
 * @param {Function} [opts.onStatusChange] - Generic status change callback
 */
export function useEscrow({
  transactionId,
  session,
  isSeller = false,
  onRelease,
  onDispute,
  onStatusChange,
}) {
  const [tx,         setTx]         = useState(null)
  const [loading,    setLoading]    = useState(null)   // current action name | null
  const [error,      setError]      = useState(null)   // last error string | null
  const [countdown,  setCountdown]  = useState(null)   // ms until auto-release

  const prevStatusRef = useRef(null)
  const countdownRef  = useRef(null)

  // ── Load initial transaction ───────────────────────────────────────────────
  useEffect(() => {
    if (!transactionId) return
    supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single()
      .then(({ data, error }) => {
        if (error) console.warn('[useEscrow] Load error:', error.message)
        else if (data) {
          setTx(data)
          prevStatusRef.current = data.status
        }
      })
  }, [transactionId])

  // ── Real-time subscription ─────────────────────────────────────────────────
  useTransactionStatus(transactionId, (updated) => {
    const prev = prevStatusRef.current
    prevStatusRef.current = updated.status

    setTx(updated)

    // Toast on status change
    if (prev !== updated.status && TRANSITION_TOASTS[updated.status]) {
      const { msg, type } = TRANSITION_TOASTS[updated.status]
      if (type === 'success') toast.success(msg)
      else if (type === 'error') toast.error(msg)
      else toast(msg)
    }

    onStatusChange?.(updated, prev)
    if (updated.status === 'released') onRelease?.(updated)
    if (updated.status === 'disputed') onDispute?.(updated)
  })

  // ── Countdown ticker for auto-release window ───────────────────────────────
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)

    if (!tx?.auto_release_at) {
      setCountdown(null)
      return
    }

    const tick = () => {
      const ms = Math.max(0, new Date(tx.auto_release_at).getTime() - Date.now())
      setCountdown(ms)
      if (ms === 0) clearInterval(countdownRef.current)
    }

    tick()
    countdownRef.current = setInterval(tick, 10_000)
    return () => clearInterval(countdownRef.current)
  }, [tx?.auto_release_at])

  // ── Core Edge Function caller ──────────────────────────────────────────────
  const edgeCall = useCallback(async (action, extra = {}) => {
    if (!session?.access_token) {
      setError('Not authenticated')
      toast.error('Please sign in to continue')
      return { success: false, error: 'Not authenticated' }
    }

    setLoading(action)
    setError(null)

    const { data, error: callError } = await callEdgeFunction(
      'release-escrow',
      { action, transaction_id: transactionId, ...extra },
      session.access_token
    )

    setLoading(null)

    if (callError) {
      setError(callError)
      toast.error(callError)
      return { success: false, error: callError }
    }

    // Refresh tx state from DB (real-time may beat this, that's fine)
    supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single()
      .then(({ data: fresh }) => fresh && setTx(fresh))

    return { success: true, data }
  }, [transactionId, session])

  // ── State machine actions ──────────────────────────────────────────────────

  /**
   * BUYER: Release funds immediately by providing the seller's QR secret.
   * Triggers: meetup_initiated → released
   */
  const release = useCallback((qrSecret) => {
    if (!qrSecret?.trim()) {
      toast.error('Please enter the QR code from the seller')
      return Promise.resolve({ success: false })
    }
    return edgeCall('release', { qr_secret: qrSecret.trim() })
  }, [edgeCall])

  /**
   * SELLER or BUYER: Confirm the physical meetup has started.
   * Triggers: locked → meetup_initiated
   * Starts the 24-hour QR scan window.
   */
  const initiateMeetup = useCallback((meetupSpot = null) => {
    return edgeCall('initiate_meetup', {
      ...(meetupSpot ? { meetup_spot: meetupSpot } : {}),
    })
  }, [edgeCall])

  /**
   * SELLER: Request fund release after 24h timeout.
   * Triggers: meetup_initiated → release_requested
   * Starts the 48-hour auto-release countdown.
   * Edge Function enforces the time gate — cannot be called too early.
   */
  const requestRelease = useCallback(() => {
    if (!isSeller) {
      toast.error('Only the seller can request release')
      return Promise.resolve({ success: false })
    }
    return edgeCall('request_release')
  }, [edgeCall, isSeller])

  /**
   * BUYER: File a formal dispute within the 48h window.
   * Triggers: release_requested → disputed
   * Cancels the pending auto-release job.
   * Requires a reason string of at least 20 characters.
   */
  const dispute = useCallback((reason) => {
    if (!reason || reason.trim().length < 20) {
      toast.error('Please provide a detailed reason (minimum 20 characters)')
      return Promise.resolve({ success: false })
    }
    if (isSeller) {
      toast.error('Only the buyer can file a dispute')
      return Promise.resolve({ success: false })
    }
    return edgeCall('dispute', { reason: reason.trim() })
  }, [edgeCall, isSeller])

  // ── Derived state ──────────────────────────────────────────────────────────

  const status    = tx?.status ?? 'pending'
  const meta      = TX_STATUS_META[status] ?? TX_STATUS_META.pending
  const stepIndex = TX_STEPS.findIndex(s => s.key === status)

  // Which actions are available for the current user + status
  const canInitiateMeetup  = isSeller  && status === 'locked'
  const canShowQR          = isSeller  && status === 'meetup_initiated'
  const canRelease         = !isSeller && status === 'meetup_initiated'
  const canRequestRelease  = isSeller  && status === 'meetup_initiated'
  const canDispute         = !isSeller && status === 'release_requested'
  const isTerminal         = status === 'released' || status === 'cancelled'
  const isDisputed         = status === 'disputed'

  // Auto-release countdown
  const autoReleaseMs      = countdown ?? null
  const autoReleaseHours   = autoReleaseMs != null ? Math.floor(autoReleaseMs / 3_600_000) : null
  const autoReleaseMins    = autoReleaseMs != null ? Math.floor((autoReleaseMs % 3_600_000) / 60_000) : null
  const autoReleaseExpired = tx?.auto_release_at ? new Date(tx.auto_release_at) < new Date() : false

  return {
    // ── State ─────────────────────────────────────────────────────────────
    tx,
    status,
    meta,
    loading,
    error,

    // ── Progress bar data ──────────────────────────────────────────────────
    steps:     TX_STEPS,
    stepIndex,

    // ── Countdown ─────────────────────────────────────────────────────────
    countdown: {
      ms:      autoReleaseMs,
      hours:   autoReleaseHours,
      mins:    autoReleaseMins,
      expired: autoReleaseExpired,
      label:   autoReleaseHours != null
                 ? `${autoReleaseHours}h ${autoReleaseMins}m`
                 : null,
    },

    // ── Availability flags ─────────────────────────────────────────────────
    can: {
      initiateMeetup: canInitiateMeetup,
      showQR:         canShowQR,
      release:        canRelease,
      requestRelease: canRequestRelease,
      dispute:        canDispute,
    },
    isTerminal,
    isDisputed,
    isSeller,

    // ── Actions ────────────────────────────────────────────────────────────
    actions: {
      release,
      initiateMeetup,
      requestRelease,
      dispute,
    },

    // ── Loading helpers ────────────────────────────────────────────────────
    isLoading:       (action) => loading === action,
    isAnyLoading:    loading !== null,
  }
}
