import { useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useNotifications } from '@/hooks/useRealtime'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'

const TYPE_ICON = {
  transaction_complete: '✅',
  funds_released:       '💰',
  payment_locked:       '🔐',
  lostfound_match:      '🔍',
  credit_topup:         '💳',
  badge_earned:         '🏆',
  new_message:          '💬',
}

export default function NotificationBanner() {
  const { user } = useAuth()
  const qc = useQueryClient()

  useNotifications(user?.id, (notif) => {
    const icon = TYPE_ICON[notif.type] || '🔔'
    toast.custom(
      (t) => (
        <div
          className={`flex items-start gap-3 p-4 rounded-xl border border-cyan/20 bg-obsidian-400
                      shadow-[0_8px_32px_rgba(0,0,0,0.4)] cursor-pointer transition-all
                      ${t.visible ? 'animate-fade-up' : 'opacity-0'}`}
          style={{ maxWidth: 340 }}
          onClick={() => toast.dismiss(t.id)}
        >
          <span className="text-xl">{icon}</span>
          <div>
            <p className="text-sm font-semibold text-white">{notif.title}</p>
            {notif.body && <p className="text-xs text-white/50 mt-0.5 leading-relaxed">{notif.body}</p>}
          </div>
        </div>
      ),
      { duration: 6000 }
    )

    // Invalidate unread count
    qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
    qc.invalidateQueries({ queryKey: ['notifications', user?.id] })
  })

  return null // No DOM output; purely a subscription subscriber
}
