import { supabase } from './client'
import { callEdgeFunction } from './paystack'
import type { Database } from '@/types/database'

export async function validateEduEmail(email: string): Promise<{ valid: boolean; university: string | null }> {
  const domain = email?.split('@')[1]?.toLowerCase()
  if (!domain) return { valid: false, university: null }
  const { data } = await supabase.from('allowed_domains').select('institution_name').eq('domain', domain).eq('active', true).maybeSingle()
  return data ? { valid: true, university: data.institution_name } : { valid: false, university: null }
}

export async function markNotificationRead(notificationId: string) {
  const update: Database['public']['Tables']['notifications']['Update'] = { read: true }
  return supabase.from('notifications').update(update).eq('id', notificationId)
}

export async function markAllNotificationsRead(userId: string) {
  const update: Database['public']['Tables']['notifications']['Update'] = { read: true }
  return supabase.from('notifications').update(update).eq('user_id', userId).eq('read', false)
}

export interface ActivityLogOptions {
  actorName: string
  actorId: string
  action: string
  subject?: string
  amount?: number | null
  emoji?: string
  university?: string | null
}

export async function logActivity(options: ActivityLogOptions): Promise<void> {
  try {
    const insert: Database['public']['Tables']['activity_feed']['Insert'] = {
      actor_name: options.actorName,
      actor_id: options.actorId,
      action: options.action,
      subject: options.subject ?? null,
      amount: options.amount ?? null,
      emoji: options.emoji ?? '⚡',
      university: options.university ?? null,
    }
    await supabase.from('activity_feed').insert(insert)
  } catch {
    // Activity telemetry is intentionally non-fatal.
  }
}

export async function getPublicProfileStats(profileId: string) {
  const { data, error } = await supabase.from('public_profile_stats').select('*').eq('id', profileId).single()
  if (error) throw error
  return data
}

export async function getTransactionForListing(listingId: string, buyerId: string) {
  const { data } = await supabase.from('transactions').select('*').eq('listing_id', listingId).eq('buyer_id', buyerId).not('status', 'eq', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

export async function getSellerTransaction(listingId: string, sellerId: string) {
  const { data } = await supabase.from('transactions').select('*').eq('listing_id', listingId).eq('seller_id', sellerId).not('status', 'eq', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

export async function scanChatMessage(messageId: string, _senderId: string, receiverId: string, content: string, chatType?: string) {
  const isPreFlight = !messageId || messageId.startsWith('temp-')
  const payload = isPreFlight
    ? { raw_content: content, receiver_id: receiverId, chat_type: chatType }
    : { message_id: messageId, chat_type: chatType }
  const { data, error } = await callEdgeFunction('ai-chat-scan', payload)
  if (error) throw new Error(error)
  return data
}
