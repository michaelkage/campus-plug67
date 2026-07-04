import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Trophy, TrendingUp, Star, Zap } from 'lucide-react'

const BADGE_CONFIG = {
  'Hall of Fame':  { emoji: '🏛️', color: 'amber' },
  'Top Seller':    { emoji: '🏆', color: 'amber' },
  'Rising Star':   { emoji: '🌟', color: 'cyan'  },
  'Mentor Badge':  { emoji: '📚', color: 'purple' },
  'Plug Dev':      { emoji: '⚡', color: 'cyan'  },
  'Community Hero':{ emoji: '🦸', color: 'green'  },
}

function Badge({ name }) {
  const cfg = BADGE_CONFIG[name] || { emoji: '🎖️', color: 'white' }
  return (
    <span className={`tag text-[10px] ${
      cfg.color === 'amber'  ? 'tag-amber'  :
      cfg.color === 'cyan'   ? 'tag-cyan'   :
      cfg.color === 'purple' ? 'tag-purple' :
      cfg.color === 'green'  ? 'tag-green'  :
      'bg-obsidian-300 text-white/50 border-obsidian-500'
    }`}>
      {cfg.emoji} {name}
    </span>
  )
}

function RankMedal({ rank }) {
  if (rank === 1) return <span className="text-plug-amber text-xl font-black font-mono">1</span>
  if (rank === 2) return <span className="text-white/60 text-xl font-black font-mono">2</span>
  if (rank === 3) return <span className="text-[#CD7F32] text-xl font-black font-mono">3</span>
  return <span className="text-white/30 text-xl font-black font-mono">{rank}</span>
}

export default function Leaderboard() {
  const { profile: myProfile } = useAuth()

  const { data: leaders = [], isLoading } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, university, plug_score, total_sales, total_earnings, badges, avatar_url')
        .order('plug_score', { ascending: false })
        .limit(50)
      if (error) throw error
      return data || []
    },
    staleTime: 60_000,
  })

  // Stats
  const { data: monthStar } = useQuery({
    queryKey: ['student-of-month'],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, university, total_sales, plug_score, badges, avatar_url')
        .order('total_sales', { ascending: false })
        .limit(1)
        .single()
      return data
    },
  })

  // My rank
  const myRank = leaders.findIndex(l => l.id === myProfile?.id) + 1

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <p className="section-label">Community</p>
        <h1 className="text-2xl font-black tracking-tight">Campus Leaderboard</h1>
        <p className="text-sm text-white/40 mt-1">Ranked by PlugScore — updated in real-time</p>
      </div>

      {/* Student of the Month */}
      {monthStar && (
        <div className="relative overflow-hidden rounded-2xl border border-plug-amber/30
                        bg-gradient-to-br from-plug-amber/5 to-plug-amber/0 p-6 mb-8">
          <div className="absolute top-0 right-0 w-48 h-48 rounded-full
                          bg-plug-amber/5 blur-3xl pointer-events-none" />
          <div className="flex items-center gap-2 mb-4">
            <Trophy size={16} className="text-plug-amber" />
            <span className="text-xs font-bold text-plug-amber uppercase tracking-wider">
              Student of the Month
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-plug-amber to-plug-red
                            flex items-center justify-center text-obsidian font-black text-2xl flex-shrink-0">
              {monthStar.avatar_url ? (
                <img src={monthStar.avatar_url} className="w-full h-full rounded-full object-cover" />
              ) : (
                monthStar.full_name?.[0]?.toUpperCase()
              )}
            </div>
            <div>
              <div className="text-xl font-black">{monthStar.full_name}</div>
              <div className="text-sm text-white/50">{monthStar.university}</div>
              <div className="flex gap-2 mt-2 flex-wrap">
                {monthStar.badges?.slice(0, 3).map(b => <Badge key={b} name={b} />)}
              </div>
            </div>
            <div className="ml-auto text-right hidden sm:block">
              <div className="text-2xl font-black text-plug-amber font-mono">{monthStar.plug_score}</div>
              <div className="text-xs text-white/40">PlugScore</div>
              <div className="text-sm font-bold mt-1">{monthStar.total_sales} sales</div>
            </div>
          </div>
          <div className="mt-4 text-xs text-white/30">
            🏅 Prize: ₦2,400 Campus Voucher + Verified Badge + Campus Screen Feature
          </div>
        </div>
      )}

      {/* My rank card (if not in top 10) */}
      {myRank > 10 && myProfile && (
        <div className="bg-cyan/5 border border-cyan/20 rounded-xl p-4 mb-6 flex items-center gap-4">
          <div className="text-sm text-white/50">Your rank</div>
          <div className="text-2xl font-black text-cyan font-mono">#{myRank}</div>
          <div className="text-sm text-white/50">PlugScore: <span className="text-cyan font-mono">{myProfile.plug_score}</span></div>
          <div className="ml-auto text-xs text-white/30">Keep selling to climb! 🚀</div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {[
          { label: '⚡ PlugScore',  key: 'plug_score'     },
          { label: '💰 Top Earners', key: 'total_earnings' },
          { label: '📦 Top Sellers', key: 'total_sales'   },
        ].map(({ label }) => (
          <button key={label} className="px-4 py-1.5 rounded-full text-sm font-semibold
                                         bg-obsidian-400 border border-obsidian-500
                                         text-white/50 hover:border-cyan/30 hover:text-white/80 transition-all">
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4 border-b border-obsidian-500 animate-pulse last:border-0">
              <div className="w-6 h-6 bg-obsidian-300 rounded" />
              <div className="w-10 h-10 rounded-full bg-obsidian-300" />
              <div className="flex-1 space-y-1">
                <div className="h-4 bg-obsidian-300 rounded w-1/3" />
                <div className="h-3 bg-obsidian-300 rounded w-1/4" />
              </div>
            </div>
          ))
        ) : (
          leaders.map((leader, i) => {
            const rank = i + 1
            const isMe = leader.id === myProfile?.id
            return (
              <Link
                key={leader.id}
                to={`/profile/${leader.id}`}
                className={`flex items-center gap-4 p-4 border-b border-obsidian-500 last:border-0
                             transition-colors hover:bg-obsidian-300/50 ${
                  isMe ? 'bg-cyan/5 border-l-2 border-l-cyan' : ''
                }`}
              >
                <div className="w-8 text-center flex-shrink-0">
                  {rank <= 3 ? (
                    <span className="text-lg">
                      {rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'}
                    </span>
                  ) : (
                    <RankMedal rank={rank} />
                  )}
                </div>

                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan to-purple
                                flex items-center justify-center text-obsidian font-bold text-sm flex-shrink-0">
                  {leader.avatar_url ? (
                    <img src={leader.avatar_url} className="w-full h-full rounded-full object-cover" />
                  ) : (
                    leader.full_name?.[0]?.toUpperCase() || '?'
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm truncate">
                      {leader.full_name}
                      {isMe && <span className="text-cyan text-xs ml-1">(you)</span>}
                    </span>
                    {leader.badges?.slice(0, 2).map(b => (
                      <Badge key={b} name={b} />
                    ))}
                  </div>
                  <div className="text-xs text-white/30 mt-0.5 truncate">
                    {leader.university} · {leader.total_sales} sales
                  </div>
                </div>

                <div className="text-right flex-shrink-0">
                  <div className="font-black font-mono text-cyan text-base">
                    {leader.plug_score?.toLocaleString()}
                  </div>
                  <div className="text-xs text-white/30">pts</div>
                </div>
              </Link>
            )
          })
        )}
      </div>

      {/* Scoring guide */}
      <div className="mt-8 bg-obsidian-400 border border-obsidian-500 rounded-xl p-5">
        <h3 className="font-bold text-sm mb-4">How PlugScore Works</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { action: 'Complete a sale',    pts: '+50', icon: '💰' },
            { action: 'Get a 5★ review',   pts: '+25', icon: '⭐' },
            { action: 'Help in Lost & Found', pts: '+20', icon: '🔍' },
            { action: 'Campus Rep action', pts: '+10', icon: '🎖️' },
          ].map(({ action, pts, icon }) => (
            <div key={action} className="text-center">
              <div className="text-2xl mb-1">{icon}</div>
              <div className="text-plug-green font-black font-mono text-sm">{pts}</div>
              <div className="text-xs text-white/40 mt-0.5">{action}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
