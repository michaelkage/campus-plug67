import { useEffect, useState } from 'react'
import { CloudOff } from 'lucide-react'

export default function OfflineSyncBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (online) return null

  return (
    <div className="fixed inset-x-0 top-0 z-[100] border-b border-[var(--md-error-container)] bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] shadow-none">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 text-xs sm:text-sm">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--md-error-container)] text-[var(--md-on-error-container)]">
          <CloudOff size={16} />
        </span>
        <div className="min-w-0 flex-1 leading-5">
          <strong className="font-semibold">Offline mode:</strong> cached app assets may still load, but payments, chats, escrow actions, and Safe Swap check-ins require a live connection. A locally saved draft is not a completed or synced action.
        </div>
      </div>
    </div>
  )
}
