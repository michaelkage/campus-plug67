import { useEffect } from 'react'

export function useTransactionSyncGuard(active:boolean) {
  useEffect(()=>{
    if(!active || typeof window==='undefined') return
    const handler=(event:BeforeUnloadEvent)=>{ event.preventDefault(); event.returnValue='Campus Plug is still syncing an active transaction.' }
    window.addEventListener('beforeunload',handler)
    return ()=>window.removeEventListener('beforeunload',handler)
  },[active])
}
