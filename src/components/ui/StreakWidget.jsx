import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, callEdgeFunction } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Flame, Snowflake, Trophy } from 'lucide-react'

const MILESTONES = [7, 14, 30, 60, 100]

/**
 * useStreak — fetches and auto-triggers streak activity on app load.
 */
export function useStreak() {
  const { session, user } = useAuth()
  const qc = useQueryClient()

  const { data: streak } = useQuery({
    queryKey: ['streak', user?.id],
    queryFn:  async () => {
      const { data } = await supabase
        .from('streaks')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle()
      return data
    },
    enabled: !!user?.id,
    staleTime: 60_000 * 5,
  })

  // Trigger streak activity once per session (non-blocking)
  useEffect(() => {
    if (!session?.access_token || !user) return
    const key = `cp_streak_${user.id}_${new Date().toDateString()}`
    if (sessionStorage.getItem(key)) return  // Already fired today in this session

    callEdgeFunction('process-growth-events', { action: 'streak_activity' }, session.access_token)
      .then(({ data }) => {
        if (data?.milestone) {
          qc.invalidateQueries({ queryKey: ['streak', user.id] })
          qc.invalidateQueries({ queryKey: ['profile', user.id] })
        }
        sessionStorage.setItem(key, '1')
      })
  }, [user?.id, session?.access_token])

  return { streak }
}

/**
 * StreakWidget — displays the user's current streak with flame animation.
 * Place this on the Home page or Profile.
 */
export function StreakWidget({ userId, compact = false }) {
  const { data: streak } = useQuery({
    queryKey: ['streak', userId],
    queryFn:  async () => {
      const { data } = await supabase.from('streaks').select('*').eq('user_id', userId).maybeSingle()
      return data
    },
    enabled: !!userId,
    staleTime: 60_000 * 5,
  })

  if (!streak && !compact) return null

  const current = streak?.current_streak || 0
  const longest = streak?.longest_streak || 0
  const nextMilestone = MILESTONES.find(m => m > current) || MILESTONES[MILESTONES.length - 1]
  const progress = Math.min((current / nextMilestone) * 100, 100)

  if (compact) return (
    <div className="flex items-center gap-1.5 text-xs">
      <motion.div
        animate={current > 0 ? { scale: [1, 1.2, 1] } : {}}
        transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 3 }}
      >
        <Flame size={13} className={current >= 7 ? 'text-[var(--md-error)] fill-[var(--md-error)]' : 'text-[var(--md-secondary)]'} />
      </motion.div>
      <span className={`font-bold font-mono ${current >= 7 ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'}`}>
        {current}d
      </span>
      <span className="text-[var(--md-on-surface-variant)]/70">streak</span>
    </div>
  )

  return (
    <div className="bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] rounded-2xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Flame size={16} className={current >= 7 ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'} />
            <span className="font-bold text-sm">Daily Streak</span>
          </div>
          <p className="text-xs text-[var(--md-on-surface-variant)]">Login and transact daily to keep your streak alive.</p>
        </div>
        {(streak?.freeze_tokens || 0) > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--md-primary)]">
            <Snowflake size={12} />
            <span>{streak.freeze_tokens} freeze token{streak.freeze_tokens !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Current streak display */}
      <div className="flex items-end gap-4 mb-5">
        <motion.div
          key={current}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex items-end gap-2"
        >
          <span className={`text-5xl font-black font-mono leading-none ${
            current >= 30 ? 'text-[var(--md-error)]' :
            current >= 14 ? 'text-[var(--md-secondary)]' :
            current >= 7  ? 'text-[var(--md-primary)]' : 'text-[var(--md-on-surface)]/70'
          }`}>{current}</span>
          <span className="text-lg text-[var(--md-on-surface-variant)] mb-1">day{current !== 1 ? 's' : ''}</span>
        </motion.div>
        {longest > current && (
          <div className="mb-1 text-xs text-[var(--md-on-surface-variant)]/70">
            Best: <span className="text-[var(--md-on-surface)]/70 font-mono">{longest}d</span>
          </div>
        )}
      </div>

      {/* Progress to next milestone */}
      <div className="mb-4">
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-[var(--md-on-surface-variant)]">Next milestone: {nextMilestone} days</span>
          <span className="text-[var(--md-on-surface-variant)]">{nextMilestone - current} more to go</span>
        </div>
        <div className="h-2 bg-[var(--md-surface-container-high)] rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              current >= 30 ? 'bg-[var(--md-error)]' :
              'bg-[var(--md-primary)]'
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Milestone badges */}
      <div className="flex gap-2">
        {MILESTONES.map(m => (
          <div
            key={m}
            className={`flex-1 py-2 rounded-xl text-center border transition-all ${
              current >= m
                ? 'bg-[var(--md-secondary)]/15 border-[var(--md-secondary)]/30 text-[var(--md-secondary)]'
                : 'bg-[var(--md-surface-container-high)] border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)]/50'
            }`}
          >
            {current >= m ? <Trophy size={12} className="mx-auto mb-0.5" /> : null}
            <div className="text-[10px] font-bold">{m}d</div>
          </div>
        ))}
      </div>

      {/* Milestone bonuses explainer */}
      <div className="mt-3 text-xs text-[var(--md-on-surface-variant)]/60 text-center">
        Reach 7d, 14d, 30d, 60d, 100d for PlugScore bonuses
      </div>
    </div>
  )
}
