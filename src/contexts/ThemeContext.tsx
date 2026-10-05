import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import {
  resolveInitialMode,
  setMode,
  watchSystemMode,
  type ThemeMode,
} from '@/theme/themeEngine'

const ThemeContext = createContext({
  theme: 'dark' as ThemeMode,
  isAmoled: false,
  isLight: false,
  setTheme: (_t: ThemeMode) => {},
  toggle: () => {},
})

/**
 * Resolve the boot mode. `initTheme()` already wrote the palette to :root in
 * main.tsx before first paint, so this only needs to read the resolved value -
 * re-running the HCT solve here would be wasted work.
 */
function currentMode(): ThemeMode {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark' || attr === 'amoled') return attr
  return resolveInitialMode()
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(currentMode)

  // Track the OS appearance in real time.
  useEffect(() => {
    const unsubscribe = watchSystemMode((mode) => setThemeState(mode))
    return unsubscribe
  }, [])

  // Reconcile with the signed-in profile. Runs once on boot.
  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user || cancelled) return
      supabase
        .from('profiles')
        .select('theme_mode')
        .eq('id', session.user.id)
        .single()
        .then(({ data }) => {
          if (cancelled) return
          const stored = data?.theme_mode
          if (stored === 'light' || stored === 'dark' || stored === 'amoled') {
            setThemeState(stored)
            setMode(stored)
          }
        })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t)
    setMode(t)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        supabase.from('profiles').update({ theme_mode: t }).eq('id', session.user.id).then()
      }
    })
  }, [])

  const toggle = useCallback(
    () => setTheme(theme === 'dark' ? 'amoled' : theme === 'amoled' ? 'light' : 'dark'),
    [theme, setTheme],
  )

  return (
    <ThemeContext.Provider
      value={{ theme, isAmoled: theme === 'amoled', isLight: theme === 'light', setTheme, toggle }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)