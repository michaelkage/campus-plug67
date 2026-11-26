import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, Banknote, CreditCard, Database, LayoutDashboard, PackageCheck, RefreshCw, Search, Shield, Users, WalletCards } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import TransactionTimeline from '@/components/admin/TransactionTimeline'

const tabs=[['overview','Overview',LayoutDashboard],['transactions','Transactions',CreditCard],['rentals','Rental disputes',PackageCheck],['payments','Payments',WalletCards],['financial-ops','Financial ops',Banknote],['security','Security',Shield],['operations','Operations',Activity]]

export default function AdminConsole(){
  const { user }=useAuth(); const [tab,setTab]=useState('overview'); const [transactionId,setTransactionId]=useState(''); const [rentalShares,setRentalShares]=useState({}); const [rentalCustody,setRentalCustody]=useState({})
  const isAdmin=['admin','platform_admin'].includes(String(user?.app_metadata?.role ?? ''))
  const {data:snapshot,isLoading,isError,refetch}=useQuery({
    queryKey:['admin-console-snapshot'], enabled:isAdmin,
    queryFn:async()=>{const {data,error}=await supabase.rpc('get_admin_console_snapshot');if(error)throw error;return data},
    staleTime:15_000,
  })
  const {data:financialOps,isLoading:financialOpsLoading,isError:financialOpsError,refetch:refetchFinancialOps}=useQuery({
    queryKey:['admin-financial-operations-snapshot'],
    enabled:isAdmin && tab==='financial-ops',
    queryFn:async()=>{const {data,error}=await supabase.rpc('get_admin_financial_operations_snapshot',{p_limit:30});if(error)throw error;return data},
    staleTime:30_000,
    refetchInterval:60_000,
  })
  const {data:rentalDisputes=[],isLoading:rentalDisputesLoading,refetch:refetchRentalDisputes}=useQuery({
    queryKey:['admin-gear-rental-disputes'], enabled:isAdmin && tab==='rentals',
    queryFn:async()=>{const {data,error}=await supabase.functions.invoke('admin-gear-rentals',{body:{action:'list_disputes'}});if(error)throw error;if(data?.error)throw new Error(data.error);return data?.disputes||[]},
    staleTime:10_000,
  })
  const resolveRental=async(rentalId,shareBps,custodyResolved)=>{
    try{
      const {data,error}=await supabase.functions.invoke('resolve-gear-rental-dispute',{body:{rental_id:rentalId,lender_share_bps:shareBps,custody_resolved:custodyResolved}})
      if(error)throw error
      if(data?.error)throw new Error(data.error)
      toast.success('Rental dispute settled. Wallet balances updated.')
      setRentalCustody(current=>({...current,[rentalId]:false}))
      await refetchRentalDisputes()
    }catch(error){toast.error(error instanceof Error?error.message:'Could not settle rental dispute')}
  }
  const cards=useMemo(()=>snapshot?[
    ['Users',snapshot.users,Users],['Active listings',snapshot.active_listings,Database],['30d transactions',snapshot.transactions_30d,CreditCard],
    ['Disputed',snapshot.disputed,AlertTriangle],['Payment events 24h',snapshot.payment_events_24h,WalletCards],['Errors 24h',snapshot.observability_errors_24h,Activity]
  ]:[],[snapshot])
  if(!isAdmin)return <main className="page-shell"><div className="surface p-8 text-center"><Shield className="mx-auto mb-3 text-[var(--md-error)]"/><h1 className="text-xl font-black">Admin access required</h1><p className="mt-2 text-sm text-[var(--md-on-surface)]/40">This console is restricted to platform operators.</p></div></main>
  return <main className="page-shell space-y-6">
    <header className="page-header"><div><p className="section-label">Operations</p><h1 className="page-title">Admin Console</h1><p className="page-subtitle">System health, marketplace activity, payments, security and audit trails in one command center.</p></div><button className="btn-secondary text-sm" onClick={()=>refetch()} disabled={isLoading}><RefreshCw size={15} className={isLoading?'animate-spin':''}/> Refresh</button></header>
    <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Admin sections">{tabs.map(([id,label,Icon])=><button key={id} onClick={()=>setTab(id)} aria-current={tab===id?'page':undefined} className={`flex min-h-11 shrink-0 items-center gap-2 rounded-sm border px-4 text-sm font-bold ${tab===id?'border-primary/40 bg-primary/10 text-primary':'border-[var(--md-outline-variant)] text-[var(--md-on-surface)]/45 hover:text-on-surface'}`}><Icon size={14}/>{label}</button>)}</nav>
    {isError&&<div className="surface p-4 border-[var(--md-error)]/40 text-sm text-[var(--md-error)]" role="alert">Admin data is temporarily unavailable. Refresh and try again.</div>}
    {tab==='overview'&&<><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{cards.map(([label,value,Icon])=><div key={label} className="stat-card"><Icon size={16} className="text-primary mb-3"/><div className="text-2xl font-black">{value??'—'}</div><div className="text-xs text-[var(--md-on-surface)]/40 mt-1">{label}</div></div>)}</div><div className="grid gap-5 lg:grid-cols-2"><section className="surface p-5"><h2 className="font-black">Operational health</h2><div className="mt-4 space-y-3"><HealthRow label="Payment processing" value={snapshot?.payment_failures_24h||0} bad={snapshot?.payment_failures_24h>0}/><HealthRow label="Observability errors" value={snapshot?.observability_errors_24h||0} bad={snapshot?.observability_errors_24h>0}/><HealthRow label="Ledger activity" value={snapshot?.ledger_entries_24h||0}/></div></section><section className="surface p-5"><h2 className="font-black">Recent errors</h2><div className="mt-4 space-y-2">{(snapshot?.recent_errors||[]).slice(0,6).map((e,i)=><div key={e.id||i} className="rounded-md border border-[var(--md-outline-variant)] p-3"><div className="flex justify-between gap-3 text-xs font-bold"><span>{e.service} · {e.operation}</span><span className="text-[var(--md-on-surface)]/30">{new Date(e.created_at).toLocaleTimeString()}</span></div><div className="mt-1 text-[11px] text-[var(--md-error)]">{e.error_code||'runtime_error'}</div></div>)}{!snapshot?.recent_errors?.length&&<Empty text="No recent errors recorded."/>}</div></section></div></>}
    {tab==='transactions'&&<section className="space-y-5"><div className="surface p-5"><label className="label" htmlFor="admin-tx-id">Transaction ID</label><div className="flex gap-2"><input id="admin-tx-id" className="input" value={transactionId} onChange={e=>setTransactionId(e.target.value.trim())} placeholder="Paste a transaction UUID"/><button className="btn-primary shrink-0" onClick={()=>{if(!transactionId)toast.error('Enter a transaction ID')}}><Search size={15}/> Inspect</button></div></div><TransactionTimeline transactionId={transactionId} admin={isAdmin}/></section>}
    {tab==='rentals'&&<section className="space-y-4">
      <div className="surface p-5"><h2 className="font-black">Gear rental disputes</h2><p className="mt-1 text-xs text-[var(--md-on-surface)]/45">Held rental funds remain untouched until a platform admin records a settlement. The lender share applies to the full held amount, including the refundable deposit. You can settle funds even if the item has not returned; in that case the listing stays blocked until custody is later verified.</p></div>
      {rentalDisputesLoading?<div className="surface p-8 text-center text-sm text-on-surface-variant">Loading rental disputes…</div>:rentalDisputes.length===0?<div className="surface p-8 text-center text-sm text-on-surface-variant">No open gear rental disputes.</div>:rentalDisputes.map(rental=><article key={rental.id} className="surface space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold">{rental.listing?.title||'Gear rental'}</h3><p className="mt-1 text-[11px] font-mono text-on-surface-variant">{rental.id}</p></div><span className="rounded-sm bg-error/10 px-2 py-1 text-[10px] font-bold uppercase text-error">Disputed</span></div>
        <div className="grid gap-2 text-xs sm:grid-cols-3"><div><span className="text-on-surface-variant">Rental dates</span><p className="font-semibold">{rental.start_date} to {rental.end_date}</p></div><div><span className="text-on-surface-variant">Rental fee</span><p className="font-semibold">{(Number(rental.rental_fee_kobo)/100).toLocaleString('en-NG',{style:'currency',currency:'NGN'})}</p></div><div><span className="text-on-surface-variant">Total held</span><p className="font-semibold">{(Number(rental.total_held_kobo)/100).toLocaleString('en-NG',{style:'currency',currency:'NGN'})}</p></div></div>
        <div className="rounded-md border border-outline-variant bg-surface-container p-3"><p className="text-[10px] font-bold uppercase text-on-surface-variant">Dispute reason</p><p className="mt-1 whitespace-pre-wrap text-sm">{rental.dispute_reason}</p></div>
        {rental.custody_resolved_at ? <label className="flex items-start gap-2 rounded-md border border-outline-variant p-3 text-xs leading-5"><input type="checkbox" checked={rentalCustody[rental.id]===true} onChange={event=>setRentalCustody(current=>({...current,[rental.id]:event.target.checked}))}/><span>Physical custody verified at {new Date(rental.custody_resolved_at).toLocaleString()}. I reviewed the return evidence and confirm the item is with the lender.</span></label> : <p className="rounded-md border border-tertiary/30 bg-tertiary/5 p-3 text-xs text-tertiary">Settlement is locked until the borrower returns the item and the lender verifies the one-time return code.</p>}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><label className="space-y-1 text-xs font-semibold text-on-surface-variant">Lender share of held funds (%)<input className="input" type="number" min="0" max="100" step="1" value={rentalShares[rental.id]??100} onChange={event=>setRentalShares(current=>({...current,[rental.id]:event.target.value}))}/></label><button className="btn-primary" disabled={!Number.isFinite(Number(rentalShares[rental.id]??100))||Number(rentalShares[rental.id]??100)<0||Number(rentalShares[rental.id]??100)>100} onClick={()=>{if(window.confirm('Settle this dispute and distribute the held funds using the selected split? This cannot be reversed.'))void resolveRental(rental.id,Math.round(Number(rentalShares[rental.id]??100)*100),rentalCustody[rental.id]===true)}}>Settle dispute</button></div>
        <div className="flex flex-wrap gap-2"><button className="btn-secondary text-xs" onClick={()=>setRentalShares(current=>({...current,[rental.id]:0}))}>Full refund to borrower</button><button className="btn-secondary text-xs" onClick={()=>setRentalShares(current=>({...current,[rental.id]:100}))}>Full release to lender</button></div>
      </article>)}
    </section>}
    {tab==='payments'&&<section className="surface overflow-hidden"><div className="p-5 border-b border-[var(--md-outline-variant)]"><h2 className="font-black">Payment event ledger</h2><p className="text-xs text-[var(--md-on-surface)]/40 mt-1">Provider events are immutable; this view is read-only.</p></div><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-[var(--md-outline-variant)]"><th className="p-4">Event</th><th className="p-4">Reference</th><th className="p-4">Status</th><th className="p-4">Received</th></tr></thead><tbody>{(snapshot?.recent_payments||[]).map((e,i)=><tr key={e.event_id||i} className="border-b border-[var(--md-outline-variant)]"><td className="p-4 font-bold">{e.event_type}</td><td className="p-4 font-mono text-[var(--md-on-surface)]/50">{e.reference||'—'}</td><td className="p-4">{e.processing_status}</td><td className="p-4 text-[var(--md-on-surface)]/40">{new Date(e.received_at).toLocaleString()}</td></tr>)}</tbody></table></div></section>}
    {tab==='financial-ops'&&<section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-black">Financial reconciliation</h2><p className="mt-1 text-xs text-[var(--md-on-surface)]/45">Read-only exception queues derived from payment events and immutable journal postings. Nothing here moves money.</p></div><button type="button" className="btn-secondary text-sm" onClick={()=>refetchFinancialOps()} disabled={financialOpsLoading}><RefreshCw size={14} className={financialOpsLoading?'animate-spin':''}/> Refresh queues</button></div>
      {financialOpsError&&<div className="surface p-4 text-sm text-error" role="alert">Financial operations data could not be loaded. Refresh and try again.</div>}
      {financialOpsLoading&&!financialOps?<div className="surface p-8 text-center text-sm text-on-surface-variant" role="status">Loading reconciliation queues…</div>:<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
          <OpsMetric label="Refunds needing attention" value={financialOps?.counts?.refund_attention}/>
          <OpsMetric label="Failed payment events" value={financialOps?.counts?.failed_payment_events}/>
          <OpsMetric label="Missing journal postings" value={financialOps?.counts?.missing_journal_postings}/>
          <OpsMetric label="Wallet mirror gaps" value={financialOps?.counts?.unmirrored_wallet_entries}/>
          <OpsMetric label="Trial balance issues" value={financialOps?.counts?.journal_balance_imbalances}/>
          <OpsMetric label="Payouts needing attention" value={financialOps?.counts?.payout_attention}/>
          <OpsMetric label="Stale payout attempts" value={financialOps?.counts?.stale_payout_attempts}/>
          <OpsMetric label="Manual recovery decisions" value={financialOps?.counts?.payout_operator_audits}/>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <OpsQueue title="Refunds needing attention" description="Failed, needs-attention, or processing for more than 15 minutes." rows={financialOps?.refund_attention||[]} kind="refund" onInspect={id=>{setTransactionId(id);setTab('transactions')}}/>
          <OpsQueue title="Failed provider events" description="Webhook events that were recorded but did not complete processing." rows={financialOps?.payment_failures||[]} kind="payment" onInspect={id=>{if(id){setTransactionId(id);setTab('transactions')}}}/>
          <OpsQueue title="Missing journal postings" description="Verified Paystack funding, release or processed refund events without their expected journal entry." rows={financialOps?.missing_journal||[]} kind="journal" onInspect={id=>{setTransactionId(id);setTab('transactions')}}/>
          <OpsQueue title="Unmirrored wallet entries" description="Legacy PlugCredit movements missing their matching financial journal record." rows={financialOps?.unmirrored_wallet_entries||[]} kind="wallet"/>
          <OpsQueue title="Payouts requiring attention" description="Current failed, blocked, rejected, abandoned or needs-attention attempts without a newer attempt." rows={financialOps?.payout_attention||[]} kind="payout" onInspect={id=>{setTransactionId(id);setTab('transactions')}}/>
          <OpsQueue title="Stale payout attempts" description="Processing or pending bank transfers with no update for more than 15 minutes." rows={financialOps?.stale_payouts||[]} kind="stale-payout" onInspect={id=>{setTransactionId(id);setTab('transactions')}}/>
        </div>
        <section className="surface overflow-hidden">
          <div className="border-b border-[var(--md-outline-variant)] p-5"><h3 className="font-black">Manual payout recovery audit</h3><p className="mt-1 text-xs text-[var(--md-on-surface)]/45">Append-only operator decisions. Provider 404 evidence and the operator note are retained; this view cannot alter a payout.</p></div>
          {(financialOps?.payout_operator_audit||[]).length===0?<p className="p-5 text-sm text-on-surface-variant" role="status">No manual payout recovery decisions recorded.</p>:
            <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-[var(--md-outline-variant)]"><th className="p-3">Reference</th><th className="p-3">Operator</th><th className="p-3">Provider</th><th className="p-3">Support note</th><th className="p-3">Recorded</th></tr></thead><tbody>{financialOps.payout_operator_audit.map(row=><tr key={row.id} className="border-b border-[var(--md-outline-variant)]"><td className="p-3 font-mono">{row.provider_reference}</td><td className="p-3 font-mono">{row.operator_id}</td><td className="p-3">{row.provider_http_status}</td><td className="p-3 min-w-64 whitespace-pre-wrap">{row.note}</td><td className="p-3 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="surface p-5">
          <h3 className="font-black">Trial balance integrity</h3>
          {(financialOps?.journal_balance||[]).length===0?<p className="mt-2 text-sm text-on-surface-variant" role="status">No journal imbalance detected in the current NGN trial balance.</p>:
            <div className="mt-3 space-y-2">{financialOps.journal_balance.map((entry,index)=><div key={entry.currency||index} className="rounded-md border border-error/30 bg-error/5 p-3 text-sm"><strong>{entry.currency}</strong><span className="ml-2 text-error">Imbalance: {formatKobo(entry.imbalance)}</span></div>)}</div>}
        </section>
      </>}
    </section>}
    {tab==='security'&&<section className="grid gap-5 md:grid-cols-2"><div className="surface p-5"><h2 className="font-black">Security posture</h2><ul className="mt-4 space-y-3 text-sm text-[var(--md-on-surface)]/55"><li>✓ Platform-admin RPC authorization</li><li>✓ Service-role-only sensitive telemetry tables</li><li>✓ Transaction transition audit trail</li><li>✓ Payment event idempotency ledger</li><li>✓ Client device signals are not authentication</li></ul></div><div className="surface p-5"><h2 className="font-black">Incident signals</h2><div className="mt-4 text-3xl font-black">{snapshot?.observability_errors_24h||0}</div><p className="text-xs text-[var(--md-on-surface)]/40">observability errors in the last 24 hours</p></div></section>}
    {tab==='operations'&&<section className="grid gap-5 md:grid-cols-2"><div className="surface p-5"><h2 className="font-black">Marketplace</h2><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><span className="text-[var(--md-on-surface)]/45">Active listings</span><strong>{snapshot?.active_listings??'—'}</strong></div><div className="flex justify-between"><span className="text-[var(--md-on-surface)]/45">Pending/review</span><strong>{snapshot?.pending_listings??'—'}</strong></div></div></div><div className="surface p-5"><h2 className="font-black">Users</h2><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><span className="text-[var(--md-on-surface)]/45">Total</span><strong>{snapshot?.users??'—'}</strong></div><div className="flex justify-between"><span className="text-[var(--md-on-surface)]/45">Verified</span><strong>{snapshot?.verified_users??'—'}</strong></div></div></div></section>}
  </main>
}
function HealthRow({label,value,bad}){return <div className="flex items-center justify-between rounded-md border border-[var(--md-outline-variant)] p-3"><span className="text-sm text-[var(--md-on-surface)]/55">{label}</span><span className={`font-mono font-black ${bad?'text-[var(--md-error)]':'text-primary'}`}>{value}</span></div>}
function Empty({text}){return <div className="py-8 text-center text-sm text-[var(--md-on-surface)]/30">{text}</div>}
function formatKobo(value){
  const amount=Number(value||0)/100
  return amount.toLocaleString('en-NG',{style:'currency',currency:'NGN',maximumFractionDigits:2})
}
function OpsMetric({label,value}){
  return <div className="stat-card"><div className="text-2xl font-black">{Number(value??0).toLocaleString('en-NG')}</div><div className="mt-1 text-xs text-[var(--md-on-surface)]/45">{label}</div></div>
}
function OpsQueue({title,description,rows,kind,onInspect}){
  const primary=row=>kind==='refund'?'Transaction '+row.id:kind==='payment'?row.event_type:kind==='journal'?row.issue:(kind==='payout'||kind==='stale-payout')?'Transfer '+row.reference:'Ledger entry '+row.ledger_entry_id
  const detail=row=>kind==='refund'?(row.refund_failure_reason||row.refund_status):kind==='payment'?(row.failure_reason||row.reference):kind==='journal'?row.paystack_ref:(kind==='payout'||kind==='stale-payout')?[row.status,row.failure_reason||row.provider_message].filter(Boolean).join(' · '):row.user_id
  const timestamp=row=>row.updated_at||row.received_at||row.created_at
  const transactionId=row=>kind==='refund'?row.id:kind==='payment'?row.transaction_id:kind==='journal'?row.transaction_id:(kind==='payout'||kind==='stale-payout')?row.transaction_id:null
  const amount=row=>kind==='wallet'?row.amount:row.amount_kobo??row.amount
  return <section className="surface min-w-0 p-5">
    <div className="mb-3"><h3 className="font-black">{title}</h3><p className="mt-1 text-xs text-[var(--md-on-surface)]/45">{description}</p></div>
    {!rows.length?<p className="py-5 text-center text-sm text-on-surface-variant" role="status">No exceptions in this queue.</p>:
      <div className="space-y-2">{rows.map((row,index)=><article key={row.id||row.event_id||row.transfer_id||row.transaction_id||row.ledger_entry_id||index} className="rounded-md border border-[var(--md-outline-variant)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-all text-xs font-bold">{primary(row)}</p><p className="mt-1 break-all text-[11px] text-[var(--md-on-surface)]/55">{detail(row)||'No provider detail recorded'}</p></div>{amount(row)!=null&&<span className="shrink-0 text-xs font-mono font-bold">{formatKobo(amount(row))}</span>}</div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] text-[var(--md-on-surface)]/35">{timestamp(row)?new Date(timestamp(row)).toLocaleString():'Timestamp unavailable'}</span>{transactionId(row)&&onInspect&&<button type="button" className="btn-secondary min-h-10 text-xs" onClick={()=>onInspect(transactionId(row))}>Inspect transaction</button>}</div>
      </article>)}</div>}
  </section>
}
