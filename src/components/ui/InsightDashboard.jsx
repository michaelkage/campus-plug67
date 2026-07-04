import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Clock, TrendingUp, TrendingDown, AlertTriangle, BarChart3, Zap } from 'lucide-react'

function fmtMs(ms) {
  if (!ms || ms < 0) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h/24)}d ${h%24}h`
}

function Card({ label, value, sub, trend, alert, Icon, color = 'text-cyan' }) {
  return (
    <div className={`bg-obsidian-400 border rounded-xl p-4 ${alert ? 'border-plug-red/40' : 'border-obsidian-500'}`}>
      <div className="flex items-start justify-between mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${alert ? 'bg-plug-red/15' : 'bg-obsidian-300'}`}>
          <Icon size={14} className={alert ? 'text-plug-red' : color} />
        </div>
        {trend != null && trend !== 0 && (
          <div className={`flex items-center gap-1 text-[10px] font-bold ${trend > 0 ? 'text-plug-red' : 'text-plug-green'}`}>
            {trend > 0 ? <TrendingUp size={10}/> : <TrendingDown size={10}/>} {trend > 0 ? '+' : ''}{trend}%
          </div>
        )}
      </div>
      <div className={`text-2xl font-black font-mono mb-0.5 ${alert ? 'text-plug-red' : color}`}>{value}</div>
      <div className="text-xs font-semibold text-white/60">{label}</div>
      {sub && <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>}
      {alert && <div className="text-[10px] text-plug-red font-bold mt-2 flex items-center gap-1"><AlertTriangle size={9}/> FRICTION ALERT</div>}
    </div>
  )
}

export function InsightDashboard() {
  const { profile } = useAuth()
  const isAdmin = profile?.badges?.includes('Plug Dev') || profile?.badges?.includes('Community Hero')
  if (!isAdmin) return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-6 text-center">
      <BarChart3 size={28} className="mx-auto mb-3 text-white/20"/>
      <div className="text-sm text-white/30">Insight Engine — Admin Only</div>
    </div>
  )

  const { data: velocity } = useQuery({
    queryKey: ['insight-velocity'],
    queryFn: async () => {
      const { data } = await supabase.from('transactions').select('locked_at,released_at').eq('status','released')
        .not('locked_at','is',null).not('released_at','is',null)
        .gte('released_at', new Date(Date.now()-30*86400000).toISOString()).limit(500)
      if (!data?.length) return null
      const ds = data.map(t => new Date(t.released_at).getTime()-new Date(t.locked_at).getTime()).filter(d=>d>0&&d<7*86400000).sort((a,b)=>a-b)
      const avg = ds.reduce((s,d)=>s+d,0)/ds.length
      const med = ds[Math.floor(ds.length/2)]
      const cut = Date.now()-7*86400000
      const rec = data.filter(t=>new Date(t.released_at).getTime()>cut).map(t=>new Date(t.released_at).getTime()-new Date(t.locked_at).getTime())
      const old = data.filter(t=>new Date(t.released_at).getTime()<=cut).map(t=>new Date(t.released_at).getTime()-new Date(t.locked_at).getTime())
      const rAvg = rec.length ? rec.reduce((s,d)=>s+d,0)/rec.length : avg
      const oAvg = old.length ? old.reduce((s,d)=>s+d,0)/old.length : avg
      const trend = oAvg > 0 ? Math.round(((rAvg-oAvg)/oAvg)*100) : 0
      return { avg, median: med, p25: ds[Math.floor(ds.length*0.25)], p75: ds[Math.floor(ds.length*0.75)], count: ds.length, trend }
    }, staleTime: 300_000,
  })

  const { data: dropoffs } = useQuery({
    queryKey: ['insight-dropoffs'],
    queryFn: async () => {
      const { data } = await supabase.from('transactions').select('status').gte('created_at',new Date(Date.now()-30*86400000).toISOString())
      const counts = {}
      for (const t of data||[]) counts[t.status] = (counts[t.status]||0)+1
      const total = Object.values(counts).reduce((s,n)=>s+n,0)
      return { counts, total, convRate: total>0 ? Math.round((counts.released||0)/total*100) : 0 }
    }, staleTime: 300_000,
  })

  const friction = (velocity?.trend||0) >= 40

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><p className="section-label">Admin Intelligence</p><h2 className="font-black text-lg">Insight Engine</h2></div>
        <div className="text-[10px] text-white/30 font-mono">Last 30 days</div>
      </div>

      {friction && (
        <motion.div initial={{opacity:0,y:-8}} animate={{opacity:1,y:0}}
          className="flex items-start gap-3 p-4 bg-plug-red/8 border border-plug-red/30 rounded-xl">
          <AlertTriangle size={16} className="text-plug-red flex-shrink-0 mt-0.5"/>
          <div>
            <div className="font-bold text-sm text-plug-red mb-1">⚠️ Friction Alert — Review Meetup Flow</div>
            <div className="text-xs text-white/60">Escrow release time is <strong className="text-plug-red">{velocity?.trend}% slower</strong> this week. Consider simplifying the handshake or adding more Safe Zones.</div>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Avg Release Time" value={fmtMs(velocity?.avg)} sub={`${velocity?.count||0} transactions`} trend={velocity?.trend} alert={friction} Icon={Clock} color="text-cyan"/>
        <Card label="Median" value={fmtMs(velocity?.median)} sub="50th percentile" Icon={BarChart3} color="text-purple"/>
        <Card label="Fast 25%" value={fmtMs(velocity?.p25)} sub="25th percentile" Icon={Zap} color="text-plug-green"/>
        <Card label="Conv. Rate" value={`${dropoffs?.convRate||0}%`} sub={`${dropoffs?.total||0} total transactions`} Icon={TrendingUp} color="text-plug-amber"/>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="bg-obsidian-300 rounded-xl p-3"><div className="font-bold text-plug-green mb-1">⚡ Velocity FAST → Tighten Security</div><div className="text-white/50">Users rushing through meetups. Add more friction to QR handshake.</div></div>
        <div className="bg-obsidian-300 rounded-xl p-3"><div className="font-bold text-plug-red mb-1">🐌 Velocity SLOW → Reduce Friction</div><div className="text-white/50">Users confused by meetup flow. Simplify Amber sync, add Safe Zones.</div></div>
      </div>
    </div>
  )
}
