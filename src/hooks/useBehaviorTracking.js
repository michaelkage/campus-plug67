import { useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

/**
 * useBehaviorTracking — logs meaningful interaction events to behavior_events table.
 * Used for: drop-off detection, feature usage analytics, PWA trigger (3rd interaction).
 */
export function useBehaviorTracking() {
  const { user } = useAuth()

  const track = useCallback(async (eventType, entityId = null, metadata = {}) => {
    if (!user?.id) return
    try {
      await supabase.from('behavior_events').insert({
        user_id:    user.id,
        event_type: eventType,
        entity_id:  entityId,
        metadata,
      })
      // PWA onboarding trigger: count meaningful interactions
      const key = 'cp_interactions'
      const count = parseInt(localStorage.getItem(key) || '0') + 1
      localStorage.setItem(key, String(count))
    } catch {}
  }, [user?.id])

  return { track }
}
