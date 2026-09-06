import { useEffect, useState } from 'react'
import { CloudOff, Cloud, RefreshCw } from 'lucide-react'

export default function OfflineSyncBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    const timer = window.setInterval(() => {
      try { setPending(Number(localStorage.getItem('cp-offline-pending') || '0')) } catch { setPending(0) }
    }, 1000)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.clearInterval(timer) }
  }, [])

  if (online && pending === 0) return null

  return (
    <div className={`fixed top-0 left-0 right-0 z-[100] border-b px-4 py-2.5 text-xs shadow-lg backdrop-blur-md ${online ? 'bg-plug-amber/10 border-plug-amber/30 text-plug-amber' : 'bg-plug-red/10 border-plug-red/30 text-white'}`}>
      <div className="max-w-7xl mx-auto flex items-center gap-3">
        {online ? <Cloud size={15} className="text-plug-amber flex-shrink-0" /> : <CloudOff size={15} className="text-plug-red flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          {!online ? (
            <><strong>Offline Mode:</strong> your changes are saved locally when supported. Keep this tab open until network returns so pending campus updates can publish.</>
          ) : (
            <><strong>Sync in progress:</strong> {pending} campus update{pending === 1 ? '' : 's'} waiting to publish.</>
          )}
        </div>
        {pending > 0 && <RefreshCw size={13} className="animate-spin text-plug-amber flex-shrink-0" />}
      </div>
    </div>
  )
}
