/**
 * Campus Plug — Chat Anti-Leakage Scanner
 *
 * Scans outgoing messages in real-time for patterns that indicate
 * a user is trying to move the transaction off-platform (leakage).
 *
 * Architecture:
 *   - Fast Regex Layer: Runs synchronously for zero-latency client-side feedback
 *   - Semantic AI Layer: Validates obfuscated payment requests via Edge Function
 *   - Logging: Fire-and-forget server-side logging using message hashes
 */

import { supabase } from './supabase'
import { analyzeChatContent } from './ai'

// ── Pattern definitions (Fast Regex Layer) ────────────────────────────────────

const PATTERNS = [
  // Phone numbers
  {
    id:       'phone_number',
    label:    'Phone Number',
    severity: 'warning',
    regex:    /(?:(?:\+?234|0)(?:7|8|9)(?:0|1)\d{8})/g,
    message:  'Sharing phone numbers in chat can lead to off-platform fraud. Use Campus Plug messaging.',
  },
  // WhatsApp / Telegram redirects
  {
    id:       'whatsapp',
    label:    'WhatsApp/Telegram Redirect',
    severity: 'warning',
    regex:    /(?:whatsapp|telegram|wa\.me|t\.me|wa\s+me)/gi,
    message:  'Avoid moving deals to WhatsApp — you lose buyer/seller protection.',
  },
  // Instagram / Snapchat
  {
    id:       'instagram',
    label:    'Social Media Redirect',
    severity: 'warning',
    regex:    /(?:instagram|insta|snap(?:chat)?|dm\s+me|follow\s+me)/gi,
    message:  'Keep deal communications on Campus Plug for your protection.',
  },
  // External payment apps
  {
    id:       'external_payment',
    label:    'External Payment Request',
    severity: 'critical',
    regex:    /(?:opay|palmpay|kuda|moniepoint|transfer\s+to|send\s+me|pay\s+me|bank\s+transfer|acct\s+no|account\s+number)/gi,
    message:  '🚨 Payment requests outside PlugPay void your protection. All payments must go through escrow.',
  },
  // Email addresses
  {
    id:       'email',
    label:    'Email Address',
    severity: 'warning',
    regex:    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    message:  'Avoid sharing personal contact info in chat.',
  },
  // Matric number / ID sharing
  {
    id:       'matric_sharing',
    label:    'Personal ID Sharing',
    severity: 'warning',
    regex:    /(?:matric|student\s+id|my\s+id|send\s+your)/gi,
    message:  'Never share personal student ID details in chat.',
  },
]

// ── SHA-256 hash (for server-side logging — no plaintext stored) ──────────────
async function sha256(text: string) {
  const encoded = new TextEncoder().encode(text)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Core scanner ──────────────────────────────────────────────────────────────

/**
 * Scan a message for leakage patterns.
 * Runs synchronous regex, followed by semantic AI check.
 */
export async function scanMessage(message: string, senderId?: string, listingId?: string, accessToken?: string) {
  const flags: any[] = []

  // 1. FAST REGEX SCAN (Zero-latency)
  for (const pattern of PATTERNS) {
    const matches = message.match(pattern.regex)
    if (matches) {
      flags.push({
        id:       pattern.id,
        label:    pattern.label,
        severity: pattern.severity,
        message:  pattern.message,
        match:    matches[0],
      })
    }
  }

  let hasCritical = flags.some(f => f.severity === 'critical')
  let primary     = flags.find(f => f.severity === 'critical') ?? flags[0]

  // 2. HYBRID AI SCAN (Semantic evaluation for obfuscated text)
  // We only run this if we have the accessToken (meaning we are authenticated and doing an actual send)
  // We don't want to burn tokens on every keystroke, so AI is only on final submission.
  if (accessToken && !hasCritical) {
    const aiResult = await analyzeChatContent(message);
    if (aiResult.flags.length > 0) {
       flags.push(...aiResult.flags);
       hasCritical = flags.some(f => f.severity === 'critical');
       primary = flags.find(f => f.severity === 'critical') ?? flags[0];
    }
  }

  if (flags.length === 0) {
    return { clean: true, blocked: false, flags: [], message: null }
  }

  // 3. LOGGING
  if (senderId && accessToken) {
    sha256(message).then(hash => {
      supabase.from('chat_flag_log').insert({
        sender_id:    senderId,
        listing_id:   listingId ?? null,
        message_hash: hash,
        flag_type:    primary?.id || 'ai_flag',
        severity:     primary?.severity || 'warning',
        action_taken: hasCritical ? 'blocked' : 'warned',
      }).then() // truly fire-and-forget
    })
  }

  return {
    clean:   false,
    blocked: hasCritical,
    flags,
    message: primary?.message,
  }
}

/**
 * Real-time hook: scan as user types.
 * Returns the scan result for the current input value.
 * Call this on every keystroke — pure CPU, no network.
 */
export function scanLive(text: string) {
  const flags: any[] = []

  for (const pattern of PATTERNS) {
    const matches = text.match(pattern.regex)
    if (matches) {
      flags.push({
        id:       pattern.id,
        label:    pattern.label,
        severity: pattern.severity,
        message:  pattern.message,
        match:    matches[0],
      })
    }
  }

  const hasCritical = flags.some(f => f.severity === 'critical')
  const primary     = flags.find(f => f.severity === 'critical') ?? flags[0]

  return {
    clean:   flags.length === 0,
    blocked: hasCritical,
    flags,
    message: primary?.message ?? null,
  }
}
