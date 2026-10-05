import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock3, CreditCard, Flag, LockKeyhole, RotateCcw, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const iconFor = (state='') => {
  if (state === 'RELEASED') return CheckCircle2
  if (state === 'LOCKED') return LockKeyhole
  if (state === 'DISPUTED') return ShieldAlert
  if (state === 'REFUNDED' || state === 'CANCELLED') return RotateCcw
  return Clock3
}

export default function TransactionTimeline({ transactionId, admin=false }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-transaction-timeline', transactionId],
    enabled: Boolean(transactionId && admin),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_admin_transaction_timeline', { p_transaction_id: transactionId })
      if (error) throw error
      return data
    },
    staleTime: 15_000,
  })

  if (!admin || !transactionId) return null
  if (isLoading) return <div className="surface p-5 animate-pulse"><div className="skeleton h-4 w-40 mb-4"/><div className="space-y-3">{[1,2,3].map(i=><div key={i} className="skeleton h-12"/>)}</div></div>
  if (isError) return <div className="surface p-5 text-sm text-[var(--md-error)]" role="alert">Timeline could not be loaded.</div>

  const transitions = data?.transitions || []
  const payments = data?.payments || []
  const events = [
    ...transitions.map(x => ({...x, kind:'state', at:x.created_at})),
    ...payments.map(x => ({...x, kind:'payment', at:x.received_at, to_state:x.processing_status, action:x.event_type}))
  ].sort((a,b)=>new Date(a.at)-new Date(b.at))

  return <section className="surface p-5" aria-labelledby="transaction-timeline-title">
    <div className="flex items-center justify-between gap-3 mb-5">
      <div><p className="section-label">Audit trail</p><h2 id="transaction-timeline-title" className="text-lg font-black">Transaction timeline</h2></div>
      <span className="tag tag-cyan">{events.length} events</span>
    </div>
    {events.length===0 ? <div className="py-8 text-center text-sm text-white/35">No server-side events recorded yet.</div> :
      <ol className="relative ml-2 border-l border-[var(--md-outline-variant)]">
        {events.map((event,i)=>{const Icon=event.kind==='payment'?CreditCard:iconFor(event.to_state);return <li key={`${event.kind}-${event.id||i}`} className="relative pl-7 pb-6 last:pb-0">
          <span className="absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]"><Icon size={12} className="text-primary"/></span>
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{event.kind==='payment'?event.event_type:event.action}</strong>{event.to_state&&<span className="tag tag-purple text-[9px]">{event.to_state}</span>}</div>
          <div className="mt-1 text-[11px] text-white/40">{new Date(event.at).toLocaleString()}</div>
          {event.failure_reason&&<div className="mt-2 text-xs text-[var(--md-error)]" role="alert">{event.failure_reason}</div>}
        </li>})}
      </ol>}
  </section>
}