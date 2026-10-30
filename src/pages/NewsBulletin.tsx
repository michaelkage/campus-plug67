import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CalendarDays, Pin, Plus, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

const CATEGORIES = ['Announcement', 'Academic', 'Events', 'Deadline', 'Safety', 'Other']
type Bulletin = { id:string; university:string; title:string; body:string; category:string; is_pinned:boolean; created_by:string; created_at:string; profiles?:{full_name?:string}|null }

export default function NewsBulletin() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const [showComposer, setShowComposer] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({title:'',body:'',category:'Announcement'})
  const canPublish = Boolean(profile?.badges?.includes('Plug Dev') || profile?.badges?.includes('Community Hero'))
  const {data:posts=[],isLoading,error} = useQuery<Bulletin[]>({
    queryKey:['campus-bulletins',profile?.university],
    enabled:Boolean(profile?.university),
    queryFn:async()=>{
      if (!profile?.university) return []
      const {data,error}=await supabase.from('campus_bulletins').select('*, profiles:created_by(full_name)').eq('university',profile.university).order('is_pinned',{ascending:false}).order('created_at',{ascending:false}).limit(100)
      if(error) throw error
      return (data||[]) as Bulletin[]
    },
  })
  const publish = async (event:React.FormEvent) => {
    event.preventDefault()
    if(!profile?.id || !profile?.university) return toast.error('Complete your university profile first')
    if(!canPublish) return toast.error('Only campus moderators can publish bulletins')
    setSubmitting(true)
    try {
      const {error}=await supabase.from('campus_bulletins').insert({university:profile.university,title:form.title.trim(),body:form.body.trim(),category:form.category,created_by:profile.id})
      if(error) throw error
      setForm({title:'',body:'',category:'Announcement'});setShowComposer(false)
      await qc.invalidateQueries({queryKey:['campus-bulletins',profile.university]})
      toast.success('Campus bulletin published')
    } catch(e:any) { toast.error(e?.message||'Could not publish bulletin') }
    finally { setSubmitting(false) }
  }
  const togglePin = async (post:Bulletin) => {
    const {error}=await supabase.from('campus_bulletins').update({is_pinned:!post.is_pinned,updated_at:new Date().toISOString()}).eq('id',post.id).eq('created_by',profile?.id)
    if(error) toast.error(error.message)
    else { await qc.invalidateQueries({queryKey:['campus-bulletins',profile?.university]});toast.success(post.is_pinned?'Bulletin unpinned':'Bulletin pinned') }
  }
  const remove = async (post:Bulletin) => {
    if(!window.confirm('Delete this bulletin?')) return
    const {error}=await supabase.from('campus_bulletins').delete().eq('id',post.id).eq('created_by',profile?.id)
    if(error) toast.error(error.message)
    else { await qc.invalidateQueries({queryKey:['campus-bulletins',profile?.university]});toast.success('Bulletin deleted') }
  }
  return <div className="content-width page-gutter py-6 sm:py-8">
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="section-label">Campus updates</p><h1 className="text-3xl font-black tracking-tight">News Bulletin</h1><p className="mt-2 max-w-2xl text-sm text-[var(--md-on-surface)]/45">University announcements, deadlines, academic updates, events and important notices — all in one place.</p></div>
      {canPublish&&<button className="btn-primary self-start" onClick={()=>setShowComposer(true)}><Plus size={16}/> Publish update</button>}
    </div>
    {!profile?.university&&<div className="surface p-5 text-sm text-[var(--md-on-surface)]/50">Add your university in Settings to view your campus bulletin.</div>}
    {isLoading&&<div className="grid gap-3">{[1,2,3].map(n=><div key={n} className="surface h-28 animate-pulse"/>)}</div>}
    {error&&<div role="alert" className="surface p-5 text-sm text-error">Could not load campus updates. Please refresh and try again.</div>}
    {!isLoading&&!error&&profile?.university&&posts.length===0&&<div className="surface flex min-h-64 flex-col items-center justify-center p-8 text-center"><Bell size={30} className="mb-3 text-primary"/><h2 className="font-bold">No campus updates yet</h2><p className="mt-1 text-sm text-[var(--md-on-surface)]/40">{canPublish?'Publish the first university update.':'New announcements from your campus will appear here.'}</p></div>}
    <div className="space-y-3">{posts.map(post=><article key={post.id} className={`surface p-5 sm:p-6 ${post.is_pinned?'border-primary/30':''}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2"><span className="tag tag-purple">{post.category}</span>{post.is_pinned&&<span className="tag tag-green"><Pin size={10}/> Pinned</span>}<span className="ml-auto flex items-center gap-1 text-xs text-[var(--md-on-surface)]/30"><CalendarDays size={12}/>{new Date(post.created_at).toLocaleString()}</span></div>
      <h2 className="text-lg font-bold">{post.title}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/65">{post.body}</p>
      <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3"><span className="text-xs text-[var(--md-on-surface)]/30">Posted by {post.profiles?.full_name||'Campus team'}</span>{post.created_by===profile?.id&&<div className="flex gap-2"><button className="btn-secondary text-xs" onClick={()=>togglePin(post)}><Pin size={12}/>{post.is_pinned?'Unpin':'Pin'}</button><button className="btn-secondary text-xs text-error" onClick={()=>remove(post)}><Trash2 size={12}/>Delete</button></div>}</div>
    </article>)}</div>
    {showComposer&&<div className="modal-backdrop"><button aria-label="Close bulletin form" className="absolute inset-0" onClick={()=>setShowComposer(false)}/><div className="modal-panel"><div className="modal-header"><h2 className="font-bold">Publish campus update</h2><button className="icon-button" onClick={()=>setShowComposer(false)}><X size={16}/></button></div><form className="space-y-4 p-5" onSubmit={publish}><div><label className="label">Headline</label><input className="input" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} minLength={3} maxLength={160} required placeholder="e.g. Registration deadline extended"/></div><div><label className="label">Category</label><select className="input" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>{CATEGORIES.map(category=><option key={category}>{category}</option>)}</select></div><div><label className="label">Update details</label><textarea className="input resize-y" rows={6} value={form.body} onChange={e=>setForm(f=>({...f,body:e.target.value}))} minLength={3} maxLength={10000} required placeholder="What should students know? Include dates, venues and official links."/></div><button className="btn-primary w-full" type="submit" disabled={submitting}>{submitting?'Publishing…':'Publish bulletin'}</button></form></div></div>}
  </div>
}
