import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira, toKobo } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { CheckCircle, Clock, FileText, Play, Send, ShieldAlert, XCircle } from 'lucide-react'

const statusLabel = {
  pending: 'Awaiting provider quote',
  quoted: 'Quote awaiting your decision',
  confirmed: 'Quote accepted',
  in_progress: 'Service in progress',
  delivered: 'Awaiting customer confirmation',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export function ServiceBookingActions({ booking, currentUserId }) {
  const queryClient = useQueryClient()
  const isProvider = currentUserId === booking.seller_id
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [amount, setAmount] = useState(
    booking.amount ? (Number(booking.amount) / 100).toString() : '',
  )
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())

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

  const latestQuote = quoteData.recent[0] || null
  const acceptedQuote = quoteData.accepted
  const displayedQuote = acceptedQuote || latestQuote
  const quoteExpiryMs = latestQuote?.status === 'sent' ? Date.parse(latestQuote.expires_at) : Number.NaN

  // Re-render when the quote deadline is reached; the RPC remains authoritative.
  useEffect(() => {
    if (!Number.isFinite(quoteExpiryMs)) return undefined
    const timeout = window.setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, quoteExpiryMs - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [quoteExpiryMs])

  const quoteExpired = Number.isFinite(quoteExpiryMs) && quoteExpiryMs <= clockNow
  const actionsDisabled = busy || quotesLoading

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['gig-bookings'] }),
      queryClient.invalidateQueries({ queryKey: ['service-booking-quotes', booking.id] }),
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
    accept ? 'Quote accepted. The service is confirmed.' : 'Quote declined. The provider can revise it.',
  )

  const transition = action => {
    const messages = {
      start: 'Service marked as in progress',
      deliver: 'Delivery submitted. The customer must confirm completion.',
      confirm: 'Service completion confirmed',
      cancel: 'Booking cancelled',
    }
    return callRpc(
      'transition_gig_booking',
      { p_booking_id: booking.id, p_action: action },
      messages[action],
    )
  }

  const canCancel = ['pending', 'quoted', 'confirmed'].includes(booking.status)

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
          This booking was confirmed before final quotes were introduced. Ask the provider to send the final price and work scope here before work begins.
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
              <p className="text-[11px] leading-4 text-on-surface/50">The customer has 24 hours to accept or decline this quote. Sending a quote does not collect payment.</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={actionsDisabled} className="btn-primary text-xs">{busy ? 'Sending…' : 'Send quote'}</button>
                <button type="button" disabled={actionsDisabled} onClick={() => setShowQuoteForm(false)} className="btn-secondary text-xs">Close</button>
              </div>
            </form>
          )}
        </div>
      )}

      {isProvider && booking.status === 'confirmed' && acceptedQuote && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('start')} className="btn-primary text-xs">
          <Play size={13} /> Start service
        </button>
      )}
      {isProvider && booking.status === 'in_progress' && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('deliver')} className="btn-primary text-xs">
          <CheckCircle size={13} /> Mark delivered
        </button>
      )}
      {!isProvider && booking.status === 'delivered' && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('confirm')} className="btn-primary text-xs">
          <CheckCircle size={13} /> Confirm service received
        </button>
      )}
      {canCancel && (
        <button type="button" disabled={actionsDisabled} onClick={() => transition('cancel')} className="btn-secondary text-xs">
          <XCircle size={13} /> Cancel booking
        </button>
      )}

      <p className="flex items-start gap-1.5 text-[11px] leading-4 text-on-surface/50">
        <ShieldAlert size={12} className="mt-0.5 shrink-0" />
        Service quotes and delivery confirmation do not collect or protect funds yet. Keep payment outside this workflow until protected service payments are launched.
      </p>
      <span className="sr-only">{statusLabel[booking.status] || booking.status}</span>
    </div>
  )
}
