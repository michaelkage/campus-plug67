import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira, toKobo } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Users, Clock, Zap, ShoppingCart } from 'lucide-react'

const POOL_CATEGORIES = ['Group Buy', 'Stationery', 'Food & Snacks', 'Lab Supplies', 'Toiletries', 'Event Tickets', 'Other']

// ── Time remaining helper ─────────────────────────────────────────────────────
function timeLeft(expiresAt) {
  const diff = new Date(expiresAt) - Date.now()
  if (diff <= 0) return 'Expired'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 24 ? `${Math.floor(h/24)}d ${h%24}h` : `${h}h ${m}m`
}

// ── Create Pool Modal ─────────────────────────────────────────────────────────
function CreatePoolModal({ onClose, profile }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    title: '', item_name: '', description: '',
    category: '', unit_price: '', total_price: '',
    max_capacity: '', supplier_info: '', expires_hours: '48',
  })
  const [submitting, setSubmitting] = useState(false)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (parseInt(form.max_capacity) < 2) { toast.error('Pool needs at least 2 participants'); return }
    setSubmitting(true)
    try {
      const expiresAt = new Date(Date.now() + parseInt(form.expires_hours) * 3_600_000).toISOString()
      const { error } = await supabase.from('study_pools').insert({
        organizer_id:  profile.id,
        title:         form.title,
        item_name:     form.item_name,
        description:   form.description,
        category:      form.category || 'Group Buy',
        unit_price:    toKobo(form.unit_price),
        total_price:   toKobo(form.total_price),
        max_capacity:  parseInt(form.max_capacity),
        current_count: 1,
        participants:  [profile.id],
        university:    profile.university,
        expires_at:    expiresAt,
        supplier_info: form.supplier_info || null,
      })
      if (error) throw error

      await supabase.from('activity_feed').insert({
        actor_name: profile.full_name, actor_id: profile.id,
        action: 'started a study pool', subject: form.title,
        emoji: '🛒', university: profile.university,
      })

      toast.success('Pool created! Share it with your course mates 🎉')
      qc.invalidateQueries({ queryKey: ['pools'] })
      onClose()
    } catch (e) { toast.error(e.message) }
    finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="relative z-10 w-full max-w-lg bg-obsidian-400 border border-obsidian-500 rounded-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="sticky top-0 bg-obsidian-400 border-b border-obsidian-500 px-6 py-4 flex items-center justify-between">
          <h2 className="font-bold text-lg">Start a Study Pool</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white"><X size={18}/></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="bg-cyan/5 border border-cyan/20 rounded-xl p-4 text-sm text-white/60">
            <strong className="text-cyan">How pools work:</strong> Set a group buy deal.
            Students join and pay their share. When full, the pool locks and you purchase together at the bulk price.
          </div>

          <div><label className="label">Pool Title</label>
            <input className="input" placeholder='e.g. "Bulk A4 Paper — Faculty of Science"'
              value={form.title} onChange={set('title')} required /></div>

          <div><label className="label">Item Name</label>
            <input className="input" placeholder='e.g. "Ream of Balogun A4 Paper (500 sheets)"'
              value={form.item_name} onChange={set('item_name')} required /></div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Category</label>
              <select className="input" value={form.category} onChange={set('category')}>
                <option value="">Select</option>
                {POOL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div><label className="label">Max Participants</label>
              <input className="input" type="number" min="2" max="50" placeholder="e.g. 10"
                value={form.max_capacity} onChange={set('max_capacity')} required /></div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Per-Person Price (₦)</label>
              <input className="input" type="number" placeholder="e.g. 500"
                value={form.unit_price} onChange={set('unit_price')} required /></div>
            <div><label className="label">Full Deal Price (₦)</label>
              <input className="input" type="number" placeholder="e.g. 4500"
                value={form.total_price} onChange={set('total_price')} required /></div>
          </div>

          <div><label className="label">Pool Duration</label>
            <select className="input" value={form.expires_hours} onChange={set('expires_hours')}>
              <option value="24">24 hours</option>
              <option value="48">48 hours</option>
              <option value="72">72 hours</option>
              <option value="120">5 days</option>
            </select>
          </div>

          <div><label className="label">Supplier Info (optional)</label>
            <input className="input" placeholder="Where you'll buy from, contact, etc."
              value={form.supplier_info} onChange={set('supplier_info')} /></div>

          <div><label className="label">Description</label>
            <textarea className="input resize-none" rows={2} placeholder="Any extra details..."
              value={form.description} onChange={set('description')} /></div>

          <button type="submit" disabled={submitting} className="btn-primary w-full disabled:opacity-50">
            {submitting ? 'Creating...' : '🛒 Create Pool'}
          </button>
        </form>
      </motion.div>
    </div>
  )
}

// ── Pool Card ─────────────────────────────────────────────────────────────────
function PoolCard({ pool, myId, onJoin }) {
  const isOrganizer = pool.organizer_id === myId
  const isMember    = pool.participants?.includes(myId)
  const pct         = (pool.current_count / pool.max_capacity) * 100
  const spotsLeft   = pool.max_capacity - pool.current_count
  const expired     = new Date(pool.expires_at) < new Date()

  const statusColor = {
    open:      'border-cyan/20 hover:border-cyan/40',
    locked:    'border-plug-green/20 hover:border-plug-green/40',
    completed: 'border-obsidian-500 opacity-60',
    cancelled: 'border-obsidian-500 opacity-40',
  }

  const savingsPct = pool.total_price > 0
    ? Math.round((1 - pool.unit_price * pool.max_capacity / pool.total_price) * 100)
    : 0

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-obsidian-400 border rounded-2xl p-5 transition-all duration-200 ${statusColor[pool.status] || statusColor.open}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="tag tag-cyan text-[10px]">{pool.category}</span>
            {pool.status === 'locked' && <span className="tag tag-green text-[10px]">🔒 FULL</span>}
            {expired && pool.status === 'open' && <span className="tag tag-red text-[10px]">EXPIRED</span>}
          </div>
          <h3 className="font-bold text-base leading-snug">{pool.title}</h3>
          <p className="text-xs text-white/50 mt-0.5">{pool.item_name}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-lg font-black text-cyan font-mono">{formatNaira(pool.unit_price)}</div>
          <div className="text-xs text-white/40">per person</div>
          {savingsPct > 0 && (
            <div className="text-[10px] text-plug-green font-bold mt-0.5">~{savingsPct}% cheaper</div>
          )}
        </div>
      </div>

      {pool.description && (
        <p className="text-sm text-white/50 mb-3 line-clamp-2">{pool.description}</p>
      )}

      {/* Progress bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs mb-1.5">
          <div className="flex items-center gap-1.5 text-white/50">
            <Users size={11} />
            <span>{pool.current_count}/{pool.max_capacity} joined</span>
          </div>
          <span className={`font-bold ${spotsLeft <= 2 ? 'text-plug-red' : 'text-white/40'}`}>
            {pool.status === 'locked' ? 'Full!' : `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} left`}
          </span>
        </div>
        <div className="h-2 bg-obsidian-300 rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${pool.status === 'locked' ? 'bg-plug-green' : 'bg-gradient-to-r from-cyan to-purple'}`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Participant avatars */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex -space-x-2">
          {Array.from({ length: Math.min(pool.current_count, 6) }).map((_, i) => (
            <div key={i} className="w-6 h-6 rounded-full bg-gradient-to-br from-cyan to-purple
                                    border border-obsidian-400 flex items-center justify-center text-[9px] font-bold text-obsidian">
              {String.fromCharCode(65 + i)}
            </div>
          ))}
          {pool.current_count > 6 && (
            <div className="w-6 h-6 rounded-full bg-obsidian-300 border border-obsidian-400
                            flex items-center justify-center text-[9px] text-white/40">
              +{pool.current_count - 6}
            </div>
          )}
        </div>
        {!expired && pool.status === 'open' && (
          <div className="flex items-center gap-1 text-xs text-white/30 ml-auto">
            <Clock size={10}/> {timeLeft(pool.expires_at)}
          </div>
        )}
      </div>

      {/* CTA */}
      {pool.status === 'open' && !expired && !isMember && !isOrganizer && (
        <button onClick={() => onJoin(pool)}
          className="btn-primary w-full text-sm flex items-center justify-center gap-2">
          <ShoppingCart size={14} />
          Join Pool — {formatNaira(pool.unit_price)}
        </button>
      )}

      {(isMember || isOrganizer) && pool.status === 'open' && (
        <div className="w-full py-2.5 rounded-lg text-sm font-semibold text-center
                        bg-plug-green/10 text-plug-green border border-plug-green/20">
          ✓ You're In{isOrganizer ? ' (Organizer)' : ''}
        </div>
      )}

      {pool.status === 'locked' && isMember && (
        <div className="w-full py-2.5 rounded-lg text-sm font-semibold text-center
                        bg-plug-green/10 text-plug-green border border-plug-green/20">
          🔒 Pool Full — Purchase Pending
        </div>
      )}

      {pool.status === 'locked' && !isMember && (
        <div className="w-full py-2.5 rounded-lg text-sm text-center text-white/30">
          Pool is full
        </div>
      )}

      {expired && pool.status === 'open' && (
        <div className="w-full py-2.5 rounded-lg text-sm text-center text-plug-red/60">
          Pool expired
        </div>
      )}
    </motion.div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function StudyPools() {
  const { profile, session, user } = useAuth()
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [filter, setFilter] = useState('all') // all | mine | joined

  const { data: pools = [], isLoading } = useQuery({
    queryKey: ['pools', filter, profile?.university],
    queryFn: async () => {
      let q = supabase.from('study_pools').select('*, profiles(full_name, university)')
        .order('created_at', { ascending: false }).limit(40)

      if (profile?.university) q = q.eq('university', profile.university)
      if (filter === 'mine')   q = q.eq('organizer_id', user.id)

      const { data, error } = await q
      if (error) throw error

      let results = data || []
      if (filter === 'joined') {
        results = results.filter(p => p.participants?.includes(user.id))
      }
      return results
    },
    enabled: !!profile,
  })

  // Real-time: update pool counts live
  useRealtimeTable({
    table: 'study_pools',
    onInsert: (pool) => {
      if (pool.university !== profile?.university) return
      qc.setQueryData(['pools', filter, profile?.university], old => [pool, ...(old || [])])
    },
    onUpdate: (updated) => {
      qc.setQueryData(['pools', filter, profile?.university], old =>
        (old || []).map(p => p.id === updated.id ? { ...p, ...updated } : p)
      )
    },
  })

  const handleJoin = async (pool) => {
    if (!session) { toast.error('Please sign in'); return }

    // Call Edge Function to join pool
    try {
      // First init paystack for payment
      const ref = `POOL-${pool.id.slice(0,8)}-${Date.now()}`
      await new Promise((resolve, reject) => {
        const launch = () => {
          const h = window.PaystackPop.setup({
            key: import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
            email: user.email,
            amount: pool.unit_price,
            ref, currency: 'NGN',
            metadata: { type: 'pool_join', pool_id: pool.id, user_id: user.id },
            callback: resolve,
            onClose: () => reject(new Error('Payment cancelled')),
          })
          h.openIframe()
        }
        if (window.PaystackPop) { launch(); return }
        const s = document.createElement('script')
        s.src = 'https://js.paystack.co/v1/inline.js'
        s.onload = launch
        s.onerror = () => reject(new Error('Paystack failed'))
        document.head.appendChild(s)
      })

      // Payment done → call Edge Function to update DB
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/join-pool`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ pool_id: pool.id, paystack_ref: ref }),
        }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Joined! ${data.spots_remaining} spot${data.spots_remaining !== 1 ? 's' : ''} remaining.`)
      qc.invalidateQueries({ queryKey: ['pools'] })
    } catch (e) {
      if (e.message !== 'Payment cancelled') toast.error(e.message)
    }
  }

  const openPools    = pools.filter(p => p.status === 'open' && new Date(p.expires_at) > new Date())
  const lockedPools  = pools.filter(p => p.status === 'locked')
  const expiredPools = pools.filter(p => p.status === 'open' && new Date(p.expires_at) <= new Date())

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="section-label">Group Buying</p>
          <h1 className="text-2xl font-black tracking-tight">Study Pools</h1>
          <p className="text-sm text-white/40 mt-1">Buy in bulk, save together. Pool up with course mates.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 self-start">
          <Plus size={16} /> Start a Pool
        </button>
      </div>

      {/* How it works */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        {[
          { icon: '🛒', title: 'Organiser creates', desc: 'Sets item, price per person & max capacity' },
          { icon: '👥', title: 'Students join & pay', desc: 'Each pays their share via PlugPay' },
          { icon: '🔒', title: 'Pool locks when full', desc: 'Organiser purchases at the bulk rate' },
        ].map(({ icon, title, desc }) => (
          <div key={title} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 text-center">
            <div className="text-2xl mb-2">{icon}</div>
            <div className="text-xs font-bold mb-1">{title}</div>
            <div className="text-xs text-white/40">{desc}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {[
          { val: 'all',    label: 'All Pools' },
          { val: 'joined', label: '✓ Joined' },
          { val: 'mine',   label: '⚡ My Pools' },
        ].map(({ val, label }) => (
          <button key={val} onClick={() => setFilter(val)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold border transition-all ${
              filter === val ? 'bg-cyan text-obsidian border-cyan' : 'bg-transparent text-white/40 border-obsidian-500 hover:border-cyan/30'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-5 animate-pulse h-56" />
          ))}
        </div>
      ) : pools.length === 0 ? (
        <div className="text-center py-20 text-white/30">
          <div className="text-4xl mb-4">🛒</div>
          <p className="font-semibold">No pools yet</p>
          <p className="text-sm mt-1">Start one and invite your course mates!</p>
        </div>
      ) : (
        <div className="space-y-6">
          {openPools.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="plug-dot" />
                <span className="text-sm font-bold text-plug-green">Open Pools ({openPools.length})</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                {openPools.map(p => <PoolCard key={p.id} pool={p} myId={user?.id} onJoin={handleJoin} />)}
              </div>
            </div>
          )}

          {lockedPools.length > 0 && (
            <div>
              <div className="text-sm font-bold text-plug-amber mb-4">🔒 Full Pools ({lockedPools.length})</div>
              <div className="grid sm:grid-cols-2 gap-4">
                {lockedPools.map(p => <PoolCard key={p.id} pool={p} myId={user?.id} onJoin={handleJoin} />)}
              </div>
            </div>
          )}

          {expiredPools.length > 0 && (
            <div>
              <div className="text-sm font-bold text-white/30 mb-4">Expired ({expiredPools.length})</div>
              <div className="grid sm:grid-cols-2 gap-4">
                {expiredPools.map(p => <PoolCard key={p.id} pool={p} myId={user?.id} onJoin={handleJoin} />)}
              </div>
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {showCreate && <CreatePoolModal onClose={() => setShowCreate(false)} profile={profile} />}
      </AnimatePresence>
    </div>
  )
}
