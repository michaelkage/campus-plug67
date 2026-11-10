import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, MapPinned, ShieldAlert, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { offlineHandoffReceiptKey, verifyOfflineHandoffTicket, type OfflineHandoffCommitment } from '@/lib/offlineHandoff'
import { getLocalTransaction, removeLocalTransaction, saveLocalTransaction } from '@/lib/transactionState'
import toast from 'react-hot-toast'

type BarcodeDetectorLike={detect:(source:CanvasImageSource)=>Promise<Array<{rawValue:string}>>}
type Props={transactionId:string;releaseUnlocked:boolean;offlineCommitment?:OfflineHandoffCommitment|null;safeZone?:{id:string;lat:number;lng:number;radius_m:number}|null;onReleased?:()=>void}

export default function MobileMeetupMode({transactionId,releaseUnlocked,offlineCommitment,safeZone,onReleased}:Props){
  const videoRef=useRef<HTMLVideoElement>(null);const streamRef=useRef<MediaStream|null>(null);const [scanning,setScanning]=useState(false);const [duressOpen,setDuressOpen]=useState(false);const [code,setCode]=useState('');const [manualQr,setManualQr]=useState('');const [busy,setBusy]=useState(false);const [receiptStatus,setReceiptStatus]=useState<string|null>(null);const [receiptError,setReceiptError]=useState<string|null>(null)
  useEffect(()=>{let active=true;const refresh=()=>void getLocalTransaction(offlineHandoffReceiptKey(transactionId)).then(local=>{if(!active||!local||local.ownerId!==offlineCommitment?.buyer_id)return;setReceiptStatus(local.status);setReceiptError(local.error||null)}).catch(()=>{});refresh();const timer=window.setInterval(refresh,3000);return()=>{active=false;window.clearInterval(timer)}},[transactionId,offlineCommitment?.buyer_id])
  const retrySavedProof=async()=>{const key=offlineHandoffReceiptKey(transactionId);const local=await getLocalTransaction(key).catch(()=>undefined);if(!local||local.ownerId!==offlineCommitment?.buyer_id||local.kind!=='offline-handoff-receipt'){setReceiptStatus(null);return}await saveLocalTransaction({...local,status:'queued',updatedAt:Date.now(),error:undefined});setReceiptStatus('queued');setReceiptError(null);if(!navigator.onLine){toast.success('Proof queued. Reconnect to synchronize it with Campus Plug.');return}toast.success('Proof queued for secure synchronization. Keep this page open briefly while it retries.')}
  useEffect(()=>()=>{streamRef.current?.getTracks().forEach(track=>track.stop())},[])
  const stopScan=()=>{streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;setScanning(false)}

  const release=async(raw:string)=>{setBusy(true);try{
    if(!offlineCommitment)throw new Error('Offline verification is not prepared. Open Safe Swap while connected before scanning.');
    if(!safeZone)throw new Error('The approved Safe Swap Zone details are not cached on this phone. Reconnect and reload Safe Swap before scanning.');
    if(!navigator.geolocation)throw new Error('Phone GPS is required to confirm the handoff location.');
    const position=await new Promise<GeolocationPosition>((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:12000,maximumAge:0}));
    if(position.coords.accuracy>50)throw new Error('GPS accuracy is too low. Refresh your location and try again.');
    const toRadians=(degrees:number)=>degrees*Math.PI/180;
    const lat1=toRadians(position.coords.latitude),lat2=toRadians(safeZone.lat);
    const dLat=toRadians(safeZone.lat-position.coords.latitude),dLng=toRadians(safeZone.lng-position.coords.longitude);
    const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    const distance=6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
    if(distance>safeZone.radius_m)throw new Error('You must be inside the same approved Safe Swap Zone to confirm this handoff.');
    const ticket=await verifyOfflineHandoffTicket(raw,offlineCommitment);
    await saveLocalTransaction({
      id:offlineHandoffReceiptKey(transactionId),
      ownerId:offlineCommitment.buyer_id,
      kind:'offline-handoff-receipt',
      payload:{transactionId,voucherId:ticket.voucher_id,token:ticket.token},
      status:'queued',
      updatedAt:Date.now(),
    });
    if(!navigator.onLine){
      toast.success('QR verified offline. Your handoff proof is saved. Reconnect and sync it before the QR's 10-minute server expiry. Funds have not been released.');
      return;
    }
    const {data,error}=await supabase.rpc('confirm_offline_handoff',{
      p_transaction_id:transactionId,p_voucher_id:ticket.voucher_id,p_token:ticket.token,
    });
    if(error){
      const httpStatus=(error as {status?:number}).status;
      if(!navigator.onLine||!httpStatus||httpStatus===0||httpStatus===401||httpStatus===408||httpStatus===429||httpStatus>=500){
        toast.success('QR verified offline. Your handoff proof is saved. Reconnect to synchronize it. Funds have not been released.');
        return;
      }
      await saveLocalTransaction({
        id:offlineHandoffReceiptKey(transactionId),
        ownerId:offlineCommitment.buyer_id,
        kind:'offline-handoff-receipt',
        payload:{transactionId,voucherId:ticket.voucher_id,token:ticket.token},
        status:'failed',
        updatedAt:Date.now(),
        error:error.message||'Server rejected the offline handoff proof',
      }).catch(()=>{});
      throw error;
    }
    const confirmation=data as {success?:boolean;error?:string}|null;
    if(!confirmation?.success)throw new Error(confirmation?.error||'Handoff confirmation failed');
    await removeLocalTransaction(offlineHandoffReceiptKey(transactionId)).catch(()=>{});
    toast.success('Handoff confirmed. Funds remain protected for a 2-hour inspection window.');
    onReleased?.();
  }catch(error){toast.error(error instanceof Error?error.message:'QR handoff verification failed')}finally{setBusy(false)}}
  const scan=async()=>{if(!releaseUnlocked){toast.error('Complete fresh Safe Swap check-ins in the same zone before confirming handoff.');return}const BarcodeDetectorCtor=(window as unknown as {BarcodeDetector?:new(o?:{formats:string[]})=>BarcodeDetectorLike}).BarcodeDetector;if(!BarcodeDetectorCtor){toast.error('QR camera scanning is not supported here. Use the QR code text field in the transaction panel.');return}try{const detector=new BarcodeDetectorCtor({formats:['qr_code']});const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});streamRef.current=stream;setScanning(true);const video=videoRef.current;if(!video)throw new Error('Camera preview unavailable');video.srcObject=stream;await video.play();let stopped=false;const loop=async()=>{if(stopped)return;if(!video.videoWidth){requestAnimationFrame(loop);return}try{const hits=await detector.detect(video);const value=hits[0]?.rawValue;if(value){stopped=true;stopScan();await release(value)}}catch{}if(!stopped)requestAnimationFrame(loop)};requestAnimationFrame(loop)}catch(error){toast.error(error instanceof Error?error.message:'Unable to start the QR camera')}}
  const triggerDuress=async()=>{if(!/^[0-9]{4,8}$/.test(code)){toast.error('Enter your 4–8 digit safety PIN.');return}setBusy(true);try{const {data,error}=await supabase.functions.invoke('release-escrow',{body:{action:'duress',transaction_id:transactionId,duress_code:code}});if(error)throw error;if(!data?.success)throw new Error(data?.error||'Safety alert failed');toast.success('Safety alert activated. Escrow is frozen.');setDuressOpen(false);setCode('')}catch(error){toast.error(error instanceof Error?error.message:'Safety alert failed')}finally{setBusy(false)}}
  return <section className="rounded-md border border-outline-variant bg-surface-container p-5 shadow-none md:hidden" aria-label="Mobile meetup mode"><div className="flex items-center justify-between gap-3 mb-5"><div><div className="text-[10px] font-black uppercase tracking-[.2em] text-primary">Meetup Execution Mode</div><h2 className="text-2xl font-black mt-1">Chop Eye / Inspection Time</h2></div><div className="rounded-md px-3 py-2 border border-outline-variant bg-primary-container text-on-primary-container text-[10px] font-black">PHONE ONLY</div></div><div className="grid grid-cols-2 gap-3 mb-4"><div className="rounded-md border border-outline-variant bg-surface-container-high p-4"><MapPinned className="text-primary mb-2" size={22}/><div className="text-xs font-black">LIVE CAMPUS GPS</div><div className="text-[10px] text-on-surface-variant mt-1">Keep location services enabled.</div></div><div className="rounded-md border border-outline-variant bg-surface-container-high p-4"><ShieldAlert className="text-tertiary mb-2" size={22}/><div className="text-xs font-black">SAFETY PIN</div><div className="text-[10px] text-on-surface-variant mt-1">Emergency freeze is always available.</div></div></div><div className="rounded-md overflow-hidden border-2 border-outline-variant bg-surface-container-high"><div className="aspect-square flex items-center justify-center relative">{scanning?<video ref={videoRef} playsInline muted className="w-full h-full object-cover"/>:<div className="text-center p-8"><Camera size={40} className="mx-auto text-primary mb-3"/><div className="font-black">Confirm handoff</div><div className="text-xs text-on-surface-variant mt-1">Scan the seller's handoff QR. This confirms receipt, not an immediate payout.</div></div>}</div><div className="p-3 border-t border-outline-variant">{scanning?<button onClick={stopScan} className="w-full py-3 rounded-md border border-outline font-black text-sm flex items-center justify-center gap-2"><X size={16}/>Stop scanner</button>:<button onClick={scan} disabled={busy||!releaseUnlocked||!offlineCommitment} className="w-full py-3 rounded-md bg-primary text-on-primary font-black text-sm flex items-center justify-center gap-2"><Camera size={16}/>{releaseUnlocked?(offlineCommitment?'Scan handoff QR':'Preparing offline verification…'):'Waiting for both Safe Swap check-ins'}</button>}</div></div><div className="mt-3 rounded-md border border-outline-variant bg-surface-container-high p-3 space-y-2"><label htmlFor="manual-seller-qr" className="text-xs font-bold">Camera not working? Enter the seller handoff code</label><input id="manual-seller-qr" value={manualQr} onChange={event=>setManualQr(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste QR text / handoff code" className="input w-full font-mono text-xs" disabled={busy||!releaseUnlocked||!offlineCommitment}/><button onClick={()=>void release(manualQr.trim())} disabled={busy||!releaseUnlocked||!offlineCommitment||!manualQr.trim()} className="w-full py-3 rounded-md border border-primary/40 text-primary font-black text-sm disabled:opacity-40">{busy?'Verifying…':'Confirm handoff'}</button></div><div className="mt-3 rounded-md border border-outline-variant bg-surface-container-high p-3" aria-live="polite">{receiptStatus==='failed'&&<><div className="text-xs font-bold">Handoff proof needs another attempt</div><p className="text-[11px] text-on-surface-variant mt-1">{receiptError||'The server did not accept the saved proof. Your proof is still stored on this phone.'}</p><button onClick={()=>void retrySavedProof()} disabled={busy} className="w-full mt-2 py-2 rounded-md border border-primary/40 text-primary text-xs font-black">Retry handoff synchronization</button></>}{(receiptStatus==='queued'||receiptStatus==='syncing')&&<><div className="text-xs font-bold">Handoff proof saved, awaiting server confirmation</div><p className="text-[11px] text-on-surface-variant mt-1">QR verification is not payment release. Funds remain locked until the server confirms the handoff.</p></>}</div><button onClick={()=>setDuressOpen(true)} className="mt-4 w-full py-3 rounded-md border border-error bg-error-container text-on-error-container font-black text-sm flex items-center justify-center gap-2"><AlertTriangle size={16}/>Safety alert / duress PIN</button>{duressOpen&&<div className="fixed inset-0 z-[80] bg-scrim/80 flex items-end justify-center p-4"><div className="w-full max-w-md rounded-md bg-surface-container-high border border-error p-6"><div className="flex items-center justify-between"><div><div className="text-xs uppercase tracking-widest text-on-error-container font-black">Safety freeze</div><h3 className="text-xl font-black mt-1">Enter your duress PIN</h3></div><button onClick={()=>setDuressOpen(false)}><X/></button></div><p className="text-xs text-on-surface/45 mt-3">Use this only if you need to silently freeze the transaction and create a campus security alert.</p><input inputMode="numeric" autoComplete="off" type="password" maxLength={8} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,8))} className="input mt-4 text-center text-2xl tracking-[.4em]" placeholder="••••"/><button onClick={triggerDuress} disabled={busy} className="w-full mt-4 py-3 rounded-md bg-error text-on-surface font-black">{busy?'Activating…':'Freeze transaction'}</button></div></div>}{busy&&<div className="mt-3 text-center text-xs text-primary animate-pulse">Securing transaction…</div>}{onReleased&&<div className="mt-3 flex items-center justify-center gap-2 text-[10px] text-on-primary-container"><CheckCircle2 size={12}/>Server-authorized handshake only</div>}</section>
}
