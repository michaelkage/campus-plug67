import { useAuth } from '@/contexts/AuthContext'
import { useNotifications } from '@/hooks/useRealtime'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'

const TYPE_ICON = {
  transaction_complete: '✅',
  funds_released: '💰',
  payment_locked: '🔐',
  lostfound_match: '🔍',
  credit_topup: '💳',
  badge_earned: '🏆',
  new_message: '💬',
}

export default function NotificationBanner() {
  const { user } = useAuth()
  const qc = useQueryClient()

  useNotifications(user?.id, (notif) => {
    const icon = TYPE_ICON[notif.type] || '🔔'
    toast.custom(
      (t) => (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`flex w-full max-w-[360px] items-start gap-3 rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] p-4 text-left shadow-none transition-all ${t.visible ? 'animate-fade-up' : 'opacity-0'}`}
        >
          <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-[var(--md-primary-container)] text-lg">
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-[var(--md-on-surface)]">{notif.title}</span>
            {notif.body && <span className="mt-1 block text-xs leading-relaxed text-[var(--md-on-surface-variant)]">{notif.body}</span>}
          </span>
          <button
            type="button"
            aria-label={`Dismiss notification: ${notif.title}`}
            className="cp-focus-ring -mr-2 -mt-2 inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-full text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]"
            onClick={() => toast.dismiss(t.id)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      ),
      { duration: 6000 }
    )

    qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })
    qc.invalidateQueries({ queryKey: ['notifications', user?.id] })
  })

  return null
}
