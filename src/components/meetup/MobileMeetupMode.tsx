import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, MapPinned, ShieldAlert, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

type Props={transactionId:string; onReleased?:()=>void}

export default function MobileMeetupMode({transactionId,onReleased}:Props){
  const videoRef=useRef<HTMLVideoElement>(null); const streamRef=useRef<MediaStream|null>(null)
  const [scanning,setScanning]=useState(false); const [duressOpen,setDuressOpen]=useState(false); const [code,setCode]=useState(''); const [busy,setBusy]=useState(false)
  useEffect(()=>()=>{streamRef.current?.getTracks().forEach(track=>track.stop())},[])
  const scan=async()=>{
    if(!('BarcodeDetector' in window)){toast.error('QR camera scanning is not supported here. Use the QR code text field in the transaction panel.');return}
    try{
      const detector=new (window as Window & {BarcodeDetector?:new(o?:{formats:string[]})=>{detect:(source:CanvasImageSource)=>Promise<Array<{rawValue:string}>>}}).BarcodeDetector?.({formats:['qr_code']})
      if(!detector)throw new Error('QR scanner unavailable')
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}}); streamRef.current=stream; setScanning(true)
      const video=videoRef.current; if(!video)throw new Error('Camera preview unavailable'); video.srcObject=stream; await video.play()
      let stopped=false
      const loop=async()=>{if(stopped||!video.videoWidth)return;try{const hits=await detector.detect(video);const value=hits[0]?.rawValue;if(value){stopped=true;stopScan();await release(value)}}catch{} if(!stopped)requestAnimationFrame(loop)}
      requestAnimationFrame(loop)
    }catch(error){toast.error(error instanceof Error?error.message:'Unable to start the QR camera')}
  }
  const stopScan=()=>{streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;setScanning(false)}
  const release=async(raw:string)=>{setBusy(true);try{let secret=raw;try{const url=new URL(raw);secret=url.searchParams.get('qr')||url.searchParams.get('release_code')||raw}catch{}const {data,error}=await supabase.functions.invoke('release-escrow',{body:{action:'release',transaction_id:transactionId,qr_secret:secret}});if(error)throw error;if(!data?.success)throw new Error(data?.error||'Release failed');toast.success('QR handshake verified — escrow released.');onReleased?.()}catch(error){toast.error(error instanceof Error?error.message:'QR release failed')}finally{setBusy(false)}}
  const triggerDuress=async()=>{if(!/^[0-9]{4,8}$/.test(code)){toast.error('Enter your 4–8 digit safety PIN.');return}setBusy(true);try{const {data,error}=await supabase.functions.invoke('release-escrow',{body:{action:'duress',transaction_id:transactionId,duress_code:code}});if(error)throw error;if(!data?.success)throw new Error(data?.error||'Safety alert failed');toast.success('Safety alert activated. Escrow is frozen.');setDuressOpen(false);setCode('')}catch(error){toast.error(error instanceof Error?error.message:'Safety alert failed')}finally{setBusy(false)}}
  return <section className="rounded-3xl border-2 border-cyan/40 bg-black p-5 shadow-[0_0_35px_rgba(0,242,255,.12)] md:hidden" aria-label="Mobile meetup mode">
    <div className="flex items-center justify-between gap-3 mb-5"><div><div className="text-[10px] font-black uppercase tracking-[.2em] text-cyan">Meetup Execution Mode</div><h2 className="text-2xl font-black mt-1">Chop Eye / Inspection Time</h2></div><div className="rounded-xl px-3 py-2 border border-plug-green/40 bg-plug-green/10 text-plug-green text-[10px] font-black">PHONE ONLY</div></div>
    <div className="grid grid-cols-2 gap-3 mb-4"><div className="rounded-2xl border border-white/10 bg-white/[.04] p-4"><MapPinned className="text-cyan mb-2" size={22}/><div className="text-xs font-black">LIVE CAMPUS GPS</div><div className="text-[10px] text-white/40 mt-1">Keep location services enabled.</div></div><div className="rounded-2xl border border-white/10 bg-white/[.04] p-4"><ShieldAlert className="text-plug-amber mb-2" size={22}/><div className="text-xs font-black">SAFETY PIN</div><div className="text-[10px] text-white/40 mt-1">Emergency freeze is always available.</div></div></div>
    <div className="rounded-2xl overflow-hidden border-2 border-white/15 bg-obsidian-400"><div className="aspect-square flex items-center justify-center relative">{scanning?<video ref={videoRef} playsInline muted className="w-full h-full object-cover"/>:<div className="text-center p-8"><Camera size={40} className="mx-auto text-cyan mb-3"/><div className="font-black">Scan seller QR</div><div className="text-xs text-white/40 mt-1">Point the rear camera at the seller's release QR.</div></div>}</div><div className="p-3 border-t border-white/10">{scanning?<button onClick={stopScan} className="w-full py-3 rounded-xl border border-white/15 font-black text-sm flex items-center justify-center gap-2"><X size={16}/>Stop scanner</button>:<button onClick={scan} disabled={busy} className="w-full py-3 rounded-xl bg-cyan text-obsidian font-black text-sm flex items-center justify-center gap-2"><Camera size={16}/>Open QR scanner</button>}</div></div>
    <button onClick={()=>setDuressOpen(true)} className="mt-4 w-full py-3 rounded-xl border border-plug-red/40 bg-plug-red/10 text-plug-red font-black text-sm flex items-center justify-center gap-2"><AlertTriangle size={16}/>Safety alert / duress PIN</button>
    {duressOpen&&<div className="fixed inset-0 z-[80] bg-black/85 flex items-end justify-center p-4"><div className="w-full max-w-md rounded-3xl bg-obsidian-400 border border-plug-red/40 p-6"><div className="flex items-center justify-between"><div><div className="text-xs uppercase tracking-widest text-plug-red font-black">Safety freeze</div><h3 className="text-xl font-black mt-1">Enter your duress PIN</h3></div><button onClick={()=>setDuressOpen(false)}><X/></button></div><p className="text-xs text-white/45 mt-3">Use this only if you need to silently freeze the transaction and create a campus security alert.</p><input inputMode="numeric" autoComplete="off" type="password" maxLength={8} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,8))} className="input mt-4 text-center text-2xl tracking-[.4em]" placeholder="••••"/><button onClick={triggerDuress} disabled={busy} className="w-full mt-4 py-3 rounded-xl bg-plug-red text-white font-black">{busy?'Activating…':'Freeze transaction'}</button></div></div>}
    {busy&&<div className="mt-3 text-center text-xs text-cyan animate-pulse">Securing transaction…</div>}
    {onReleased&&<div className="mt-3 flex items-center justify-center gap-2 text-[10px] text-plug-green"><CheckCircle2 size={12}/>Server-authorized handshake only</div>}
  </section>
}
