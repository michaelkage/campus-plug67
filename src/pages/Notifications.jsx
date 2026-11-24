/* eslint-disable no-hardcoded-colors/no-hardcoded-colors */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useNotifications } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Bell, CheckCheck } from 'lucide-react'

const TYPE_ICON = {
  transaction_complete: '✅',
  funds_released:       '💰',
  payment_locked:       '🔐',
  lostfound_match:      '🔍',
  credit_topup:         '💳',
  new_message:          '💬',
  badge_earned:         '🏆',
  purchase_started:     '🛍️',
  purchase_request:      '🛒',
  order_processing:     '📦',
}

export default function Notifications() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ['notifications', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      return data || []
    },
    enabled: !!user,
  })

  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['unread-notifications', user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { count, error } = await supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('read', false)
      if (error) throw error
      return count ?? 0
    },
    refetchInterval: 30_000,
  })

  // Real-time inserts and read-state updates keep both the inbox and global badge in sync.
  useNotifications(user?.id, (incoming) => {
    const items = Array.isArray(incoming) ? incoming : [incoming]
    qc.setQueryData(['notifications', user?.id], (old) => {
      const prev = old || []
      const seen = new Set(prev.map((row) => row.id))
      const fresh = []
      for (let i = items.length - 1; i >= 0; i--) {
        const row = items[i]
        if (row?.id && !seen.has(row.id)) {
          seen.add(row.id)
          fresh.push(row)
        }
      }
      return [...fresh, ...prev].slice(0, 50)
    })
    const latest = items[items.length - 1]
    if (latest?.title) toast(latest.title, { icon: TYPE_ICON[latest.type] || '🔔' })
    void qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
  }, {
    onUpdate: (updated) => {
      qc.setQueryData(['notifications', user?.id], old =>
        old?.map(row => row.id === updated.id ? { ...row, ...updated } : row)
      )
      void qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
    },
  })

  const markAllRead = async () => {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false)
      .select('id')
    if (error) {
      toast.error('Could not mark notifications as read. Please try again.')
      console.error('Mark all notifications read failed:', error)
      return
    }
    const { count: remainingUnread, error: verifyError } = await supabase.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false)
    if (verifyError || (remainingUnread ?? 0) > 0) {
      toast.error('Some notifications could not be marked as read. Refresh and retry.')
      await qc.invalidateQueries({ queryKey: ['notifications', user?.id] })
      await qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
      return
    }
    qc.setQueryData(['notifications', user?.id], old => old?.map(n => ({ ...n, read: true })))
    await qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
  }

  const markRead = async (id) => {
    const { data, error } = await supabase.from('notifications')
      .update({ read: true })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('read', false)
      .select('id')
      .maybeSingle()
    if (error) {
      toast.error('Could not mark this notification as read.')
      console.error('Mark notification read failed:', error)
      return false
    }
    if (!data) {
      const { data: current, error: verifyError } = await supabase.from('notifications')
        .select('read')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (verifyError || !current?.read) {
        toast.error('Could not verify this notification as read.')
        console.error('Notification read verification failed:', verifyError || 'No persisted read receipt')
        return false
      }
    }
    qc.setQueryData(['notifications', user?.id], old =>
      old?.map(n => n.id === id ? { ...n, read: true } : n)
    )
    await qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
    return true
  }

  const openNotification = async (notif) => {
    const marked = notif.read || await markRead(notif.id)
    if (!marked) return
    const data = notif.data && typeof notif.data === 'object' ? notif.data : {}
    const internalPath = data.path || data.url || data.route
    if (typeof internalPath === 'string' && internalPath.startsWith('/') && !internalPath.startsWith('//')) {
      navigate(internalPath)
      return
    }
    const listingId = data.listing_id || data.item_id
    const transactionId = data.transaction_id || data.tx_id
    const otherUserId = data.sender_id || data.other_user_id || data.user_id
    switch (notif.type) {
      case 'lostfound_match':
      case 'lost_found_match':
        navigate(listingId ? `/lost-found?item=${encodeURIComponent(listingId)}` : '/lost-found')
        return
      case 'new_message':
        navigate(otherUserId ? `/chat?user_id=${encodeURIComponent(otherUserId)}` : '/chat')
        return
      case 'transaction_complete':
      case 'funds_released':
      case 'payment_locked':
      case 'purchase_started':
      case 'purchase_request':
      case 'order_processing':
        navigate(transactionId ? `/safe-swap?tx=${encodeURIComponent(transactionId)}` : '/safe-swap')
        return
      case 'credit_topup':
        navigate('/wallet')
        return
      case 'badge_earned':
        navigate('/profile')
        return
      default:
        navigate(listingId ? `/marketplace/${encodeURIComponent(listingId)}` : transactionId ? `/safe-swap?tx=${encodeURIComponent(transactionId)}` : '/notifications')
    }
  }

  const unread = unreadCount

  const timeAgo = (ts) => {
    const diff = Date.now() - new Date(ts).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1)  return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="section-label">Inbox</p>
          <h1 className="text-2xl font-black tracking-tight">Notifications</h1>
          <p className="text-sm text-on-surface/40 mt-1" aria-live="polite" aria-atomic="true">{unread > 0 ? `${unread} unread` : 'No unread notifications'}</p>
        </div>
        {unread > 0 && (
          <button onClick={markAllRead}
            className="flex items-center gap-2 text-xs text-primary hover:text-primary/80 transition-colors font-semibold">
            <CheckCheck size={14} aria-hidden="true" />
            Mark all read
          </button>
        )}
      </div>

      {isLoading ? (
        <div role="status" aria-live="polite" className="space-y-3">
        <span className="sr-only">Loading notifications</span>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-surface-container-high border border-outline-variant rounded-md p-4 mb-3 animate-pulse h-20" />
        ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-20 text-on-surface/30" role="status">
          <Bell size={36} aria-hidden="true" className="mx-auto mb-4 opacity-30" />
          <p className="font-semibold">No notifications yet</p>
          <p className="text-sm mt-1">You're all caught up 👌</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(notif => (
            <button
              key={notif.id}
              onClick={() => { void openNotification(notif) }}
              className={`w-full text-left flex gap-4 p-4 rounded-md border transition-all hover:border-primary/20 ${
                notif.read
                  ? 'bg-surface-container-high border-outline-variant opacity-60'
                  : 'bg-surface-container-high border-primary/20 shadow-none'
              }`}
            >
              <div className="w-10 h-10 rounded-sm bg-surface-container-highest flex items-center justify-center
                              text-xl flex-shrink-0">
                {TYPE_ICON[notif.type] || '🔔'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm">{notif.title}</p>
                  {!notif.read && (
                    <>
                      <span className="sr-only">Unread</span>
                      <div aria-hidden="true" className="w-2 h-2 rounded-sm bg-primary flex-shrink-0 mt-1" />
                    </>
                  )}
                </div>
                {notif.body && (
                  <p className="text-sm text-on-surface/50 mt-0.5 leading-relaxed">{notif.body}</p>
                )}
                <p className="text-xs text-on-surface/25 mt-1">{timeAgo(notif.created_at)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
