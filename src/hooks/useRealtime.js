import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Subscribe to real-time changes on a Supabase table.
 * Calls the provided callback whenever an INSERT/UPDATE/DELETE fires.
 *
 * @param {string}   table    - The table to listen to
 * @param {Function} onInsert - Called with the new row on INSERT
 * @param {Function} onUpdate - Called with the updated row on UPDATE
 * @param {Function} onDelete - Called with the old row on DELETE
 * @param {object}   filter   - Optional { column, value } filter
 */
export function useRealtimeTable({
  table,
  onInsert,
  onUpdate,
  onDelete,
  filter,
  enabled = true,
}) {
  const channelRef = useRef(null)

  useEffect(() => {
    if (!enabled) return

    const channelName = `rt:${table}:${filter ? `${filter.column}=${filter.value}` : 'all'}`

    let subscription = supabase.channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          ...(filter ? { filter: `${filter.column}=eq.${filter.value}` } : {}),
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && onInsert) onInsert(payload.new)
          if (payload.eventType === 'UPDATE' && onUpdate) onUpdate(payload.new, payload.old)
          if (payload.eventType === 'DELETE' && onDelete) onDelete(payload.old)
        }
      )
      .subscribe()

    channelRef.current = subscription

    return () => {
      supabase.removeChannel(subscription)
    }
  }, [table, filter?.column, filter?.value, enabled])
}

/**
 * Subscribe to real-time notifications for the current user.
 */
export function useNotifications(userId, onNotification) {
  useRealtimeTable({
    table: 'notifications',
    filter: userId ? { column: 'user_id', value: userId } : undefined,
    onInsert: onNotification,
    enabled: !!userId,
  })
}

/**
 * Subscribe to a specific transaction's status updates.
 */
export function useTransactionStatus(transactionId, onUpdate) {
  useRealtimeTable({
    table: 'transactions',
    filter: transactionId ? { column: 'id', value: transactionId } : undefined,
    onUpdate,
    enabled: !!transactionId,
  })
}

/**
 * Subscribe to real-time messages in a conversation between two users.
 */
export function useMessages(senderId, receiverId, onMessage) {
  useEffect(() => {
    if (!senderId || !receiverId) return

    const channel = supabase
      .channel(`messages:${[senderId, receiverId].sort().join(':')}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
        },
        (payload) => {
          const msg = payload.new
          const isRelevant =
            (msg.sender_id === senderId && msg.receiver_id === receiverId) ||
            (msg.sender_id === receiverId && msg.receiver_id === senderId)
          if (isRelevant) onMessage(msg)
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [senderId, receiverId])
}
