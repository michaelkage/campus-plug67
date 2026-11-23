import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira, toKobo } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { AlertTriangle, CheckCircle, Clock, FileText, Play, Send, ShieldCheck, ShieldAlert, Wallet, XCircle } from 'lucide-react'

const statusLabel = {
  pending: 'Awaiting provider quote',
  quoted: 'Quote awaiting your decision',
  confirmed: 'Quote accepted, awaiting escrow funding',
  in_progress: 'Service in progress',
  delivered: 'Awaiting customer confirmation',
  disputed: 'Under platform review',
  completed: 'Completed and settled',
  cancelled: 'Cancelled',
}

export function ServiceBookingActions({ booking, currentUserId }) {
  const queryClient = useQueryClient()
  const isProvider = currentUserId === booking.seller_id
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [showDisputeForm, setShowDisputeForm] = useState(false)
  const [amount, setAmount] = useState(
    booking.amount ? (Number(booking.amount) / 100).toString() : '',
  )
  const [scope, setScope] = useState('')
  const [disputeReason, setDisputeReason] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: quoteData = { recent: [], accepted: null }, isLoading: quotesLoading } = useQuery({
    queryKey: ['service-booking-quotes', booking.id],
    queryFn: async () => {
      const columns = 'id, amount_kobo, scope, status, expires_at, accepted_at, created_at'
      const [recentResult, acceptedResult] = await Promise.all([
        supabase
          .from('service_booking_quotes')
          .select(columns)
          .eq('booking_id', booking.id)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('service_booking_quotes')
          .select(columns)
          .eq('booking_id', booking.id)
          .eq('status', 'accepted')
          .maybeSingle(),
      ])
      if (recentResult.error) throw recentResult.error
      if (acceptedResult.error) throw acceptedResult.error
      return {
        recent: recentResult.data || [],
        accepted: acceptedResult.data || null,
      }
    },
  })

  const { data: escrow = null, isLoading: escrowLoading, error: escrowError } = useQuery({
    queryKey: ['service-booking-escrow', booking.id],
    enabled: Boolean(booking.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_booking_escrows')
        .select('id, booking_id, quote_id, amount_kobo, status, delivered_at, auto_release_at, resolved_at')
        .eq('booking_id', booking.id)
        .maybeSingle()
      if (error) throw error
      return data
    },
    staleTime: 15_000,
  })

  const latestQuote = quoteData.recent[0] || null
  const acceptedQuote = quoteData.accepted
  const displayedQuote = acceptedQuote || latestQuote
  const quoteExpired = latestQuote?.status === 'sent' && new Date(latestQuote.expires_at).getTime() <= Date.now()
  const actionsDisabled = busy || quotesLoading || escrowLoading

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['gig-bookings'] }),
      queryClient.invalidateQueries({ queryKey: ['service-booking-quotes', booking.id] }),
      queryClient.invalidateQueries({ queryKey: ['service-booking-escrow', booking.id] }),
    ])
  }

  const callRpc = async (name, args, successMessage) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc(name, args)
      if (error) throw error
      if (data?.success === false) {
        if (data.code === 'quote_expired') {
          await refresh()
          throw new Error('That quote expired. Ask the provider for an updated quote.')
        }
        throw new Error(data.message || 'The booking could not be updated.')
      }
      toast.success(successMessage)
      setShowQuoteForm(false)
      setShowDisputeForm(false)
      setDisputeReason('')
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The booking could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  const sendQuote = async event => {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount < 1) {
      toast.error('Enter a valid final price')
      return
    }
    if (scope.trim().length < 20) {
      toast.error('Describe exactly what is included in at least 20 characters')
      return
    }
    await callRpc('send_gig_booking_quote', {
      p_booking_id: booking.id,
      p_amount_kobo: toKobo(numericAmount),
      p_scope: scope.trim(),
      p_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, 'Final quote sent to the customer')
  }

  const respondToQuote = accept => callRpc(
    'respond_gig_booking_quote',
    { p_quote_id: latestQuote.id, p_accept: accept },
    accept ? 'Quote accepted. Fund the booking to secure the service.' : 'Quote declined. The provider can revise it.',
  )

  const transition = action => {
    const messages = {
      start: 'Service marked as in progress',
      deliver: 'Delivery submitted. You have a 72-hour customer review window.',
      confirm: 'Service confirmed. Escrow funds released to the provider.',
      cancel: 'Booking cancelled. Any held service funds were refunded.',
    }
    return callRpc(
      'transition_gig_booking',
      { p_booking_id: booking.id, p_action: action },
      messages[action],
    )
  }

  const fundEscrow = () => callRpc(
    'fund_gig_booking_escrow',
    { p_booking_id: booking.id },
    'Campus Wallet funded. Your service payment is now held in escrow.',
  )

  const openDispute = event => {
    event.preventDefault()
    const reason = disputeReason.trim()
    if (reason.length < 20) {
      toast.error('Describe the issue in at least 20 characters')
      return
    }
    return callRpc(
      'open_gig_booking_dispute',
      { p_booking_id: booking.id, p_reason: reason },
      'Dispute opened. Your service funds remain held during platform review.',
    )
  }

  const canCancel = ['pending', 'quoted', 'confirmed'].includes(booking.status)
  const canDispute = !isProvider && ['in_progress', 'delivered'].includes(booking.status) && escrow?.status === 'held'

  return (
    <div className="mt-3 space-y-3">
      {displayedQuote && (
        <div className="rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold">
              <FileText size={13} /> {acceptedQuote ? 'Accepted final quote' : latestQuote.status === 'declined' ? 'Last declined quote' : latestQuote.status === 'expired' ? 'Expired quote' : latestQuote.status === 'cancelled' ? 'Cancelled quote' : 'Latest provider quote'}
            </span>
            <span className="font-mono text-sm font-black">{formatNaira(displayedQuote.amount_kobo)}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-on-surface/70">{displayedQuote.scope}</p>
          {displayedQuote.status === 'sent' && (
            <p className="mt-2 flex items-center gap-1 text-[11px] text-on-surface/50">
              <Clock size={11} /> {quoteExpired ? 'Quote expired. Ask the provider to revise it.' : `Expires ${new Date(displayedQuote.expires_at).toLocaleString()}`}
            </p>
          )}
        </div>
      )}

      {escrowError && (
        <p className="rounded-md border border-error/30 bg-error/5 p-3 text-xs" role="alert">
          Unable to verify service escrow status. Refresh before taking payment or starting work.
        </p>
      )}
      {escrow && (
        <div className={`rounded-md border p-3 ${escrow.status === 'disputed' ? 'border-error/30 bg-error/5' : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold">
              {escrow.status === 'disputed' ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
              {escrow.status === 'held' ? 'Campus Wallet escrow secured' : escrow.status === 'disputed' ? 'Funds held during dispute' : escrow.status === 'released' ? 'Payment released' : 'Payment refunded'}
            </span>
            <span className="font-mono text-sm font-black">{formatNaira(escrow.amount_kobo)}</span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-on-surface/60">
            {escrow.status === 'held' && escrow.auto_release_at
              ? `Customer review deadline: ${new Date(escrow.auto_release_at).toLocaleString()}. Confirm receipt or open a dispute before then.`
              : escrow.status === 'held'
                ? 'Funds remain held until the service is delivered and confirmed.'
                : escrow.status === 'disputed'
                  ? 'Neither participant can withdraw these funds while the platform reviews the case.'
                  : escrow.status === 'released'
                    ? 'The provider has been credited.'
                    : 'The held amount has been returned to the customer wallet.'}
          </p>
        </div>
      )}

      {booking.status === 'quoted' && !isProvider && latestQuote?.status === 'sent' && !quoteExpired && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={actionsDisabled} onClick={() => respondToQuote(true)} className="btn-primary text-xs">
            <CheckCircle size={13} /> Accept quote
          </button>
          <button type="button" disabled={actionsDisabled} onClick={() => respondToQuote(false)} className="btn-secondary text-xs">
            <XCircle size={13} /> Decline quote
          </button>
        </div>
      )}

      {booking.status === 'confirmed' && !isProvider && !acceptedQuote && (
        <p className="rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3 text-xs leading-5 text-on-surface/70">
          This booking was confirmed before final quotes were introduced. Ask the provider to send the final price and work scope here before funding.
        </p>
      )}

      {booking.status === 'confirmed' && !isProvider && acceptedQuote && !escrow && !escrowLoading && !escrowError && (
        <div className="rounded-md border border-[var(--md-primary)]/30 bg-[var(--md-primary)]/5 p-3">
          <p className="text-xs font-semibold">Your quote is accepted. Fund it to reserve the provider's time.</p>
          <p className="mt-1 text-[11px] leading-5 text-on-surface/60">The exact quoted amount will be debited from Campus Wallet and held until you confirm delivery. If you cancel before work starts, the held amount is refunded.</p>
          <button type="button" disabled={actionsDisabled} onClick={fundEscrow} className="btn-primary mt-3 text-xs">
            <Wallet size={13} /> Fund {formatNaira(acceptedQuote.amount_kobo)} from Campus Wallet
          </button>
        </div>
      )}

      {booking.status === 'confirmed' && isProvider && acceptedQuote && !escrow && (
        <p className="rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3 text-xs leading-5 text-on-surface/65">
          Waiting for the customer to fund the accepted quote. Do not begin work until the escrow badge confirms the funds are held.
        </p>
      )}

      {isProvider && (['pending', 'quoted'].includes(booking.status) || (booking.status === 'confirmed' && !acceptedQuote)) && (
        <div className="space-y-2">
          {!showQuoteForm ? (
            <button type="button" disabled={actionsDisabled} onClick={() => setShowQuoteForm(true)} className="btn-primary text-xs">
              <Send size={13} /> {latestQuote?.status === 'sent' ? 'Revise quote' : 'Send final quote'}
            </button>
          ) : (
            <form onSubmit={sendQuote} className="space-y-2 rounded-md border border-[var(--md-outline-variant)] p-3">
              <label className="block text-xs font-semibold" htmlFor={`service-quote-amount-${booking.id}`}>Final price (₦)</label>
              <input
                id={`service-quote-amount-${booking.id}`}
                className="input"
                type="number"
                min="1"
                step="0.01"
                required
                value={amount}
                onChange={event => setAmount(event.target.value)}
                placeholder="e.g. 2500"
              />
              <label className="block text-xs font-semibold" htmlFor={`service-quote-scope-${booking.id}`}>Work included</label>
              <textarea
                id={`service-quote-scope-${booking.id}`}
                className="input min-h-24 resize-y"
                minLength={20}
                maxLength={5000}
                required
                value={scope}
                onChange={event => setScope(event.target.value)}
                placeholder="Describe the deliverables, materials, turnaround and what is not included."
              />
              <p className="text-[11px] leading-4 text-on-surface/50">The customer has 24 hours to accept or decline. Once accepted, they fund the exact quote from Campus Wallet before you start.</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={actionsDisabled} className="btn-primary text-xs">{busy ? 'Sending…' : 'Send quote'}</button>
                <button type="button" disabled={actionsDisabled} onClick={() => setShowQuoteForm(false)} className="btn-secondary text-xs">Close</button>
              </div>
            </form>
          )}
        </div>
      )}

      {isProvider && booking.status === 'confirmed' && acceptedQuote && escrow?.status === 'held' && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('start')} className="btn-primary text-xs">
          <Play size={13} /> Start service
        </button>
      )}
      {isProvider && booking.status === 'in_progress' && escrow?.status === 'held' && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('deliver')} className="btn-primary text-xs">
          <CheckCircle size={13} /> Mark delivered
        </button>
      )}
      {!isProvider && booking.status === 'delivered' && escrow?.status === 'held' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={actionsDisabled} onClick={() => transition('confirm')} className="btn-primary text-xs">
            <CheckCircle size={13} /> Confirm service and release funds
          </button>
        </div>
      )}

      {canDispute && !showDisputeForm && (
        <button type="button" disabled={actionsDisabled} onClick={() => setShowDisputeForm(true)} className="btn-secondary text-xs text-error">
          <AlertTriangle size={13} /> Report a problem / dispute
        </button>
      )}
      {canDispute && showDisputeForm && (
        <form onSubmit={openDispute} className="space-y-2 rounded-md border border-error/30 bg-error/5 p-3">
          <label htmlFor={`service-dispute-${booking.id}`} className="text-xs font-semibold">What went wrong?</label>
          <textarea id={`service-dispute-${booking.id}`} className="input min-h-24 resize-y" minLength={20} maxLength={5000} required
            value={disputeReason} onChange={event => setDisputeReason(event.target.value)}
            placeholder="Explain what was agreed, what was delivered and what still needs fixing." />
          <p className="text-[11px] text-on-surface/55">Opening a dispute freezes the held funds. Platform operations will review the case.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={actionsDisabled} className="btn-primary text-xs">{busy ? 'Submitting…' : 'Open dispute'}</button>
            <button type="button" disabled={actionsDisabled} onClick={() => setShowDisputeForm(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </form>
      )}

      {booking.status === 'disputed' && (
        <p className="rounded-md border border-error/30 bg-error/5 p-3 text-xs leading-5" role="status">
          This booking is under platform review. Escrow funds remain frozen until an authorized resolution is recorded.
        </p>
      )}

      {canCancel && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('cancel')} className="btn-secondary text-xs">
          <XCircle size={13} /> Cancel booking{escrow?.status === 'held' ? ' and refund escrow' : ''}
        </button>
      )}

      <p className="flex items-start gap-1.5 text-[11px] leading-4 text-on-surface/50">
        <ShieldAlert size={12} className="mt-0.5 shrink-0" />
        Campus Wallet is the supported service escrow rail. Funds stay held until customer confirmation, a platform dispute decision, or automatic release 72 hours after delivery if no dispute is opened.
      </p>
      <span className="sr-only">{statusLabel[booking.status] || booking.status}</span>
    </div>
  )
}
