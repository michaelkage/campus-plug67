import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { getDeviceType } from '@/lib/device'
import { formatCountdown } from '@/lib/escrowTiming'
import { saveLocalTransaction, removeLocalTransaction, getLocalTransaction } from '@/lib/transactionState'
import { createOfflineHandoffTicket, createOfflineHandoffToken, hashOfflineHandoffToken, offlineHandoffCommitmentKey, offlineHandoffReceiptKey, type OfflineHandoffCommitment } from '@/lib/offlineHandoff'
import MobileMeetupMode from '@/components/meetup/MobileMeetupMode'
import { QRCodeSVG } from 'qrcode.react'
import { ShieldCheck, MapPin, Navigation, LockKeyhole, CheckCircle2, AlertTriangle, WalletCards, Smartphone, Clock3 } from 'lucide-react'
import toast from 'react-hot-toast'

type SafeZone={id:string;name:string;description:string|null;lat:number;lng:number;radius_m:number;zone_type:string}
type Tx={id:string;buyer_id:string;seller_id:string;university:string|null;status:string;escrow_status:string|null;payout_status:string|null;buyer_safe_zone_id:string|null;seller_safe_zone_id:string|null;buyer_arrived:boolean|null;seller_arrived:boolean|null;buyer_location_captured_at:string|null;seller_location_captured_at:string|null;mobile_release_ready_at:string|null;meetup_initiated_at:string|null;release_requested_at:string|null;auto_release_at:string|null;handshake_receipt_buffer:string|null;released_at:string|null;payment_method:string|null}
function distanceM(a:GeolocationCoordinates,z:SafeZone){const R=6371000,p1=a.latitude*Math.PI/180,p2=z.lat*Math.PI/180,dp=(z.lat-a.latitude)*Math.PI/180,dl=(z.lng-a.longitude)*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))}
function CarryMeAlong({tx,now}:{tx:Tx|null;now:number}){if(!tx)return null;const frozen=tx.escrow_status==='frozen';const payoutPending=tx.status==='released'&&['approved_for_settlement','processing','failed'].includes(tx.payout_status||'');const released=tx.status==='released'&&!payoutPending;const requested=tx.status==='release_requested';const qrInspection=requested&&Boolean(tx.handshake_receipt_buffer);const held=tx.escrow_status==='held';const initiated=Boolean(tx.meetup_initiated_at)||['meetup_initiated','release_requested','released'].includes(tx.status);const buyerHere=Boolean(tx.buyer_arrived||tx.buyer_safe_zone_id);const sellerHere=Boolean(tx.seller_arrived||tx.seller_safe_zone_id);const step=released?5:(requested?4:(initiated?(buyerHere&&sellerHere?3:2):(held?1:0)));const labels=['Payment locked','Meetup initiated','Both parties verified','Protected release window','Funds released'];const inspectionRemaining=tx.auto_release_at?Math.max(0,Date.parse(tx.auto_release_at)-now):null;const detail=frozen?'Safety freeze active — funds stay locked while the alert is handled.':payoutPending?'QR handshake approved; settlement is still processing.':released?'The protected exchange is complete and settlement has been confirmed.':requested?(qrInspection?'Handoff confirmed. Funds remain locked for a two-hour inspection window. The buyer can open a dispute before it expires.':'The seller requested release. Funds remain protected for the 48-hour dispute window.'):initiated?(buyerHere&&sellerHere?'Both parties have checked into the approved zone. Buyer can confirm the handoff with the phone QR.':`${buyerHere?'Buyer':'Seller'} has checked into the approved zone. Waiting for the other party.`):held?'Payment is verified and the funds are locked until the meetup.':'Payment is still being verified before the swap can proceed.';return <div className={`rounded-md border p-5 ${frozen?'border-error/40 bg-error-container/30':payoutPending?'border-secondary/40 bg-secondary-container/30':'border-outline-variant bg-surface-container'}`}><div className="flex items-center gap-2 mb-2"><WalletCards size={15} className={frozen?'text-error':payoutPending?'text-secondary':'text-primary'}/><h2 className="font-bold text-sm">Escrow journey</h2></div><p className="text-xs text-on-surface-variant mb-4">{detail}</p>{requested&&inspectionRemaining!==null&&<div className="rounded-md border border-tertiary/30 bg-tertiary/5 p-3 mb-4"><div className="text-[10px] uppercase tracking-widest text-tertiary font-black">Funds remain protected · {qrInspection?'inspection':'dispute'} window ends in</div><div className="text-2xl font-mono font-black text-tertiary mt-1">{formatCountdown(inspectionRemaining)}</div><p className="text-[11px] text-on-surface-variant mt-1">If no dispute is filed, Campus Plug automatically processes the seller payout when this timer expires.</p></div>}<div className="grid grid-cols-2 md:grid-cols-5 gap-2">{labels.map((label,i)=><div key={label} className={`rounded-md border p-3 ${i+1<=step?'border-primary/40 bg-primary-container/30':'border-outline-variant bg-surface-container-high'}`}><div className="text-[9px] uppercase tracking-widest text-on-surface-variant">Step {i+1}</div><div className={`text-[11px] font-black mt-1 ${i+1<=step?'text-primary':'text-on-surface-variant'}`}>{label}</div></div>)}</div>{initiated&&<div className="grid grid-cols-2 gap-2 mt-3"><div className={`rounded-md border p-3 ${buyerHere?'border-primary/40 bg-primary-container/20':'border-outline-variant bg-surface-container-high'}`}><div className="text-[9px] uppercase tracking-widest text-on-surface-variant">Buyer</div><div className="text-xs font-bold mt-1">{buyerHere?'✓ Checked in':'Waiting for arrival'}</div></div><div className={`rounded-md border p-3 ${sellerHere?'border-primary/40 bg-primary-container/20':'border-outline-variant bg-surface-container-high'}`}><div className="text-[9px] uppercase tracking-widest text-on-surface-variant">Seller</div><div className="text-xs font-bold mt-1">{sellerHere?'✓ Checked in':'Waiting for arrival'}</div></div></div>}</div>}

export default function SafeSwapZone(){
  const {user,profile}=useAuth();const [params]=useSearchParams();const transactionId=params.get('tx');const [now,setNow]=useState(Date.now());const [zones,setZones]=useState<SafeZone[]>([]);const [tx,setTx]=useState<Tx|null>(null);const [position,setPosition]=useState<GeolocationCoordinates|null>(null);const [error,setError]=useState<string|null>(null);const [checking,setChecking]=useState(false);const [localDraft,setLocalDraft]=useState(false);const [offlineTicket,setOfflineTicket]=useState<string|null>(null);const [offlineCommitment,setOfflineCommitment]=useState<OfflineHandoffCommitment|null>(null);const [voucherLoading,setVoucherLoading]=useState(false);const device=getDeviceType();
    useEffect(() => {
    const restoreOfflineContext=async()=>{
      if(!transactionId||!user?.id)return false;
      const cached=await getLocalTransaction(`offline-handoff-context:${transactionId}`).catch(()=>undefined);
      if(cached?.ownerId!==user.id||cached.kind!=='offline-handoff-context'||!cached.payload||typeof cached.payload!=='object')return false;
      const context=cached.payload as {tx?:Tx;safeZone?:SafeZone};
      if(!context.tx||context.tx.id!==transactionId)return false;
      setTx(context.tx);
      if(context.safeZone)setZones([context.safeZone]);
      return true;
    };
    const load = async () => {
      if(!navigator.onLine){await restoreOfflineContext();return}
      if (!profile?.university) {await restoreOfflineContext();return}
      const { data: zoneData } = await supabase
        .from('safe_zones')
        .select('id,name,description,lat,lng,radius_m,zone_type')
        .eq('active', true)
        .eq('university', profile.university)
        .order('name');
      setZones((zoneData || []) as SafeZone[]);

      if (transactionId) {
        const { data } = await supabase
          .from('transactions')
          .select('id,buyer_id,seller_id,university,status,escrow_status,payout_status,buyer_safe_zone_id,seller_safe_zone_id,buyer_arrived,seller_arrived,buyer_location_captured_at,seller_location_captured_at,mobile_release_ready_at,meetup_initiated_at,release_requested_at,auto_release_at,handshake_receipt_buffer,released_at,payment_method')
          .eq('id', transactionId)
          .single();
        setTx(data as Tx | null);
        if(data&&user?.id&&(data.buyer_id===user.id||data.seller_id===user.id)){
          const txData=data as Tx;
          const zoneId=txData.buyer_safe_zone_id||txData.seller_safe_zone_id;
          const safeZone=(zoneData||[]).find(zone=>zone.id===zoneId) as SafeZone|undefined;
          if(safeZone)await saveLocalTransaction({
            id:`offline-handoff-context:${transactionId}`,
            ownerId:user.id,
            kind:'offline-handoff-context',
            payload:{tx:txData,safeZone},
            status:'synced',
            updatedAt:Date.now(),
          }).catch(()=>{});
        }
        if(!data)await restoreOfflineContext();
        const draft = await getLocalTransaction(`safe-arrival:${transactionId}`).catch(() => undefined);
        setLocalDraft(Boolean(draft));
      }
    };
    void load();
    if (!transactionId) return;
    const channel = supabase.channel(`safe-swap-${transactionId}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'transactions',filter:`id=eq.${transactionId}`},payload=>setTx(payload.new as Tx)).subscribe();
    const poll=window.setInterval(()=>void load(),10000);
    return ()=>{window.clearInterval(poll);void supabase.removeChannel(channel)};
  }, [profile?.university, transactionId, user?.id]);

  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer)},[]);
  const buyerCheckinFresh=Boolean(tx?.buyer_arrived&&tx?.buyer_safe_zone_id&&tx?.mobile_release_ready_at&&now-new Date(tx.mobile_release_ready_at).getTime()<=10*60_000);
  const sellerCheckinFresh=Boolean(tx?.seller_arrived&&tx?.seller_safe_zone_id&&tx?.seller_location_captured_at&&now-new Date(tx.seller_location_captured_at).getTime()<=30*60_000);
  const bothCheckinsFresh=Boolean(buyerCheckinFresh&&sellerCheckinFresh&&tx?.buyer_safe_zone_id===tx?.seller_safe_zone_id);
  const releaseUnlocked=tx?.status==='meetup_initiated'&&bothCheckinsFresh;

  useEffect(()=>{
    if(!transactionId||!user?.id||!tx||tx.seller_id!==user.id||tx.status!=='meetup_initiated'){setOfflineTicket(null);return}
    let cancelled=false;
    const prepare=async()=>{
      setVoucherLoading(true);
      try{
        const local=await getLocalTransaction(`offline-handoff-seller:${transactionId}`).catch(()=>undefined);
        const cached=local?.payload as {v?:number;token?:string;expires_at?:string}|undefined;
        if(!releaseUnlocked){if(cached?.v===1&&typeof cached.token==='string'&&!cancelled)setOfflineTicket(JSON.stringify(cached));return}
        const cachedToken=cached?.v===1&&typeof cached.token==='string'?cached.token:null;
        // A cached QR remains available during a dead-zone. Its expiry is
        // enforced by PostgreSQL, never by the seller device clock.
        if(cachedToken&&!navigator.onLine){
          if(!cancelled)setOfflineTicket(JSON.stringify(cached));
          return;
        }
        if(!navigator.onLine)throw new Error('Connect once to prepare the offline handoff QR.');
        if(!cancelled)setOfflineTicket(null);
        const token=cachedToken||createOfflineHandoffToken();
        const tokenHash=await hashOfflineHandoffToken(token);
        const {data,error:prepareError}=await supabase.rpc('prepare_offline_handoff',{p_transaction_id:transactionId,p_token_hash:tokenHash});
        if(prepareError)throw prepareError;
        const prepared=data as {success?:boolean;message?:string;voucher_id:string;transaction_id:string;expires_at:string;buyer_id:string;seller_id:string;amount:number|string;safe_zone_id:string}|null;
        if(!prepared?.success)throw new Error(prepared?.message||'Unable to prepare offline QR');
        const ticket=createOfflineHandoffTicket({
          voucher_id:prepared.voucher_id, transaction_id:prepared.transaction_id, expires_at:prepared.expires_at,
          buyer_id:prepared.buyer_id, seller_id:prepared.seller_id, amount:Number(prepared.amount), safe_zone_id:prepared.safe_zone_id,
        },token);
        await saveLocalTransaction({id:`offline-handoff-seller:${transactionId}`,ownerId:user.id,kind:'offline-handoff-seller',payload:ticket,status:'synced',updatedAt:Date.now()});
        if(!cancelled)setOfflineTicket(JSON.stringify(ticket));
      }catch(error){if(!cancelled)toast.error(error instanceof Error?error.message:'Could not prepare the one-time offline handoff QR')}
      finally{if(!cancelled)setVoucherLoading(false)}
    };
    void prepare();
    return()=>{cancelled=true};
  },[transactionId,user?.id,tx?.seller_id,releaseUnlocked]);

  useEffect(()=>{
    if(!transactionId||!user?.id||!tx||tx.buyer_id!==user.id||tx.status!=='meetup_initiated')return;
    let cancelled=false; let attempts=0;
    const loadCommitment=async()=>{
      attempts+=1;
      const local=await getLocalTransaction(offlineHandoffCommitmentKey(transactionId)).catch(()=>undefined);
      if(local?.ownerId===user.id&&local.payload&&typeof local.payload==='object'){
        const cached=local.payload as OfflineHandoffCommitment;
        if(cached.success&&!cancelled)setOfflineCommitment(cached);
      }
      if(!navigator.onLine||cancelled)return;
      const {data,error:commitmentError}=await supabase.rpc('get_offline_handoff_commitment',{p_transaction_id:transactionId});
      const received=data as OfflineHandoffCommitment|null;
      if(!commitmentError&&received?.success){
        const commitment=received;
        await saveLocalTransaction({id:offlineHandoffCommitmentKey(transactionId),ownerId:user.id,kind:'offline-handoff-commitment',payload:commitment,status:'synced',updatedAt:Date.now()}).catch(()=>{});
        if(!cancelled)setOfflineCommitment(commitment);
      }
    };
    void loadCommitment();
    const timer=window.setInterval(()=>{if(attempts<8&&!offlineCommitment)void loadCommitment()},2500);
    return()=>{cancelled=true;window.clearInterval(timer)};
  },[transactionId,user?.id,tx?.buyer_id,tx?.status]);
  // Recover queued proofs independently of the conditional mobile scanner.
  // This runs after a reload even when transaction data was unavailable offline.
  useEffect(()=>{
    if(!transactionId||!user?.id)return;
    let syncing=false;
    const syncReceipt=async()=>{
      if(!navigator.onLine||syncing)return;
      syncing=true;
      const key=offlineHandoffReceiptKey(transactionId);
      try{
        const local=await getLocalTransaction(key).catch(()=>undefined);
        if(!local||local.ownerId!==user.id||local.kind!=='offline-handoff-receipt'||!local.payload||typeof local.payload!=='object')return;
        const receipt=local.payload as {transactionId?:string;voucherId?:string;token?:string};
        if(receipt.transactionId!==transactionId||!receipt.voucherId||!receipt.token)return;
        await saveLocalTransaction({...local,status:'syncing',updatedAt:Date.now(),error:undefined});
        const {data,error}=await supabase.rpc('confirm_offline_handoff',{
          p_transaction_id:transactionId,p_voucher_id:receipt.voucherId,p_token:receipt.token,
        });
        if(error){
          const status=(error as {status?:number}).status;
          const transient=!navigator.onLine||!status||status===0||status>=500;
          await saveLocalTransaction({...local,status:transient?'queued':'failed',updatedAt:Date.now(),error:error.message}).catch(()=>{});
          if(!transient)toast.error(error.message||'The saved handoff proof needs attention');
          return;
        }
        if((data as {success?:boolean}|null)?.success){
          await removeLocalTransaction(key).catch(()=>{});
          toast.success('Saved offline handoff synchronized. Funds remain protected for the two-hour inspection window.');
          setTx(current=>current?({...current,status:'release_requested'}):current);
        }else{
          await saveLocalTransaction({...local,status:'failed',updatedAt:Date.now(),error:'Server did not confirm the saved handoff'}).catch(()=>{});
        }
      }catch{
        // Leave the durable receipt in IndexedDB. The next online/visible retry
        // will resume it; a transient client failure must never erase proof.
      }finally{syncing=false}
    };
    const onOnline=()=>{void syncReceipt()};
    const onVisible=()=>{if(document.visibilityState==='visible')void syncReceipt()};
    const interval=window.setInterval(()=>void syncReceipt(),30000);
    window.addEventListener('online',onOnline);
    document.addEventListener('visibilitychange',onVisible);
    void syncReceipt();
    return()=>{window.clearInterval(interval);window.removeEventListener('online',onOnline);document.removeEventListener('visibilitychange',onVisible)};
  },[transactionId,user?.id]);

  const nearest=useMemo(()=>{if(!position||!zones.length)return null;return zones.map(zone=>({zone,distance:Math.round(distanceM(position,zone))})).sort((a,b)=>a.distance-b.distance)[0]},[position,zones]);const isInside=nearest?nearest.distance<=50:false;
  const startGps=()=>{if(device!=='mobile'){setError('This device cannot provide a trustworthy meetup GPS fix. Scan the desktop Transfer-to-Mobile QR and continue on your phone.');return}if(!navigator.geolocation){setError('This browser does not provide GPS.');return}setError(null);navigator.geolocation.getCurrentPosition(pos=>setPosition(pos.coords),err=>setError(err.message||'Unable to read your location.'),{enableHighAccuracy:true,timeout:12000,maximumAge:3000})}
  const confirmArrival=async()=>{if(device!=='mobile'){toast.error('Meetup verification is phone-only.');return}if(!user||!transactionId||!position)return;setChecking(true);await saveLocalTransaction({id:`safe-arrival:${transactionId}`,ownerId:user.id,kind:'safe-arrival',payload:{transactionId,role:tx?.buyer_id===user.id?'buyer':tx?.seller_id===user.id?'seller':null,lat:position.latitude,lng:position.longitude},status:'syncing',updatedAt:Date.now()}).catch(()=>{});try{const role=tx?.buyer_id===user.id?'buyer':tx?.seller_id===user.id?'seller':null;if(!role)throw new Error('You are not a participant in this transaction.');const {data,error:rpcError}=await supabase.functions.invoke('safe-arrival',{body:{transaction_id:transactionId,role,lat:position.latitude,lng:position.longitude}});if(rpcError)throw rpcError;if(!data?.success)throw new Error(data?.message||'You are outside the approved Safe Swap Zone.');await removeLocalTransaction(`safe-arrival:${transactionId}`).catch(()=>{});setLocalDraft(false);toast.success(`${data.zone_name} verified — mobile QR release zone confirmed.`);setTx(prev=>prev?({...prev,...(role==='buyer'?{buyer_safe_zone_id:data.zone_id}:{seller_safe_zone_id:data.zone_id})}):prev)}catch(err){await saveLocalTransaction({id:`safe-arrival:${transactionId}`,ownerId:user.id,kind:'safe-arrival',payload:{transactionId},status:'failed',updatedAt:Date.now(),error:err instanceof Error?err.message:'Verification failed'}).catch(()=>{});setLocalDraft(true);toast.error(err instanceof Error?err.message:'Safe-zone verification failed')}finally{setChecking(false)}}
  return <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
    {transactionId&&device==='mobile'&&tx?.buyer_id===user?.id&&tx?.status==='meetup_initiated'&&!sellerCheckinFresh&&<div className="rounded-md border border-outline-variant bg-surface-container p-4 text-sm">Waiting for the seller to verify arrival in this Safe Swap Zone. Their check-in remains valid for 30 minutes.</div>}
    {transactionId&&device==='mobile'&&tx?.buyer_id===user?.id&&tx?.status==='meetup_initiated'&&(sellerCheckinFresh||Boolean(offlineCommitment))&&<MobileMeetupMode transactionId={transactionId} releaseUnlocked={releaseUnlocked||Boolean(offlineCommitment)} offlineCommitment={offlineCommitment} safeZone={zones.find(zone=>zone.id===tx?.buyer_safe_zone_id)||null} onReleased={()=>window.location.reload()}/>} 
    <div className="card-tactical" style={{ padding: 24 }}><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-[var(--md-secondary)] text-xs font-black uppercase tracking-widest"><ShieldCheck size={15}/>Safe Swap Zone</div><h1 className="text-2xl font-black mt-2">Meet where the QR release is protected.</h1><p className="text-sm text-on-surface/70 mt-2 max-w-2xl">The buyer scans the seller's QR at an approved campus meetup point to confirm handoff. Escrow funds remain locked for a two-hour inspection window before automatic settlement. Safe-zone checks remain server-validated.</p></div><div className="rounded-md border border-[var(--md-primary)]/30 bg-[var(--md-primary)]/6 px-4 py-3 text-right"><div className="text-[10px] uppercase tracking-widest text-on-surface/60">Release radius</div><div className="text-2xl font-black text-[var(--md-primary)] font-mono">50m</div></div></div></div>
    {device==='desktop'&&transactionId&&<div className="rounded-md border-2 border-primary/30 bg-primary/5 p-5 flex items-start gap-3"><Smartphone className="text-primary mt-0.5"/><div><div className="font-black">Meetup verification moved to your phone</div><p className="text-xs text-on-surface/60 mt-1">Laptop mode remains available for listings and transaction management, but physical GPS and QR release are intentionally gated to mobile.</p></div></div>}
    {localDraft&&<div className="rounded-md border border-tertiary/30 bg-tertiary/5 p-3 text-xs text-tertiary">A previous safe-arrival sync was interrupted. Refresh your phone GPS and verify again; the local state has been retained instead of silently disappearing.</div>}
    {transactionId&&<CarryMeAlong tx={tx} now={now}/>} {tx?.meetup_initiated_at&&tx.status!=='released'&&<div className={`rounded-md border p-5 ${releaseUnlocked?'border-primary/40 bg-primary-container/20':'border-outline-variant bg-surface-container'}`}><div className="flex items-center gap-2"><Clock3 size={17} className={releaseUnlocked?'text-primary':'text-secondary'}/><div><div className="text-xs uppercase tracking-widest text-on-surface-variant font-black">Meetup verification</div><div className="font-bold mt-1">{releaseUnlocked?'Both parties verified. Handoff confirmation is available.':'Handoff unlocks when both parties have fresh check-ins in the same Safe Swap Zone.'}</div></div></div>{releaseUnlocked&&<p className="text-xs text-on-surface-variant mt-3">The server verifies both arrival records, zone identity and freshness before accepting the buyer QR confirmation. Seller funds remain protected for two hours after confirmation.</p>}</div>}<div className="grid lg:grid-cols-[1.6fr_1fr] gap-5"><div className="bg-surface-container-high border border-outline-variant rounded-md overflow-hidden"><div className="h-[430px] bg-surface-container-highest"><iframe title="Campus Safe Swap Zone map" src="https://www.openstreetmap.org/export/embed.html?bbox=3.390,6.495,3.415,6.520&layer=mapnik" className="w-full h-full border-0" loading="lazy"/></div><div className="p-4 border-t border-outline-variant"><div className="flex items-center gap-2 text-xs font-bold text-on-surface/70"><LockKeyhole size={13} className="text-primary"/>Server-authoritative release gate</div><p className="text-xs text-on-surface/50 mt-1">The map is for orientation. The final 50m check is performed server-side against the recorded phone GPS fix.</p></div></div>
      <div className="space-y-4"><div className="bg-surface-container-high border border-outline-variant rounded-md p-5"><div className="flex items-center justify-between mb-4"><h2 className="font-bold text-sm">Your location</h2>{position&&<span className={`text-[10px] font-bold ${isInside?'text-primary':'text-error'}`}>{isInside?'IN SAFE ZONE':'OUTSIDE'}</span>}</div>{position?<div className="grid grid-cols-2 gap-3 text-xs font-mono"><div><span className="text-on-surface/30 block">LAT</span>{position.latitude.toFixed(6)}</div><div><span className="text-on-surface/30 block">LNG</span>{position.longitude.toFixed(6)}</div><div className="col-span-2"><span className="text-on-surface/30 block">GPS ACCURACY</span>±{Math.round(position.accuracy)}m</div></div>:<p className="text-xs text-on-surface/50">Use your phone to get a fresh GPS fix before confirming arrival.</p>}{nearest&&<div className={`mt-4 rounded-md p-3 border ${isInside?'border-primary/30 bg-primary/5':'border-error/30 bg-error/5'}`}><div className="flex items-center gap-2"><MapPin size={13}/><span className="font-bold text-xs">{nearest.zone.name}</span></div><div className="text-[10px] text-on-surface/40 mt-1">{nearest.distance}m from center · 50m release radius</div></div>}<button onClick={startGps} disabled={device!=='mobile'} className="w-full mt-4 py-3 rounded-md bg-primary text-on-primary font-black text-sm flex items-center justify-center gap-2 disabled:opacity-40"><Navigation size={15}/>{device==='mobile'?'Refresh phone GPS':'Phone required'}</button>{error&&<p className="text-xs text-error mt-2 flex gap-2"><AlertTriangle size={13}/>{error}</p>}</div>
        {tx&&tx.seller_id===user?.id&&tx.status==='meetup_initiated'&&offlineTicket&&<div className="bg-surface-container-high border border-primary/30 rounded-md p-5 space-y-3"><div><h2 className="font-bold text-sm">One-time offline handoff QR</h2><p className="text-xs text-on-surface-variant mt-1">The buyer can verify this QR locally if campus internet drops. It expires after 24 hours, can only be consumed once, and never releases funds offline. The buyer must have loaded the matching commitment before going offline.</p></div>{offlineTicket?<div className="flex justify-center rounded-md bg-white p-4"><QRCodeSVG value={offlineTicket} size={220} level="M" includeMargin/></div>:<p className="text-xs text-on-surface-variant">{voucherLoading?'Preparing a one-time handoff voucher…':'Connect to the internet to prepare the offline QR.'}</p>}<p className="text-[10px] text-center text-on-surface-variant">Keep this QR private and show it only to the buyer in person.</p></div>}
        {transactionId&&<div className="bg-surface-container-high border border-outline-variant rounded-md p-5"><h2 className="font-bold text-sm mb-2">Transaction handshake</h2><p className="text-xs text-on-surface/40 mb-4">TX {transactionId.slice(0,8).toUpperCase()}</p><button onClick={confirmArrival} disabled={!position||!isInside||checking||device!=='mobile'} className="w-full py-3 rounded-md bg-primary text-on-primary font-black text-sm disabled:opacity-30 flex items-center justify-center gap-2"><CheckCircle2 size={15}/>{checking?'VERIFYING…':device==='mobile'?'VERIFY SAFE SWAP LOCATION':'SCAN DESKTOP QR TO CONTINUE'}</button><p className="text-[10px] text-on-surface/30 mt-3">Desktop clients cannot authorize physical arrival. This prevents inaccurate laptop network location data from blocking or corrupting the release ceremony.</p></div>}
        <div className="bg-surface-container-high border border-outline-variant rounded-md p-5"><h2 className="font-bold text-sm mb-3">Approved campus points</h2><div className="space-y-2">{zones.map(zone=><div key={zone.id} className="flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container-highest/30 p-3"><div className="w-7 h-7 rounded-sm bg-primary/10 flex items-center justify-center text-primary flex-shrink-0"><MapPin size={13}/></div><div className="min-w-0"><div className="text-xs font-bold truncate">{zone.name}</div><div className="text-[10px] text-on-surface/50 mt-0.5">50m strict release radius</div></div></div>)}{zones.length===0&&<p className="text-xs text-on-surface/30">No active safe zones configured for this campus yet.</p>}</div></div></div></div>
  </div>
}
