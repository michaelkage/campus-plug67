import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { supabase, callEdgeFunction, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'
import { Gift, Copy, Check, Share2, Users, Zap, TrendingUp } from 'lucide-react'

/**
 * useReferral — hook that manages the referral system.
 * Handles reading the referral code from URL on signup.
 */
export function useReferral() {
  const { session, profile } = useAuth()
  const qc = useQueryClient()

  const { data: referralData } = useQuery({
    queryKey: ['referral-data', profile?.id],
    queryFn:  async () => {
      const [events, invitees] = await Promise.all([
        supabase.from('referral_events')
          .select('*, referee:referee_id(full_name, created_at)')
          .eq('referrer_id', profile.id)
          .order('created_at', { ascending: false }),
        supabase.from('profiles')
          .select('id, full_name, created_at')
          .eq('referred_by', profile.id)
          .order('created_at', { ascending: false })
          .limit(10),
      ])
      return {
        events:   events.data  || [],
        invitees: invitees.data || [],
        bonusEarned: (events.data || []).filter(e => e.bonus_awarded).length * 50,
      }
    },
    enabled: !!profile?.id,
    staleTime: 60_000,
  })

  const applyReferralCode = async (code: string) => {
    if (!session) return
    const { data, error } = await callEdgeFunction(
      'process-growth-events',
      { action: 'referral_signup', referral_code: code },
      session.access_token
    )
    if (error) toast.error(error)
    else {
      toast.success(`Referral applied! Referred by ${data?.referrer_name}`)
      qc.invalidateQueries({ queryKey: ['referral-data'] })
    }
    return { data, error }
  }

  const referralUrl = profile?.referral_code
    ? `${window.location.origin}/auth?ref=${profile.referral_code}`
    : null

  return { referralData, referralUrl, referralCode: profile?.referral_code, applyReferralCode }
}

/**
 * ReferralCard — shows a user's referral code, share link, and progress.
 * Placed in Profile page.
 */
export function ReferralCard({ profile }) {
  const { referralData, referralUrl, referralCode } = useReferral()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(referralUrl || referralCode || '')
    setCopied(true)
    toast.success('Referral link copied!')
    setTimeout(() => setCopied(false), 2500)
  }

  const share = async () => {
    if (navigator.share) {
      await navigator.share({
        title: 'Join me on Campus Plug ⚡',
        text:  `Use my referral code ${referralCode} to join Campus Plug — the student marketplace for your campus!`,
        url:   referralUrl,
      })
    } else copy()
  }

  return (
    <div className="bg-obsidian-400 border border-purple/20 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple/10 to-cyan/5 px-6 py-4 border-b border-obsidian-500">
        <div className="flex items-center gap-2 mb-1">
          <Gift size={16} className="text-purple" />
          <span className="font-bold text-sm">Referral Program</span>
        </div>
        <p className="text-xs text-white/40">
          Invite friends. They buy something. You get +50 PlugScore.
        </p>
      </div>

      <div className="p-6 space-y-5">
        {/* Code display */}
        <div>
          <div className="label">Your Referral Code</div>
          <div className="flex gap-2">
            <div className="flex-1 bg-obsidian-300 border border-obsidian-500 rounded-xl
                            flex items-center px-4 font-mono text-xl font-black text-cyan tracking-widest">
              {referralCode || '—'}
            </div>
            <button
              onClick={copy}
              className="p-3 bg-obsidian-300 border border-obsidian-500 rounded-xl
                         hover:border-cyan/30 transition-colors"
            >
              {copied ? <Check size={16} className="text-plug-green" /> : <Copy size={16} className="text-white/40" />}
            </button>
            <button
              onClick={share}
              className="p-3 bg-obsidian-300 border border-obsidian-500 rounded-xl
                         hover:border-cyan/30 transition-colors"
            >
              <Share2 size={16} className="text-white/40" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Invites Sent',      val: referralData?.invitees.length ?? 0,     icon: Users,      color: 'text-cyan'        },
            { label: 'Bonuses Earned',    val: referralData?.events.filter(e=>e.bonus_awarded).length ?? 0, icon: Gift, color: 'text-plug-green' },
            { label: 'Score Earned',      val: `+${referralData?.bonusEarned ?? 0}`,   icon: TrendingUp, color: 'text-plug-amber'  },
          ].map(({ label, val, icon: Icon, color }) => (
            <div key={label} className="bg-obsidian-300 rounded-xl p-3 text-center">
              <Icon size={14} className={`${color} mx-auto mb-1`} />
              <div className={`text-lg font-black font-mono ${color}`}>{val}</div>
              <div className="text-[10px] text-white/40 leading-tight">{label}</div>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="bg-obsidian-300 rounded-xl p-4 space-y-2">
          <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">How It Works</div>
          {[
            { step: '1', text: 'Share your code with a fellow student' },
            { step: '2', text: 'They sign up using your code' },
            { step: '3', text: 'They complete their first purchase' },
            { step: '4', text: 'You automatically get +50 PlugScore' },
          ].map(({ step, text }) => (
            <div key={step} className="flex items-center gap-3 text-xs">
              <div className="w-5 h-5 rounded-full bg-cyan/20 text-cyan font-bold
                              flex items-center justify-center text-[10px] flex-shrink-0">
                {step}
              </div>
              <span className="text-white/60">{text}</span>
            </div>
          ))}
        </div>

        {/* Recent invitees */}
        {(referralData?.invitees.length || 0) > 0 && (
          <div>
            <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-2">Recent Referrals</div>
            <div className="space-y-2">
              {referralData?.invitees.slice(0, 5).map(inv => {
                const event = referralData?.events.find(e => e.referee_id === inv.id)
                return (
                  <div key={inv.id} className="flex items-center justify-between text-sm
                                                bg-obsidian-300 rounded-xl px-3 py-2">
                    <span className="text-white/70">{inv.full_name}</span>
                    <span className={`text-xs font-bold ${event?.bonus_awarded ? 'text-plug-green' : 'text-white/30'}`}>
                      {event?.bonus_awarded ? '+50 PlugScore ✓' : 'Pending purchase'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * ReferralOnboarding — shown during signup if ?ref= param exists.
 */
export function ReferralApply() {
  const { applyReferralCode } = useReferral()
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('ref') || '')
  const [applying, setApplying] = useState(false)
  const [applied, setApplied]   = useState(false)

  const apply = async () => {
    if (!code.trim() || applied) return
    setApplying(true)
    const { error } = await applyReferralCode(code.trim().toUpperCase())
    if (!error) setApplied(true)
    setApplying(false)
  }

  if (applied) return (
    <div className="flex items-center gap-2 p-3 rounded-xl bg-plug-green/10 border border-plug-green/20 text-sm text-plug-green">
      <Check size={14} />
      Referral code applied successfully!
    </div>
  )

  return (
    <div>
      <div className="label">Referral Code (optional)</div>
      <div className="flex gap-2">
        <input className="input flex-1 font-mono uppercase tracking-widest" placeholder="e.g. AB3C2D1E"
          value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={8} />
        {code.length === 8 && (
          <button onClick={apply} disabled={applying}
            className="px-4 bg-plug-green/20 text-plug-green border border-plug-green/30 rounded-xl
                       text-sm font-bold hover:bg-plug-green/30 transition-colors disabled:opacity-50">
            {applying ? '...' : 'Apply'}
          </button>
        )}
      </div>
    </div>
  )
}
