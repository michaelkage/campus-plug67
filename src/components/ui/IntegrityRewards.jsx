import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Shield, Zap } from 'lucide-react'

export function IntegrityStreakCard({ profile }) {
  const { data } = useQuery({
    queryKey: ['integrity', profile?.id],
    queryFn: async () => {
      const { count } = await supabase.from('transactions').select('id', { count: 'exact', head: true })
        .eq('seller_id', profile.id).eq('status', 'released')
      return { clean: Math.min(count || 0, 5) }
    },
    enabled: !!profile?.id, staleTime: 300_000,
  })
  const has = profile?.badges?.includes('Integrity Streak')
  const pct = ((data?.clean || 0) / 5) * 100
  return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
      <div className="bg-gradient-to-r from-plug-green/10 to-cyan/5 px-5 py-4 border-b border-obsidian-500">
        <div className="flex items-center gap-2"><Shield size={14} className="text-plug-green"/><span className="font-bold text-sm">Integrity Streak</span>{has && <span className="ml-auto tag tag-green text-[9px]">🛡️ ACTIVE</span>}</div>
        <p className="text-xs text-white/40 mt-0.5">Complete 5 clean trades in a row with zero disputes.</p>
      </div>
      <div className="p-5">
        {!has ? (
          <>
            <div className="flex justify-between text-xs mb-2"><span className="text-white/50">Clean trades</span><span className="font-mono font-bold text-plug-green">{data?.clean || 0} / 5</span></div>
            <div className="h-2 bg-obsidian-300 rounded-full overflow-hidden mb-4">
              <motion.div className="h-full rounded-full bg-gradient-to-r from-plug-green to-cyan" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: 'easeOut' }}/>
            </div>
            <div className="space-y-2 text-xs text-white/50">
              <div>🛡️ Integrity Streak badge</div><div>+25 PlugScore bonus</div><div>1-hour top-of-feed boost</div>
            </div>
          </>
        ) : (
          <div className="text-center py-2"><div className="text-3xl mb-1">🛡️</div><div className="font-bold text-sm text-plug-green">Integrity Streak Active</div></div>
        )}
      </div>
    </div>
  )
}

export function PowerUserBadge({ badges }) {
  if (!badges?.includes('Power User')) return null
  return (
    <motion.div animate={{ opacity: [1, 0.7, 1] }} transition={{ duration: 3, repeat: Infinity }}
      className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border bg-purple/15 text-purple border-purple/30">
      <Zap size={10}/> Power User
    </motion.div>
  )
}

export function AchievementToast({ badge, description, reward, onDismiss }) {
  const [visible, setVisible] = useState(true)
  useState(() => { const t = setTimeout(() => { setVisible(false); setTimeout(onDismiss, 300) }, 4000); return () => clearTimeout(t) })
  const cfg = { 'Integrity Streak': { emoji: '🛡️', color: 'text-plug-green', border: 'border-plug-green/30' }, 'Power User': { emoji: '⚡', color: 'text-purple', border: 'border-purple/30' } }
  const c = cfg[badge] || { emoji: '🎖️', color: 'text-plug-amber', border: 'border-plug-amber/30' }
  return (
    <AnimatePresence>
      {visible && (
        <motion.div initial={{ opacity:0, y:40 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-20 }} onClick={() => { setVisible(false); setTimeout(onDismiss, 200) }}
          className={`fixed bottom-24 md:bottom-8 left-4 right-4 z-50 max-w-sm mx-auto border rounded-2xl overflow-hidden cursor-pointer ${c.border}`}>
          <div className="h-1 bg-gradient-to-r from-cyan to-purple"/>
          <div className="p-5 flex items-center gap-4 bg-obsidian-400">
            <motion.div animate={{ rotate: [0,-8,8,-4,4,0] }} transition={{ duration: 0.6, delay: 0.2 }} className="text-4xl flex-shrink-0">{c.emoji}</motion.div>
            <div className="flex-1"><div className={`font-black text-base ${c.color}`}>{badge} Unlocked!</div><div className="text-xs text-white/60 mt-0.5">{description}</div>{reward && <div className={`text-xs font-bold mt-1 ${c.color}`}>{reward}</div>}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function useGamifiedRewards() {
  const { user, profile, refreshProfile } = useAuth()
  const qc = useQueryClient()
  const [pending, setPending] = useState(null)

  const checkRewards = async () => {
    if (!user?.id || !profile) return
    const badges = profile.badges || []
    if (!badges.includes('Integrity Streak')) {
      const [{ count: clean }, { count: disputed }] = await Promise.all([
        supabase.from('transactions').select('id',{count:'exact',head:true}).eq('seller_id',user.id).eq('status','released'),
        supabase.from('transactions').select('id',{count:'exact',head:true}).eq('seller_id',user.id).eq('status','disputed').gte('created_at',new Date(Date.now()-30*86400000).toISOString()),
      ])
      if ((clean||0) >= 5 && (disputed||0) === 0) {
        await supabase.from('profiles').update({ badges: [...badges,'Integrity Streak'], plug_score: Math.min((profile.plug_score||500)+25,1000) }).eq('id',user.id)
        setPending({ badge:'Integrity Streak', description:'5 consecutive clean trades. No disputes.', reward:'+25 PlugScore applied' })
        await refreshProfile?.()
        qc.invalidateQueries({ queryKey: ['profile',user.id] })
      }
    }
    if (!badges.includes('Power User') && (profile.total_sales||0) >= 20 && (profile.plug_score||0) >= 700) {
      await supabase.from('profiles').update({ badges: [...badges,'Power User'] }).eq('id',user.id)
      if (!pending) setPending({ badge:'Power User', description:'20+ trades, clean record, PlugScore ≥700.', reward:'Power User badge unlocked' })
      await refreshProfile?.()
    }
  }

  return { checkRewards, pendingAchievement: pending, clearAchievement: () => setPending(null) }
}
