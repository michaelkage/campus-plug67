/**
 * Campus Plug — Passkey (WebAuthn) Utilities
 *
 * Uses @simplewebauthn/browser. Private keys remain in the platform authenticator;
 * the server receives only WebAuthn ceremony data and verifies the signature.
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from '@simplewebauthn/browser'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'

export { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill }

type RegistrationOptionsResponse = {
  options: Parameters<typeof startRegistration>[0]
}

type AuthenticationOptionsResponse = {
  options: Parameters<typeof startAuthentication>[0]
}

type VerifyResponse = {
  verified?: boolean
  access_token?: string
  refresh_token?: string
  [key: string]: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function registerPasskey(user: User, deviceLabel: string): Promise<VerifyResponse> {
  if (!browserSupportsWebAuthn()) throw new Error('This device does not support passkeys')

  const { data: optionsRes, error } = await supabase.functions.invoke<RegistrationOptionsResponse>('passkey-auth', {
    body: { action: 'generate_registration_options', userId: user.id, userEmail: user.email },
  })
  if (error) throw new Error(error.message)
  if (!optionsRes?.options) throw new Error('Passkey registration options unavailable')

  let regResponse: Awaited<ReturnType<typeof startRegistration>>
  try {
    regResponse = await startRegistration(optionsRes.options)
  } catch (error: unknown) {
    if (errorMessage(error) === 'NotAllowedError' || (error instanceof DOMException && error.name === 'NotAllowedError')) {
      throw new Error('Biometric prompt was dismissed')
    }
    throw error
  }

  const { data: verifyRes, error: verifyErr } = await supabase.functions.invoke<VerifyResponse>('passkey-auth', {
    body: {
      action: 'verify_registration',
      userId: user.id,
      response: regResponse,
      deviceLabel: deviceLabel || 'My Device',
    },
  })
  if (verifyErr) throw new Error(verifyErr.message)
  if (!verifyRes?.verified) throw new Error('Passkey verification failed')
  return verifyRes
}

export async function authenticateWithPasskey(email: string) {
  if (!browserSupportsWebAuthn()) throw new Error('This device does not support passkeys')

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()
  if (profileError) throw profileError
  if (!profile) throw new Error('No account found for this email')

  const { data: optionsRes, error } = await supabase.functions.invoke<AuthenticationOptionsResponse>('passkey-auth', {
    body: { action: 'generate_authentication_options', userId: profile.id },
  })
  if (error) throw new Error(error.message)
  if (!optionsRes?.options) throw new Error('No passkeys registered for this account')

  let authResponse: Awaited<ReturnType<typeof startAuthentication>>
  try {
    authResponse = await startAuthentication(optionsRes.options)
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Biometric prompt was dismissed')
    }
    throw error
  }

  const { data: verifyRes, error: verifyErr } = await supabase.functions.invoke<VerifyResponse>('passkey-auth', {
    body: { action: 'verify_authentication', userId: profile.id, response: authResponse },
  })
  if (verifyErr) throw new Error(verifyErr.message)
  if (!verifyRes?.verified) throw new Error('Authentication failed — signature invalid')

  if (verifyRes.access_token && verifyRes.refresh_token) {
    const { data, error: sessionError } = await supabase.auth.setSession({
      access_token: verifyRes.access_token,
      refresh_token: verifyRes.refresh_token,
    })
    if (sessionError) throw sessionError
    return data
  }

  throw new Error('Server did not return a session token')
}

export async function listPasskeys(userId: string) {
  const { data, error } = await supabase
    .from('passkey_credentials')
    .select('id, credential_id, device_label, created_at, last_used_at, backed_up, transports')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function removePasskey(credentialId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('passkey_credentials')
    .delete()
    .eq('credential_id', credentialId)
    .eq('user_id', userId)
  if (error) throw error
}
