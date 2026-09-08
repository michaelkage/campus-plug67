import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, validateEduEmail } from '@/lib/supabase'
import { registerDevice, getDeviceHash, checkDeviceBan } from '@/lib/security'
import { registerPasskey, authenticateWithPasskey, browserSupportsWebAuthn } from '@/lib/passkeys'
import type { Database } from '@/types/database'
import toast from 'react-hot-toast'

type Profile = Database['public']['Tables']['profiles']['Row'] & {
  magistrate_at?: string | null
  juror_streak?: number | null
  free_listing_tokens?: number | null
  referral_code?: string | null
  badges?: unknown[] | null
}
type AuthResult = { data?: unknown; error?: unknown; success?: boolean }

type AuthContextValue = {
  session: Session | null
  profile: Profile | null
  user: User | null
  loading: boolean
  deviceHash: string | null
  isAuthenticated: boolean
  passkeySupported: boolean
  signUp: (args: { email: string; password: string; fullName: string; university?: string; matric?: string }) => Promise<AuthResult>
  signIn: (args: { email: string; password: string }) => Promise<AuthResult>
  signInWithPasskey: (email: string) => Promise<AuthResult>
  addPasskey: (deviceLabel: string) => Promise<AuthResult>
  signOut: () => Promise<void>
  updateProfile: (updates: Partial<Profile>) => Promise<AuthResult | undefined>
  refreshProfile: () => Promise<Profile | null | undefined>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [deviceHash, setDeviceHash] = useState<string | null>(null)

  const fetchProfile = useCallback(async (userId: string) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    if (data) setProfile(data as Profile)
    return (data as Profile | null) ?? null
  }, [])

  useEffect(() => {
    getDeviceHash().then(setDeviceHash).catch(() => {})

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session)
      if (session?.user) {
        await fetchProfile(session.user.id)
        try {
          await registerDevice(session.user.id)
        } catch (error: unknown) {
          if (errorMessage(error, '').startsWith('DEVICE_BANNED')) {
            await supabase.auth.signOut()
            toast.error('🚫 This device has been flagged for policy violations.')
          }
        }
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      setSession(session)
      if (session?.user) {
        await fetchProfile(session.user.id)
        try {
          await registerDevice(session.user.id)
        } catch (error: unknown) {
          if (errorMessage(error, '').startsWith('DEVICE_BANNED')) {
            await supabase.auth.signOut()
            toast.error('🚫 This device has been flagged for policy violations.')
          }
        }
      } else {
        setProfile(null)
      }
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [fetchProfile])

  const signUp = useCallback(async ({ email, password, fullName, university, matric }: { email: string; password: string; fullName: string; university?: string; matric?: string }) => {
    try {
      const validation = validateEduEmail(email)
      if (!validation.valid) return { success: false, error: validation.error }
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) return { success: false, error: error.message }
      if (data.user) {
        const detectedUni = university || validation.university || ''
        await supabase.from('profiles').update({ full_name: fullName, university: detectedUni, matric_number: matric || null }).eq('id', data.user.id)
        const { error: tokenError } = await supabase.rpc('provision_my_emergency_tokens')
        if (tokenError) console.warn('Initial emergency token provisioning unavailable:', tokenError.message)
      }
      return { data, success: true }
    } catch (error: unknown) {
      return { success: false, error: errorMessage(error, 'Sign up failed') }
    }
  }, [])

  const signIn = useCallback(async ({ email, password }: { email: string; password: string }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { success: false, error: error.message }
    return { data, success: true }
  }, [])

  const signInWithPasskey = useCallback(async (email: string) => {
    return authenticateWithPasskey(email)
  }, [])

  const addPasskey = useCallback(async (deviceLabel: string) => {
    if (!session?.user) return { success: false, error: 'Not authenticated' }
    return registerPasskey(session.user.id, deviceLabel)
  }, [session])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
  }, [])

  const updateProfile = useCallback(async (updates: Partial<Profile>) => {
    if (!session?.user) return undefined
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', session.user.id).select().single()
    if (error) return { success: false, error: error.message }
    setProfile(data as Profile)
    return { data, success: true }
  }, [session])

  const refreshProfile = useCallback(async () => {
    if (!session?.user) return null
    return fetchProfile(session.user.id)
  }, [fetchProfile, session])

  const value: AuthContextValue = {
    session,
    profile,
    user: session?.user ?? null,
    loading,
    deviceHash,
    isAuthenticated: !!session,
    passkeySupported: browserSupportsWebAuthn(),
    signUp,
    signIn,
    signInWithPasskey,
    addPasskey,
    signOut,
    updateProfile,
    refreshProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
