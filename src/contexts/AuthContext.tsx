import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, validateEduEmail } from '@/lib/supabase'
import { registerDevice, getDeviceHash } from '@/lib/security'
import { registerPasskey, authenticateWithPasskey, browserSupportsWebAuthn } from '@/lib/passkeys'
import toast from 'react-hot-toast'

type Profile = Record<string, any>

type AuthResult = { data?: any; error?: any }

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
  updateProfile: (updates: Record<string, any>) => Promise<AuthResult | undefined>
  refreshProfile: () => Promise<Profile | null | undefined>
}

const AuthContext = createContext<AuthContextValue | null>(null)

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
        } catch (e: any) {
          if (e?.message?.startsWith('DEVICE_BANNED')) {
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
        } catch (e: any) {
          if (e?.message?.startsWith('DEVICE_BANNED')) {
            await supabase.auth.signOut()
            toast.error('🚫 This device has been flagged for policy violations.')
          }
        }
      } else {
        setProfile(null)
      }
    })
    return () => subscription.unsubscribe()
  }, [fetchProfile])

  const checkDeviceBan = async () => {
    const { getDeviceHash } = await import('@/lib/security')
    const clientFingerprint = await getDeviceHash().catch(() => null)
    const { data, error } = await supabase.functions.invoke('security-gate', {
      body: { action: 'check', client_fingerprint: clientFingerprint },
    })
    if (error) throw new Error(error.message || 'Security service unavailable')
    if (data?.error?.startsWith?.('DEVICE_BANNED')) return true
    if (!data?.success) throw new Error('Security service unavailable')
    return false
  }

  const signUp = async ({ email, password, fullName, university, matric }: { email: string; password: string; fullName: string; university?: string; matric?: string }) => {
    const { valid, university: detectedUni } = await validateEduEmail(email)
    if (!valid) {
      toast.error('Please use an approved university email from the allowlist')
      return { error: 'Invalid email domain' }
    }

    try {
      if (await checkDeviceBan()) {
        toast.error('🚫 This device is restricted from creating new accounts.')
        return { error: 'DEVICE_BANNED' }
      }
    } catch (e: any) {
      toast.error('Security check unavailable. Please try again.')
      return { error: e }
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, university: university || detectedUni },
        emailRedirectTo: `${import.meta.env.VITE_APP_URL}/auth/callback`,
      },
    })

    if (error) { toast.error(error.message); return { error } }

    if (data.user) {
      await supabase.from('profiles').update({
        full_name: fullName,
        university: university || detectedUni,
        matric_number: matric || null,
      }).eq('id', data.user.id)
      const { error: tokenError } = await supabase.rpc('provision_my_emergency_tokens')
      if (tokenError) console.warn('Initial emergency token provisioning unavailable:', tokenError.message)
    }

    toast.success('Account created! Check your email to verify.')
    return { data }
  }

  const signIn = async ({ email, password }: { email: string; password: string }) => {
    try {
      if (await checkDeviceBan()) {
        toast.error('🚫 This device is restricted from signing in.')
        return { error: 'DEVICE_BANNED' }
      }
    } catch (e: any) {
      toast.error('Security check unavailable. Please try again.')
      return { error: e }
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { toast.error(error.message); return { error } }
    return { data }
  }

  const signInWithPasskey = async (email: string) => {
    if (!browserSupportsWebAuthn()) {
      toast.error('Passkeys not supported on this device')
      return { error: 'NOT_SUPPORTED' }
    }
    try {
      const result = await authenticateWithPasskey(email)
      toast.success('Signed in with biometrics! 🔐')
      return { data: result }
    } catch (e: any) {
      toast.error(e?.message || 'Passkey authentication failed')
      return { error: e?.message || 'Passkey authentication failed' }
    }
  }

  const addPasskey = async (deviceLabel: string) => {
    if (!session?.user) return { error: 'Not authenticated' }
    try {
      await registerPasskey(session.user, deviceLabel)
      toast.success('🔐 Passkey registered! Use biometrics to sign in next time.')
      return { success: true }
    } catch (e: any) {
      toast.error(e?.message || 'Passkey registration failed')
      return { error: e?.message || 'Passkey registration failed' }
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }

  const updateProfile = async (updates: Record<string, any>) => {
    if (!session?.user) return
    const { data, error } = await supabase.from('profiles')
      .update(updates).eq('id', session.user.id).select().single()
    if (error) { toast.error('Failed to update profile'); return { error } }
    setProfile(data as Profile)
    toast.success('Profile updated!')
    return { data }
  }

  const refreshProfile = () => session?.user ? fetchProfile(session.user.id) : Promise.resolve(undefined)

  return (
    <AuthContext.Provider value={{
      session, profile, user: session?.user ?? null, loading, deviceHash,
      isAuthenticated: !!session, passkeySupported: browserSupportsWebAuthn(),
      signUp, signIn, signInWithPasskey, addPasskey, signOut, updateProfile, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
