import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira, toKobo } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Zap, GraduationCap, CalendarDays, CheckCircle, XCircle, ClipboardList } from 'lucide-react'

const GIG_CATEGORIES = ['Tech Repair', 'Tutoring', 'Design', 'Hair & Beauty', 'Food', 'Laundry', 'Errand', 'Writing', 'Other']
const ACADEMIC_GIGS = ['GST 101/102 Summary Notes', 'Engineering Drawing Board Rental', 'Lab Coat & Safety Goggles', 'Departmental Printing / Binding', 'Past Questions & Revision Packs']

function GigCard({ gig, onBook, isOwner, onEdit, onDelete }) {
  return <div className="surface surface-interactive relative p-5">
    <div className="absolute right-4 top-4"><span className="tag tag-green text-[9px]">0% FEE</span></div>
    <div className="mb-4 flex items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--md-secondary-container)] text-sm font-bold text-on-primary">{gig.profiles?.full_name?.[0]?.toUpperCase() || '?'}</div><div className="min-w-0"><div className="truncate text-sm font-semibold">{gig.profiles?.full_name}</div><div className="truncate text-xs text-white/40">{gig.profiles?.university}</div></div></div>
    <h3 className="mb-2 font-bold">{gig.title}</h3><p className="mb-4 line-clamp-2 text-sm text-white/50">{gig.description}</p>
    <div className="flex items-center justify-between gap-3"><span className="font-mono text-sm font-black text-[var(--md-primary)]">{formatNaira(gig.starting_price)}{gig.max_price && gig.max_price > gig.starting_price ? ` – ${formatNaira(gig.max_price)}` : ''}</span><span className="tag tag-purple text-[10px]">{gig.category}</span></div>
    {Array.isArray(gig.available_days) && gig.available_days.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Available days">{gig.available_days.map(day=><span key={day} className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/55">{day}</span>)}</div>}
    {isOwner ? <div className="mt-4 grid grid-cols-2 gap-2"><button onClick={()=>onEdit(gig)} className="btn-secondary text-sm">Edit listing</button><button onClick={()=>onDelete(gig)} className="btn-secondary text-sm text-error">Delete</button></div> : <button onClick={()=>onBook(gig)} className="btn-primary mt-4 w-full"><CalendarDays size={14}/> Book this skill</button>}
  </div>
}

export function Gigs() {
  const { user, profile } = useAuth(); const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false); const [editingGig, setEditingGig] = useState(null); const [bookingGig, setBookingGig] = useState(null); const [booking, setBooking] = useState({ date:'', time:'', notes:'' }); const [bookingSubmitting, setBookingSubmitting] = useState(false); const [bookingActionId, setBookingActionId] = useState(null); const [form, setForm] = useState({ title: '', description: '', category: '', starting_price: '', max_price: '', available_days: [] }); const [filter, setFilter] = useState(''); const [submitting, setSubmitting] = useState(false)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const { data: gigs = [], isLoading } = useQuery({ queryKey: ['gigs', filter, profile?.university], enabled: Boolean(profile?.university), queryFn: async () => { let q = supabase.from('gigs').select('*, profiles(full_name, university)').eq('active', true).eq('university', profile?.university).order('created_at', { ascending: false }); if (filter) q = q.eq('category', filter); const { data, error } = await q; if (error) throw error; return data || [] } })
  useRealtimeTable({ table: 'gigs', onInsert: g => { if (g.university === profile?.university) qc.setQueryData(['gigs', filter, profile?.university], old => [g, ...(old || [])]) } })
  const { data: myBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['gig-bookings', profile?.id],
    enabled: Boolean(profile?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gig_bookings')
        .select('*, gigs(title)')
        .or(`client_id.eq.${profile.id},seller_id.eq.${profile.id}`)
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) throw error
      return data || []
    },
  })
  const updateBooking = async (bookingRow, status) => {
    setBookingActionId(bookingRow.id)
    try {
      const { error } = await supabase.from('gig_bookings').update({ status }).eq('id', bookingRow.id)
      if (error) throw error
      toast.success(status === 'confirmed' ? 'Booking confirmed' : status === 'completed' ? 'Booking marked complete' : 'Booking cancelled')
      await qc.invalidateQueries({ queryKey: ['gig-bookings'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update booking')
    } finally {
      setBookingActionId(null)
    }
  }
  const openEdit = gig => { setEditingGig(gig); setForm({ title:gig.title||'', description:gig.description||'', category:gig.category||'', starting_price:String(Number(gig.starting_price)/100), max_price:gig.max_price ? String(Number(gig.max_price)/100) : '', available_days:Array.isArray(gig.available_days)?gig.available_days:[] }); setShowCreate(true) }
  const removeGig = async gig => { if (!window.confirm(`Delete “${gig.title}”? This cannot be undone.`)) return; try { const { error } = await supabase.from('gigs').delete().eq('id',gig.id).eq('seller_id',profile.id); if(error) throw error; toast.success('Skill listing deleted'); if(editingGig?.id===gig.id){setEditingGig(null);setShowCreate(false)} await qc.invalidateQueries({queryKey:['gigs']}) } catch(err){toast.error(err.message||'Could not delete listing')} }
  const handleSubmit = async e => {
    e.preventDefault()
    const min = Number(form.starting_price), max = form.max_price === '' ? null : Number(form.max_price)
    if (!Number.isFinite(min) || min <= 0) return toast.error('Enter a minimum price greater than zero')
    if (max !== null && (!Number.isFinite(max) || max < min)) return toast.error('Maximum price must be equal to or greater than minimum price')
    if (!form.available_days.length) return toast.error('Select at least one available day')
    setSubmitting(true)
    try {
      const payload = { title:form.title.trim(), description:form.description.trim(), category:form.category, starting_price:toKobo(min), max_price:max===null?null:toKobo(max), available_days:form.available_days }
      const result = editingGig
        ? await supabase.from('gigs').update(payload).eq('id',editingGig.id).eq('seller_id',profile.id)
        : await supabase.from('gigs').insert({ ...payload, seller_id:profile.id, university:profile.university, active:true })
      if (result.error) throw result.error
      if (!editingGig) await supabase.from('activity_feed').insert({ actor_name:profile.full_name, actor_id:profile.id, action:'listed a new gig', subject:form.title, emoji:'⚡', university:profile.university })
      toast.success(editingGig ? 'Skill listing updated' : 'Skill listed! 🎉')
      await qc.invalidateQueries({ queryKey:['gigs'] })
      setShowCreate(false); setEditingGig(null); setForm({title:'',description:'',category:'',starting_price:'',max_price:'',available_days:[]})
    } catch(err) { toast.error(err.message||'Could not save skill listing') }
    finally { setSubmitting(false) }
  }
  const book = async () => {
    if (!user?.id || !profile?.id) return toast.error('Sign in and complete your profile before booking')
    if (!bookingGig || !booking.date || !booking.time) return toast.error('Choose a date and time')
    if (bookingGig.seller_id === profile.id) return toast.error('You cannot book your own service')
    if (new Date(`${booking.date}T00:00:00`) < new Date(new Date().toDateString())) return toast.error('Choose today or a future date')
    const selectedDay = new Date(`${booking.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
    if (Array.isArray(bookingGig.available_days) && bookingGig.available_days.length > 0 && !bookingGig.available_days.includes(selectedDay)) return toast.error(`This provider is not available on ${selectedDay}. Choose one of their listed days.`)
    setBookingSubmitting(true)
    try {
      const { error } = await supabase.from('gig_bookings').insert({
        gig_id: bookingGig.id,
        client_id: profile.id,
        seller_id: bookingGig.seller_id,
        slot_date: booking.date,
        slot_time: booking.time,
        notes: booking.notes || null,
        amount: bookingGig.starting_price,
        status: 'pending',
      })
      if (error) throw error
      // A database trigger creates the seller notification with the booking.
      toast.success('Skill booking request sent')
      qc.invalidateQueries({ queryKey: ['gig-bookings'] })
      setBookingGig(null)
      setBooking({ date: '', time: '', notes: '' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Booking failed. Please try again.')
    } finally {
      setBookingSubmitting(false)
    }
  }
  return <div className="content-width page-gutter py-6 sm:py-8">
    <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="section-label">Gig Economy</p><h1 className="text-2xl font-black tracking-tight">Student Services</h1><div className="mt-1 flex items-center gap-2"><Zap size={12} className="text-[var(--md-primary)]" /><span className="text-xs font-semibold text-[var(--md-primary)]">Zero commission for student sellers. Always.</span></div></div><button onClick={() => { setEditingGig(null); setForm({title:'',description:'',category:'',starting_price:'',max_price:'',available_days:[]}); setShowCreate(true) }} className="btn-primary self-start"><Plus size={16} /> List a Service</button></div>
    <div className="mb-5 rounded-3xl border border-[var(--md-secondary)]/20 bg-tertiary/5 p-4"><div className="mb-3 flex items-center gap-2"><GraduationCap size={15} className="text-[var(--md-secondary)]" /><span className="text-xs font-black uppercase tracking-widest text-[var(--md-secondary)]">Academic Emergency Plug</span></div><div className="flex flex-wrap gap-2">{ACADEMIC_GIGS.map(c => <button key={c} onClick={() => setFilter(filter === c ? '' : c)} className={`min-h-10 rounded-xl border px-3 py-2 text-xs font-semibold transition-all ${filter === c ? 'border-tertiary bg-tertiary text-white' : 'border-[var(--md-outline-variant)] bg-white/[0.03] text-white/60 hover:border-tertiary/40 hover:text-white'}`}>{c}</button>)}</div></div>
    <div className="mb-6 flex flex-wrap gap-2">{['', ...GIG_CATEGORIES].map(c => <button key={c || 'all'} onClick={() => setFilter(c)} className={`min-h-10 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${filter === c ? 'border-tertiary bg-tertiary text-white' : 'border-[var(--md-outline-variant)] bg-white/[0.03] text-white/50 hover:border-tertiary/30 hover:text-white/80'}`}>{c || 'All Services'}</button>)}</div>
    {profile?.id && <section className="surface mb-6 p-5">
      <div className="mb-4 flex items-center gap-2"><ClipboardList size={17} className="text-[var(--md-primary)]"/><h2 className="font-bold">My Service Bookings</h2><span className="ml-auto text-xs text-white/40">{myBookings.length}</span></div>
      {bookingsLoading ? <p className="text-sm text-white/40">Loading bookings…</p> : myBookings.length === 0 ? <p className="text-sm text-white/45">Your booking requests and service appointments will appear here.</p> : <div className="space-y-3">{myBookings.map(b => {
        const isSeller = b.seller_id === profile.id
        const statusLabel = ({pending:'Awaiting confirmation',confirmed:'Confirmed',completed:'Completed',cancelled:'Cancelled'})[b.status] || b.status
        return <div key={b.id} className="rounded-xl border border-[var(--md-outline-variant)] p-3 sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1"><p className="font-semibold">{b.gigs?.title || 'Student service'}</p><p className="mt-1 text-xs text-white/45">{isSeller ? 'Customer booking' : 'Your booking'} · {b.slot_date} at {b.slot_time}</p><p className="mt-1 text-xs text-white/60">Status: <span className="font-semibold">{statusLabel}</span></p>{b.notes && <p className="mt-2 text-sm text-white/50">{b.notes}</p>}</div>
            <div className="flex flex-wrap gap-2">
              {isSeller && b.status === 'pending' && <button className="btn-primary text-xs" disabled={bookingActionId === b.id} onClick={() => updateBooking(b,'confirmed')}><CheckCircle size={13}/> Confirm</button>}
              {isSeller && b.status === 'confirmed' && <button className="btn-primary text-xs" disabled={bookingActionId === b.id} onClick={() => updateBooking(b,'completed')}><CheckCircle size={13}/> Mark complete</button>}
              {((isSeller && ['pending','confirmed'].includes(b.status)) || (!isSeller && b.status === 'pending')) && <button className="btn-secondary text-xs" disabled={bookingActionId === b.id} onClick={() => updateBooking(b,'cancelled')}><XCircle size={13}/> Cancel</button>}
            </div>
          </div>
        </div>
      })}</div>}
    </section>}
    {isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-44" />)}</div> : gigs.length === 0 ? <div className="surface flex min-h-64 flex-col items-center justify-center p-8 text-center text-white/30"><div className="mb-4 text-4xl">⚡</div><p className="font-semibold">No gigs listed yet</p><p className="mt-1 text-sm">Be the first to offer a service!</p></div> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{gigs.map(gig => <GigCard key={gig.id} gig={gig} onBook={setBookingGig} isOwner={gig.seller_id===profile?.id} onEdit={openEdit} onDelete={removeGig} />)}</div>}
    {showCreate && <div className="modal-backdrop"><div className="absolute inset-0" onClick={() => setShowCreate(false)} /><div className="modal-panel"><div className="modal-header"><h2 className="font-bold">{editingGig ? 'Edit Skill Listing' : 'List a Service'}</h2><button onClick={() => { setShowCreate(false); setEditingGig(null) }} className="icon-button -mr-2" aria-label="Close dialog"><X size={18} /></button></div><form onSubmit={handleSubmit} className="space-y-4 p-5"><div><label className="label">Service Title</label><input className="input" placeholder="e.g. GST 101 summary notes" value={form.title} onChange={set('title')} required /></div><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Category</label><select className="input" value={form.category} onChange={set('category')} required><option value="">Select category</option>{[...GIG_CATEGORIES, ...ACADEMIC_GIGS].map(c => <option key={c} value={c}>{c}</option>)}</select></div><div><label className="label">Minimum Price (₦)</label><input className="input" type="number" min="1" placeholder="e.g. 2500" value={form.starting_price} onChange={set('starting_price')} required /></div></div>
          <div><label className="label">Maximum Price (₦) <span className="font-normal text-white/30">(optional, for a price range)</span></label><input className="input" type="number" min={form.starting_price || 1} placeholder="Leave blank for fixed price" value={form.max_price} onChange={set('max_price')} /><p className="mt-1 text-xs text-white/35">The minimum is used as the initial booking quote; agree the final price before confirming.</p></div>
          <fieldset><legend className="label mb-2">Available days</legend><div className="flex flex-wrap gap-2">{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(day=><label key={day} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs ${form.available_days.includes(day)?'border-primary bg-primary/10 text-primary':'border-white/10 text-white/55'}`}><input type="checkbox" checked={form.available_days.includes(day)} onChange={e=>setForm(f=>({...f,available_days:e.target.checked?[...f.available_days,day]:f.available_days.filter(d=>d!==day)}))}/>{day}</label>)}</div></fieldset><div><label className="label">Description</label><textarea className="input resize-none" rows={3} placeholder="What do you offer? Turnaround, what's included, etc." value={form.description} onChange={set('description')} /></div><button type="submit" disabled={submitting} className="btn-primary w-full">{submitting ? 'Saving...' : editingGig ? 'Save Changes' : 'Publish Skill'}</button></form></div></div>}
    {bookingGig && <div className="modal-backdrop"><div className="absolute inset-0" onClick={()=>setBookingGig(null)}/><div className="modal-panel"><div className="modal-header"><div><h2 className="font-bold">Book {bookingGig.title}</h2><p className="text-xs text-white/35">Request a time from the student provider. {Array.isArray(bookingGig.available_days)&&bookingGig.available_days.length>0 ? `Available: ${bookingGig.available_days.join(', ')}` : 'Availability not specified.'}</p></div><button className="icon-button" onClick={()=>setBookingGig(null)}><X size={17}/></button></div><div className="space-y-4 p-5"><div className="grid grid-cols-2 gap-3"><div><label className="label">Date</label><input className="input" type="date" min={new Date().toLocaleDateString("en-CA")} value={booking.date} onChange={e=>setBooking(b=>({...b,date:e.target.value}))}/></div><div><label className="label">Time</label><input className="input" type="time" value={booking.time} onChange={e=>setBooking(b=>({...b,time:e.target.value}))}/></div></div><textarea className="input" rows={3} placeholder="What do you need?" value={booking.notes} onChange={e=>setBooking(b=>({...b,notes:e.target.value}))}/><button className="btn-primary w-full" onClick={book} disabled={bookingSubmitting || !booking.date || !booking.time}>{bookingSubmitting ? "Sending request…" : "Send booking request"}</button></div></div></div>}
  </div>
}

export default Gigs
