import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Check, Monitor, Moon, Smartphone, Sparkles, Volume2, GraduationCap, ShieldCheck } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

const defaults={reducedMotion:false,compactMode:false,transactionAlerts:true,chatAlerts:true}

export default function Settings(){
 const {theme,setTheme}=useTheme()
 const {user,profile,refreshProfile}=useAuth()
 const [prefs,setPrefs]=useState(profile?.preferences??defaults)
 const [saving,setSaving]=useState(false)
 const [saveAnnouncement,setSaveAnnouncement]=useState('')
 const prefsRef=useRef(prefs)
 const saveQueueRef=useRef(Promise.resolve())
 const pendingSavesRef=useRef(0)
 const [institutions,setInstitutions]=useState([])
 const [memberships,setMemberships]=useState([])
 const [institutionLoading,setInstitutionLoading]=useState(false)
 const [selectedInstitutionId,setSelectedInstitutionId]=useState(profile?.primary_institution_id||'')

 useEffect(()=>{const next=profile?.preferences??defaults;prefsRef.current=next;setPrefs(next)},[profile?.preferences])
 useEffect(()=>{setSelectedInstitutionId(profile?.primary_institution_id||'')},[profile?.primary_institution_id])
 useEffect(()=>{document.documentElement.dataset.reducedMotion=prefs.reducedMotion?'true':'false';document.documentElement.dataset.compact=prefs.compactMode?'true':'false'},[prefs])

 const loadInstitutionData=useCallback(async()=>{
   if(!user?.id)return
   setInstitutionLoading(true)
   const [directory,membershipRows]=await Promise.all([
     supabase.from('institutions').select('id,name').eq('is_active',true).order('name'),
     supabase.from('institution_memberships').select('id,institution_id,status,is_primary,verified_at').eq('user_id',user.id).order('created_at',{ascending:false})
   ])
   setInstitutionLoading(false)
   if(directory.error){toast.error(directory.error.message||'Unable to load campus directory');return}
   if(membershipRows.error){toast.error(membershipRows.error.message||'Unable to load campus memberships');return}
   setInstitutions(directory.data||[])
   setMemberships(membershipRows.data||[])
 },[user?.id])

 useEffect(()=>{void loadInstitutionData()},[loadInstitutionData])

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

 const claimCampus=async()=>{
   if(!user)return
   setInstitutionLoading(true)
   const {data,error}=await supabase.rpc('claim_my_institution_membership')
   setInstitutionLoading(false)
   if(error){toast.error(error.message||'Campus verification failed');return}
   await refreshProfile()
   await loadInstitutionData()
   toast.success(data?.institution_name? `Verified ${data.institution_name}`:'Campus membership verified')
 }
 const setPrimaryCampus=async()=>{
   if(!selectedInstitutionId||!user)return
   setInstitutionLoading(true)
   const {error}=await supabase.rpc('set_my_primary_institution',{p_institution_id:selectedInstitutionId})
   setInstitutionLoading(false)
   if(error){toast.error(error.message||'Unable to change primary campus');return}
   await refreshProfile()
   await loadInstitutionData()
   toast.success('Primary campus updated')
 }

 const verifiedMemberships=memberships.filter(m=>m.status==='verified')
 const institutionName=id=>institutions.find(item=>item.id===id)?.name||'Institution'

 return <div className="page-shell max-w-3xl space-y-6" aria-busy={saving}>
   <header className="page-header"><div><p className="section-label">Preferences</p><h1 className="page-title">Settings</h1><p className="page-subtitle">Control appearance, motion, density and notification behavior.</p></div></header>
   <section className="surface p-5">
     <div className="flex items-center gap-3 mb-5"><GraduationCap size={18} className="text-primary"/><div><h2 className="font-black">Campus identity</h2><p className="text-xs text-on-surface/50">Your campus is verified from your confirmed university email, not a manually typed profile label.</p></div></div>
     <div className="rounded-md border border-[var(--md-outline-variant)] p-4 space-y-3">
       <div className="flex items-start gap-3"><ShieldCheck size={18} className="text-primary mt-0.5"/><div className="min-w-0 flex-1"><p className="text-sm font-bold">Verify this account's campus</p><p className="text-xs text-on-surface/50 mt-1">Campus Plug checks the confirmed email on your account against its approved institution-domain registry. Unverified email addresses cannot create verified memberships.</p>{user?.email&&<p className="mt-2 text-xs font-mono text-on-surface/70 break-all">{user.email}</p>}</div></div>
       <button className="btn-primary w-full sm:w-auto" onClick={()=>void claimCampus()} disabled={institutionLoading||!user?.email}> {institutionLoading?'Checking…':'Verify and add campus membership'} </button>
     </div>
     <div className="mt-4 space-y-3">
       <div><h3 className="text-sm font-bold">Verified memberships</h3><p className="text-xs text-on-surface/45">A profile can hold more than one institution membership. Choose which verified campus is primary.</p></div>
       {memberships.length===0?<p className="rounded-md bg-surface-container p-3 text-xs text-on-surface/55">{institutionLoading?'Loading memberships…':'No verified campus membership yet.'}</p>:<div className="space-y-2">{memberships.map(m=><div key={m.id} className="flex items-center justify-between gap-3 rounded-md border border-[var(--md-outline-variant)] p-3"><div className="min-w-0"><p className="text-sm font-semibold truncate">{institutionName(m.institution_id)}</p><p className="text-xs text-on-surface/45 capitalize">{m.status.replace('_',' ')}{m.is_primary?' · Primary campus':''}</p></div>{m.status==='verified'&&<ShieldCheck size={17} className="text-primary shrink-0"/>}</div>)}</div>}
       {verifiedMemberships.length>0&&<div className="flex flex-col sm:flex-row gap-2"><select className="input min-w-0 flex-1" value={selectedInstitutionId} onChange={e=>setSelectedInstitutionId(e.target.value)} aria-label="Primary campus">{verifiedMemberships.map(m=><option key={m.institution_id} value={m.institution_id}>{institutionName(m.institution_id)}</option>)}</select><button className="btn-primary" onClick={()=>void setPrimaryCampus()} disabled={institutionLoading||!selectedInstitutionId||selectedInstitutionId===profile?.primary_institution_id}>Set primary campus</button></div>}
       {profile?.university&&<p className="text-xs text-on-surface/40">Legacy campus label: <span className="text-on-surface/70">{profile.university}</span></p>}
     </div>
   </section>
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Monitor size={18} className="text-primary"/><div><h2 className="font-black">Appearance</h2><p className="text-xs text-on-surface/40">Your preference is applied immediately.</p></div></div>
     <div className="grid gap-3 sm:grid-cols-2"><button type="button" aria-pressed={theme==='dark'} onClick={()=>{setTheme('dark');void saveProfile('dark')}} className={`rounded-md border p-4 text-left ${theme==='dark'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Moon size={17}/><div className="mt-3 font-bold">Material Dark</div><div className="text-xs text-on-surface/40">Balanced campus default.</div>{theme==='dark'&&<Check className="mt-2 text-primary" size={15}/>}</button><button type="button" aria-pressed={theme==='amoled'} onClick={()=>{setTheme('amoled');void saveProfile('amoled')}} className={`rounded-md border p-4 text-left ${theme==='amoled'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Sparkles size={17}/><div className="mt-3 font-bold">AMOLED</div><div className="text-xs text-on-surface/40">True-black surfaces for OLED screens.</div>{theme==='amoled'&&<Check className="mt-2 text-primary" size={15}/>}</button></div>
   </section>
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Smartphone size={18} className="text-primary"/><div><h2 className="font-black">Accessibility & comfort</h2><p className="text-xs text-on-surface/40">These preferences are synced to your Campus Plug profile.</p></div></div><div className="divide-y divide-[var(--md-outline-variant)]">{[['reducedMotion','Reduce motion','Respects motion-sensitive users',Sparkles],['compactMode','Compact density','Fit more information on desktop',Monitor],['transactionAlerts','Transaction alerts','Important escrow and payment notifications',Bell],['chatAlerts','Chat alerts','New marketplace and group messages',Volume2]].map(([key,title,desc,Icon])=><label key={key} className="flex min-h-16 cursor-pointer items-center gap-3 py-3"><Icon size={17} className="text-on-surface/50"/><span className="flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-on-surface/45">{desc}</span></span><input type="checkbox" checked={Boolean(prefs[key])} onChange={e=>void update(key,e.target.checked)} aria-label={title}/></label>)}</div></section>
   <section className="rounded-md border border-primary/20 bg-primary/5 p-4 text-xs text-on-surface/75"><strong className="text-on-surface">Tip:</strong> Reduced motion follows your system preference as well as this setting. Financial actions never rely on offline success states.</section>
   <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{saveAnnouncement}</p>
 </div>
}
