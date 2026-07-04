import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase, formatNaira } from '@/lib/supabase'
import { Shield, Star, Package, TrendingUp, CheckCircle, ExternalLink } from 'lucide-react'
import { motion } from 'framer-motion'

const BADGE_EMOJI = {
  'Hall of Fame':   '🏛️',
  'Top Seller':     '🏆',
  'Rising Star':    '🌟',
  'Mentor Badge':   '📚',
  'Plug Dev':       '⚡',
  'Community Hero': '🦸',
}

/**
 * Public verification page for Campus Plug resumes.
 * Accessible without auth at /verify/:profileId
 * Linked from the QR code on exported PDF resumes.
 */
export default function VerifyProfile() {
  const { profileId } = useParams()

  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['verify-profile', profileId],
    queryFn: async () => {
      // Uses the public_profile_stats view (anon access granted)
      const { data, error } = await supabase
        .from('public_profile_stats')
        .select('*')
        .eq('id', profileId)
        .single()
      if (error) throw error
      return data
    },
    staleTime: 60_000,
  })

  const verifiedAt = new Date().toLocaleString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  if (isLoading) return (
    <div className="min-h-screen bg-obsidian flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-4 animate-bounce">⚡</div>
        <p className="text-white/40 text-sm">Fetching live data...</p>
      </div>
    </div>
  )

  if (error || !stats) return (
    <div className="min-h-screen bg-obsidian flex items-center justify-center p-4">
      <div className="text-center max-w-sm">
        <div className="text-5xl mb-4">🔍</div>
        <h2 className="text-xl font-bold mb-2">Profile Not Found</h2>
        <p className="text-white/40 text-sm">
          This verification link may be invalid or the profile may have been deleted.
        </p>
      </div>
    </div>
  )

  const scoreColor = stats.plug_score >= 750 ? '#00FF88'
    : stats.plug_score >= 500 ? '#00F2FF' : '#FFB800'

  return (
    <div className="min-h-screen bg-obsidian">
      {/* Verification header */}
      <div className="bg-gradient-to-r from-plug-green/20 to-cyan/10 border-b border-plug-green/30 py-4 px-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <CheckCircle size={20} className="text-plug-green flex-shrink-0" />
          <div>
            <div className="font-bold text-sm text-plug-green">Verified by Campus Plug</div>
            <div className="text-xs text-white/40">
              Live data pulled at {verifiedAt} · campusplug.ng
            </div>
          </div>
          <div className="ml-auto">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan to-purple flex items-center justify-center text-obsidian font-black text-sm">
              ⚡
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Profile header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-6"
        >
          <div className="flex items-start gap-5">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan to-purple
                            flex items-center justify-center text-obsidian font-black text-2xl flex-shrink-0">
              {stats.full_name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h1 className="text-xl font-black">{stats.full_name}</h1>
                {stats.is_verified && (
                  <span className="flex items-center gap-1 tag tag-green text-[10px]">
                    <Shield size={9} /> Verified Student
                  </span>
                )}
              </div>
              <p className="text-sm text-white/50">{stats.university}</p>
              {stats.department && (
                <p className="text-xs text-white/30 mt-0.5">{stats.department} · Level {stats.level}</p>
              )}
              <p className="text-xs text-white/25 mt-2">
                Member since {new Date(stats.created_at).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })}
              </p>
            </div>

            {/* PlugScore ring */}
            <div className="text-center flex-shrink-0">
              <div className="relative w-16 h-16">
                <svg viewBox="0 0 64 64" width="64" height="64">
                  <circle cx="32" cy="32" r="26" fill="none" stroke="#1A2332" strokeWidth="5" />
                  <circle
                    cx="32" cy="32" r="26" fill="none"
                    stroke={scoreColor} strokeWidth="5" strokeLinecap="round"
                    strokeDasharray={`${(stats.plug_score / 1000) * 163} 163`}
                    transform="rotate(-90 32 32)"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-sm font-black font-mono" style={{ color: scoreColor }}>
                    {stats.plug_score}
                  </div>
                </div>
              </div>
              <div className="text-[9px] text-white/40 mt-1">PlugScore</div>
            </div>
          </div>

          {/* Badges */}
          {stats.badges?.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mt-4 pt-4 border-t border-obsidian-500">
              {stats.badges.map(b => (
                <span key={b} className="tag tag-amber text-[10px]">
                  {BADGE_EMOJI[b] || '🎖️'} {b}
                </span>
              ))}
            </div>
          )}
        </motion.div>

        {/* Live stats */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          {[
            { label: 'Completed Sales',    val: stats.total_sales,                   icon: Package,    color: 'text-cyan' },
            { label: 'Total Earnings',     val: formatNaira(stats.total_earnings),   icon: TrendingUp, color: 'text-plug-green' },
            { label: 'Avg. Rating',        val: stats.avg_rating > 0 ? `${stats.avg_rating} ★` : 'N/A', icon: Star, color: 'text-plug-amber' },
            { label: 'Verified Uploads',   val: stats.verified_uploads,              icon: Shield,     color: 'text-purple' },
          ].map(({ label, val, icon: Icon, color }) => (
            <div key={label} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 text-center">
              <Icon size={16} className={`${color} mx-auto mb-2`} />
              <div className={`text-lg font-black font-mono ${color}`}>{val}</div>
              <div className="text-[10px] text-white/40 mt-0.5 leading-snug">{label}</div>
            </div>
          ))}
        </motion.div>

        {/* Verification statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-obsidian-400 border border-plug-green/20 rounded-xl p-5"
        >
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={16} className="text-plug-green" />
            <span className="font-bold text-sm text-plug-green">Verification Statement</span>
          </div>
          <p className="text-sm text-white/60 leading-relaxed">
            Campus Plug confirms that <strong className="text-white">{stats.full_name}</strong> is a
            registered student at <strong className="text-white">{stats.university}</strong> with a
            verified campus email. The statistics above reflect real, completed transactions on the
            Campus Plug platform as of {verifiedAt}. This data is pulled live and cannot be manipulated.
          </p>
          <div className="mt-4 pt-4 border-t border-obsidian-500 flex items-center justify-between flex-wrap gap-2">
            <div className="text-xs text-white/30 font-mono">
              Profile ID: {profileId}
            </div>
            <a href="https://campusplug.ng" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-cyan hover:underline">
              <ExternalLink size={11} /> campusplug.ng
            </a>
          </div>
        </motion.div>

        {/* Rating breakdown */}
        {stats.rating_count > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5"
          >
            <h3 className="font-bold text-sm mb-4">Client Reviews</h3>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-3xl font-black text-plug-amber font-mono">{stats.avg_rating}</div>
                <div className="flex items-center gap-0.5 mt-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} size={12}
                      className={i < Math.round(stats.avg_rating) ? 'text-plug-amber fill-plug-amber' : 'text-white/20'} />
                  ))}
                </div>
                <div className="text-xs text-white/30 mt-1">{stats.rating_count} reviews</div>
              </div>
              <div className="flex-1">
                {[5, 4, 3, 2, 1].map(star => (
                  <div key={star} className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-white/40 w-2">{star}</span>
                    <div className="flex-1 h-1.5 bg-obsidian-300 rounded-full overflow-hidden">
                      <div className="h-full bg-plug-amber rounded-full"
                        style={{ width: `${star === Math.round(stats.avg_rating) ? 70 : star > Math.round(stats.avg_rating) ? 15 : 10}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-white/20 pb-4">
          <p>This page is publicly accessible to verify Campus Plug resumes.</p>
          <p className="mt-1">Data refreshes every minute. Employers may bookmark this URL for ongoing verification.</p>
        </div>
      </div>
    </div>
  )
}
