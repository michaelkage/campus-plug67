import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { consumeSessionHandoff } from '@/lib/sessionHandoff'
import { Smartphone, ShieldCheck, AlertTriangle } from 'lucide-react'

export default function MobileHandoff(){
  const navigate=useNavigate(); const [state,setState]=useState<'loading'|'error'>('loading'); const [message,setMessage]=useState('Securely moving your Campus Plug session…')
  useEffect(()=>{
    let cancelled=false
    const run=async()=>{
      const token=new URLSearchParams(window.location.hash.replace(/^#/,'')).get('handoff')
      if(!token){setState('error');setMessage('This handoff link is missing its one-time token.');return}
      try{
        const result=await consumeSessionHandoff(token)
        if(cancelled)return
        window.history.replaceState(null,'',window.location.pathname)
        navigate(result.transactionId?`/safe-swap?tx=${encodeURIComponent(result.transactionId)}`:'/safe-swap',{replace:true})
      }catch(error){if(!cancelled){setState('error');setMessage(error instanceof Error?error.message:'The mobile handoff expired. Generate a new QR code from your laptop.')}}
    }
    void run(); return ()=>{cancelled=true}
  },[navigate])
  return <main className="min-h-screen bg-obsidian-950 text-white flex items-center justify-center p-6"><div className="w-full max-w-md bg-obsidian-400 border border-obsidian-500 rounded-3xl p-8 text-center shadow-2xl"><div className="w-16 h-16 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center mx-auto mb-5">{state==='error'?<AlertTriangle className="text-plug-red"/>:<Smartphone className="text-cyan"/>}</div><h1 className="text-xl font-black">{state==='error'?'Mobile handoff failed':'Meetup Mode handoff'}</h1><p className="text-sm text-white/45 mt-3">{message}</p>{state==='loading'&&<div className="mt-6 flex items-center justify-center gap-2 text-xs text-plug-green"><ShieldCheck size={14}/>One-time session transfer · 2 minute expiry</div>}{state==='error'&&<button onClick={()=>navigate('/safe-swap',{replace:true})} className="mt-6 w-full py-3 rounded-xl bg-cyan text-obsidian font-black">Open Safe Swap</button>}</div></main>
}
