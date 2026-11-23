import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowDownToLine, ArrowRight, Bell, CalendarDays, CheckCircle2,
  ClipboardList, Flame, GraduationCap, MessageCircle, Package, Plus,
  ShieldCheck, ShoppingBag, Sparkles, TrendingUp, WalletCards, Zap,
} from 'lucide-react'
import { supabase, formatNaira, timeAgo } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import { useStreak } from '@/components/ui/StreakWidget'
import { CampusTicker } from '@/components/ui/DemandEngine'
import { TierBadge } from '@/components/ui/TierSystem'
import { StreakWidget } from '@/components/ui/StreakWidget'
import { useStudentWorkspace } from '@/features/workspace/useStudentWorkspace'
import { buildWorkspaceActions } from '@/features/workspace/workspaceModel'

function SectionHeading({ title, to, label = 'View all' }) {
  return <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-bold">{title}</h2>{to && <Link to={to} className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">{label}<ArrowRight size={12}/></Link>}</div>
}

function MetricCard({ label, value, detail, icon: Icon, href }) {
  const content = <div className="h-full rounded-md border border-outline-variant bg-surface-container-high p-4 sm:p-5"><div className="mb-3 flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wider text-on-surface/45">{label}</span><Icon size={16} className="text-primary"/></div><div className="font-mono text-xl font-black tracking-tight sm:text-2xl">{value}</div>{detail && <p className="mt-1 text-[11px] text-on-surface/40">{detail}</p>}</div>
  return href ? <Link to={href} className="block transition-transform hover:-translate-y-0.5">{content}</Link> : content
}

const statusLabel = status => ({
  pending:'Awaiting payment or confirmation', locked:'Funds held in escrow',
  meetup_initiated:'Handoff in progress', release_requested:'Awaiting buyer inspection',
  disputed:'Dispute under review', completed:'Transaction marked completed',
  released:'Funds released', cancelled:'Cancelled',
}[status] || String(status || 'In progress').replaceAll('_',' '))

export default function Home() {
  const { profile, user } = useAuth()
  const queryClient = useQueryClient()
  const [feedItems, setFeedItems] = useState([])
  useStreak()
  const currentUniversity = profile?.university ?? null
  const workspaceQuery = useStudentWorkspace(user?.id)
  const workspace = workspaceQuery.data
  const actions = useMemo(() => workspace && user?.id
    ? buildWorkspaceActions(user.id, workspace.transactions, workspace.bookings, workspace.rentals)
    : [], [workspace, user?.id])

  const { data: initialFeed = [] } = useQuery({
    queryKey: ['activity-feed', currentUniversity],
    enabled: Boolean(currentUniversity),
    queryFn: async () => {
      const { data, error } = await supabase.from('activity_feed').select('*')
        .eq('university', currentUniversity).order('created_at', { ascending: false }).limit(20)
      if (error) throw error
      return data || []
    },
    staleTime: 30_000,
  })
  useEffect(() => { setFeedItems(initialFeed) }, [initialFeed])
  useRealtimeTable({
    table: 'activity_feed', batchMs: 250,
    onInsert: incoming => {
      const items = Array.isArray(incoming) ? incoming : [incoming]
      setFeedItems(previous => {
        const seen = new Set(previous.map(row => row.id))
        const fresh = []
        for (let index = items.length - 1; index >= 0; index--) {
          const row = items[index]
          if (row?.id && !seen.has(row.id) && (!currentUniversity || row.university === currentUniversity)) {
            seen.add(row.id)
            fresh.push(row)
          }
        }
        return [...fresh, ...previous].slice(0, 30)
      })
    },
  })

  const { data: campusStats } = useQuery({
    queryKey: ['workspace-campus-stats', currentUniversity],
    enabled: Boolean(currentUniversity),
    queryFn: async () => {
      const [listings, trending] = await Promise.all([
        supabase.from('listings').select('id', { count:'exact', head:true })
          .eq('status','active').eq('university',currentUniversity),
        supabase.from('trending_listings').select('listing_id', { count:'exact', head:true }),
      ])
      if (listings.error) throw listings.error
      if (trending.error) throw trending.error
      return { activeListings:listings.count ?? 0, trendingCount:trending.count ?? 0 }
    },
    staleTime: 60_000,
  })

  const { data: recentListings = [] } = useQuery({
    queryKey: ['workspace-recent-listings', currentUniversity],
    enabled: Boolean(currentUniversity),
    queryFn: async () => {
      const { data, error } = await supabase.from('listings')
        .select('id,title,price,images,category,hostel,created_at,profiles!listings_seller_id_fkey(full_name,tier)')
        .eq('status','active').eq('university',currentUniversity)
        .order('created_at',{ascending:false}).limit(4)
      if (error) throw error
      return data || []
    },
    staleTime: 60_000,
  })

  const { data: trendingListings = [] } = useQuery({
    queryKey: ['workspace-trending', currentUniversity],
    enabled: Boolean(currentUniversity),
    queryFn: async () => {
      const { data, error } = await supabase.from('trending_listings')
        .select('listing_id,views_1h,score,listings(id,title,price,images,category,university)')
        .order('score',{ascending:false}).limit(12)
      if (error) throw error
      return (data || []).filter(item => item.listings?.university === currentUniversity).slice(0,3)
    },
    staleTime: 120_000,
  })

  const { data: departments = [] } = useQuery({
    queryKey: ['department-leaderboard', currentUniversity],
    enabled: Boolean(currentUniversity),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_department_leaderboard',{p_university:currentUniversity})
      if (error) throw error
      return data || []
    },
    staleTime: 300_000,
  })

  useEffect(() => {
    if (!user?.id) return
    const tables = ['transactions','gig_bookings','gear_rentals','notifications','messages','profiles']
    const channel = supabase.channel(`student-workspace:${user.id}`)
    tables.forEach(table => {
      channel.on('postgres_changes',{event:'*',schema:'public',table},() => {
        void queryClient.invalidateQueries({queryKey:['workspace','overview',user.id]})
      })
    })
    channel.subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [queryClient,user?.id])

  const statCards = [
    {label:'Campus Wallet',value:workspace?.walletBalanceKobo == null ? '—' : formatNaira(workspace.walletBalanceKobo),detail:'Available balance',icon:WalletCards,href:'/wallet'},
    {label:'PlugScore',value:workspace?.plugScore ?? '—',detail:'Your campus reputation',icon:Zap,href:'/profile'},
    {label:'Active listings',value:workspaceQuery.isLoading ? '…' : workspace?.activeListingCount ?? 0,detail:'Items you are selling',icon:Package,href:'/marketplace?tab=my-listings'},
    {label:'Open purchases',value:workspaceQuery.isLoading ? '…' : workspace?.pendingPurchasesCount ?? 0,detail:'Buyer-side transactions',icon:ShoppingBag,href:'/marketplace'},
    {label:'Open sales',value:workspaceQuery.isLoading ? '…' : workspace?.pendingSalesCount ?? 0,detail:'Seller-side transactions',icon:TrendingUp,href:'/marketplace?tab=my-listings'},
  ]

  return <div className="mx-auto max-w-7xl space-y-7 px-4 py-6 sm:py-8">
    <section className="relative overflow-hidden rounded-md border border-outline-variant bg-surface-container-high p-5 sm:p-7">
      <div className="cyber-grid absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_at_top_left,black,transparent)]"/>
      <div className="relative z-10">
        <div className="mb-2 flex flex-wrap items-center gap-2"><p className="section-label">Your campus workspace</p>{profile?.tier && <TierBadge tier={profile.tier} size="xs"/>}</div>
        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Welcome back, {profile?.full_name?.split(' ')[0] || 'Student'}.</h1>
        <p className="mt-2 max-w-2xl text-sm text-on-surface/55">{profile?.university ? `Your ${profile.university} activity, transactions and campus services in one place. ${campusStats?.activeListings ?? '—'} listings are currently active on campus.` : 'Your transactions, services and campus activity in one place.'}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link to="/marketplace" className="btn-primary inline-flex items-center gap-2 text-sm"><ShoppingBag size={14}/>Browse marketplace</Link>
          <Link to="/marketplace?action=create" className="btn-secondary inline-flex items-center gap-2 text-sm"><Plus size={14}/>List an item</Link>
          <Link to="/gigs" className="btn-secondary inline-flex items-center gap-2 text-sm"><Zap size={14}/>Offer a service</Link>
          <Link to="/wallet" className="btn-secondary inline-flex items-center gap-2 text-sm"><ArrowDownToLine size={14}/>Fund wallet</Link>
        </div>
      </div>
    </section>

    {!profile?.primary_institution_id && <section className="flex flex-col gap-3 rounded-md border border-amber-400/25 bg-amber-400/5 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><GraduationCap size={18} className="mt-0.5 text-amber-300"/><div><p className="text-sm font-bold">Verify your campus identity</p><p className="mt-1 text-xs text-on-surface/55">Verify your university email to unlock the right campus context and membership features.</p></div></div><Link to="/settings" className="btn-secondary shrink-0 text-xs">Verify campus <ArrowRight size={12}/></Link></section>}

    <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      {statCards.map(card=><MetricCard key={card.label} {...card}/>)}
    </section>

    <section className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-md border border-outline-variant bg-surface-container-high p-4 sm:p-5 lg:col-span-2">
        <div className="mb-4 flex items-center justify-between gap-3"><div><p className="section-label">Action center</p><h2 className="mt-1 text-lg font-black">Things needing your attention</h2></div><span className="rounded-sm bg-primary/10 px-2 py-1 text-xs font-bold text-primary">{actions.length} open</span></div>
        {workspaceQuery.isLoading ? <div className="space-y-3" aria-label="Loading workspace actions"><div className="skeleton h-14 w-full"/><div className="skeleton h-14 w-full"/></div>
          : workspaceQuery.error ? <div className="rounded-md border border-error/20 bg-error/5 p-4 text-sm text-error">Your action center could not load. <button className="ml-1 underline" onClick={()=>void workspaceQuery.refetch()}>Retry</button></div>
          : actions.length === 0 ? <div className="rounded-md bg-surface-container p-5 text-center"><CheckCircle2 size={24} className="mx-auto mb-2 text-primary"/><p className="text-sm font-semibold">You are all caught up</p><p className="mt-1 text-xs text-on-surface/45">Active purchases, service bookings and rentals will show here when they need a step from you.</p></div>
          : <div className="space-y-2">{actions.map(action=><Link key={action.id} to={action.href} className="flex items-center gap-3 rounded-md border border-outline-variant bg-surface-container p-3 transition-colors hover:border-primary/35"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-sm ${action.priority==='urgent'?'bg-error/10 text-error':'bg-primary/10 text-primary'}`}>{action.kind==='purchase'?<ShoppingBag size={16}/>:action.kind==='service'?<CalendarDays size={16}/>:<Package size={16}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{action.title}</span><span className="mt-0.5 block truncate text-xs text-on-surface/45">{action.detail}</span></span>{action.priority==='urgent'&&<span className="text-[9px] font-bold uppercase tracking-wider text-error">Action</span>}<ArrowRight size={14} className="shrink-0 text-on-surface/35"/></Link>)}</div>}
      </div>
      <div className="space-y-3">
        <div className="rounded-md border border-outline-variant bg-surface-container-high p-4">
          <p className="section-label">Stay connected</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link to="/chat" className="rounded-md bg-surface-container p-3"><MessageCircle size={17} className="text-primary"/><p className="mt-2 text-xl font-black">{workspace?.unreadMessages ?? '—'}</p><p className="text-[10px] text-on-surface/45">Unread messages</p></Link>
            <Link to="/notifications" className="rounded-md bg-surface-container p-3"><Bell size={17} className="text-primary"/><p className="mt-2 text-xl font-black">{workspace?.unreadNotifications ?? '—'}</p><p className="text-[10px] text-on-surface/45">Unread alerts</p></Link>
          </div>
        </div>
        <div className="rounded-md border border-outline-variant bg-surface-container-high p-4">
          <p className="section-label">Your activity</p>
          <div className="mt-3 space-y-3">
            <Link to="/gigs" className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-on-surface/70"><Zap size={15} className="text-primary"/>Service bookings</span><span className="font-mono font-bold">{workspace?.bookings.length ?? '—'}</span></Link>
            <Link to="/rentals" className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-on-surface/70"><Package size={15} className="text-primary"/>Gear rentals</span><span className="font-mono font-bold">{workspace?.rentals.length ?? '—'}</span></Link>
            <Link to="/marketplace?tab=my-listings" className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-on-surface/70"><ClipboardList size={15} className="text-primary"/>My listings</span><span className="font-mono font-bold">{workspace?.listings.length ?? '—'}</span></Link>
          </div>
        </div>
      </div>
    </section>

    {profile?.university && <section><div className="mb-2 flex items-center gap-2"><span className="plug-dot"/><span className="text-xs font-bold uppercase tracking-wider text-primary">Live on campus</span></div><CampusTicker university={profile.university}/></section>}

    <section className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-3">
        <SectionHeading title="Your recent transactions" to="/marketplace" label="Marketplace"/>
        {workspaceQuery.isLoading ? <div className="skeleton h-24 w-full"/> : (workspace?.transactions.length ?? 0)===0
          ? <div className="rounded-md border border-outline-variant bg-surface-container-high p-5 text-sm text-on-surface/45">No purchases or sales yet. Your transaction timeline will appear here.</div>
          : <div className="divide-y divide-outline-variant rounded-md border border-outline-variant bg-surface-container-high">{workspace.transactions.slice(0,5).map(transaction=><div key={transaction.id} className="flex items-center gap-3 p-3 sm:p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary/10 text-primary"><ShoppingBag size={16}/></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{transaction.buyer_id===user?.id?'Purchase':'Sale'} · {formatNaira(transaction.amount)}</p><p className="mt-0.5 truncate text-xs text-on-surface/45">{statusLabel(transaction.status)} · {timeAgo(transaction.updated_at || transaction.created_at)}</p></div><span className={`max-w-24 truncate rounded-sm px-2 py-1 text-[9px] font-bold uppercase ${transaction.status==='disputed'?'bg-error/10 text-error':'bg-surface-container text-on-surface/55'}`}>{transaction.status.replaceAll('_',' ')}</span></div>)}</div>}
      </div>
      <div className="space-y-3 lg:col-span-2">
        <SectionHeading title="Live campus activity"/>
        <div className="max-h-[390px] overflow-y-auto rounded-md border border-outline-variant bg-surface-container-high">
          {feedItems.length===0 ? <p className="p-5 text-sm text-on-surface/40">No campus activity yet.</p> : feedItems.slice(0,12).map(item=><motion.div key={item.id} initial={{opacity:0,x:-6}} animate={{opacity:1,x:0}} className="flex gap-3 border-b border-outline-variant p-3 last:border-0"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-container text-sm">{item.emoji||'⚡'}</span><div className="min-w-0 flex-1"><p className="text-xs leading-5 text-on-surface/75"><strong>{item.actor_name||'A student'}</strong> {item.action}{item.subject&&<span className="text-primary"> “{item.subject}”</span>}</p><p className="mt-0.5 text-[10px] text-on-surface/35">{timeAgo(item.created_at)}</p></div></motion.div>)}
        </div>
      </div>
    </section>

    <section>
      <SectionHeading title="Fresh from your campus" to="/marketplace"/>
      {!currentUniversity ? <div className="rounded-md border border-outline-variant bg-surface-container-high p-5 text-sm text-on-surface/50">Verify your campus in Settings to see campus-specific listings.</div>
        : recentListings.length===0 ? <div className="rounded-md border border-outline-variant bg-surface-container-high p-5 text-sm text-on-surface/50">No active campus listings yet.</div>
        : <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{recentListings.map(listing=><Link key={listing.id} to={`/marketplace/${listing.id}`} className="group overflow-hidden rounded-md border border-outline-variant bg-surface-container-high transition-colors hover:border-primary/35"><div className="aspect-square overflow-hidden bg-surface-container">{listing.images?.[0]?<img src={listing.images[0]} alt={listing.title} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105"/>:<div className="grid h-full place-items-center text-3xl">📦</div>}</div><div className="p-3"><p className="truncate text-xs font-bold">{listing.title}</p><p className="mt-1 font-mono text-sm font-black text-primary">{formatNaira(listing.price)}</p><p className="mt-1 truncate text-[10px] text-on-surface/40">{listing.category} · {timeAgo(listing.created_at)}</p></div></Link>)}</div>}
    </section>

    {trendingListings.length>0 && <section><SectionHeading title="Trending around campus" to="/marketplace"/><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{trendingListings.map(item=>item.listings&&<Link key={item.listing_id} to={`/marketplace/${item.listing_id}`} className="flex items-center gap-3 rounded-md border border-outline-variant bg-surface-container-high p-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-primary/10 text-primary"><Flame size={17}/></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{item.listings.title}</span><span className="mt-1 block font-mono text-xs font-black text-primary">{formatNaira(item.listings.price)}</span></span><span className="text-[10px] text-on-surface/40">{item.views_1h ?? 0} views</span></Link>)}</div></section>}

    {departments.length>0 && <section className="rounded-md border border-outline-variant bg-surface-container-high p-4 sm:p-5"><div className="mb-4 flex items-center gap-2"><Sparkles size={16} className="text-primary"/><h2 className="text-sm font-bold">Departmental PlugScore</h2><span className="ml-auto text-[10px] text-on-surface/35">Campus leaderboard</span></div><div className="grid gap-2 sm:grid-cols-2">{departments.slice(0,6).map(row=><div key={row.department} className="flex items-center gap-3 rounded-sm bg-surface-container p-3"><span className="w-6 text-center font-black text-primary">#{row.rank}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{row.department}</span><span className="text-[10px] text-on-surface/40">{row.students} students</span></span><span className="font-mono text-xs font-black">{row.avg_plug_score}</span></div>)}</div><Link to="/leaderboard" className="mt-3 block text-center text-xs font-semibold text-primary hover:underline">Open full leaderboard →</Link></section>}

    {user?.id && <StreakWidget userId={user.id}/>}
  </div>
}
