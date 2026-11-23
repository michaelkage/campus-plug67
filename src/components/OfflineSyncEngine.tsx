import { useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { syncOfflineQueue } from '@/lib/offlineSync'

/**
 * Lifecycle coordinator for the durable IndexedDB outbox.
 * Sync is event-driven: initial auth hydration, browser reconnect, and tab
 * visibility. A bounded retry timer handles transient failures while online.
 */
export default function OfflineSyncEngine() {
  const { user } = useAuth()

  useEffect(() => {
    if (!user?.id) return
    let disposed = false
    let retryTimer: number | undefined
    const run = async () => {
      if (disposed || !navigator.onLine) return
      try {
        await syncOfflineQueue(user.id)
      } catch (error) {
        // Keep the durable row queued. The next online/visibility event retries.
        console.warn('[CampusPlug offline sync] Queue pass failed', error instanceof Error ? error.message : 'Unknown error')
      }
    }
    const onOnline = () => { void run() }
    const onVisible = () => { if (document.visibilityState === 'visible') void run() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    void run()
    retryTimer = window.setInterval(() => { void run() }, 15_000)
    return () => {
      disposed = true
      if (retryTimer !== undefined) window.clearInterval(retryTimer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user?.id])

  return null
}
