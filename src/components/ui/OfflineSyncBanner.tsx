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
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      window.clearInterval(timer)
    }
  }, [])

  if (online && pending === 0) return null

  const warning = online
  return (
    <div className="fixed inset-x-0 top-0 z-[100] border-b border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] shadow-[var(--md-elevation-2)]">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 text-xs sm:text-sm">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${warning ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]' : 'bg-[var(--md-error-container)] text-[var(--md-on-error-container)]'}`}>
          {warning ? <Cloud size={16} /> : <CloudOff size={16} />}
        </span>
        <div className="min-w-0 flex-1 leading-5">
          {!online ? (
            <><strong className="font-semibold">Offline mode:</strong> your changes are saved locally when supported. Keep this tab open until the network returns so pending campus updates can publish.</>
          ) : (
            <><strong className="font-semibold">Sync in progress:</strong> {pending} campus update{pending === 1 ? '' : 's'} waiting to publish.</>
          )}
        </div>
        {pending > 0 && <RefreshCw size={16} className="shrink-0 animate-spin text-[var(--md-primary)]" />}
      </div>
    </div>
  )
}
