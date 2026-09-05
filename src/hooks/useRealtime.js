import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Subscribe to real-time changes on a Supabase table.
 * Callbacks are read from refs so bursty inserts always hit the latest handler
 * without resubscribing on every render.
 *
 * @param {string}   table    - The table to listen to
 * @param {Function} onInsert - Called with the new row on INSERT
 * @param {Function} onUpdate - Called with the updated row on UPDATE
 * @param {Function} onDelete - Called with the old row on DELETE
 * @param {object}   filter   - Optional { column, value } filter
 * @param {number}   batchMs  - When >0, coalesce INSERT callbacks into one flush
 */
export function useRealtimeTable({
  table,
  onInsert,
  onUpdate,
  onDelete,
  filter,
  enabled = true,
  batchMs = 0,
}) {
  const channelRef = useRef(null)
  const onInsertRef = useRef(onInsert)
  const onUpdateRef = useRef(onUpdate)
  const onDeleteRef = useRef(onDelete)
  const pendingInsertsRef = useRef([])
  const flushTimerRef = useRef(null)

  onInsertRef.current = onInsert
  onUpdateRef.current = onUpdate
  onDeleteRef.current = onDelete

  useEffect(() => {
    if (!enabled) return

    const channelName = `rt:${table}:${filter ? `${filter.column}=${filter.value}` : 'all'}`
    const flushInserts = () => {
      flushTimerRef.current = null
      const batch = pendingInsertsRef.current
      pendingInsertsRef.current = []
      if (!batch.length || !onInsertRef.current) return
      if (batch.length === 1) onInsertRef.current(batch[0])
      else onInsertRef.current(batch)
    }

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
          if (payload.eventType === 'INSERT' && onInsertRef.current) {
            if (batchMs > 0) {
              pendingInsertsRef.current.push(payload.new)
              if (!flushTimerRef.current) {
                flushTimerRef.current = setTimeout(flushInserts, batchMs)
              }
            } else {
              onInsertRef.current(payload.new)
            }
          }
          if (payload.eventType === 'UPDATE' && onUpdateRef.current) {
            onUpdateRef.current(payload.new, payload.old)
          }
          if (payload.eventType === 'DELETE' && onDeleteRef.current) {
            onDeleteRef.current(payload.old)
          }
        }
      )
      .subscribe()

    channelRef.current = subscription

    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
        flushInserts()
      }
      supabase.removeChannel(subscription)
    }
  }, [table, filter?.column, filter?.value, enabled, batchMs])
}

/**
 * Subscribe to real-time notifications for the current user.
 */
export function useNotifications(userId, onNotification, { batchMs = 200 } = {}) {
  useRealtimeTable({
    table: 'notifications',
    filter: userId ? { column: 'user_id', value: userId } : undefined,
    onInsert: onNotification,
    enabled: !!userId,
    batchMs,
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
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

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
          if (isRelevant) onMessageRef.current?.(msg)
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [senderId, receiverId])
}
