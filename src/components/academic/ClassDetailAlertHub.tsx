import { useQuery } from '@tanstack/react-query'
import { Book, Bell, MapPin, ShoppingBag, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export default function ClassDetailAlertHub() {
  const { profile } = useAuth()
  const materials = ['Algorithm Design Manual (2nd Ed)', 'Scientific Calculator']
  const { data: recommendations = [] } = useQuery({
    queryKey: ['class-material-recommendations', profile?.university],
    enabled: !!profile?.university,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('listings')
        .select('id,title,price,images,category')
        .eq('university', profile.university)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) throw error
      const rows = data || []
      return rows.filter((item: any) => materials.some(m => `${item.title} ${item.category}`.toLowerCase().includes(m.split(' ')[0].toLowerCase()))).slice(0, 4)
    },
  })

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="surface p-6">
        <h1 className="text-2xl font-black text-white flex items-center gap-3"><Book className="text-plug-green" /> CSC 301: Data Structures</h1>
        <div className="flex items-center gap-2 mt-2 text-white/60 text-sm"><MapPin size={14} /> LT1, Faculty of Science</div>
        <button className="mt-4 flex items-center gap-2 bg-white/5 hover:bg-white/10 px-4 py-2 rounded-lg text-sm text-white transition"><Bell size={14} /> Set Class Alert</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="surface p-6">
          <h2 className="font-bold text-white mb-4">Required Materials</h2>
          <ul className="space-y-3 text-sm text-white/70">{materials.map(m => <li key={m} className="flex items-center gap-2"><input type="checkbox" className="accent-cyan" /> {m}</li>)}</ul>
          <Link to="/marketplace" className="mt-4 flex items-center justify-center gap-2 w-full bg-cyan/10 text-cyan py-2 rounded-lg text-xs font-bold uppercase hover:bg-cyan/20">Search Campus Catalog <ArrowRight size={13}/></Link>
        </div>

        <div className="surface p-6">
          <h2 className="font-bold text-white mb-4 flex items-center gap-2"><Book size={16} className="text-plug-amber" /> Note Marketplace</h2>
          <div className="space-y-3"><div className="bg-obsidian-300 p-3 rounded-lg border border-white/5 flex justify-between items-center"><div><p className="text-sm font-semibold text-white">Midterm Summary Notes</p><p className="text-xs text-white/40">Shared by a student</p></div><span className="text-plug-green font-bold text-sm">₦500</span></div><div className="bg-obsidian-300 p-3 rounded-lg border border-white/5 flex justify-between items-center"><div><p className="text-sm font-semibold text-white">Past Questions (2020-2024)</p><p className="text-xs text-white/40">Shared by a student</p></div><span className="text-plug-green font-bold text-sm">₦1000</span></div></div>
        </div>
      </div>

      <div className="surface p-6">
        <div className="flex items-center justify-between mb-4"><div><p className="section-label">Smart recommendations</p><h2 className="font-bold">Get what this class needs</h2></div><ShoppingBag size={18} className="text-cyan"/></div>
        {recommendations.length === 0 ? <p className="text-sm text-white/35">No matching campus listings yet. Campus Plug will surface relevant listings here as students add them.</p> : <div className="grid gap-3 sm:grid-cols-2">{recommendations.map((item:any)=><Link key={item.id} to={`/marketplace/${item.id}`} className="surface-interactive rounded-xl border border-white/5 bg-white/[.02] p-3"><div className="flex gap-3"><div className="h-14 w-14 overflow-hidden rounded-lg bg-white/5">{item.images?.[0]&&<img src={item.images[0]} alt="" className="h-full w-full object-cover"/>}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold">{item.title}</div><div className="mt-1 text-xs text-white/35">{item.category}</div><div className="mt-2 text-sm font-black text-cyan">{formatNaira(item.price)}</div></div></div></Link>)}</div>}
      </div>
    </div>
  )
}
