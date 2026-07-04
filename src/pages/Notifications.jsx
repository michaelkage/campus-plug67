import { useQuery, useQueryClient } from '@tanstack/react-query'
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
}

export default function Notifications() {
  const { user } = useAuth()
  const qc = useQueryClient()

  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ['notifications', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)
      return data || []
    },
    enabled: !!user,
  })

  // Real-time: prepend new notifications
  useNotifications(user?.id, (newNotif) => {
    qc.setQueryData(['notifications', user?.id], old => [newNotif, ...(old || [])])
    toast(newNotif.title, { icon: TYPE_ICON[newNotif.type] || '🔔' })
  })

  const markAllRead = async () => {
    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false)
    qc.invalidateQueries({ queryKey: ['notifications'] })
    qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
  }

  const markRead = async (id) => {
    await supabase.from('notifications').update({ read: true }).eq('id', id)
    qc.setQueryData(['notifications', user?.id], old =>
      old?.map(n => n.id === id ? { ...n, read: true } : n)
    )
    qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
  }

  const unread = notifications.filter(n => !n.read).length

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
          {unread > 0 && (
            <p className="text-sm text-white/40 mt-1">{unread} unread</p>
          )}
        </div>
        {unread > 0 && (
          <button onClick={markAllRead}
            className="flex items-center gap-2 text-xs text-cyan hover:text-cyan/80 transition-colors font-semibold">
            <CheckCheck size={14} />
            Mark all read
          </button>
        )}
      </div>

      {isLoading ? (
        Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 mb-3 animate-pulse h-20" />
        ))
      ) : notifications.length === 0 ? (
        <div className="text-center py-20 text-white/30">
          <Bell size={36} className="mx-auto mb-4 opacity-30" />
          <p className="font-semibold">No notifications yet</p>
          <p className="text-sm mt-1">You're all caught up 👌</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(notif => (
            <button
              key={notif.id}
              onClick={() => markRead(notif.id)}
              className={`w-full text-left flex gap-4 p-4 rounded-xl border transition-all hover:border-cyan/20 ${
                notif.read
                  ? 'bg-obsidian-400 border-obsidian-500 opacity-60'
                  : 'bg-obsidian-400 border-cyan/20 shadow-[0_0_0_1px_rgba(0,242,255,0.06)]'
              }`}
            >
              <div className="w-10 h-10 rounded-full bg-obsidian-300 flex items-center justify-center
                              text-xl flex-shrink-0">
                {TYPE_ICON[notif.type] || '🔔'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm">{notif.title}</p>
                  {!notif.read && (
                    <div className="w-2 h-2 rounded-full bg-cyan flex-shrink-0 mt-1" />
                  )}
                </div>
                {notif.body && (
                  <p className="text-sm text-white/50 mt-0.5 leading-relaxed">{notif.body}</p>
                )}
                <p className="text-xs text-white/25 mt-1">{timeAgo(notif.created_at)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
