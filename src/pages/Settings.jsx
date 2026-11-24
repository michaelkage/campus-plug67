import { useEffect, useRef, useState } from 'react'
import { Bell, Check, Monitor, Moon, Smartphone, Sparkles, Volume2 } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import CampusVerificationPanel from '@/components/settings/CampusVerificationPanel'

const defaults={reducedMotion:false,compactMode:false,transactionAlerts:true,chatAlerts:true}

export default function Settings(){
 const {theme,setTheme}=useTheme()
 const {user,profile}=useAuth()
 const [prefs,setPrefs]=useState(profile?.preferences??defaults)
 const [saving,setSaving]=useState(false)
 const [saveAnnouncement,setSaveAnnouncement]=useState('')
 const prefsRef=useRef(prefs)
 const saveQueueRef=useRef(Promise.resolve())
 const pendingSavesRef=useRef(0)

 useEffect(()=>{const next=profile?.preferences??defaults;prefsRef.current=next;setPrefs(next)},[profile?.preferences])
 useEffect(()=>{document.documentElement.dataset.reducedMotion=prefs.reducedMotion?'true':'false';document.documentElement.dataset.compact=prefs.compactMode?'true':'false'},[prefs])

 const enqueuePreferenceSave=(operation,onError)=>{
   pendingSavesRef.current+=1
   setSaving(true)
   setSaveAnnouncement('Saving preferences')
   const task=saveQueueRef.current.then(async()=>{
     const {error}=await operation()
     if(error)throw error
     setSaveAnnouncement('Preferences saved')
     return true
   }).catch(error=>{
     onError?.(error)
     setSaveAnnouncement('Unable to save preferences')
     toast.error(error?.message||'Failed to save preferences')
     return false
   }).finally(()=>{
     pendingSavesRef.current=Math.max(0,pendingSavesRef.current-1)
     setSaving(pendingSavesRef.current>0)
   })
   saveQueueRef.current=task
   return task
 }
 const update=(key,value)=>{
   if(!user)return
   const previous=prefsRef.current
   const next={...previous,[key]:value}
   prefsRef.current=next
   setPrefs(next)
   return enqueuePreferenceSave(
     ()=>supabase.from('profiles').update({preferences:prefsRef.current}).eq('id',user.id),
     ()=>{
       const current=prefsRef.current
       if(current[key]===value){
         const rollback={...current,[key]:previous[key]}
         prefsRef.current=rollback
         setPrefs(rollback)
       }
     }
   )
 }
 const saveProfile=next=>{
   if(!user)return
   return enqueuePreferenceSave(()=>supabase.from('profiles').update({theme_mode:next}).eq('id',user.id))
 }

 return <div className="page-shell max-w-3xl space-y-6" aria-busy={saving}>
   <header className="page-header"><div><p className="section-label">Preferences</p><h1 className="page-title">Settings</h1><p className="page-subtitle">Control appearance, motion, density and notification behavior.</p></div></header>
   <CampusVerificationPanel />
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Monitor size={18} className="text-primary"/><div><h2 className="font-black">Appearance</h2><p className="text-xs text-on-surface/40">Your preference is applied immediately.</p></div></div>
     <div className="grid gap-3 sm:grid-cols-2"><button type="button" aria-pressed={theme==='dark'} onClick={()=>{setTheme('dark');void saveProfile('dark')}} className={`rounded-md border p-4 text-left ${theme==='dark'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Moon size={17}/><div className="mt-3 font-bold">Material Dark</div><div className="text-xs text-on-surface/40">Balanced campus default.</div>{theme==='dark'&&<Check className="mt-2 text-primary" size={15}/>}</button><button type="button" aria-pressed={theme==='amoled'} onClick={()=>{setTheme('amoled');void saveProfile('amoled')}} className={`rounded-md border p-4 text-left ${theme==='amoled'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Sparkles size={17}/><div className="mt-3 font-bold">AMOLED</div><div className="text-xs text-on-surface/40">True-black surfaces for OLED screens.</div>{theme==='amoled'&&<Check className="mt-2 text-primary" size={15}/>}</button></div>
   </section>
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Smartphone size={18} className="text-primary"/><div><h2 className="font-black">Accessibility & comfort</h2><p className="text-xs text-on-surface/40">These preferences are synced to your Campus Plug profile.</p></div></div><div className="divide-y divide-[var(--md-outline-variant)]">{[['reducedMotion','Reduce motion','Respects motion-sensitive users',Sparkles],['compactMode','Compact density','Fit more information on desktop',Monitor],['transactionAlerts','Transaction alerts','Important escrow and payment notifications',Bell],['chatAlerts','Chat alerts','New marketplace and group messages',Volume2]].map(([key,title,desc,Icon])=><label key={key} className="flex min-h-16 cursor-pointer items-center gap-3 py-3"><Icon size={17} className="text-on-surface/50"/><span className="flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-on-surface/45">{desc}</span></span><input type="checkbox" checked={Boolean(prefs[key])} onChange={e=>void update(key,e.target.checked)} aria-label={title}/></label>)}</div></section>
   <section className="rounded-md border border-primary/20 bg-primary/5 p-4 text-xs text-on-surface/75"><strong className="text-on-surface">Tip:</strong> Reduced motion follows your system preference as well as this setting. Financial actions never rely on offline success states.</section>
   <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{saveAnnouncement}</p>
 </div>
}
