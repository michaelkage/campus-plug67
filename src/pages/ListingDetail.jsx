import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useTransactionStatus } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { ArrowLeft, Shield, MapPin, Trash2, QrCode, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react'

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

const STEPS = ['pending','locked','meetup_initiated','release_requested','released']
const STEP_LABELS = { pending:'Pay', locked:'Locked', meetup_initiated:'Meetup', release_requested:'Req.Release', released:'Done' }
const STATUS_META = {
  pending:           { color:'amber', icon:'⏳', label:'Awaiting Payment' },
  locked:            { color:'cyan',  icon:'🔐', label:'Funds Locked — Arrange Meetup' },
  meetup_initiated:  { color:'cyan',  icon:'📍', label:'Meetup Initiated' },
  release_requested: { color:'amber', icon:'⏰', label:'Release Requested' },
  disputed:          { color:'red',   icon:'🚨', label:'Under Dispute Review' },
  released:          { color:'green', icon:'✅', label:'Exchange Complete' },
  cancelled:         { color:'red',   icon:'❌', label:'Cancelled' },
}
const COLOR_CLASS = {
  amber: 'border-plug-amber/30 bg-plug-amber/5',
  cyan:  'border-cyan/30 bg-cyan/5',
  green: 'border-plug-green/30 bg-plug-green/5',
  red:   'border-plug-red/30 bg-plug-red/5',
}

function EscrowPanel({ tx, isSeller, onRefresh }) {
  const [showDispute, setShowDispute] = useState(false)
  const [disputeText, setDisputeText] = useState('')
  const [qrInput, setQrInput] = useState('')
  const [loading, setLoading] = useState(null)
  const { session } = useAuth()

  const edge = async (action, extra = {}) => {
    setLoading(action)
    try {
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

  const meta = STATUS_META[tx.status] || STATUS_META.pending
  const stepIdx = STEPS.indexOf(tx.status)

  const autoReleaseMs = tx.auto_release_at ? Math.max(0, new Date(tx.auto_release_at) - Date.now()) : null
  const hoursLeft = autoReleaseMs != null ? Math.floor(autoReleaseMs / 3_600_000) : null
  const minsLeft  = autoReleaseMs != null ? Math.floor((autoReleaseMs % 3_600_000) / 60_000) : null

  return (
    <motion.div
      className={`rounded-2xl border p-5 ${COLOR_CLASS[meta.color] || COLOR_CLASS.amber}`}
      animate={tx.status === 'locked'
        ? { boxShadow: ['0 0 0 0 rgba(0,242,255,0)', '0 0 28px 6px rgba(0,242,255,0.18)', '0 0 0 0 rgba(0,242,255,0)'] }
        : { boxShadow: '0 0 0 0 rgba(0,0,0,0)' }
      }
      transition={{ duration: 2.8, repeat: tx.status === 'locked' ? Infinity : 0 }}
    >
      <div className="flex items-center gap-3 mb-4">
        <span className="text-2xl">{meta.icon}</span>
        <div>
          <div className="font-bold text-sm">{meta.label}</div>
          <div className="text-xs text-white/30">PlugPay Escrow</div>
        </div>
      </div>

      {/* Step bar */}
      <div className="flex items-center gap-1 mb-5 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const active = i <= stepIdx && !['disputed','cancelled'].includes(tx.status)
          return (
            <div key={s} className="flex items-center gap-1 flex-shrink-0">
              <div className={`px-2 py-0.5 rounded-full text-[9px] font-bold transition-all ${active ? 'bg-cyan text-obsidian' : 'bg-obsidian-300 text-white/25'}`}>
                {STEP_LABELS[s]}
              </div>
              {i < STEPS.length - 1 && <div className={`w-3 h-px ${i < stepIdx ? 'bg-cyan' : 'bg-obsidian-500'}`} />}
            </div>
          )
        })}
      </div>

      {/* Auto-release timer */}
      {tx.status === 'release_requested' && hoursLeft != null && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-obsidian-300 text-sm mb-4">
          <Clock size={13} className="text-plug-amber" />
          <span className="text-white/50">Auto-releases in </span>
          <span className="font-mono font-bold text-plug-amber">{hoursLeft}h {minsLeft}m</span>
        </div>
      )}

      {/* ── SELLER ── */}
      {isSeller && tx.status === 'locked' && (
        <div className="space-y-3">
          <p className="text-xs text-white/50">Payment received and locked. Arrange your campus meetup, then confirm below.</p>
          <button onClick={() => edge('initiate_meetup')} disabled={loading === 'initiate_meetup'}
            className="btn-primary w-full text-sm disabled:opacity-50">
            {loading === 'initiate_meetup' ? 'Confirming...' : '📍 Confirm Meetup Started'}
          </button>
        </div>
      )}

      {isSeller && tx.status === 'meetup_initiated' && (
        <div className="space-y-3">
          <p className="text-xs text-white/50">Show this QR code to the buyer to release your funds instantly.</p>
          <div className="flex justify-center">
            <div className="p-3 bg-white rounded-2xl">
              <QRCodeSVG value={tx.qr_secret} size={172} bgColor="#fff" fgColor="#080B0F" level="M" />
            </div>
          </div>
          <p className="text-[10px] font-mono text-white/20 text-center break-all">{tx.qr_secret}</p>
          <button onClick={() => edge('request_release')} disabled={loading === 'request_release'}
            className="w-full py-2.5 rounded-lg text-sm font-semibold border border-plug-amber/30
                       text-plug-amber hover:bg-plug-amber/10 transition-colors disabled:opacity-40">
            {loading === 'request_release' ? 'Requesting...' : '⏰ Request Release (24h+ elapsed)'}
          </button>
        </div>
      )}

      {isSeller && tx.status === 'release_requested' && (
        <p className="text-xs text-white/50">Buyer has 48h to dispute. Funds auto-release after the window.</p>
      )}

      {/* ── BUYER ── */}
      {!isSeller && tx.status === 'meetup_initiated' && (
        <div className="space-y-3">
          <p className="text-xs text-white/50">At the meetup? Enter the seller's QR code to confirm and release funds.</p>
          <div className="flex gap-2">
            <input className="input flex-1 text-sm font-mono" placeholder="Paste QR code / UUID..."
              value={qrInput} onChange={e => setQrInput(e.target.value)} />
            <button onClick={() => edge('release', { qr_secret: qrInput.trim() })}
              disabled={loading === 'release' || !qrInput.trim()}
              className="btn-primary px-4 disabled:opacity-50 flex items-center gap-1.5 text-sm whitespace-nowrap">
              <QrCode size={14} /> {loading === 'release' ? '...' : 'Release'}
            </button>
          </div>
        </div>
      )}

      {!isSeller && tx.status === 'release_requested' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-plug-amber/10">
            <AlertTriangle size={13} className="text-plug-amber flex-shrink-0 mt-0.5" />
            <p className="text-xs text-white/60">
              Seller requested release. Funds auto-release in <strong className="text-plug-amber">{hoursLeft}h {minsLeft}m</strong>. Not received the item?
            </p>
          </div>
          <button onClick={() => setShowDispute(v => !v)}
            className="w-full py-2.5 rounded-lg text-sm font-semibold border border-plug-red/30
                       text-plug-red hover:bg-plug-red/10 transition-colors">
            🚨 File a Dispute
          </button>
          <AnimatePresence>
            {showDispute && (
              <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }}
                exit={{ opacity:0, height:0 }} className="overflow-hidden space-y-2">
                <textarea className="input resize-none w-full text-sm" rows={3}
                  placeholder="Describe the issue (min 20 chars)..."
                  value={disputeText} onChange={e => setDisputeText(e.target.value)} />
                <button onClick={() => edge('dispute', { reason: disputeText })}
                  disabled={loading === 'dispute' || disputeText.length < 20}
                  className="btn-primary w-full text-sm disabled:opacity-40">
                  {loading === 'dispute' ? 'Filing...' : 'Submit Dispute'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {tx.status === 'released' && (
        <motion.div initial={{ scale:0.8, opacity:0 }} animate={{ scale:1, opacity:1 }}
          className="text-center space-y-2 py-2">
          <div className="text-3xl">🎉</div>
          <div className="font-bold text-plug-green">Exchange Complete!</div>
          <p className="text-xs text-white/40">{isSeller ? 'Funds released to your account.' : 'Enjoy your item!'}</p>
        </motion.div>
      )}

      {tx.status === 'disputed' && (
        <div className="text-center space-y-2">
          <p className="text-sm text-white/50">Dispute filed. Review within 24 hours.</p>
          {tx.dispute_reason && (
            <div className="p-3 rounded-xl bg-obsidian-300 text-xs text-white/40 text-left">
              <span className="font-semibold text-white/60">Reason: </span>{tx.dispute_reason}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}

export default function ListingDetail() {
  const { id } = useParams()
  const { user, profile, session } = useAuth()
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
        .select('*, profiles(id, full_name, university, plug_score, total_sales, avatar_url, badges)')
        .eq('id', id).single()
      if (error) throw error
      return data
    },
  })

  const { data: existingTx } = useQuery({
    queryKey: ['transaction', id, user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('transactions').select('*')
        .eq('listing_id', id).eq('buyer_id', user.id)
        .not('status', 'eq', 'cancelled')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      return data
    },
    enabled: !!user && !!listing && listing.seller_id !== user.id,
  })

  useTransactionStatus(existingTx?.id, (updated) => {
    setLiveTx(updated)
    if (updated.status === 'locked') toast.success('🔐 Payment confirmed! Escrow active.')
    if (updated.status === 'released') toast.success('🎉 Exchange complete!')
    if (updated.status === 'disputed') toast('🚨 Dispute filed — under review')
  })

  const activeTx = liveTx || existingTx
  const isSeller = user?.id === listing?.seller_id

  const handleBuy = async () => {
    if (!profile) { toast.error('Complete your profile first'); return }
    setBuying(true)
    try {
      const ref = `CP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
      const { data: tx, error } = await supabase.from('transactions').insert({
        listing_id: listing.id, buyer_id: user.id, seller_id: listing.seller_id,
        amount: listing.price, status: 'pending', paystack_ref: ref,
      }).select().single()
      if (error) throw error

      await initPaystack({
        email: user.email, amount: listing.price, ref,
        publicKey: import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
        metadata: { type: 'marketplace_escrow', transaction_id: tx.id, listing_id: listing.id },
      })
      qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })
    } catch (e) {
      if (e.message !== 'Payment cancelled') toast.error(e.message)
    } finally { setBuying(false) }
  }

  if (isLoading) return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-pulse space-y-4">
      <div className="h-8 bg-obsidian-400 rounded w-1/3" />
      <div className="aspect-video bg-obsidian-400 rounded-2xl" />
    </div>
  )
  if (!listing) return <div className="text-center py-20 text-white/30"><p className="text-4xl mb-4">🔍</p><p>Not found</p></div>

  const images = listing.images?.length ? listing.images : [null]

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-white/40 hover:text-cyan text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back
      </button>

      <div className="grid md:grid-cols-5 gap-8">
        <div className="md:col-span-3 space-y-3">
          <div className="aspect-video rounded-2xl bg-obsidian-400 border border-obsidian-500 overflow-hidden">
            {images[activeImg] ? <img src={images[activeImg]} alt={listing.title} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-6xl">📦</div>}
          </div>
          {images.length > 1 && (
            <div className="flex gap-2">
              {images.map((img, i) => (
                <button key={i} onClick={() => setActiveImg(i)}
                  className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${activeImg === i ? 'border-cyan' : 'border-obsidian-500'}`}>
                  {img ? <img src={img} className="w-full h-full object-cover" />
                       : <div className="w-full h-full bg-obsidian-300 flex items-center justify-center">📦</div>}
                </button>
              ))}
            </div>
          )}
          {listing.description && (
            <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5">
              <h3 className="font-bold text-sm mb-3">Description</h3>
              <p className="text-sm text-white/60 leading-relaxed whitespace-pre-wrap">{listing.description}</p>
            </div>
          )}
        </div>

        <div className="md:col-span-2 space-y-4">
          <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <span className="tag tag-cyan">{listing.category}</span>
              {isSeller && (
                <button onClick={() => { if (window.confirm('Delete listing?')) { supabase.from('listings').update({status:'deleted'}).eq('id',id); navigate('/marketplace') } }}
                  className="p-1.5 text-plug-red/50 hover:text-plug-red rounded-lg transition-colors">
                  <Trash2 size={15} />
                </button>
              )}
            </div>
            <h1 className="text-xl font-black tracking-tight mb-2">{listing.title}</h1>
            <motion.div className="text-3xl font-black text-cyan font-mono"
              animate={activeTx?.status === 'locked' ? { color: ['#00F2FF','#00FF88','#00F2FF'] } : { color: '#00F2FF' }}
              transition={{ duration: 2.5, repeat: activeTx?.status === 'locked' ? Infinity : 0 }}>
              {formatNaira(listing.price)}
            </motion.div>
            <div className="flex items-center gap-1.5 mt-1 text-xs text-white/30"><MapPin size={11}/>{listing.university}</div>
          </div>

          <Link to={`/profile/${listing.seller_id}`}
            className="flex items-center gap-3 bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 hover:border-cyan/30 transition-colors">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan to-purple flex items-center justify-center text-obsidian font-bold flex-shrink-0">
              {listing.profiles?.full_name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{listing.profiles?.full_name}</div>
              <div className="text-xs text-white/40">{listing.profiles?.total_sales} sales · PlugScore {listing.profiles?.plug_score}</div>
            </div>
            <span className="text-white/20">→</span>
          </Link>

          <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1"><Shield size={13} className="text-plug-green"/>
              <span className="text-xs font-bold text-plug-green uppercase tracking-wider">PlugPay Escrow + Dispute Protection</span>
            </div>
            <p className="text-xs text-white/40">Funds locked until QR handshake. 48h dispute window on every transaction.</p>
          </div>

          {!isSeller && listing.status === 'active' && !activeTx && (
            <button onClick={handleBuy} disabled={buying} className="btn-primary w-full text-base disabled:opacity-50">
              {buying ? 'Opening Paystack...' : `Buy Now — ${formatNaira(listing.price)}`}
            </button>
          )}

          {activeTx && (
            <EscrowPanel tx={activeTx} isSeller={isSeller}
              onRefresh={() => qc.invalidateQueries({ queryKey: ['transaction', id, user.id] })} />
          )}

          {listing.status === 'sold' && (
            <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5 text-center">
              <div className="text-2xl mb-2">✅</div><div className="font-bold text-sm">Sold</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
