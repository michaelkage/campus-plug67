import { useEffect, useState } from 'react'
import { listActiveLocalTransactions } from '@/lib/transactionState'

export default function TransactionSyncGuard(){
  const [active,setActive]=useState(false)
  useEffect(()=>{let alive=true;const check=async()=>{const rows=await listActiveLocalTransactions().catch(()=>[]);if(alive)setActive(rows.some(row=>row.status==='syncing'||row.status==='queued'))};void check();const timer=window.setInterval(check,1500);return()=>{alive=false;window.clearInterval(timer)}},[])
  useEffect(()=>{if(!active)return;const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='Campus Plug is still syncing an active transaction.'};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler)},[active])
  return null
}
