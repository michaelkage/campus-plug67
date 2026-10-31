/* eslint-disable no-hardcoded-colors/no-hardcoded-colors */
import { motion } from 'framer-motion'
import { Shield, Star, Crown, Zap, TrendingUp, CreditCard, Award } from 'lucide-react'

// ── Tier definitions ───────────────────────────────────────────────────────────
export const TIERS = {
  citizen: {
    key:         'citizen',
    label:       'Citizen',
    emoji:       '🎓',
    icon:        Shield,
    color:       'text-on-surface/60',
    bg:          'bg-[var(--md-surface-container-high)]',
    border:      'border-[var(--md-outline-variant)]',
    minScore:    0,
    nextScore:   650,
    privileges:  [
      'Access to Marketplace',
      'Gig Listings',
      'Study Pools',
      'Lost & Found',
    ],
    locked: [
      'Top of Feed placement',
      'PlugCredit (BNPL)',
      'Zero-commission featured listings',
    ],
  },
  trusted: {
    key:         'trusted',
    label:       'Trusted Seller',
    emoji:       '⭐',
    icon:        Star,
    color:       'text-[var(--md-primary)]',
    bg:          'bg-[var(--md-primary)]/10',
    border:      'border-[var(--md-primary)]/30',
    minScore:    650,
    nextScore:   800,
    privileges:  [
      'Everything in Citizen',
      '🔝 Top of Feed placement',
      'Trust badge on all listings',
      'Priority in search results',
    ],
    locked: [
      'PlugCredit (BNPL)',
      'Zero-commission featured listings',
    ],
  },
  elite: {
    key:         'elite',
    label:       'Campus Elite',
    emoji:       '👑',
    icon:        Crown,
    color:       'text-[var(--md-secondary)]',
    bg:          'bg-[var(--md-secondary)]/10',
    border:      'border-[var(--md-secondary)]/30',
    minScore:    800,
    nextScore:   1000,
    privileges:  [
      'Everything in Trusted',
      '💳 PlugCredit (BNPL) — Buy Now, Pay Later',
      '⭐ Zero-commission featured listings',
      '🏆 Campus Elite badge',
      'PlugScore multiplier: 1.5×',
    ],
    locked: [],
  },
}

/**
 * TierBadge — compact inline badge showing a user's tier.
 */
export function TierBadge({ tier = 'citizen', size = 'sm' }) {
  const t = TIERS[tier] || TIERS.citizen
  const Icon = t.icon

  if (size === 'xs') return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-sm border ${t.bg} ${t.border} ${t.color}`}>
      {t.emoji} {t.label}
    </span>
  )

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-sm border ${t.bg} ${t.border} ${t.color}`}>
      <Icon size={11} />
      {t.label}
    </span>
  )
}

/**
 * TierCard — full tier status card for the Profile page.
 */
export function TierCard({ profile }) {
  const tier      = profile?.tier || 'citizen'
  const score     = profile?.plug_score || 500
  const t         = TIERS[tier]
  const nextTier  = tier === 'citizen' ? TIERS.trusted : tier === 'trusted' ? TIERS.elite : null
  const progress  = nextTier
    ? Math.min(Math.max((score - t.minScore) / (nextTier.minScore - t.minScore) * 100, 0), 100)
    : 100

  const Icon = t.icon

  return (
    <div className={`bg-[var(--md-surface-container)] border rounded-md overflow-hidden ${t.border}`}>
      {/* Header */}
      <div className={`${t.bg} px-6 py-5 border-b ${t.border}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <motion.div
              className={`w-12 h-12 rounded-md flex items-center justify-center text-2xl border ${t.bg} ${t.border}`}
            >
              {t.emoji}
            </motion.div>
            <div>
              <div className={`font-black text-lg ${t.color}`}>{t.label}</div>
              <div className="text-xs text-on-surface/40">PlugScore {score}</div>
            </div>
          </div>
          <div className="text-right">
            <div className={`text-2xl font-black font-mono ${t.color}`}>{score}</div>
            <div className="text-xs text-on-surface/30">/ 1000</div>
          </div>
        </div>

        {/* Progress to next tier */}
        {nextTier && (
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-on-surface/40">Progress to {nextTier.label}</span>
              <span className="text-on-surface/40">{nextTier.minScore - score} pts needed</span>
            </div>
            <div className="h-2 bg-[var(--md-scrim)]/20 rounded-sm overflow-hidden">
              <motion.div
                className={`h-full rounded-sm ${
                  tier === 'citizen' ? 'bg-[var(--md-primary)]'
                  : 'bg-[var(--md-secondary)]'
                }`}
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
              />
            </div>
          </div>
        )}

        {tier === 'elite' && (
          <div className="text-xs text-[var(--md-secondary)]/70 mt-2">
            🏆 Maximum tier reached. You are Campus Elite.
          </div>
        )}
      </div>

      {/* Privileges */}
      <div className="p-5">
        <div className="text-xs font-bold text-on-surface/40 uppercase tracking-wider mb-3">Your Privileges</div>
        <div className="space-y-2 mb-4">
          {t.privileges.map(p => (
            <div key={p} className="flex items-center gap-2 text-sm text-on-surface/70">
              <div className="w-1.5 h-1.5 rounded-sm bg-[var(--md-primary)] flex-shrink-0" />
              {p}
            </div>
          ))}
        </div>

        {t.locked.length > 0 && (
          <>
            <div className="text-xs font-bold text-on-surface/20 uppercase tracking-wider mb-3">
              Unlock Next
            </div>
            <div className="space-y-2">
              {t.locked.map(p => (
                <div key={p} className="flex items-center gap-2 text-sm text-on-surface/30">
                  <div className="w-1.5 h-1.5 rounded-sm bg-on-surface/20 flex-shrink-0" />
                  {p}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * TierGate — wraps any feature that requires a minimum tier.
 * Shows the feature blurred with a locked overlay if the user doesn't qualify.
 */
export function TierGate({ requiredTier, userTier, children, featureName }) {
  const tierOrder = ['citizen', 'trusted', 'elite']
  const hasAccess = tierOrder.indexOf(userTier || 'citizen') >= tierOrder.indexOf(requiredTier)
  const required  = TIERS[requiredTier]

  if (hasAccess) return children

  return (
    <div className="relative rounded-md overflow-hidden">
      <div className="blur-sm pointer-events-none select-none opacity-40">
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center
                      bg-surface-container rounded-md">
        <div className={`text-2xl mb-2`}>{required.emoji}</div>
        <div className={`font-bold text-sm ${required.color}`}>{required.label} Required</div>
        <div className="text-xs text-on-surface/40 mt-1 text-center px-4">
          {featureName} is unlocked at {required.minScore}+ PlugScore
        </div>
      </div>
    </div>
  )
}

/**
 * EliteBadge — compact tier badge for listing cards showing seller status.
 */
export function EliteBadge({ tier }) {
  if (tier !== 'elite' && tier !== 'trusted') return null
  const isElite = tier === 'elite'

  return (
    <motion.div
      className={`flex items-center gap-1 px-2 py-0.5 rounded-sm text-[9px] font-black border ${
        isElite
          ? 'bg-tertiary/20 text-[var(--md-secondary)] border-tertiary/40'
          : 'bg-[var(--md-primary)]/15 text-[var(--md-primary)] border-[var(--md-primary)]/30'
      }`}
    >
      {isElite ? '👑' : '⭐'} {isElite ? 'ELITE' : 'TRUSTED'}
    </motion.div>
  )
}
