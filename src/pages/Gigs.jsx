// src/pages/Gigs.jsx
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira, toKobo, uploadImage } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Star, Zap } from 'lucide-react'

const GIG_CATEGORIES = ['Tech Repair', 'Tutoring', 'Design', 'Hair & Beauty', 'Food', 'Laundry', 'Errand', 'Writing', 'Other']

function GigCard({ gig }) {
  return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5 hover:border-purple/40 hover:-translate-y-1 transition-all duration-200 relative">
      <div className="absolute top-4 right-4">
        <span className="tag tag-green text-[9px]">0% FEE</span>
      </div>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple to-cyan flex items-center justify-center text-obsidian font-bold text-sm flex-shrink-0">
          {gig.profiles?.full_name?.[0]?.toUpperCase() || '?'}
        </div>
        <div>
          <div className="text-sm font-semibold">{gig.profiles?.full_name}</div>
          <div className="text-xs text-white/40">{gig.profiles?.university}</div>
        </div>
      </div>
      <h3 className="font-bold mb-2">{gig.title}</h3>
      <p className="text-sm text-white/50 mb-4 line-clamp-2">{gig.description}</p>
      <div className="flex items-center justify-between">
        <span className="font-mono font-black text-cyan text-sm">{formatNaira(gig.starting_price)}</span>
        <span className="tag tag-purple text-[10px]">{gig.category}</span>
      </div>
    </div>
  )
}

export function Gigs() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', category: '', starting_price: '' })
  const [filter, setFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const { data: gigs = [], isLoading } = useQuery({
    queryKey: ['gigs', filter],
    queryFn: async () => {
      let q = supabase.from('gigs').select('*, profiles(full_name, university)').eq('active', true).order('created_at', { ascending: false })
      if (filter) q = q.eq('category', filter)
      const { data, error } = await q
      if (error) throw error
      return data || []
    },
  })

  useRealtimeTable({
    table: 'gigs',
    onInsert: (g) => qc.setQueryData(['gigs', filter], old => [g, ...(old || [])]),
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const { error } = await supabase.from('gigs').insert({
        seller_id: profile.id,
        title: form.title,
        description: form.description,
        category: form.category,
        starting_price: toKobo(form.starting_price),
        university: profile.university,
        active: true,
      })
      if (error) throw error
      await supabase.from('activity_feed').insert({
        actor_name: profile.full_name,
        actor_id: profile.id,
        action: 'listed a new gig',
        subject: form.title,
        emoji: '⚡',
        university: profile.university,
      })
      toast.success('Gig listed! 🎉')
      qc.invalidateQueries({ queryKey: ['gigs'] })
      setShowCreate(false)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="section-label">Gig Economy</p>
          <h1 className="text-2xl font-black tracking-tight">Student Services</h1>
          <div className="flex items-center gap-2 mt-1">
            <Zap size={12} className="text-plug-green" />
            <span className="text-xs text-plug-green font-semibold">Zero commission for student sellers. Always.</span>
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 self-start">
          <Plus size={16} /> List a Service
        </button>
      </div>

      <div className="flex gap-2 flex-wrap mb-6">
        {['', ...GIG_CATEGORIES].map(c => (
          <button key={c || 'all'} onClick={() => setFilter(c)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
              filter === c ? 'bg-purple text-white border-purple' : 'bg-obsidian-400 text-white/50 border-obsidian-500 hover:border-purple/30'
            }`}>
            {c || 'All Services'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5 animate-pulse h-44" />
          ))}
        </div>
      ) : gigs.length === 0 ? (
        <div className="text-center py-20 text-white/30">
          <div className="text-4xl mb-4">⚡</div>
          <p className="font-semibold">No gigs listed yet</p>
          <p className="text-sm mt-1">Be the first to offer a service!</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {gigs.map(gig => <GigCard key={gig.id} gig={gig} />)}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowCreate(false)} />
          <div className="relative z-10 w-full max-w-md bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-obsidian-500">
              <h2 className="font-bold">List a Service</h2>
              <button onClick={() => setShowCreate(false)} className="text-white/30 hover:text-white"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div><label className="label">Service Title</label><input className="input" placeholder="e.g. Hair Braiding — Knotless Styles" value={form.title} onChange={set('title')} required /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Category</label>
                  <select className="input" value={form.category} onChange={set('category')} required>
                    <option value="">Select</option>
                    {GIG_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div><label className="label">Starting Price (₦)</label><input className="input" type="number" placeholder="0" value={form.starting_price} onChange={set('starting_price')} required /></div>
              </div>
              <div><label className="label">Description</label><textarea className="input resize-none" rows={3} placeholder="What do you offer? Turnaround, what's included, etc." value={form.description} onChange={set('description')} /></div>
              <button type="submit" disabled={submitting} className="btn-primary w-full disabled:opacity-50">
                {submitting ? 'Listing...' : 'Publish Gig'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default Gigs
