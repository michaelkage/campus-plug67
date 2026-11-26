import { useState } from 'react'
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'

function formatKobo(value) {
  return (Number(value || 0) / 100).toLocaleString('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  })
}

export default function PayoutReconciliationPanel({ data, loading, onRefresh }) {
  const [notes, setNotes] = useState({})
  const [tickets, setTickets] = useState({})
  const [confirmations, setConfirmations] = useState({})
  const [busy, setBusy] = useState({})

  const runAction = async (row, action) => {
    const reference = row.reference
    const note = String(notes[reference] || '').trim()
    const supportTicket = String(tickets[reference] || '').trim()
    if (note.length < 20 || note.length > 500) {
      toast.error('Add an audit note between 20 and 500 characters.')
      return
    }
    if (action === 'confirm_not_created' && confirmations[reference] !== true) {
      toast.error('Confirm that you checked the exact reference in Paystack.')
      return
    }

    setBusy(current => ({ ...current, [reference]: true }))
    try {
      const { data: result, error } = await supabase.functions.invoke(
        'admin-resolve-paystack-payout-attention',
        { body: { action, reference, note, support_ticket: supportTicket || null } },
      )
      if (error) {
        const context = error.context
        if (context) {
          const payload = await context.clone().json().catch(() => null)
          if (typeof payload?.error === 'string') throw new Error(payload.error)
        }
        throw error
      }
      if (result?.error) throw new Error(result.error)

      const message = result?.resolution === 'provider_confirmed_not_created'
        ? 'Provider absence confirmed. The failed attempt is audited; retry eligibility follows the server retry policy.'
        : result?.resolution === 'provider_not_found'
          ? 'Paystack returned 404. No payout state changed; the verification was audited.'
          : result?.resolution === 'provider_mismatch_quarantined'
            ? 'Provider details did not match. The payout remains quarantined for manual review.'
            : 'Provider status reconciled and operator action audited.'
      toast.success(message)
      setNotes(current => ({ ...current, [reference]: '' }))
      setConfirmations(current => ({ ...current, [reference]: false }))
      await onRefresh?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Payout operation failed')
    } finally {
      setBusy(current => ({ ...current, [reference]: false }))
    }
  }

  const queue = data?.payout_queue || []
  const audit = data?.payout_operator_audit || []

  return (
    <div className="space-y-4">
      <section className="surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-black">Seller payout reconciliation</h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--md-on-surface)]/50">
              Provider lookups verify the exact reference, amount, NGN currency and original beneficiary.
              They never create or resend a transfer. A not-created confirmation requires a fresh Paystack 404,
              a 30-minute minimum age, no provider transfer IDs, and a recorded operator note.
            </p>
          </div>
          <button type="button" className="btn-secondary min-h-11 text-sm" onClick={() => void onRefresh?.()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh payouts
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="stat-card"><div className="text-2xl font-black">{Number(data?.counts?.payout_attention || 0).toLocaleString('en-NG')}</div><div className="mt-1 text-xs text-on-surface/45">Need attention / stale</div></div>
          <div className="stat-card"><div className="text-2xl font-black">{Number(data?.counts?.payout_inflight || 0).toLocaleString('en-NG')}</div><div className="mt-1 text-xs text-on-surface/45">In flight</div></div>
          <div className="stat-card col-span-2 sm:col-span-1"><div className="text-2xl font-black">{Number(data?.counts?.payout_reversals_24h || 0).toLocaleString('en-NG')}</div><div className="mt-1 text-xs text-on-surface/45">Reversed in 24h</div></div>
        </div>

        {loading && !data ? <p className="py-8 text-center text-sm text-on-surface-variant" role="status">Loading payout attempts…</p>
          : queue.length === 0 ? <p className="py-8 text-center text-sm text-on-surface-variant" role="status">No outstanding seller payouts.</p>
          : <div className="mt-4 space-y-3">
            {queue.map(row => {
              const note = String(notes[row.reference] || '')
              const isBusy = busy[row.reference] === true
              return (
                <article key={row.transfer_id} className="rounded-lg border border-[var(--md-outline-variant)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-black uppercase">{row.status.replaceAll('_', ' ')}</span>
                        {row.status === 'needs_attention' && <span className="rounded-sm bg-error/10 px-2 py-1 text-[10px] font-bold text-error">Manual attention</span>}
                      </div>
                      <p className="mt-2 break-all font-mono text-xs">{row.reference}</p>
                      <p className="mt-1 text-xs text-on-surface/55">Transaction {row.transaction_id}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm font-black">{formatKobo(row.amount_kobo)}</p>
                      <p className="mt-1 text-[11px] text-on-surface/45">{row.currency} · Attempt {row.attempt_number}/5</p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 rounded-md bg-surface-container p-3 text-xs sm:grid-cols-2">
                    <p><span className="text-on-surface/45">Beneficiary</span><br/><strong>{row.bank_name || 'Verified bank'} · •••• {row.account_last4 || '----'}</strong></p>
                    <p><span className="text-on-surface/45">Provider status</span><br/><strong>{row.provider_status || 'Not confirmed'}</strong></p>
                    <p><span className="text-on-surface/45">Last provider check</span><br/><strong>{row.last_reconciled_at ? new Date(row.last_reconciled_at).toLocaleString() : 'Never'}</strong></p>
                    <p><span className="text-on-surface/45">Last update</span><br/><strong>{new Date(row.updated_at).toLocaleString()}</strong></p>
                  </div>

                  <div className="mt-3 space-y-2">
                    <label className="block space-y-1 text-xs font-semibold">
                      Operator audit note
                      <textarea
                        className="input min-h-20 w-full resize-y"
                        value={note}
                        maxLength={500}
                        onChange={event => setNotes(current => ({ ...current, [row.reference]: event.target.value }))}
                        placeholder="Record what you checked. Do not include bank account numbers, OTPs or secrets."
                        aria-label={`Audit note for payout ${row.reference}`}
                        disabled={isBusy}
                      />
                    </label>
                    <label className="block space-y-1 text-xs font-semibold">
                      Support ticket (optional)
                      <input
                        className="input w-full"
                        value={tickets[row.reference] || ''}
                        maxLength={120}
                        onChange={event => setTickets(current => ({ ...current, [row.reference]: event.target.value }))}
                        placeholder="Ticket or incident reference"
                        disabled={isBusy}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn-secondary min-h-11 text-xs" onClick={() => void runAction(row, 'reconcile')} disabled={isBusy || note.trim().length < 20}>
                        <RefreshCw size={14} className={isBusy ? 'animate-spin' : ''}/> Verify with Paystack
                      </button>
                    </div>
                    {row.status === 'needs_attention' && (
                      <div className="rounded-md border border-error/25 p-3">
                        <label className="flex items-start gap-2 text-xs leading-relaxed">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={confirmations[row.reference] === true}
                            onChange={event => setConfirmations(current => ({ ...current, [row.reference]: event.target.checked }))}
                            disabled={isBusy}
                          />
                          <span>I independently checked this exact reference in the correct Paystack Dashboard environment and confirmed no transfer exists. I understand this can make the attempt eligible for a later retry.</span>
                        </label>
                        <button
                          type="button"
                          className="btn-primary mt-3 min-h-11 text-xs"
                          onClick={() => void runAction(row, 'confirm_not_created')}
                          disabled={isBusy || note.trim().length < 20 || confirmations[row.reference] !== true}
                        >
                          <ShieldCheck size={14}/> Confirm no transfer exists
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>}
      </section>

      <section className="surface p-5">
        <div className="flex items-center gap-2"><AlertTriangle size={16} className="text-primary"/><h3 className="font-black">Recent payout operator audit</h3></div>
        <p className="mt-1 text-xs text-on-surface/45">Append-only history. Each action records the verified operator, support note, provider result and status transition.</p>
        {audit.length === 0 ? <p className="py-6 text-center text-sm text-on-surface-variant" role="status">No manual payout operations recorded.</p>
          : <div className="mt-3 space-y-2">
            {audit.map(item => (
              <article key={item.id} className="rounded-md border border-[var(--md-outline-variant)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold">{item.action.replaceAll('_', ' ')}</p>
                  <p className="text-[10px] text-on-surface/45">{new Date(item.created_at).toLocaleString()}</p>
                </div>
                <p className="mt-1 break-all font-mono text-[11px]">{item.reference || item.transfer_id}</p>
                <p className="mt-2 text-xs">{item.before_status} → {item.after_status} · Provider: {item.provider_status || 'unknown'} ({item.provider_http_status ?? 'n/a'})</p>
                <p className="mt-2 whitespace-pre-wrap text-xs text-on-surface/65">{item.note}</p>
                <p className="mt-1 text-[10px] text-on-surface/40">Operator {item.operator_name || item.operator_id} · {item.operator_id}{item.support_ticket ? ` · ${item.support_ticket}` : ''}</p>
              </article>
            ))}
          </div>}
      </section>
    </div>
  )
}
