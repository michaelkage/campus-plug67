/**
 * Campus Plug — AuthContext
 *
 * FIX #5: checkDeviceBan() was querying `banned_devices` with `.eq('device_hash', ...)`
 *         but the schema column is `device_fingerprint`.  Fixed to use the correct column.
 */
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase, validateEduEmail } from '@/lib/supabase'
import { registerDevice, getDeviceHash } from '@/lib/security'
import { registerPasskey, authenticateWithPasskey, browserSupportsWebAuthn } from '@/lib/passkeys'
import toast from 'react-hot-toast'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session,    setSession]    = useState(null)
  const [profile,    setProfile]    = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [deviceHash, setDeviceHash] = useState(null)

  const fetchProfile = useCallback(async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (data) setProfile(data)
    return data
  }, [])

  useEffect(() => {
    getDeviceHash().then(setDeviceHash).catch(() => {})

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session?.user) {
        fetchProfile(session.user.id)
        registerDevice(session.user.id).catch(e => {
          if (e.message?.startsWith('DEVICE_BANNED')) {
            supabase.auth.signOut()
            toast.error('🚫 This device has been flagged for policy violations.')
          }
        })
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_e, session) => {
        setSession(session)
        if (session?.user) {
          await fetchProfile(session.user.id)
          registerDevice(session.user.id).catch(() => {})
        } else {
          setProfile(null)
        }
      }
    )
    return () => subscription.unsubscribe()
  }, [fetchProfile])

  // FIX #5: use `device_fingerprint` not `device_hash` on banned_devices
  const checkDeviceBan = async () => {
    const hash = await getDeviceHash().catch(() => null)
    if (!hash) return false
    const { data } = await supabase
      .from('banned_devices')
      .select('ban_reason')
      .eq('device_fingerprint', hash)
      .maybeSingle()
    return !!data
  }

  const signUp = async ({ email, password, fullName, university, matric }) => {
    const { valid, university: detectedUni } = await validateEduEmail(email)
    if (!valid) {
      toast.error('Please use your university email address (.edu.ng or .edu)')
      return { error: 'Invalid email domain' }
    }

    if (await checkDeviceBan()) {
      toast.error('🚫 This device is restricted from creating new accounts.')
      return { error: 'DEVICE_BANNED' }
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data:             { full_name: fullName, university: university || detectedUni },
        emailRedirectTo:  `${import.meta.env.VITE_APP_URL}/auth/callback`,
      },
    })

    if (error) { toast.error(error.message); return { error } }

    if (data.user) {
      await supabase.from('profiles').update({
        full_name:     fullName,
        university:    university || detectedUni,
        matric_number: matric || null,
      }).eq('id', data.user.id)
      await supabase.rpc('provision_emergency_tokens', { p_user_id: data.user.id })
    }

    toast.success('Account created! Check your email to verify.')
    return { data }
  }

  const signIn = async ({ email, password }) => {
    if (await checkDeviceBan()) {
      toast.error('🚫 This device is restricted from signing in.')
      return { error: 'DEVICE_BANNED' }
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { toast.error(error.message); return { error } }
    return { data }
  }

  const signInWithPasskey = async (email) => {
    if (!browserSupportsWebAuthn()) {
      toast.error('Passkeys not supported on this device')
      return { error: 'NOT_SUPPORTED' }
    }
    try {
      const result = await authenticateWithPasskey(email)
      toast.success('Signed in with biometrics! 🔐')
      return { data: result }
    } catch (e) {
      toast.error(e.message)
      return { error: e.message }
    }
  }

  const addPasskey = async (deviceLabel) => {
    if (!session?.user) return { error: 'Not authenticated' }
    try {
      await registerPasskey(session.user, deviceLabel)
      toast.success('🔐 Passkey registered! Use biometrics to sign in next time.')
      return { success: true }
    } catch (e) {
      toast.error(e.message)
      return { error: e.message }
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }

  const updateProfile = async (updates) => {
    if (!session?.user) return
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', session.user.id)
      .select()
      .single()
    if (error) { toast.error('Failed to update profile'); return { error } }
    setProfile(data)
    toast.success('Profile updated!')
    return { data }
  }

  const refreshProfile = () => session?.user && fetchProfile(session.user.id)

  return (
    <AuthContext.Provider value={{
      session, profile, user: session?.user ?? null,
      loading, deviceHash,
      isAuthenticated:  !!session,
      passkeySupported: browserSupportsWebAuthn(),
      signUp, signIn, signInWithPasskey, addPasskey,
      signOut, updateProfile, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
