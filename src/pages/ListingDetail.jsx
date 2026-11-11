import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isReleaseGateOpen } from '@/lib/escrowTiming'
import { useTransactionStatus } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { ArrowLeft, Shield, MapPin, Trash2, Clock, AlertTriangle } from 'lucide-react'

function initPaystack({ email, amount, ref, metadata, publicKey }) {
  return new Promise((resolve, reject) => {
    const launch = () => {
      const h = window.PaystackPop.setup({
        key: publicKey, email, amount, ref, currency: 'NGN', metadata,
        callback: resolve, onClose: () => reject(new Error('Payment cancelled')),
      })
      h.openIframe()
    }
    if (window.PaystackPop) { launch(); return }
    const s = document.createElement('script')
    s.src = 'https://js.paystack.co/v1/inline.js'
    s.onload = launch
    s.onerror = () => reject(new Error('Failed to load Paystack'))
    document.head.appendChild(s)
  })
}

import { TX_STATUS, TX_STEPS, TX_STATUS_META } from '@/lib/escrowState'
import { deriveTransactionLifecycle } from '@/lib/transactionLifecycle'
import GearRentalPanel from '@/components/gear/GearRentalPanel'

const COLOR_CLASS = {
  amber: 'border-[var(--md-secondary)]/30 bg-[var(--md-secondary)]/5',
  cyan:  'border-[var(--md-primary)]/30 bg-[var(--md-primary)]/5',
  green: 'border-primary/30 bg-[var(--md-primary)]/5',
  red:   'border-[var(--md-error)]/30 bg-error/5',
}

function EscrowPanel({ tx, isSeller, onRefresh, otherUserId }) {
  const [showDispute, setShowDispute] = useState(false)
  const [disputeText, setDisputeText] = useState('')
  const [loading, setLoading] = useState(null)
  const { session } = useAuth()

  const edge = async (action, extra = {}) => {
    setLoading(action)
    try {
      if (action === 'initiate_meetup' && tx.payment_method === 'campus_wallet') {
        const { data, error } = await supabase.rpc('resolve_wallet_micro_escrow', {
          p_transaction_id: tx.id,
          p_action: 'initiate_meetup',
        })
        if (error) throw error
        if (!data?.success) throw new Error(data?.message || 'Unable to start wallet escrow pickup')
        toast.success('Pickup started. Meet at an approved campus Safe Swap Zone.')
        onRefresh?.()
        return
      }
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/release-escrow`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action, transaction_id: tx.id, ...extra }),
        }
      )
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      toast.success(d.message || 'Done!')
      onRefresh?.()
    } catch (e) { toast.error(e.message) }
    finally { setLoading(null) }
  }

  const fileDispute = async () => {
    if (!deriveTransactionLifecycle(tx).canDispute) {
      toast.error('The dispute window has closed for this transaction.')
      return
    }
    const reason = disputeText.trim()
    if (reason.length < 20) {
      toast.error('Describe the issue in at least 20 characters.')
      return
    }
    setLoading('dispute')
    try {
      const { data, error } = await supabase.functions.invoke('process-dispute', {
        body: { action: 'open_case', transaction_id: tx.id, reason },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Could not open the dispute')
      toast.success('Dispute filed. Escrow funds remain held while the case is reviewed.')
      setShowDispute(false)
      onRefresh?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the dispute')
    } finally {
      setLoading(null)
    }
  }

  const lifecycle = deriveTransactionLifecycle(tx)
  const baseMeta = TX_STATUS_META[tx.status] || TX_STATUS_META.pending
  const meta = {
    ...baseMeta,
    label: lifecycle.title,
    color: lifecycle.tone === 'danger' ? 'red' : lifecycle.tone === 'success' ? 'green' : lifecycle.tone === 'warning' ? 'amber' : 'cyan',
    icon: lifecycle.phase === 'dispute' ? '🚨' : lifecycle.handoffConfirmed ? '🛡️' : baseMeta.icon,
  }
  const stepIdx = TX_STEPS.findIndex(step => step.key === tx.status)
  const releaseGateOpen = isReleaseGateOpen(tx.meetup_initiated_at)
  const autoReleaseMs = tx.auto_release_at ? Math.max(0, new Date(tx.auto_release_at) - Date.now()) : null
  const hoursLeft = autoReleaseMs != null ? Math.floor(autoReleaseMs / 3_600_000) : null
  const minsLeft  = autoReleaseMs != null ? Math.floor((autoReleaseMs % 3_600_000) / 60_000) : null

  return (
    <motion.div
      className={`rounded-md border p-5 ${COLOR_CLASS[meta.color] || COLOR_CLASS.amber}`}
      transition={{ duration: 0.2 }}
    >
      <div className="flex items-center gap-3 mb-4"><span className="text-2xl">{meta.icon}</span><div><div className="font-bold text-sm">{meta.label}</div><div className="text-xs text-on-surface/30">PlugPay Escrow</div></div></div>
      <div className="flex items-center gap-1 mb-5 overflow-x-auto pb-1">{TX_STEPS.map((step, i) => { const active = i <= stepIdx && !['disputed','cancelled'].includes(tx.status); return <div key={step.key} className="flex items-center gap-1 flex-shrink-0"><div className={`px-2 py-0.5 rounded-sm text-[9px] font-bold transition-all ${active ? 'bg-primary text-on-primary' : 'bg-[var(--md-surface-container-high)] text-on-surface/35'}`}>{step.label}</div>{i < TX_STEPS.length - 1 && <div className={`w-3 h-px ${i < stepIdx ? 'bg-primary' : 'bg-surface-container-highest'}`} />}</div> })}</div>
      {!['released', 'cancelled', 'disputed'].includes(tx.status) && <div className="mb-4 rounded-md border border-[var(--md-primary)]/20 bg-[var(--md-primary)]/5 p-4 space-y-3"><div><p className="font-bold text-sm">What happens next?</p><p className="mt-1 text-xs leading-5 text-on-surface/70">{tx.status === 'pending' ? 'Your payment is still being verified. Do not travel for pickup or hand over the item until the status changes to Funds protected in escrow.' : tx.status === 'locked' ? 'Payment is secured. Agree on a public campus pickup point and time in chat. The seller starts the pickup flow after both sides agree.' : tx.status === 'meetup_initiated' ? 'Meet at the agreed public campus location. Inspect the item before confirming receipt. The buyer can confirm the QR handoff as soon as both participants have fresh check-ins in the same approved Safe Swap Zone.' : tx.handshake_receipt_buffer ? 'Handoff confirmed. Funds stay held for a two-hour inspection window. File a dispute before the countdown ends if something is wrong.' : 'The seller has requested release. If the item is missing or not as agreed, the buyer must file a dispute within the 48-hour window. Otherwise, server settlement is triggered at the deadline. Seller payout confirmation follows separately.'}</p></div><div className="grid gap-2 sm:grid-cols-2"><Link to={`/workspace?other=${encodeURIComponent(otherUserId || '')}&tx=${encodeURIComponent(tx.id)}`} className="btn-primary flex items-center justify-center text-sm">💬 Message {isSeller ? 'buyer' : 'seller'}</Link><Link to={`/safe-swap?tx=${encodeURIComponent(tx.id)}`} className="btn-secondary flex items-center justify-center text-sm"><MapPin size={14}/> Meetup & safety check-in</Link></div></div>}
      {tx.status === 'release_requested' && hoursLeft != null && <div className="flex items-center gap-2 p-3 rounded-md bg-[var(--md-surface-container-high)] text-sm mb-4"><Clock size={13} className="text-[var(--md-secondary)]" />{autoReleaseMs === 0 ? <span className="text-on-surface/70">The {lifecycle.phase === 'inspection' ? 'inspection' : 'dispute'} deadline has passed. Server settlement is still being confirmed.</span> : <><span className="text-on-surface/50">{lifecycle.phase === 'inspection' ? 'Inspection ends in ' : 'Dispute window ends in '}</span><span className="font-mono font-bold text-[var(--md-secondary)]">{hoursLeft}h {minsLeft}m</span></>}</div>}
      {isSeller && tx.status === 'locked' && <div className="space-y-3"><p className="text-xs text-on-surface/70">Your buyer has paid. PlugPay is holding the funds. Agree on a public campus pickup point and time in chat before starting the meetup.</p><button onClick={() => edge('initiate_meetup')} disabled={loading === 'initiate_meetup'} className="btn-primary w-full text-sm disabled:opacity-50">{loading === 'initiate_meetup' ? 'Starting pickup...' : '📍 Start pickup process'}</button></div>}
      {isSeller && tx.payment_method === 'campus_wallet' && tx.status === 'meetup_initiated' && <div className="space-y-3"><p className="text-xs text-on-surface/70">Complete your Safe Swap check-in first. Your handoff QR appears as soon as both participants have fresh check-ins in the same approved zone. No 24-hour wait is required for buyer QR confirmation.</p><Link to={`/safe-swap?tx=${encodeURIComponent(tx.id)}`} className="btn-primary flex items-center justify-center gap-2 text-sm"><MapPin size={14}/> Open Safe Swap and show handoff QR</Link></div>}
      {isSeller && tx.payment_method !== 'campus_wallet' && tx.status === 'meetup_initiated' && <div className="space-y-3"><p className="text-xs text-on-surface/70">Complete your Safe Swap check-in first. The handoff QR appears as soon as both participants have fresh check-ins in the same approved zone. The separate seller-requested release option unlocks after 24 hours.</p><Link to={`/safe-swap?tx=${encodeURIComponent(tx.id)}`} className="btn-primary flex items-center justify-center gap-2 text-sm"><MapPin size={14}/> Open Safe Swap and show handoff QR</Link><button onClick={() => edge('request_release')} disabled={loading === 'request_release' || !releaseGateOpen} className="w-full py-2.5 rounded-lg text-sm font-semibold border border-[var(--md-secondary)]/30 text-[var(--md-secondary)] hover:bg-[var(--md-secondary)]/10 transition-colors disabled:opacity-40">{loading === 'request_release' ? 'Requesting...' : releaseGateOpen ? '⏰ Request Release instead' : '⏳ Seller request unlocks in 24h'}</button></div>}
      {isSeller && tx.status === 'release_requested' && <div className="space-y-3"><p className="text-xs text-on-surface/70">{tx.handshake_receipt_buffer ? 'The buyer confirmed handoff. Your payout remains protected in escrow during the two-hour inspection window.' : 'Either participant can dispute the seller-requested release during the 48-hour window. If no dispute is filed, server settlement is triggered when the 48-hour window ends.'}</p><p className="text-[10px] text-on-surface/30 text-center">{tx.handshake_receipt_buffer ? 'When the two-hour inspection ends without a dispute, server settlement is triggered. Seller payout confirmation follows separately.' : 'When the 48-hour window ends without a dispute, server settlement is triggered. Seller payout confirmation follows separately.'}</p></div>}
      {!isSeller && tx.payment_method === 'campus_wallet' && tx.status === 'meetup_initiated' && <div className="space-y-3"><p className="text-xs text-on-surface/70">Inspect the item first. Campus Wallet release requires both participants to verify in the same approved Safe Swap Zone, then the buyer uses their phone to scan the seller's QR as soon as both participants have fresh check-ins in the same approved zone. There is no 24-hour QR delay.</p><Link to={`/safe-swap?tx=${encodeURIComponent(tx.id)}`} className="btn-primary flex items-center justify-center gap-2 text-sm"><MapPin size={14}/> Continue on phone to inspect and confirm</Link></div>}
      {!isSeller && tx.status === 'meetup_initiated' && <div className="space-y-3"><p className="text-xs text-on-surface/70">Inspect the item first. Once both participants have fresh check-ins in the same approved Safe Swap Zone, confirm handoff from your phone. QR confirmation starts a two-hour inspection window; it does not release funds immediately.</p><Link to={`/safe-swap?tx=${encodeURIComponent(tx.id)}`} className="btn-primary flex items-center justify-center gap-2 text-sm"><MapPin size={14}/> Continue to Safe Swap handoff</Link></div>}
      {!isSeller && lifecycle.canDispute && ['locked', 'meetup_initiated'].includes(tx.status) && <div className="space-y-3"><button onClick={() => setShowDispute(v => !v)} className="w-full py-2.5 rounded-lg text-sm font-semibold border border-[var(--md-error)]/30 text-[var(--md-error)] hover:bg-[var(--md-error)]/10 transition-colors">🚨 Report a problem / open dispute</button><AnimatePresence>{showDispute && <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }} className="overflow-hidden space-y-2"><textarea className="input resize-none w-full text-sm" rows={3} placeholder="Describe the issue (min 20 chars)..." value={disputeText} onChange={e => setDisputeText(e.target.value)} /><button onClick={async () => { if (disputeText.trim().length < 20) return; setLoading('dispute'); try { const { data, error } = await supabase.functions.invoke('process-dispute', { body: { action: 'open_case', transaction_id: tx.id, reason: disputeText.trim() } }); if (error) throw error; if (!data?.success) throw new Error(data?.error || 'Unable to open dispute'); toast.success('Dispute opened. Funds remain protected while the case is reviewed.'); onRefresh?.() } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to open dispute') } finally { setLoading(null) } }} disabled={loading === 'dispute' || disputeText.trim().length < 20} className="btn-primary w-full text-sm disabled:opacity-40">{loading === 'dispute' ? 'Opening dispute...' : 'Submit dispute'}</button></motion.div>}</AnimatePresence></div>}
      {!isSeller && lifecycle.canDispute && tx.status === 'release_requested' && <div className="space-y-3"><div className="flex items-start gap-2 p-3 rounded-md bg-[var(--md-secondary)]/10"><AlertTriangle size={13} className="text-[var(--md-secondary)] flex-shrink-0 mt-0.5" /><p className="text-xs text-on-surface/70">{tx.handshake_receipt_buffer ? <>Handoff confirmed. Your funds remain protected for <strong className="text-[var(--md-secondary)]">2 hours</strong>. File a dispute if the item has a problem. Inspection deadline in <strong className="text-[var(--md-secondary)]">{hoursLeft}h {minsLeft}m</strong>.</> : <>Seller requested release. You have <strong className="text-[var(--md-secondary)]">48 hours</strong> to dispute if the item is missing or not as agreed. Settlement deadline in <strong className="text-[var(--md-secondary)]">{hoursLeft}h {minsLeft}m</strong>.</>}</p></div><button onClick={() => setShowDispute(v => !v)} className="w-full py-2.5 rounded-lg text-sm font-semibold border border-[var(--md-error)]/30 text-[var(--md-error)] hover:bg-[var(--md-error)]/10 transition-colors">🚨 File a Dispute</button><AnimatePresence>{showDispute && <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }} className="overflow-hidden space-y-2"><textarea className="input resize-none w-full text-sm" rows={3} placeholder="Describe the issue (min 20 chars)..." value={disputeText} onChange={e => setDisputeText(e.target.value)} /><button onClick={fileDispute} disabled={loading === 'dispute' || disputeText.trim().length < 20} className="btn-primary w-full text-sm disabled:opacity-40">{loading === 'dispute' ? 'Filing...' : 'Submit Dispute'}</button></motion.div>}</AnimatePresence></div>}
      {isSeller && lifecycle.canDispute && <div className="space-y-3"><button onClick={() => setShowDispute(v => !v)} className="w-full py-2.5 rounded-lg text-sm font-semibold border border-[var(--md-error)]/30 text-[var(--md-error)] hover:bg-[var(--md-error)]/10 transition-colors">🚨 Report a problem / open dispute</button><AnimatePresence>{showDispute && <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }} className="overflow-hidden space-y-2"><textarea className="input resize-none w-full text-sm" rows={3} placeholder="Describe the issue (min 20 chars)..." value={disputeText} onChange={e => setDisputeText(e.target.value)} /><button onClick={fileDispute} disabled={loading === 'dispute' || disputeText.trim().length < 20} className="btn-primary w-full text-sm disabled:opacity-40">{loading === 'dispute' ? 'Filing...' : 'Submit dispute'}</button></motion.div>}</AnimatePresence></div>}
      {tx.status === 'released' && <motion.div initial={{ scale:0.8, opacity:0 }} animate={{ scale:1, opacity:1 }} className="text-center space-y-2 py-2"><div className="text-3xl">{lifecycle.payout.settled ? '🎉' : '🛡️'}</div><div className="font-bold text-[var(--md-primary)]">{lifecycle.payout.settled ? 'Exchange complete' : 'Exchange resolved'}</div><p className="text-xs text-on-surface/50">{isSeller ? lifecycle.payout.description : lifecycle.payout.settled ? 'The seller payout has been confirmed.' : 'The transaction is resolved, but seller payout is not yet confirmed.'}</p></motion.div>}
      {tx.status === 'disputed' && <div className="text-center space-y-2"><p className="text-sm text-on-surface/50">Dispute filed. Review within 24 hours.</p>{tx.dispute_reason && <div className="p-3 rounded-md bg-[var(--md-surface-container-high)] text-xs text-on-surface/40 text-left"><span className="font-semibold text-on-surface/60">Reason: </span>{tx.dispute_reason}</div>}</div>}
    </motion.div>
  )
}

function PurchaseJourneyGuide() {
  const steps = [
    ['1. Pay securely', 'Complete checkout. Wait for Paystack verification before arranging pickup.'],
    ['2. Funds are protected', 'After payment is verified, PlugPay holds the money. The seller has not been paid yet.'],
    ['3. Arrange pickup', 'Use in-app chat to agree on a public campus meetup point and time. The seller starts the pickup flow.'],
    ['4. Inspect and confirm', 'Inspect the item before confirming the seller’s QR handoff. QR confirmation is available as soon as both participants have fresh check-ins in the same approved Safe Swap Zone.'],
    ['5. Inspection and dispute window', 'A QR-confirmed handoff starts a two-hour inspection window. A seller-requested release gives both participants a 48-hour dispute window. Open a dispute before the relevant deadline if there is a problem.'],
    ['6. Settlement is confirmed', 'When the deadline passes without a dispute, Campus Plug runs the server-side settlement. The transaction may be resolved before the payment rail confirms the seller payout. Check the payout status instead of assuming the countdown itself moved the money.'],
  ]

  return (
    <section className="surface space-y-4 p-4 sm:p-5" aria-labelledby="purchase-journey-title">
      <div>
        <h2 id="purchase-journey-title" className="font-bold text-sm">How a protected purchase works</h2>
        <p className="mt-1 text-xs leading-5 text-on-surface/60">The buyer receives the item before the seller receives the money. Keep coordination and proof of handoff inside Campus Plug.</p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        {steps.map(([title, description]) => (
          <li key={title} className="rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3">
            <p className="text-xs font-bold text-[var(--md-primary)]">{title}</p>
            <p className="mt-1 text-xs leading-5 text-on-surface/60">{description}</p>
          </li>
        ))}
      </ol>
      <p className="text-[11px] leading-5 text-on-surface/50">Never scan the QR or confirm receipt before you have inspected and received the item. You have two hours to dispute after QR handoff, or 48 hours to dispute after a seller-requested release. The deadline starts settlement processing; it is not proof that the seller has already been paid.</p>
    </section>
  )
}

export default function ListingDetail() {
  const { id } = useParams()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [activeImg, setActiveImg] = useState(0)
  const [buying, setBuying] = useState(false)
  const [liveTx, setLiveTx] = useState(null)

  const { data: listing, isLoading } = useQuery({
    queryKey: ['listing', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('listings')
        .select('*, profiles!listings_seller_id_fkey(id, full_name, university, plug_score, total_sales, avatar_url, badges, is_verified)')
        .eq('id', id).single()
      if (error) throw error
      return data
    },
  })

  const { data: existingTx } = useQuery({
    queryKey: ['transaction', id, user?.id],
    queryFn: async () => {
      const partyColumn = listing.seller_id === user.id ? 'seller_id' : 'buyer_id'
      const { data } = await supabase.from('transactions').select('*')
        .eq('listing_id', id).eq(partyColumn, user.id)
        .not('status', 'eq', 'cancelled')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      return data
    },
    enabled: !!user && !!listing,
  })

  useTransactionStatus(existingTx?.id, (updated) => {
    setLiveTx(updated)
    if (updated.status === 'locked') toast.success('🔐 Payment confirmed! Escrow active.')
    if (updated.status === 'released') toast.success('Transaction resolved. Settlement status is updating.')
    if (updated.status === 'disputed') toast('🚨 Dispute filed — under review')
  })

  // Ignore realtime state from a previously viewed listing/transaction.
  const activeTx = liveTx?.id === existingTx?.id ? liveTx : existingTx
  const isSeller = user?.id === listing?.seller_id

  const handleBuy = async () => {
    if (!profile) { toast.error('Complete your profile first'); return }
    setBuying(true)
    try {
      const ref = `CP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
      const amountInKobo = Number(listing.price)
      if (!Number.isSafeInteger(amountInKobo) || amountInKobo <= 0) throw new Error('This listing has an invalid price.')
      const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY
      if (!publicKey) throw new Error('Payment service is not configured. Please try again later.')
      const { data: tx, error } = await supabase.rpc('create_pending_paystack_transaction', { p_listing_id: listing.id, p_paystack_ref: ref })
      if (error) throw error
      if (tx?.success === false) {
        qc.invalidateQueries({ queryKey: ['listing', id] })
        qc.invalidateQueries({ queryKey: ['listings'] })
        qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })
        throw new Error(tx.message || 'This listing is no longer available.')
      }
      if (!tx?.id) throw new Error('The payment service did not create a transaction. Please try again.')
      try {
        await initPaystack({ email: user.email, amount: amountInKobo, ref, publicKey, metadata: { type: 'marketplace_escrow', transaction_id: tx.id, listing_id: listing.id } })
        const { data: verification, error: verificationError } = await supabase.functions.invoke('verify-payment', {
          body: { transaction_id: tx.id },
        })
        if (verificationError) throw verificationError
        if (!verification?.success && !verification?.already_verified) {
          qc.invalidateQueries({ queryKey: ['listing', id] })
          qc.invalidateQueries({ queryKey: ['listings'] })
          qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })
          toast('Payment received. We are confirming it with Paystack; your transaction will update automatically.', {
            icon: '⏳',
          })
          return
        }
      } catch (paymentError) {
        if (paymentError?.message === 'Payment cancelled') {
          await supabase.rpc('cancel_pending_transaction', { p_transaction_id: tx.id })
        }
        throw paymentError
      }
      qc.invalidateQueries({ queryKey: ['listing', id] })
      qc.invalidateQueries({ queryKey: ['listings'] })
      qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })
    } catch (e) {
      if (e.message !== 'Payment cancelled') toast.error(e.message)
    } finally { setBuying(false) }
  }

  if (isLoading) return <div className="page-shell max-w-4xl" aria-label="Loading listing"><div className="skeleton h-8 w-1/3 mb-6" /><div className="grid md:grid-cols-5 gap-8"><div className="md:col-span-3 skeleton aspect-video rounded-md" /><div className="md:col-span-2 space-y-4"><div className="skeleton h-36 rounded-md" /><div className="skeleton h-20 rounded-md" /><div className="skeleton h-24 rounded-md" /></div></div></div>
  if (!listing) return <div className="page-shell"><div className="surface mx-auto max-w-xl px-6 py-16 text-center"><div className="text-4xl mb-4">🔍</div><p className="font-bold">Listing unavailable</p><p className="mt-1 text-sm text-on-surface/40">This listing may have been removed or is no longer available.</p><Link to="/marketplace" className="btn-secondary mt-5">Back to Marketplace</Link></div></div>

  const images = listing.images?.length ? listing.images : [null]
  return (
    <div className="page-shell max-w-4xl">
      <button type="button" onClick={() => navigate(-1)} className="icon-button w-auto px-3 mb-6 text-sm"><ArrowLeft size={16} /> Back</button>
      <div className="grid md:grid-cols-5 gap-8">
        <div className="md:col-span-3 space-y-3">
          <div className="surface aspect-video overflow-hidden">{images[activeImg] ? <img src={images[activeImg]} alt={listing.title} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-6xl">📦</div>}</div>
          {images.length > 1 && <div className="flex gap-2">{images.map((img, i) => <button key={i} onClick={() => setActiveImg(i)} className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${activeImg === i ? 'border-primary' : 'border-[var(--md-outline-variant)]'}`}>{img ? <img src={img} className="w-full h-full object-cover" /> : <div className="w-full h-full bg-[var(--md-surface-container-high)] flex items-center justify-center">📦</div>}</button>)}</div>}
          {listing.description && <div className="surface p-5"><h3 className="font-bold text-sm mb-3">Description</h3><p className="text-sm text-on-surface/60 leading-relaxed whitespace-pre-wrap">{listing.description}</p></div>}
        </div>
        <div className="md:col-span-2 space-y-4">
          <div className="surface rounded-md p-5"><div className="flex items-start justify-between gap-3 mb-3"><span className="tag tag-cyan">{listing.category}</span>{listing.listing_mode === 'both' && <span className="tag tag-purple">SELL + RENT</span>}{isSeller && <button type="button" onClick={async () => {
            if (!window.confirm('Remove this listing from the marketplace?')) return
            try {
              const { data, error } = await supabase
                .from('listings')
                .delete()
                .eq('id', id)
                .eq('seller_id', user.id)
                .select('id')
                .maybeSingle()
              if (error) throw error
              if (!data) throw new Error('Listing could not be removed. It may already be sold or unavailable.')
              qc.removeQueries({ queryKey: ['listing', id] })
              qc.invalidateQueries({ queryKey: ['listings'] })
              toast.success('Listing removed')
              navigate('/marketplace', { replace: true })
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Failed to remove listing')
            }
          }} className="icon-button h-9 w-9 text-[var(--md-error)]/50 hover:text-[var(--md-error)]" aria-label="Delete listing"><Trash2 size={15} /></button>}</div><h1 className="text-xl font-black tracking-tight mb-2">{listing.title}</h1><motion.div className="text-3xl font-black text-[var(--md-primary)] font-mono" animate={activeTx?.status === 'locked' ? { color: ['var(--md-primary)', 'var(--md-secondary)', 'var(--md-primary)'] } : { color: 'var(--md-primary)' }} transition={{ duration: 2.5, repeat: activeTx?.status === 'locked' ? Infinity : 0 }}>{formatNaira(listing.price)}</motion.div>{listing.listing_mode === 'both' && <p className="mt-1 text-xs text-on-surface-variant">Sale price · rentals available at {formatNaira(listing.rental_daily_rate_kobo)} per day</p>}<div className="flex items-center gap-1.5 mt-1 text-xs text-on-surface/30"><MapPin size={11}/>{listing.university}</div></div>
          <Link to={`/profile/${listing.seller_id}`} className="surface surface-interactive flex items-center gap-3 p-4"><div className="w-10 h-10 rounded-sm bg-[var(--md-primary-container)] flex items-center justify-center text-on-primary font-bold flex-shrink-0">{listing.profiles?.full_name?.[0]?.toUpperCase()}</div><div className="flex-1 min-w-0"><div className="flex items-center gap-1.5 font-semibold text-sm">{listing.profiles?.full_name}{listing.profiles?.is_verified && <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--md-primary)]/10 px-1.5 py-0.5 text-[9px] font-bold text-[var(--md-primary)]"><Shield size={9} /> Verified</span>}</div><div className="text-xs text-on-surface/40">{listing.profiles?.total_sales} sales · PlugScore {listing.profiles?.plug_score}</div></div><span className="text-on-surface/20">→</span></Link>
          <div className="surface p-4"><div className="flex items-center gap-2 mb-1"><Shield size={13} className="text-[var(--md-primary)]"/><span className="text-xs font-bold text-[var(--md-primary)] uppercase tracking-wider">PlugPay Escrow + Dispute Protection</span></div><p className="text-xs text-on-surface/40">Funds stay protected through a two-hour QR inspection or a 48-hour seller-requested release window.</p></div>
          {!isSeller && listing.status === 'active' && !activeTx && <><PurchaseJourneyGuide /><button onClick={handleBuy} disabled={buying} className="btn-primary w-full text-base disabled:opacity-50">{buying ? 'Opening Paystack...' : `Buy securely — ${formatNaira(listing.price)}`}</button></>}
          {listing.listing_mode === 'both' && <GearRentalPanel listing={listing} />}
          {activeTx && <EscrowPanel tx={activeTx} isSeller={isSeller} otherUserId={isSeller ? activeTx.buyer_id : activeTx.seller_id} onRefresh={() => qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })} />}
          {listing.status === 'reserved' && !activeTx && <div className="surface p-5 text-center"><div className="font-bold text-sm">Reserved</div><p className="mt-1 text-xs text-on-surface/60">Another buyer has an active purchase for this listing. Check back if it becomes available again.</p></div>}
          {listing.status === 'sold' && <div className="surface p-5 text-center"><div className="text-2xl mb-2">✅</div><div className="font-bold text-sm">Sold</div></div>}
        </div>
      </div>
    </div>
  )
}
