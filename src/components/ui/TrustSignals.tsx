import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Shield, Star, Award, CheckCircle2, TrendingUp, Zap, Lock } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

// ── Micro-copy library ─────────────────────────────────────────────────────────
export const MICRO_COPY = {
  // Post-transaction emotional reward
  dealComplete: (sellerName: string) =>
    `Deal completed safely 🤝 You're building a legendary reputation, ${sellerName}.`,

  safeZoneVerified: () =>
    `Safe Zone Verified. Campus Shield is active.`,

  dualSyncComplete: () =>
    `✅ Presence Verified. This handshake is now on-record.`,

  escrowLocked: (amount: string) =>
    `${amount} is held safely in PlugPay. Neither party can touch it until you meet.`,

  omwStarted: (minutes: number) =>
    `On My Way — ${minutes}-minute presence window started.`,

  tierUpgrade: (tier: string) =>
    tier === 'elite'
      ? `🏆 You are Campus Elite. You've earned the trust of this ecosystem.`
      : `⭐ Trusted Seller status unlocked. The campus sees you differently now.`,

  juryVote: (correct: boolean) =>
    correct
      ? `⚖️ Correct verdict! Your accuracy improves. Campus justice runs on people like you.`
      : `⚖️ Vote recorded. Every juror shapes the trust layer.`,

  streakMilestone: (days: number) =>
    `🔥 ${days}-day streak. Consistency is the rarest currency on campus.`,

  referralBonus: () =>
    `🎁 Your referral completed their first trade. You built someone's first trust.`,

  ghostRefund: () =>
    `🔄 Campus Shield protected you. Your money is coming back.`,

  priorityRelist: () =>
    `🚀 You waited. The feed rewards patience — you're back on top.`,
}

// ── High Confidence Trade badge ───────────────────────────────────────────────
export function HighConfidenceBadge({ transaction, profile }: { transaction?: any; profile?: any }) {
  const score = profile?.plug_score || 0
  const sales = profile?.total_sales || 0

  // Confidence criteria
  const criteria = [
    { met: score >= 650,    label: 'Trusted reputation' },
    { met: sales >= 10,     label: '10+ completed trades' },
    { met: profile?.tier === 'trusted' || profile?.tier === 'elite', label: 'Verified tier' },
    { met: !profile?.collusion_flag, label: 'No collusion flags' },
  ]

  const confidencePct  = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100)
  const isHighConf     = confidencePct >= 75

  if (!isHighConf) return null

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="group relative bg-[var(--md-primary)]/8 border border-[var(--md-primary)]/30 rounded-xl px-4 py-3
                 flex items-center gap-3 cursor-help"
    >
      <div className="w-8 h-8 rounded-lg bg-[var(--md-primary)]/15 flex items-center justify-center flex-shrink-0">
        <Shield size={16} className="text-[var(--md-primary)]" />
      </div>
      <div>
        <div className="text-xs font-bold text-[var(--md-primary)]">High Confidence Trade</div>
        <div className="text-[10px] text-[var(--md-on-surface-variant)] mt-0.5">
          Based on verified behavior and successful transactions.
        </div>
      </div>
      <div className="ml-auto">
        <div className="text-sm font-black text-[var(--md-primary)] font-mono">{confidencePct}%</div>
      </div>

      {/* Tooltip on hover */}
      <div className="absolute bottom-full left-0 mb-2 w-56 p-3 bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]
                      rounded-xl shadow-card invisible group-hover:visible transition-all z-20">
        <div className="text-[10px] font-bold text-white/50 uppercase tracking-wider mb-2">Confidence Factors</div>
        {criteria.map(c => (
          <div key={c.label} className="flex items-center gap-2 text-[11px] mb-1">
            <div className={`w-3 h-3 rounded-full flex-shrink-0 ${c.met ? 'bg-plug-green' : 'bg-[var(--md-on-surface)]/15'}`} />
            <span className={c.met ? 'text-[var(--md-on-surface)]' : 'text-[var(--md-on-surface-variant)]'}>{c.label}</span>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

// ── Verified Interaction Pattern badge ────────────────────────────────────────
export function VerifiedInteractionBadge({ listingId, sellerId }: { listingId: string; sellerId: string }) {
  const { data } = useQuery({
    queryKey: ['verified-interaction', listingId, sellerId],
    queryFn:  async () => {
      // Check: seller has completed trades on this category + no recent flags
      const [trades, flags] = await Promise.all([
        supabase.from('transactions').select('id', { count: 'exact', head: true })
          .eq('seller_id', sellerId).eq('status', 'released'),
        supabase.from('chat_flag_log').select('id', { count: 'exact', head: true })
          .eq('sender_id', sellerId).gte('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString()),
      ])
      return { trades: trades.count || 0, flags: flags.count || 0 }
    },
    enabled: !!(listingId && sellerId),
    staleTime: 300_000,
  })

  if (!data || data.trades < 3 || data.flags > 2) return null

  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan">
      <CheckCircle2 size={12} />
      Verified Interaction Pattern
    </div>
  )
}

// ── Campus Shield nudge ────────────────────────────────────────────────────────
export function CampusShieldNudge({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-start gap-3 p-4 bg-[var(--md-primary)]/6 border border-[var(--md-primary)]/20 rounded-xl"
    >
      <Lock size={14} className="text-cyan flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-xs text-[var(--md-on-surface)] leading-relaxed">
        <span className="text-cyan font-bold">🔐 Campus Shield: </span>
        Stay in-app to keep your escrow protection and PlugScore bonuses active.
        Moving off-platform voids your safety guarantee.
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-white/20 hover:text-white/50 flex-shrink-0">×</button>
      )}
    </motion.div>
  )
}

// ── Success moment card ───────────────────────────────────────────────────────
export function SuccessMoment({ type, data }: { type: keyof typeof MICRO_COPY; data?: any }) {
  const [visible, setVisible] = useState(true)

  const copy = (() => {
    switch (type) {
      case 'dealComplete':     return MICRO_COPY.dealComplete(data?.name || 'Student')
      case 'safeZoneVerified': return MICRO_COPY.safeZoneVerified()
      case 'dualSyncComplete': return MICRO_COPY.dualSyncComplete()
      case 'escrowLocked':     return MICRO_COPY.escrowLocked(data?.amount || '₦0')
      case 'tierUpgrade':      return MICRO_COPY.tierUpgrade(data?.tier || 'trusted')
      case 'streakMilestone':  return MICRO_COPY.streakMilestone(data?.days || 7)
      default:                 return ''
    }
  })()

  const isSuccess = ['dealComplete', 'dualSyncComplete', 'tierUpgrade', 'streakMilestone'].includes(type)

  if (!copy) return null

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          className={`relative overflow-hidden rounded-2xl border p-5 ${
            isSuccess
              ? 'border-[var(--md-primary)]/30 bg-[var(--md-primary)]/8'
              : 'border-[var(--md-primary)]/20 bg-[var(--md-primary)]/5'
          }`}
        >
          
          <div className="relative z-10 flex items-start gap-3">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-lg flex-shrink-0 ${
              isSuccess ? 'bg-[var(--md-primary)]/15' : 'bg-[var(--md-primary)]/10'
            }`}>
              {isSuccess ? '🤝' : '🔐'}
            </div>
            <p className={`text-sm leading-relaxed flex-1 ${isSuccess ? 'text-white/80' : 'text-[var(--md-on-surface)]'}`}>
              {copy}
            </p>
            <button onClick={() => setVisible(false)} className="text-white/20 hover:text-white/50 flex-shrink-0 text-lg leading-none">×</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── PWA onboarding overlay ────────────────────────────────────────────────────
export function PWAOverlay({ onDismiss }: { onDismiss: () => void }) {
  const [installing, setInstalling] = useState(false)
  const [promptEvent, setPromptEvent] = useState<any>(null)

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setPromptEvent(e) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const install = async () => {
    if (!promptEvent) return
    setInstalling(true)
    promptEvent.prompt()
    const result = await promptEvent.userChoice
    setInstalling(false)
    if (result.outcome === 'accepted') onDismiss()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: '100%' }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: '100%' }}
        transition={{ type: 'spring', stiffness: 300, damping: 32 }}
        className="fixed bottom-20 md:bottom-6 left-4 right-4 z-50 max-w-sm mx-auto"
      >
        <div className="bg-[var(--md-surface-container)] border border-[var(--md-primary)]/30 rounded-2xl overflow-hidden shadow-md">
          {/* Glow stripe */}
          <div className="h-1 bg-[var(--md-primary)]" />

          <div className="p-5">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-12 h-12 rounded-xl bg-[var(--md-primary-container)] flex items-center justify-center text-obsidian font-black text-xl flex-shrink-0">
                ⚡
              </div>
              <div>
                <div className="font-black text-base mb-1">⚡ Pro Access</div>
                <p className="text-sm text-white/60 leading-relaxed">
                  Faster loading and lag-free handshakes. Install Campus Plug for the full experience.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { icon: Zap,         label: 'Instant load'       },
                { icon: Shield,      label: 'Offline capable'    },
                { icon: TrendingUp,  label: 'Home screen'        },
              ].map(({ icon: Icon, label }) => (
                <div key={label} className="bg-[var(--md-surface-container-high)] rounded-xl p-2.5 text-center">
                  <Icon size={14} className="text-cyan mx-auto mb-1" />
                  <div className="text-[10px] text-white/50">{label}</div>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button onClick={onDismiss} className="btn-secondary flex-1 text-sm py-2.5">
                Not Now
              </button>
              <button
                onClick={promptEvent ? install : onDismiss}
                disabled={installing}
                className="btn-primary flex-1 text-sm py-2.5 disabled:opacity-50"
              >
                {installing ? 'Installing…' : 'Install App'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

// ── PWA onboarding trigger (hook) ─────────────────────────────────────────────
export function usePWAOnboarding() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Trigger after 3rd meaningful interaction
    const count = parseInt(localStorage.getItem('cp_interactions') || '0')
    const dismissed = localStorage.getItem('cp_pwa_dismissed')
    if (count >= 3 && !dismissed && !window.matchMedia('(display-mode: standalone)').matches) {
      setShow(true)
    }
  }, [])

  const trackInteraction = () => {
    const count = parseInt(localStorage.getItem('cp_interactions') || '0') + 1
    localStorage.setItem('cp_interactions', String(count))
    if (count === 3) setShow(true)
  }

  const dismiss = () => {
    setShow(false)
    localStorage.setItem('cp_pwa_dismissed', '1')
  }

  return { show, dismiss, trackInteraction }
}
