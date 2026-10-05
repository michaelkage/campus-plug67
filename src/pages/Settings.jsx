import { useEffect, useState } from 'react'
import { Bell, Check, Monitor, Moon, Smartphone, Sparkles, Volume2 } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

const prefKey='campus_plug_preferences'
const defaults={reducedMotion:false,compactMode:false,transactionAlerts:true,chatAlerts:true}
function load(){try{return {...defaults,...JSON.parse(localStorage.getItem(prefKey)||'{}')}}catch{return defaults}}
export default function Settings(){
 const {theme,setTheme}=useTheme(); const {user}=useAuth(); const [prefs,setPrefs]=useState(load); const [saving,setSaving]=useState(false)
 useEffect(()=>{try{localStorage.setItem(prefKey,JSON.stringify(prefs))}catch{};document.documentElement.dataset.reducedMotion=prefs.reducedMotion?'true':'false';document.documentElement.dataset.compact=prefs.compactMode?'true':'false'},[prefs])
 const update=(key,value)=>setPrefs(p=>({...p,[key]:value}))
 const saveProfile=async(next)=>{if(!user)return;setSaving(true);const {error}=await supabase.from('profiles').update({theme_mode:next}).eq('id',user.id);setSaving(false);if(error)toast.error(error.message);else toast.success('Preferences saved')}
 return <main className="page-shell max-w-3xl space-y-6">
   <header className="page-header"><div><p className="section-label">Preferences</p><h1 className="page-title">Settings</h1><p className="page-subtitle">Control appearance, motion, density and notification behavior.</p></div></header>
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Monitor size={18} className="text-primary"/><div><h2 className="font-black">Appearance</h2><p className="text-xs text-white/40">Your preference is applied immediately.</p></div></div>
     <div className="grid gap-3 sm:grid-cols-2"><button onClick={()=>{setTheme('dark');void saveProfile('dark')}} className={`rounded-2xl border p-4 text-left ${theme==='dark'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Moon size={17}/><div className="mt-3 font-bold">Material Dark</div><div className="text-xs text-white/40">Balanced campus default.</div>{theme==='dark'&&<Check className="mt-2 text-primary" size={15}/>}</button><button onClick={()=>{setTheme('amoled');void saveProfile('amoled')}} className={`rounded-2xl border p-4 text-left ${theme==='amoled'?'border-primary/40 bg-primary/10':'border-[var(--md-outline-variant)]'}`}><Sparkles size={17}/><div className="mt-3 font-bold">AMOLED</div><div className="text-xs text-white/40">True-black surfaces for OLED screens.</div>{theme==='amoled'&&<Check className="mt-2 text-primary" size={15}/>}</button></div>
   </section>
   <section className="surface p-5"><div className="flex items-center gap-3 mb-5"><Smartphone size={18} className="text-primary"/><div><h2 className="font-black">Accessibility & comfort</h2><p className="text-xs text-white/40">These stay on this device and work offline.</p></div></div><div className="divide-y divide-[var(--md-outline-variant)]">{[['reducedMotion','Reduce motion','Respects motion-sensitive users',Sparkles],['compactMode','Compact density','Fit more information on desktop',Monitor],['transactionAlerts','Transaction alerts','Important escrow and payment notifications',Bell],['chatAlerts','Chat alerts','New marketplace and group messages',Volume2]].map(([key,title,desc,Icon])=><label key={key} className="flex min-h-16 cursor-pointer items-center gap-3 py-3"><Icon size={17} className="text-white/50"/><span className="flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-white/35">{desc}</span></span><input type="checkbox" checked={Boolean(prefs[key])} onChange={e=>update(key,e.target.checked)} aria-label={title} /></label>)}</div></section>
   <section className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-xs text-white/55"><strong className="text-white">Tip:</strong> Reduced motion follows your system preference as well as this setting. Financial actions never rely on offline success states.</section>
   {saving&&<p className="text-xs text-white/30" role="status">Saving…</p>}
 </main>
}