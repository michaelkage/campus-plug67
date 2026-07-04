import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'

// ── Environment guards ────────────────────────────────────────────────────────
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON) {
  throw new Error(
    '[CampusPlug] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
    'Copy .env.example → .env and fill in your Supabase project credentials.'
  )
}

// ── Singleton client ──────────────────────────────────────────────────────────
export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storageKey:         'cp_auth',
    flowType:           'pkce',
  },
  realtime: {
    params: { eventsPerSecond: 12 },
  },
  global: {
    headers: { 'x-app-version': '3.0.0' },
  },
})

// ── Currency helpers ──────────────────────────────────────────────────────────

/** Convert kobo → formatted Naira string.  e.g. 450000 → "₦4,500" */
export function formatNaira(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return '₦0'
  return `₦${(kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

/** Convert Naira → kobo integer for DB storage.  e.g. 4500 → 450000 */
export function toKobo(naira: number | string): number {
  const n = parseFloat(String(naira).replace(/,/g, ''))
  if (isNaN(n)) return 0
  return Math.round(n * 100)
}

/** Format a relative timestamp.  e.g. "3m ago", "2h ago", "1d ago" */
export function timeAgo(timestamp: string | Date | null | undefined): string {
  if (!timestamp) return ''
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7)  return `${days}d ago`
  return new Date(timestamp).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })
}

// ── Email domain validation ───────────────────────────────────────────────────

/**
 * Validate a university email against the allowed_domains table.
 * Falls back to accepting any .edu.ng or .edu address.
 *
 * FIX #4: query `institution_name` (canonical DB column), not `university`.
 * We return `institution_name` aliased to the `university` field so callers
 * don't need to change.
 */
export async function validateEduEmail(
  email: string
): Promise<{ valid: boolean; university: string | null }> {
  const domain = email?.split('@')[1]?.toLowerCase()
  if (!domain) return { valid: false, university: null }

  // FIX #4: column is `institution_name`, not `university`
  const { data } = await supabase
    .from('allowed_domains')
    .select('institution_name')
    .eq('domain', domain)
    .eq('active', true)
    .maybeSingle()

  if (data) return { valid: true, university: (data as any).institution_name }

  if (domain.endsWith('.edu.ng') || domain.endsWith('.edu')) {
    return { valid: true, university: null }
  }

  return { valid: false, university: null }
}

// ── Storage upload ────────────────────────────────────────────────────────────

/**
 * Upload a file (EXIF-stripped) to Supabase Storage.
 * Returns the public CDN URL.
 */
export async function uploadImage(
  file: File,
  bucket = 'listings',
  folder = 'public'
): Promise<string> {
  const ext  = file.name?.split('.').pop() || 'jpg'
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const path = `${folder}/${name}`

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert:       false,
    contentType:  file.type || 'image/jpeg',
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

/** Delete an image from Supabase Storage given its public URL. */
export async function deleteImage(publicUrl: string, bucket = 'listings'): Promise<void> {
  try {
    const url   = new URL(publicUrl)
    const parts = url.pathname.split(`/storage/v1/object/public/${bucket}/`)
    if (parts.length < 2) return
    await supabase.storage.from(bucket).remove([parts[1]])
  } catch {
    // Non-fatal — best-effort cleanup
  }
}

// ── Smart Price Suggestion ────────────────────────────────────────────────────

/** IQR-cleaned price suggestion for a category + university. */
export async function getSmartPrice(category: string, university: string): Promise<any> {
  if (!category || !university) return null
  const { data, error } = await supabase.rpc('get_price_suggestion', {
    p_category:   category,
    p_university: university,
  } as any)
  if (error || !data) return null
  return data
}

/** Price floor (60 % of IQR-cleaned median) for a category + university. */
export async function getPriceFloor(category: string, university: string): Promise<any> {
  if (!category || !university) return null
  const { data, error } = await supabase.rpc('get_price_floor', {
    p_category:   category,
    p_university: university,
  } as any)
  if (error || !data) return null
  return data
}

// ── Paystack helpers ──────────────────────────────────────────────────────────

interface PaystackOpts {
  email:      string
  amount:     number
  ref:        string
  publicKey:  string
  metadata?:  any
  currency?:  string
}

/** Dynamically load Paystack inline script and open the payment popup. */
export function openPaystack(opts: PaystackOpts): Promise<any> {
  const { email, amount, ref, publicKey, metadata = {}, currency = 'NGN' } = opts

  return new Promise((resolve, reject) => {
    const init = () => {
      const handler = (window as any).PaystackPop.setup({
        key:      publicKey,
        email,
        amount,
        ref,
        currency,
        metadata,
        callback: resolve,
        onClose:  () => reject(new Error('Payment cancelled')),
      })
      handler.openIframe()
    }

    if ((window as any).PaystackPop) { init(); return }

    const script    = document.createElement('script')
    script.src      = 'https://js.paystack.co/v1/inline.js'
    script.onload   = init
    script.onerror  = () => reject(new Error('Failed to load Paystack. Check your connection.'))
    document.head.appendChild(script)
  })
}

/** Generate a Paystack transaction reference.  Format: CP-{ts}-{rnd} */
export function generatePaystackRef(prefix = 'CP'): string {
  const ts  = Date.now().toString(36).toUpperCase()
  const rnd = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `${prefix}-${ts}-${rnd}`
}

// ── Edge Function caller ──────────────────────────────────────────────────────

export type AllowedEdgeFunctionName = 'release-escrow' | 'ai-chat-scan' | 'beacon-matcher'

/** Call a Supabase Edge Function, falling back to raw fetch on invoke error. */
export async function callEdgeFunction(
  functionName: AllowedEdgeFunctionName,
  body: any,
  accessToken?: string
): Promise<any> {
  try {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    })
    if (error) {
      console.error(`Edge function ${functionName} error:`, error)
      return { data: null, error: error.message || 'Edge function error' }
    }
    return { data, error: null }
  } catch {
    const url = `${SUPABASE_URL}/functions/v1/${functionName}`
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   accessToken ? `Bearer ${accessToken}` : '',
          apikey:          SUPABASE_ANON,
        },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: data.error || `HTTP ${res.status}` }
      return { data, error: null }
    } catch (e: any) {
      return { data: null, error: e.message || 'Network error' }
    }
  }
}

/** Ping an Edge Function's /ping endpoint — useful for keep-warm scripts. */
export async function pingEdgeFunction(
  functionName: AllowedEdgeFunctionName
): Promise<{ warm: boolean; latencyMs: number }> {
  const url   = `${SUPABASE_URL}/functions/v1/${functionName}/ping`
  const start = Date.now()
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
      signal:  AbortSignal.timeout(5000),
    })
    return { warm: res.ok, latencyMs: Date.now() - start }
  } catch {
    return { warm: false, latencyMs: Date.now() - start }
  }
}

// ── Notification helpers ──────────────────────────────────────────────────────

export async function markNotificationRead(notificationId: string): Promise<any> {
  return supabase.from('notifications').update({ read: true } as any).eq('id', notificationId)
}

export async function markAllNotificationsRead(userId: string): Promise<any> {
  return supabase
    .from('notifications')
    .update({ read: true } as any)
    .eq('user_id', userId)
    .eq('read', false)
}

// ── Activity feed helpers ─────────────────────────────────────────────────────

interface ActivityLogOpts {
  actorName:   string
  actorId:     string
  action:      string
  subject?:    string
  amount?:     number | null
  emoji?:      string
  university?: string | null
}

/** Insert an activity feed event — fire-and-forget, never throws. */
export async function logActivity(opts: ActivityLogOpts): Promise<void> {
  const { actorName, actorId, action, subject, amount, emoji = '⚡', university } = opts
  try {
    await supabase.from('activity_feed').insert({
      actor_name: actorName,
      actor_id:   actorId,
      action,
      subject:    subject    || null,
      amount:     amount     ?? null,
      emoji,
      university: university ?? null,
    } as any)
  } catch {
    // Non-fatal
  }
}

// ── Profile helpers ───────────────────────────────────────────────────────────

export async function getPublicProfileStats(profileId: string): Promise<any> {
  const { data, error } = await supabase
    .from('public_profile_stats')
    .select('*')
    .eq('id', profileId)
    .single()
  if (error) throw error
  return data
}

// ── Transaction helpers ───────────────────────────────────────────────────────

export async function getTransactionForListing(
  listingId: string,
  buyerId: string
): Promise<any> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('listing_id', listingId)
    .eq('buyer_id', buyerId)
    .not('status', 'eq', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

export async function getSellerTransaction(
  listingId: string,
  sellerId: string
): Promise<any> {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('listing_id', listingId)
    .eq('seller_id', sellerId)
    .not('status', 'eq', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

// ── Edge Function wrappers ────────────────────────────────────────────────────

export async function releaseEscrow(
  transactionId: string,
  releaseCode: string,
  action: 'release' | 'refund'
): Promise<any> {
  const { data, error } = await callEdgeFunction('release-escrow', {
    transaction_id: transactionId,
    release_code:   releaseCode,
    action,
  })
  if (error) throw new Error(error)
  return data
}

export async function scanChatMessage(
  messageId:  string,
  senderId:   string,
  receiverId: string,
  content:    string,
  chatType?:  string
): Promise<any> {
  const { data, error } = await callEdgeFunction('ai-chat-scan', {
    message_id:  messageId,
    sender_id:   senderId,
    receiver_id: receiverId,
    content,
    chat_type:   chatType,
  })
  if (error) throw new Error(error)
  return data
}

export async function updateBeacon(
  userId:        string,
  latitude:      number,
  longitude:     number,
  beaconType:    'meetup' | 'general' = 'meetup',
  transactionId?: string,
  maxDistance:   number = 500
): Promise<any> {
  const { data, error } = await callEdgeFunction('beacon-matcher', {
    action:         'update_beacon',
    user_id:        userId,
    transaction_id: transactionId,
    latitude,
    longitude,
    beacon_type:    beaconType,
    max_distance:   maxDistance,
  })
  if (error) throw new Error(error)
  return data
}

export async function checkProximity(
  userId:        string,
  transactionId: string,
  latitude:      number,
  longitude:     number,
  maxDistance:   number = 500
): Promise<any> {
  const { data, error } = await callEdgeFunction('beacon-matcher', {
    action:         'check_proximity',
    user_id:        userId,
    transaction_id: transactionId,
    latitude,
    longitude,
    max_distance:   maxDistance,
  })
  if (error) throw new Error(error)
  return data
}
