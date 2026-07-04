import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

const ThemeContext = createContext({ theme: 'dark', isAmoled: false, setTheme: () => {}, toggle: () => {} })

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem('cp_theme', theme) } catch {}
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try { return localStorage.getItem('cp_theme') === 'amoled' ? 'amoled' : 'dark' } catch { return 'dark' }
  })

  // Sync from profile on login
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) return
      supabase.from('profiles').select('theme_mode').eq('id', session.user.id).single()
        .then(({ data }) => {
          if (data?.theme_mode && data.theme_mode !== theme) {
            setThemeState(data.theme_mode)
            applyTheme(data.theme_mode)
          }
        })
    })
  }, [])

  const setTheme = useCallback((t) => {
    setThemeState(t)
    applyTheme(t)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) supabase.from('profiles').update({ theme_mode: t }).eq('id', session.user.id).then()
    })
  }, [])

  const toggle = useCallback(() => setTheme(theme === 'dark' ? 'amoled' : 'dark'), [theme, setTheme])

  return (
    <ThemeContext.Provider value={{ theme, isAmoled: theme === 'amoled', setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
