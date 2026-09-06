import { useEffect, useState } from 'react'
import { WifiOff, Wifi } from 'lucide-react'

export default function NetworkStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)

    let cancelled = false
    const measure = async () => {
      if (!navigator.onLine) return
      const started = performance.now()
      try {
        await fetch('/favicon.ico', { cache: 'no-store', method: 'HEAD' })
        if (!cancelled) setSlow(performance.now() - started > 1500)
      } catch {
        if (!cancelled) setSlow(true)
      }
    }
    const timer = window.setInterval(measure, 30_000)
    measure()
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (online && !slow) return null

  return (
    <div role="status" aria-live="polite" className={`fixed left-1/2 top-3 z-[100] -translate-x-1/2 rounded-full border px-4 py-2 shadow-xl backdrop-blur-xl ${online ? 'border-plug-amber/25 bg-plug-amber/10 text-plug-amber' : 'border-plug-red/25 bg-plug-red/10 text-plug-red'}`}>
      <div className="flex items-center gap-2 text-xs font-bold">
        {online ? <Wifi size={14} /> : <WifiOff size={14} />}
        <span>{online ? 'Poor network — reconnecting gently' : 'Offline — changes will resume when connected'}</span>
      </div>
    </div>
  )
}
