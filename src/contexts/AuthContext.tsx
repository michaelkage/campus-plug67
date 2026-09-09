import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '@/lib/supabase/client'
import { checkDeviceBan, registerDevice } from '@/lib/security'
import { registerPasskey } from '@/lib/passkeys'
import { toast } from 'sonner'
import type { Database } from '@/types/database'

type Profile = Database['public']['Tables']['profiles']['Row']

type EditableProfileFields = {
  full_name?: string | null
  department?: string | null
  level?: string | null
  bio?: string | null
}

// NOTE: this file intentionally preserves the existing auth flow. The profile
// type in database.ts is currently behind the live profiles schema for the
// editable department/level columns, so the narrow boundary below keeps those
// fields explicit without weakening the server-side mutation guard.

interface AuthContextValue {
  user: any
  session: any
  profile: Profile | null
  loading: boolean
  signIn: (...args: any[]) => Promise<any>
  signUp: (...args: any[]) => Promise<any>
  signOut: () => Promise<any>
  updateProfile: (updates: EditableProfileFields) => Promise<any>
  signInWithPasskey: (...args: any[]) => Promise<any>
  registerUserPasskey: (...args: any[]) => Promise<any>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any>(null)
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const hydrateSession = async (nextSession: any) => {
    if (!nextSession?.user) {
      setUser(null)
      setSession(null)
      setProfile(null)
      setLoading(false)
      return
    }

    setUser(nextSession.user)
    setSession(nextSession)
    try {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', nextSession.user.id).single()
      if (error) throw error
      setProfile(data as Profile)
      try {
        await registerDevice()
      } catch (error) {
        if (String(errorMessage(error, '')).includes('DEVICE_BANNED')) {
          await supabase.auth.signOut()
          setUser(null)
          setSession(null)
          setProfile(null)
          toast.error('This device is restricted.')
          return
        }
      }
    } catch (error) {
      console.error('Failed to hydrate profile', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) void hydrateSession(data.session)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return
      // Defer profile hydration so Supabase auth callbacks do not deadlock on
      // another auth call while the internal auth lock is held.
      setTimeout(() => {
        if (mounted) void hydrateSession(nextSession)
      }, 0)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    try {
      await checkDeviceBan()
    } catch (error) {
      toast.error('Security check unavailable. Please try again.')
      return { error }
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) toast.error(error.message)
    return { data, error }
  }

  const signUp = async (...args: any[]) => {
    try {
      await checkDeviceBan()
    } catch (error) {
      toast.error('Security check unavailable. Please try again.')
      return { error }
    }
    return supabase.auth.signUp(...args)
  }

  const signInWithPasskey = async (...args: any[]) => {
    try {
      await checkDeviceBan()
    } catch (error) {
      toast.error('Security check unavailable. Please try again.')
      return { error }
    }
    return args.length ? (await import('@/lib/passkeys')).authenticateWithPasskey(...args) : null
  }

  const registerUserPasskey = async (deviceLabel: string) => {
    if (!session?.user) return { error: 'Not signed in' }
    try {
      await registerPasskey(session.user, deviceLabel)
      toast.success('🔐 Passkey registered! Use biometrics to sign in next time.')
      return { success: true }
    } catch (error: unknown) {
      toast.error(errorMessage(error, 'Passkey registration failed'))
      return { error: errorMessage(error, 'Passkey registration failed') }
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }

  const updateProfile = async (updates: EditableProfileFields) => {
    if (!session?.user) return

    const safeUpdates: EditableProfileFields = {}
    if (updates.full_name !== undefined) safeUpdates.full_name = String(updates.full_name ?? '').trim().slice(0, 120)
    if (updates.department !== undefined) safeUpdates.department = String(updates.department ?? '').trim().slice(0, 120)
    if (updates.level !== undefined) safeUpdates.level = updates.level
    if (updates.bio !== undefined) safeUpdates.bio = String(updates.bio ?? '').trim().slice(0, 1000)

    if (Object.keys(safeUpdates).length === 0) {
      return { error: 'No editable profile fields supplied' }
    }

    // department/level exist in the live profiles schema but are absent from
    // the hand-maintained generated Database type. Keep the cast local to this
    // already-narrow, explicitly editable payload.
    const { data, error } = await supabase.from('profiles')
      .update(safeUpdates as never)
      .eq('id', session.user.id).select().single()
    if (error) { toast.error('Failed to update profile'); return { error } }
    setProfile(data as Profile)
    toast.success('Profile updated!')
    return { data }
  }

  return (
    <AuthContext.Provider value={{ user, session, profile, loading, signIn, signUp, signOut, updateProfile, signInWithPasskey, registerUserPasskey }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
