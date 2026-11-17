import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { listActiveLocalTransactions, purgeStaleLocalTransactions } from '@/lib/transactionState'

export default function TransactionSyncGuard(){
  const { user } = useAuth()
  const [active,setActive]=useState(false)

  useEffect(()=>{
    let alive=true
    const check=async()=>{
      if(!user?.id){setActive(false);return}
      await purgeStaleLocalTransactions(user.id).catch(()=>undefined)
      const rows=await listActiveLocalTransactions(user.id).catch(()=>[])
      if(alive)setActive(rows.some(row=>row.status==='syncing'||row.status==='queued'))
    }
    void check()
    const timer=window.setInterval(check,1500)
    return()=>{alive=false;window.clearInterval(timer)}
  },[user?.id])

  useEffect(()=>{
    if(!active)return
    const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='Campus Plug is still syncing an active transaction.'}
    window.addEventListener('beforeunload',handler)
    return()=>window.removeEventListener('beforeunload',handler)
  },[active])

  return null
}
