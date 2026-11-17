/**
 * Campus Plug — FeatureFlagContext
 *
 * FIX #10: global_config schema has `value: string`, NOT `is_enabled: boolean`.
 * The old code queried `.select('key, is_enabled')` which always returned undefined,
 * making every feature flag evaluate as disabled.
 *
 * Fix: query `key, value` and treat the string value "true" / "1" / "yes" as enabled.
 * Realtime handler also corrected to read `payload.new.value` instead of `is_enabled`.
 *
 * Server is truth. Client ONLY reads; it can never unlock features.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

const FeatureFlagContext = createContext({ flags: {}, loaded: false })

/** Returns true for the string values "true", "1", "yes", "on" (case-insensitive). */
function parseFlagValue(value) {
  if (value === null || value === undefined) return false
  const v = String(value).trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

export function FeatureFlagProvider({ children }) {
  const [flags,  setFlags]  = useState({})
  const [loaded, setLoaded] = useState(false)

  const loadFlags = async () => {
    // FIX #10: select `value`, not `is_enabled`
    const { data } = await supabase
      .from('global_config')
      .select('key, value')

    if (data) {
      const map = {}
      for (const row of data) {
        map[row.key] = parseFlagValue(row.value)
      }
      setFlags(map)
    }
    setLoaded(true)
  }

  useEffect(() => {
    loadFlags()

    // Real-time: when an admin changes global_config, all clients update instantly
    const ch = supabase
      .channel('feature-flags')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'global_config' },
        (payload) => {
          const row = payload.new
          if (row?.key !== undefined) {
            // FIX #10: read `value`, not `is_enabled`
            setFlags(prev => ({
              ...prev,
              [row.key]: parseFlagValue(row.value),
            }))
          }
        }
      )
      .subscribe()

    return () => supabase.removeChannel(ch)
  }, [])

  return (
    <FeatureFlagContext.Provider value={{ flags, loaded }}>
      {children}
    </FeatureFlagContext.Provider>
  )
}

export function useFeature(key) {
  const { flags, loaded } = useContext(FeatureFlagContext)
  return { enabled: !!flags[key], loaded }
}

export const useFlags = () => useContext(FeatureFlagContext)
