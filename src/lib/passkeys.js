/**
 * Campus Plug — Passkey (WebAuthn) Utilities
 *
 * Uses the @simplewebauthn/browser library which wraps the Web Authentication API.
 * The private key NEVER leaves the Secure Enclave / TPM.
 * The server (Supabase) only ever receives a cryptographic signature.
 *
 * Flow:
 *   REGISTER:  generateRegistrationOptions (server) → startRegistration (browser) → verifyRegistrationResponse (server)
 *   LOGIN:     generateAuthenticationOptions (server) → startAuthentication (browser) → verifyAuthenticationResponse (server)
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from '@simplewebauthn/browser'
import { supabase } from './supabase'

export { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill }

// ── REGISTRATION ──────────────────────────────────────────────────────────────

/**
 * Register a new passkey for the current user.
 * Calls the passkey-auth Edge Function to get a challenge, then triggers biometric prompt.
 */
export async function registerPasskey(user, deviceLabel) {
  if (!browserSupportsWebAuthn()) {
    throw new Error('This device does not support passkeys')
  }

  // 1. Get registration options from server (includes challenge)
  const { data: optionsRes, error } = await supabase.functions.invoke('passkey-auth', {
    body: { action: 'generate_registration_options', userId: user.id, userEmail: user.email },
  })
  if (error) throw new Error(error.message)

  // 2. Trigger biometric / platform authenticator
  let regResponse
  try {
    regResponse = await startRegistration(optionsRes.options)
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Biometric prompt was dismissed')
    throw err
  }

  // 3. Verify with server and store credential
  const { data: verifyRes, error: verifyErr } = await supabase.functions.invoke('passkey-auth', {
    body: {
      action:       'verify_registration',
      userId:       user.id,
      response:     regResponse,
      deviceLabel:  deviceLabel || 'My Device',
    },
  })
  if (verifyErr) throw new Error(verifyErr.message)
  if (!verifyRes?.verified) throw new Error('Passkey verification failed')

  return verifyRes
}

/**
 * Authenticate with an existing passkey.
 * Returns the Supabase session on success.
 */
export async function authenticateWithPasskey(email) {
  if (!browserSupportsWebAuthn()) {
    throw new Error('This device does not support passkeys')
  }

  // 1. Look up user's credentials
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (!profile) throw new Error('No account found for this email')

  // 2. Get authentication options
  const { data: optionsRes, error } = await supabase.functions.invoke('passkey-auth', {
    body: { action: 'generate_authentication_options', userId: profile.id },
  })
  if (error) throw new Error(error.message)
  if (!optionsRes?.options) throw new Error('No passkeys registered for this account')

  // 3. Trigger biometric prompt
  let authResponse
  try {
    authResponse = await startAuthentication(optionsRes.options)
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Biometric prompt was dismissed')
    throw err
  }

  // 4. Verify signature on server
  const { data: verifyRes, error: verifyErr } = await supabase.functions.invoke('passkey-auth', {
    body: {
      action:   'verify_authentication',
      userId:   profile.id,
      response: authResponse,
    },
  })
  if (verifyErr) throw new Error(verifyErr.message)
  if (!verifyRes?.verified) throw new Error('Authentication failed — signature invalid')

  // 5. If server verified, sign in via magic link or custom token
  // In production: Edge Function returns a Supabase service-role-generated session token
  if (verifyRes.access_token) {
    const { data, error: sessionError } = await supabase.auth.setSession({
      access_token:  verifyRes.access_token,
      refresh_token: verifyRes.refresh_token,
    })
    if (sessionError) throw sessionError
    return data
  }

  throw new Error('Server did not return a session token')
}

/**
 * List all registered passkeys for the current user.
 */
export async function listPasskeys(userId) {
  const { data, error } = await supabase
    .from('passkey_credentials')
    .select('id, credential_id, device_label, created_at, last_used_at, backed_up, transports')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Remove a passkey credential.
 */
export async function removePasskey(credentialId, userId) {
  const { error } = await supabase
    .from('passkey_credentials')
    .delete()
    .eq('credential_id', credentialId)
    .eq('user_id', userId)    // RLS guard

  if (error) throw error
}
