import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { supabase, formatNaira, timeAgo } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import { useStreak } from '@/components/ui/StreakWidget'
import { CampusTicker } from '@/components/ui/DemandEngine'
import { TierBadge } from '@/components/ui/TierSystem'
import { StreakWidget } from '@/components/ui/StreakWidget'
import { TrendingUp, Package, Zap, Flame, ArrowRight } from 'lucide-react'

export default function Home() {
  const { profile, user } = useAuth()
  const [feedItems, setFeedItems] = useState([])

  // Trigger daily streak on home load
  useStreak()

  // Activity feed
  const { data: initialFeed } = useQuery({
    queryKey: ['activity-feed'],
    queryFn: async () => {
      const { data } = await supabase
        .from('activity_feed').select('*')
        .order('created_at', { ascending: false }).limit(20)
      return data || []
    },
  })
  useEffect(() => { if (initialFeed) setFeedItems(initialFeed) }, [initialFeed])
  useRealtimeTable({ table: 'activity_feed', onInsert: (item) => setFeedItems(p => [item, ...p].slice(0, 30)) })

  // Stats
  const { data: stats } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: async () => {
      const [l, t, tr] = await Promise.all([
        supabase.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('status', 'released'),
        supabase.from('trending_listings').select('listing_id', { count: 'exact', head: true }),
      ])
      return { activeListings: l.count || 0, completedDeals: t.count || 0, trendingCount: tr.count || 0 }
    },
    staleTime: 60_000,
  })

  // Recent listings
  const { data: recentListings } = useQuery({
    queryKey: ['recent-listings'],
    queryFn: async () => {
      const { data } = await supabase
        .from('listings').select('*, profiles(full_name, tier)')
        .eq('status', 'active').order('created_at', { ascending: false }).limit(4)
      return data || []
    },
  })

  // Trending
  const { data: trendingListings } = useQuery({
    queryKey: ['trending-home'],
    queryFn: async () => {
      const { data } = await supabase
        .from('trending_listings')
        .select('listing_id, views_1h, score, listings(id, title, price, images, category, profiles(full_name, tier))')
        .order('score', { ascending: false }).limit(3)
      return data || []
    },
    staleTime: 120_000,
  })

  const colorMap = { cyan:'text-cyan bg-cyan/10', green:'text-plug-green bg-plug-green/10', purple:'text-purple bg-purple/10', amber:'text-plug-amber bg-plug-amber/10' }
  const statCards = [
    { label:'PlugScore',      val:profile?.plug_score ?? '—', color:'cyan',   Icon:Zap         },
    { label:'Your Sales',     val:profile?.total_sales ?? 0,  color:'green',  Icon:TrendingUp  },
    { label:'Active Listings',val:stats?.activeListings ?? '—', color:'purple',Icon:Package    },
    { label:'🔥 Trending',   val:stats?.trendingCount ?? '—', color:'amber',  Icon:Flame       },
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">

      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-obsidian-400 border border-obsidian-500 p-7">
        <div className="cyber-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_top_left,black,transparent)]" />
        <div className="absolute top-0 left-0 w-72 h-72 rounded-full bg-cyan/5 blur-3xl pointer-events-none -translate-x-1/3 -translate-y-1/3" />
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <p className="section-label">Welcome back</p>
            {profile?.tier && <TierBadge tier={profile.tier} size="xs" />}
          </div>
          <h1 className="text-3xl font-black tracking-tight mb-2">
            Hey, {profile?.full_name?.split(' ')[0] || 'Student'} 👋
          </h1>
          <p className="text-white/50 text-sm max-w-md">
            {stats?.activeListings || '—'} active listings at {profile?.university || 'your campus'}.
            {stats?.trendingCount ? ` ${stats.trendingCount} items trending right now.` : ''}
          </p>
          <div className="flex flex-wrap gap-3 mt-5">
            <Link to="/marketplace" className="btn-primary text-sm py-2 px-5">Browse Market</Link>
            <Link to="/marketplace?action=create" className="btn-secondary text-sm py-2 px-5">List an Item</Link>
          </div>
        </div>
      </div>

      {/* Campus Ticker */}
      {profile?.university && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="plug-dot" />
            <span className="text-xs text-plug-green font-bold uppercase tracking-wider">Live on Campus</span>
          </div>
          <CampusTicker university={profile.university} />
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map(({ label, val, color, Icon }) => (
          <div key={label} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-5">
            <div className={`w-8 h-8 rounded-lg mb-3 flex items-center justify-center ${colorMap[color]}`}>
              <Icon size={15} />
            </div>
            <div className={`text-2xl font-black font-mono ${colorMap[color].split(' ')[0]}`}>{val}</div>
            <div className="text-xs text-white/40 mt-1 uppercase tracking-wide font-medium">{label}</div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid md:grid-cols-5 gap-6">
        {/* Activity feed */}
        <div className="md:col-span-2 bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-obsidian-500">
            <h2 className="font-bold text-sm">Live Activity</h2>
            <div className="flex items-center gap-1.5">
              <div className="plug-dot" />
              <span className="text-xs text-plug-green font-semibold">Live</span>
            </div>
          </div>
          <div className="divide-y divide-obsidian-500 max-h-96 overflow-y-auto">
            {feedItems.length === 0 && (
              <div className="p-6 text-center text-white/30 text-sm">No activity yet!</div>
            )}
            {feedItems.map(item => (
              <motion.div key={item.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
                className="flex gap-3 p-4 hover:bg-obsidian-300/50 transition-colors">
                <div className="w-8 h-8 rounded-full bg-obsidian-300 flex items-center justify-center text-base flex-shrink-0">
                  {item.emoji || '⚡'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/80 leading-snug">
                    <span className="font-semibold text-white">{item.actor_name}</span>
                    {' '}{item.action}
                    {item.subject && <span className="text-cyan"> "{item.subject}"</span>}
                    {item.amount != null && <span className="text-plug-green font-mono font-bold ml-1">{formatNaira(item.amount)}</span>}
                  </p>
                  <p className="text-xs text-white/25 mt-0.5">{timeAgo(item.created_at)}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Listings + Trending */}
        <div className="md:col-span-3 space-y-5">
          {/* Trending */}
          {(trendingListings?.length || 0) > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Flame size={14} className="text-plug-red" />
                  <h2 className="font-bold text-sm">Trending Now</h2>
                </div>
                <Link to="/marketplace" className="text-xs text-cyan hover:underline flex items-center gap-1">
                  View all <ArrowRight size={10} />
                </Link>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {trendingListings?.map(t => {
                  const l = t.listings
                  if (!l) return null
                  return (
                    <Link key={t.listing_id} to={`/marketplace/${l.id}`}
                      className="bg-obsidian-400 border border-plug-red/20 rounded-xl overflow-hidden hover:border-plug-red/40 transition-all group">
                      <div className="aspect-square bg-obsidian-300 overflow-hidden relative">
                        {l.images?.[0]
                          ? <img src={l.images[0]} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                          : <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>}
                        <div className="absolute top-1.5 left-1.5">
                          <div className="flex items-center gap-0.5 bg-plug-red/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full">
                            <Flame size={7} /> {t.views_1h}
                          </div>
                        </div>
                      </div>
                      <div className="p-2.5">
                        <div className="text-xs font-semibold truncate">{l.title}</div>
                        <div className="text-xs font-black text-cyan font-mono mt-0.5">{formatNaira(l.price)}</div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )}

          {/* Fresh listings */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-sm">Fresh Listings</h2>
              <Link to="/marketplace" className="text-xs text-cyan hover:underline">View all →</Link>
            </div>
            {recentListings?.map(listing => (
              <Link key={listing.id} to={`/marketplace/${listing.id}`}
                className="flex gap-4 p-4 bg-obsidian-400 border border-obsidian-500 rounded-xl mb-3
                           hover:border-cyan/30 transition-all group">
                {listing.images?.[0]
                  ? <img src={listing.images[0]} className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
                  : <div className="w-14 h-14 rounded-lg bg-obsidian-300 flex items-center justify-center text-2xl flex-shrink-0">📦</div>}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-sm truncate group-hover:text-cyan transition-colors">{listing.title}</h3>
                    <span className="font-mono font-bold text-cyan text-sm flex-shrink-0">{formatNaira(listing.price)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="tag tag-cyan text-[10px]">{listing.category}</span>
                    {listing.profiles?.tier && listing.profiles.tier !== 'citizen' && (
                      <TierBadge tier={listing.profiles.tier} size="xs" />
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-1">{timeAgo(listing.created_at)}</p>
                </div>
              </Link>
            ))}
          </div>

          {/* Streak */}
          {user?.id && <StreakWidget userId={user.id} />}
        </div>
      </div>
    </div>
  )
}
