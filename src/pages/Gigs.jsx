import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira, toKobo } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Zap, GraduationCap } from 'lucide-react'

const GIG_CATEGORIES = ['Tech Repair', 'Tutoring', 'Design', 'Hair & Beauty', 'Food', 'Laundry', 'Errand', 'Writing', 'Other']
const ACADEMIC_GIGS = ['GST 101/102 Summary Notes', 'Engineering Drawing Board Rental', 'Lab Coat & Safety Goggles', 'Departmental Printing / Binding', 'Past Questions & Revision Packs']

function GigCard({ gig }) {
  return <div className="surface surface-interactive relative p-5">
    <div className="absolute right-4 top-4"><span className="tag tag-green text-[9px]">0% FEE</span></div>
    <div className="mb-4 flex items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-purple to-cyan text-sm font-bold text-obsidian">{gig.profiles?.full_name?.[0]?.toUpperCase() || '?'}</div><div className="min-w-0"><div className="truncate text-sm font-semibold">{gig.profiles?.full_name}</div><div className="truncate text-xs text-white/40">{gig.profiles?.university}</div></div></div>
    <h3 className="mb-2 font-bold">{gig.title}</h3><p className="mb-4 line-clamp-2 text-sm text-white/50">{gig.description}</p>
    <div className="flex items-center justify-between gap-3"><span className="font-mono text-sm font-black text-cyan">{formatNaira(gig.starting_price)}</span><span className="tag tag-purple text-[10px]">{gig.category}</span></div>
  </div>
}

export function Gigs() {
  const { profile } = useAuth(); const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false); const [form, setForm] = useState({ title: '', description: '', category: '', starting_price: '' }); const [filter, setFilter] = useState(''); const [submitting, setSubmitting] = useState(false)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const { data: gigs = [], isLoading } = useQuery({ queryKey: ['gigs', filter, profile?.university], enabled: Boolean(profile?.university), queryFn: async () => { let q = supabase.from('gigs').select('*, profiles(full_name, university)').eq('active', true).eq('university', profile?.university).order('created_at', { ascending: false }); if (filter) q = q.eq('category', filter); const { data, error } = await q; if (error) throw error; return data || [] } })
  useRealtimeTable({ table: 'gigs', onInsert: g => { if (g.university === profile?.university) qc.setQueryData(['gigs', filter, profile?.university], old => [g, ...(old || [])]) } })
  const handleSubmit = async e => { e.preventDefault(); setSubmitting(true); try { const { error } = await supabase.from('gigs').insert({ seller_id: profile.id, title: form.title, description: form.description, category: form.category, starting_price: toKobo(form.starting_price), university: profile.university, active: true }); if (error) throw error; await supabase.from('activity_feed').insert({ actor_name: profile.full_name, actor_id: profile.id, action: 'listed a new gig', subject: form.title, emoji: '⚡', university: profile.university }); toast.success('Gig listed! 🎉'); qc.invalidateQueries({ queryKey: ['gigs'] }); setShowCreate(false) } catch (err) { toast.error(err.message) } finally { setSubmitting(false) } }
  return <div className="content-width page-gutter py-6 sm:py-8">
    <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="section-label">Gig Economy</p><h1 className="text-2xl font-black tracking-tight">Student Services</h1><div className="mt-1 flex items-center gap-2"><Zap size={12} className="text-plug-green" /><span className="text-xs font-semibold text-plug-green">Zero commission for student sellers. Always.</span></div></div><button onClick={() => setShowCreate(true)} className="btn-primary self-start"><Plus size={16} /> List a Service</button></div>
    <div className="mb-5 rounded-2xl border border-purple/20 bg-purple/5 p-4"><div className="mb-3 flex items-center gap-2"><GraduationCap size={15} className="text-purple" /><span className="text-xs font-black uppercase tracking-widest text-purple">Academic Emergency Plug</span></div><div className="flex flex-wrap gap-2">{ACADEMIC_GIGS.map(c => <button key={c} onClick={() => setFilter(filter === c ? '' : c)} className={`min-h-10 rounded-xl border px-3 py-2 text-xs font-semibold transition-all ${filter === c ? 'border-purple bg-purple text-white' : 'border-white/10 bg-white/[0.03] text-white/60 hover:border-purple/40 hover:text-white'}`}>{c}</button>)}</div></div>
    <div className="mb-6 flex flex-wrap gap-2">{['', ...GIG_CATEGORIES].map(c => <button key={c || 'all'} onClick={() => setFilter(c)} className={`min-h-10 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${filter === c ? 'border-purple bg-purple text-white' : 'border-white/10 bg-white/[0.03] text-white/50 hover:border-purple/30 hover:text-white/80'}`}>{c || 'All Services'}</button>)}</div>
    {isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-44" />)}</div> : gigs.length === 0 ? <div className="surface flex min-h-64 flex-col items-center justify-center p-8 text-center text-white/30"><div className="mb-4 text-4xl">⚡</div><p className="font-semibold">No gigs listed yet</p><p className="mt-1 text-sm">Be the first to offer a service!</p></div> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{gigs.map(gig => <GigCard key={gig.id} gig={gig} />)}</div>}
    {showCreate && <div className="modal-backdrop"><div className="absolute inset-0" onClick={() => setShowCreate(false)} /><div className="modal-panel"><div className="modal-header"><h2 className="font-bold">List a Service</h2><button onClick={() => setShowCreate(false)} className="icon-button -mr-2" aria-label="Close dialog"><X size={18} /></button></div><form onSubmit={handleSubmit} className="space-y-4 p-5"><div><label className="label">Service Title</label><input className="input" placeholder="e.g. GST 101 summary notes" value={form.title} onChange={set('title')} required /></div><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Category</label><select className="input" value={form.category} onChange={set('category')} required><option value="">Select category</option>{[...GIG_CATEGORIES, ...ACADEMIC_GIGS].map(c => <option key={c} value={c}>{c}</option>)}</select></div><div><label className="label">Starting Price (₦)</label><input className="input" type="number" min="0" placeholder="0" value={form.starting_price} onChange={set('starting_price')} required /></div></div><div><label className="label">Description</label><textarea className="input resize-none" rows={3} placeholder="What do you offer? Turnaround, what's included, etc." value={form.description} onChange={set('description')} /></div><button type="submit" disabled={submitting} className="btn-primary w-full">{submitting ? 'Listing...' : 'Publish Gig'}</button></form></div></div>}
  </div>
}

export default Gigs
