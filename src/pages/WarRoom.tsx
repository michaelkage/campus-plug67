/**
 * Campus Plug — Admin War Room (/admin/war-room)
 *
 * Decoupled admin module. Architecturally isolated:
 *   - Distinct RLS: only profiles with 'Plug Dev' badge can read/write global_config
 *   - Own route, own data fetching — zero coupling to user-facing pages
 *   - Can be extracted as a standalone app by changing the Supabase project ref
 *
 * Features:
 *   - Progress bars: current_value → threshold_value per feature
 *   - Glowing "Approve Cloak Release" button when criteria_met = true
 *   - Real-time: global_config changes broadcast to all clients via Supabase Realtime
 *   - Mode display: AUTO / MANUAL / HYBRID
 *   - Manual override: force-enable any feature regardless of threshold
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  Shield, Zap, Eye, EyeOff, CheckCircle2,
  Lock, Unlock, RefreshCw, ArrowLeft, Settings
} from 'lucide-react'
import toast from 'react-hot-toast'

const MODE_COLORS = {
  AUTO:   'text-plug-green  bg-plug-green/10  border-plug-green/25',
  MANUAL: 'text-plug-amber  bg-plug-amber/10  border-plug-amber/25',
  HYBRID: 'text-cyan        bg-cyan/10        border-cyan/25',
}

function FeatureRow({ feature, onToggle, onForceEnable }) {
  const pct = feature.threshold_value > 0
    ? Math.min(100, Math.round((feature.current_value / feature.threshold_value) * 100))
    : 100

  const canApprove = feature.criteria_met && !feature.is_enabled && feature.mode !== 'AUTO'
  const isAuto     = feature.mode === 'AUTO'

  return (
    <motion.div
      layout
      animate={canApprove ? {
        boxShadow: ['0 0 0 0 rgba(255,184,0,0)', '0 0 20px 2px rgba(255,184,0,0.15)', '0 0 0 0 rgba(255,184,0,0)'],
      } : { boxShadow: '0 0 0 0 rgba(0,0,0,0)' }}
      transition={{ duration: 2.5, repeat: canApprove ? Infinity : 0 }}
      className={`border rounded-2xl overflow-hidden transition-all ${
        feature.is_enabled
          ? 'border-plug-green/25 bg-plug-green/3'
          : canApprove
          ? 'border-plug-amber/40 bg-plug-amber/4'
          : 'border-obsidian-500 bg-obsidian-400'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4">
        <div className={`text-2xl w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
          feature.is_enabled ? 'bg-plug-green/15' : 'bg-obsidian-300'
        }`}>
          {feature.icon || '⚡'}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="font-bold text-sm">{feature.label || feature.key}</span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${MODE_COLORS[feature.mode] || MODE_COLORS.HYBRID}`}>
              {feature.mode}
            </span>
            {feature.is_enabled && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-plug-green/30 bg-plug-green/10 text-plug-green">
                ✓ LIVE
              </span>
            )}
          </div>
          <p className="text-xs text-white/40 truncate">{feature.description}</p>
        </div>

        {/* Toggle */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {!isAuto && (
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => onToggle(feature.key, !feature.is_enabled)}
              className={`w-11 h-6 rounded-full relative transition-colors ${
                feature.is_enabled ? 'bg-plug-green' : 'bg-obsidian-300'
              }`}
            >
              <motion.div
                animate={{ x: feature.is_enabled ? 19 : 2 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm"
              />
            </motion.button>
          )}
          {isAuto && (
            <div className="flex items-center gap-1 text-[10px] text-plug-green font-semibold">
              <Zap size={10} /> Auto
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {feature.threshold_value > 0 && (
        <div className="px-5 pb-4">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-white/40">
              {feature.current_value.toLocaleString()} / {feature.threshold_value.toLocaleString()} {feature.key === 'trending_engine' ? 'transactions' : 'events'}
            </span>
            <span className={`font-mono font-bold ${
              pct >= 100 ? 'text-plug-green' : pct >= 60 ? 'text-plug-amber' : 'text-white/40'
            }`}>{pct}%</span>
          </div>
          <div className="h-2 bg-obsidian-300 rounded-full overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${
                pct >= 100 ? 'bg-plug-green' :
                pct >= 60  ? 'bg-plug-amber' : 'bg-cyan'
              }`}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </div>
      )}

      {/* Approve button */}
      <AnimatePresence>
        {canApprove && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 pt-1 border-t border-plug-amber/20">
              <div className="flex items-center gap-3">
                <div className="text-xs text-plug-amber flex-1">
                  ✅ Threshold reached — awaiting manual approval to go live.
                </div>
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => onForceEnable(feature.key)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs bg-plug-amber text-obsidian flex-shrink-0"
                >
                  <Unlock size={12} />
                  Approve Cloak Release
                </motion.button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default function WarRoom() {
  const { profile, user } = useAuth()
  const navigate          = useNavigate()
  const qc                = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  // Guard: admin only
  const isAdmin = profile?.badges?.includes('Plug Dev') || profile?.badges?.includes('Community Hero')

  useEffect(() => {
    if (profile && !isAdmin) navigate('/', { replace: true })
  }, [profile, isAdmin, navigate])

  // Load global_config
  const { data: features = [], isLoading } = useQuery({
    queryKey: ['global-config'],
    queryFn:  async () => {
      const { data, error } = await supabase
        .from('global_config')
        .select('*')
        .order('key')
      if (error) throw error
      return data || []
    },
    staleTime: 30_000,
  })

  // Real-time updates — when admin on another device approves, this syncs instantly
  useEffect(() => {
    const ch = supabase.channel('war-room-config')
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table:  'global_config',
      }, () => {
        qc.invalidateQueries({ queryKey: ['global-config'] })
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [qc])

  const handleToggle = async (key: string, newValue: boolean) => {
    const { error } = await supabase
      .from('global_config')
      .update({ is_enabled: newValue, updated_by: user?.id })
      .eq('key', key)

    if (error) { toast.error(error.message); return }

    qc.invalidateQueries({ queryKey: ['global-config'] })
    toast.success(newValue ? `✅ ${key} is now LIVE` : `🔒 ${key} cloaked`)
  }

  const handleForceEnable = async (key: string) => {
    await handleToggle(key, true)
  }

  const handleRefreshCounters = async () => {
    setRefreshing(true)
    // Recount transactions for trending threshold
    const { count: txCount } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'released')

    await supabase
      .from('global_config')
      .update({ current_value: txCount || 0 })
      .eq('key', 'trending_engine')

    // Recount chats for trust_signals
    const { count: chatCount } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('is_system_msg', false)

    await supabase
      .from('global_config')
      .update({ current_value: Math.floor((chatCount || 0) / 3) })
      .eq('key', 'trust_signals')

    qc.invalidateQueries({ queryKey: ['global-config'] })
    setRefreshing(false)
    toast.success('Counters refreshed')
  }

  const liveCount    = features.filter(f => f.is_enabled).length
  const readyCount   = features.filter(f => f.criteria_met && !f.is_enabled).length
  const pendingCount = features.filter(f => !f.criteria_met).length

  if (!isAdmin) return null

  return (
    <div className="min-h-screen bg-obsidian">
      {/* Header */}
      <div className="border-b border-obsidian-500 bg-obsidian-400 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-4">
          <button onClick={() => navigate('/')}
            className="text-white/40 hover:text-white transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-cyan" />
            <h1 className="font-black text-sm tracking-tight">
              Campus Plug <span className="text-plug-amber">War Room</span>
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleRefreshCounters}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors disabled:opacity-30"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              Refresh counters
            </motion.button>
            <div className="text-[10px] text-white/25 font-mono">
              Admin · {profile?.full_name?.split(' ')[0]}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Features Live',    val: liveCount,    color: 'text-plug-green', icon: '✅' },
            { label: 'Ready to Approve', val: readyCount,   color: 'text-plug-amber', icon: '🔓' },
            { label: 'Still Building',   val: pendingCount, color: 'text-white/40',   icon: '⏳' },
          ].map(({ label, val, color, icon }) => (
            <div key={label} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 text-center">
              <div className="text-xl mb-1">{icon}</div>
              <div className={`text-2xl font-black font-mono ${color}`}>{val}</div>
              <div className="text-[10px] text-white/40 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* Mode legend */}
        <div className="flex items-center gap-4 flex-wrap text-xs">
          <span className="text-white/30 font-bold uppercase tracking-wider text-[10px]">Mode:</span>
          {Object.entries(MODE_COLORS).map(([mode, cls]) => (
            <div key={mode} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-bold ${cls}`}>
              {mode === 'AUTO' && <Zap size={10} />}
              {mode === 'MANUAL' && <Settings size={10} />}
              {mode === 'HYBRID' && <Shield size={10} />}
              {mode}
              {mode === 'AUTO'   && ' — self-enables at threshold'}
              {mode === 'MANUAL' && ' — admin must approve'}
              {mode === 'HYBRID' && ' — criteria met → admin approves'}
            </div>
          ))}
        </div>

        {/* Feature list */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-24 bg-obsidian-400 border border-obsidian-500 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Live features first */}
            {features.filter(f => f.is_enabled).length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-plug-green uppercase tracking-widest mb-2 flex items-center gap-2">
                  <div className="plug-dot scale-75" /> Live
                </div>
                {features.filter(f => f.is_enabled).map(f => (
                  <FeatureRow key={f.key} feature={f} onToggle={handleToggle} onForceEnable={handleForceEnable} />
                ))}
              </div>
            )}

            {/* Ready to approve */}
            {features.filter(f => f.criteria_met && !f.is_enabled).length > 0 && (
              <div className="mt-4">
                <div className="text-[10px] font-bold text-plug-amber uppercase tracking-widest mb-2 flex items-center gap-2">
                  🔓 Ready to Approve
                </div>
                {features.filter(f => f.criteria_met && !f.is_enabled).map(f => (
                  <FeatureRow key={f.key} feature={f} onToggle={handleToggle} onForceEnable={handleForceEnable} />
                ))}
              </div>
            )}

            {/* Still building */}
            {features.filter(f => !f.criteria_met && !f.is_enabled).length > 0 && (
              <div className="mt-4">
                <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">
                  ⏳ Building Toward Threshold
                </div>
                {features.filter(f => !f.criteria_met && !f.is_enabled).map(f => (
                  <FeatureRow key={f.key} feature={f} onToggle={handleToggle} onForceEnable={handleForceEnable} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer note */}
        <div className="text-center text-xs text-white/20 pb-4">
          <p>War Room changes broadcast to all clients in real-time via Supabase Realtime.</p>
          <p className="mt-1">Server is truth — clients only read <code className="text-white/30">is_enabled</code> from this table.</p>
        </div>
      </div>
    </div>
  )
}
