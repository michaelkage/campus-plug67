import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON) {
  throw new Error(
    '[CampusPlug] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
    'Copy .env.example → .env and fill in your Supabase project credentials.'
  )
}

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'cp_auth',
    flowType: 'pkce',
  },
  realtime: { params: { eventsPerSecond: 12 } },
  global: { headers: { 'x-app-version': '3.1.0' } },
})

export function formatNaira(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return '₦0'
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export function toKobo(naira: number | string): number {
  const n = parseFloat(String(naira).replace(/,/g, ''))
  if (isNaN(n)) return 0
  return Math.round(n * 100)
}

export function timeAgo(timestamp: string | Date | null | undefined): string {
  if (!timestamp) return ''
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })
}

/** University enrollment is allow-list based. There is intentionally no blanket
 * .edu/.edu.ng fallback: a domain must be explicitly approved. */
export async function validateEduEmail(email: string): Promise<{ valid: boolean; university: string | null }> {
  const domain = email?.split('@')[1]?.toLowerCase()
  if (!domain) return { valid: false, university: null }
  const { data } = await supabase
    .from('allowed_domains')
    .select('institution_name')
    .eq('domain', domain)
    .eq('active', true)
    .maybeSingle()
  if (data) return { valid: true, university: (data as any).institution_name }
  return { valid: false, university: null }
}

export async function uploadImage(file: File, bucket = 'listings', folder = 'public'): Promise<string> {
  const ext = file.name?.split('.').pop() || 'jpg'
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const path = `${folder}/${name}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600', upsert: false, contentType: file.type || 'image/jpeg',
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

export async function deleteImage(publicUrl: string, bucket = 'listings'): Promise<void> {
  try {
    const url = new URL(publicUrl)
    const parts = url.pathname.split(`/storage/v1/object/public/${bucket}/`)
    if (parts.length < 2) return
    await supabase.storage.from(bucket).remove([parts[1]])
  } catch { /* best effort */ }
}

export async function getSmartPrice(category: string, university: string): Promise<any> {
  if (!category || !university) return null
  const { data, error } = await supabase.rpc('get_price_suggestion', { p_category: category, p_university: university } as any)
  return error || !data ? null : data
}

export async function getPriceFloor(category: string, university: string): Promise<any> {
  if (!category || !university) return null
  const { data, error } = await supabase.rpc('get_price_floor', { p_category: category, p_university: university } as any)
  return error || !data ? null : data
}

interface PaystackOpts { email: string; amount: number; ref: string; publicKey: string; metadata?: any; currency?: string }
export function openPaystack(opts: PaystackOpts): Promise<any> {
  const { email, amount, ref, publicKey, metadata = {}, currency = 'NGN' } = opts
  return new Promise((resolve, reject) => {
    const init = () => {
      const handler = (window as any).PaystackPop.setup({ key: publicKey, email, amount, ref, currency, metadata, callback: resolve, onClose: () => reject(new Error('Payment cancelled')) })
      handler.openIframe()
    }
    if ((window as any).PaystackPop) { init(); return }
    const script = document.createElement('script')
    script.src = 'https://js.paystack.co/v1/inline.js'
    script.onload = init
    script.onerror = () => reject(new Error('Failed to load Paystack. Check your connection.'))
    document.head.appendChild(script)
  })
}

export function generatePaystackRef(prefix = 'CP'): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

export type AllowedEdgeFunctionName = 'release-escrow' | 'ai-chat-scan' | 'beacon-matcher'

/** All authenticated Edge Function calls now obtain the current Supabase JWT
 * automatically. Callers may still pass an explicit access token. */
export async function callEdgeFunction(functionName: AllowedEdgeFunctionName, body: any, accessToken?: string): Promise<any> {
  const token = accessToken ?? (await supabase.auth.getSession()).data.session?.access_token
  if (!token) return { data: null, error: 'Not authenticated' }
  try {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: { Authorization: `Bearer ${token}` },
    })
    if (error) return { data: null, error: error.message || 'Edge function error' }
    return { data, error: null }
  } catch {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON },
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

export async function pingEdgeFunction(functionName: AllowedEdgeFunctionName): Promise<{ warm: boolean; latencyMs: number }> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}/ping`
  const start = Date.now()
  try {
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }, signal: AbortSignal.timeout(5000) })
    return { warm: res.ok, latencyMs: Date.now() - start }
  } catch { return { warm: false, latencyMs: Date.now() - start } }
}

export async function markNotificationRead(notificationId: string): Promise<any> {
  return supabase.from('notifications').update({ read: true } as any).eq('id', notificationId)
}

export async function markAllNotificationsRead(userId: string): Promise<any> {
  return supabase.from('notifications').update({ read: true } as any).eq('user_id', userId).eq('read', false)
}

interface ActivityLogOpts { actorName: string; actorId: string; action: string; subject?: string; amount?: number | null; emoji?: string; university?: string | null }
export async function logActivity(opts: ActivityLogOpts): Promise<void> {
  try {
    await supabase.from('activity_feed').insert({ actor_name: opts.actorName, actor_id: opts.actorId, action: opts.action, subject: opts.subject || null, amount: opts.amount ?? null, emoji: opts.emoji || '⚡', university: opts.university ?? null } as any)
  } catch { /* non-fatal */ }
}

export async function getPublicProfileStats(profileId: string): Promise<any> {
  const { data, error } = await supabase.from('public_profile_stats').select('*').eq('id', profileId).single()
  if (error) throw error
  return data
}

export async function getTransactionForListing(listingId: string, buyerId: string): Promise<any> {
  const { data } = await supabase.from('transactions').select('*').eq('listing_id', listingId).eq('buyer_id', buyerId).not('status', 'eq', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

export async function getSellerTransaction(listingId: string, sellerId: string): Promise<any> {
  const { data } = await supabase.from('transactions').select('*').eq('listing_id', listingId).eq('seller_id', sellerId).not('status', 'eq', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

export async function releaseEscrow(transactionId: string, releaseCode: string, action: 'release' | 'refund'): Promise<any> {
  const { data, error } = await callEdgeFunction('release-escrow', { transaction_id: transactionId, release_code: releaseCode, action })
  if (error) throw new Error(error)
  return data
}

export async function scanChatMessage(messageId: string, senderId: string, receiverId: string, content: string, chatType?: string): Promise<any> {
  const isPreFlight = !messageId || messageId.startsWith('temp-')
  const payload = isPreFlight
    ? { raw_content: content, receiver_id: receiverId, chat_type: chatType }
    : { message_id: messageId, chat_type: chatType }
  const { data, error } = await callEdgeFunction('ai-chat-scan', payload)
  if (error) throw new Error(error)
  return data
}

export async function updateBeacon(_userId: string, latitude: number, longitude: number, beaconType: 'meetup' | 'general' = 'meetup', transactionId?: string, maxDistance = 500): Promise<any> {
  const { data, error } = await callEdgeFunction('beacon-matcher', { action: 'update_beacon', transaction_id: transactionId, latitude, longitude, beacon_type: beaconType, max_distance: maxDistance })
  if (error) throw new Error(error)
  return data
}

export async function checkProximity(_userId: string, transactionId: string, latitude: number, longitude: number, maxDistance = 500): Promise<any> {
  const { data, error } = await callEdgeFunction('beacon-matcher', { action: 'check_proximity', transaction_id: transactionId, latitude, longitude, max_distance: maxDistance })
  if (error) throw new Error(error)
  return data
}
