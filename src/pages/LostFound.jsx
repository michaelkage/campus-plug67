import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Search, Tag } from 'lucide-react'

const PRESET_TAGS = [
  'keys', 'phone', 'wallet', 'student-id', 'laptop', 'bag',
  'glasses', 'earphones', 'charger', 'book', 'calculator', 'umbrella',
]

function TagInput({ tags, setTags }) {
  const [input, setInput] = useState('')
  const add = (tag) => {
    const clean = tag.toLowerCase().trim().replace(/\s+/g, '-')
    if (clean && !tags.includes(clean) && tags.length < 8) {
      setTags([...tags, clean])
    }
    setInput('')
  }
  const remove = (tag) => setTags(tags.filter(t => t !== tag))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map(t => (
          <span key={t} className="flex items-center gap-1 tag tag-cyan text-[11px]">
            #{t}
            <button onClick={() => remove(t)} className="hover:text-plug-red transition-colors">
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input flex-1 text-sm"
          placeholder="Add tag (e.g. keys, wallet...)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(input) } }}
        />
        <button type="button" onClick={() => add(input)} className="btn-ghost text-xs px-3">
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {PRESET_TAGS.filter(p => !tags.includes(p)).map(p => (
          <button
            key={p}
            type="button"
            onClick={() => add(p)}
            className="text-[11px] px-2 py-0.5 rounded-full border border-obsidian-500
                       text-white/40 hover:border-cyan/30 hover:text-cyan transition-colors"
          >
            #{p}
          </button>
        ))}
      </div>
    </div>
  )
}

function ReportModal({ onClose, profile }) {
  const qc = useQueryClient()
  const [type, setType]     = useState('lost')
  const [form, setForm]     = useState({ title: '', description: '', location: '' })
  const [tags, setTags]     = useState([])
  const [image, setImage]   = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!tags.length) { toast.error('Add at least one tag to help with matching'); return }
    setSubmitting(true)
    try {
      const { error } = await supabase.from('lost_found').insert({
        reporter_id: profile.id,
        type,
        title:       form.title,
        description: form.description,
        location:    form.location,
        tags,
        university:  profile.university,
      })
      if (error) throw error

      await supabase.from('activity_feed').insert({
        actor_name: profile.full_name,
        actor_id:   profile.id,
        action:     type === 'lost' ? 'reported a lost item' : 'found an item',
        subject:    form.title,
        emoji:      type === 'lost' ? '🔍' : '📦',
        university: profile.university,
      })

      toast.success(type === 'lost'
        ? '📢 Report submitted! We\'ll notify you of any matches.'
        : '📦 Found item posted! Owner will be notified if matched.')
      qc.invalidateQueries({ queryKey: ['lost-found'] })
      onClose()
    } catch (err) {
      toast.error(err.message || 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-obsidian-500">
          <h2 className="font-bold">Report an Item</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Lost / Found toggle */}
          <div className="flex bg-obsidian-300 rounded-xl p-1">
            {[
              { val: 'lost',  label: '🔍 I Lost Something',  },
              { val: 'found', label: '📦 I Found Something', },
            ].map(({ val, label }) => (
              <button
                key={val}
                type="button"
                onClick={() => setType(val)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
                  type === val ? 'bg-cyan text-obsidian' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="label">What is it?</label>
            <input className="input" placeholder='e.g. "Blue keychain with house key and a small bear"'
              value={form.title} onChange={set('title')} required />
          </div>

          <div>
            <label className="label">Description</label>
            <textarea className="input resize-none" rows={2}
              placeholder="Any identifying features, serial numbers, etc."
              value={form.description} onChange={set('description')} />
          </div>

          <div>
            <label className="label">Where was it {type === 'lost' ? 'last seen' : 'found'}?</label>
            <input className="input" placeholder="e.g. Faculty of Science block B, 2nd floor"
              value={form.location} onChange={set('location')} />
          </div>

          <div>
            <label className="label">Tags <span className="text-plug-red">*</span></label>
            <TagInput tags={tags} setTags={setTags} />
            <p className="text-xs text-white/30 mt-1">
              Tags are used by AI matching to connect lost & found reports.
            </p>
          </div>

          <button type="submit" disabled={submitting}
            className="btn-primary w-full disabled:opacity-50">
            {submitting ? 'Submitting...' : type === 'lost' ? 'Report Lost Item' : 'Post Found Item'}
          </button>
        </form>
      </div>
    </div>
  )
}

function ItemCard({ item }) {
  const isLost  = item.type === 'lost'
  const statusColors = {
    open:     isLost ? 'tag-red' : 'tag-cyan',
    resolved: 'tag-green',
    claimed:  'tag-green',
  }
  return (
    <div className={`bg-obsidian-400 border rounded-xl p-4 transition-all hover:-translate-y-0.5 ${
      isLost ? 'border-plug-red/20 hover:border-plug-red/40' : 'border-cyan/20 hover:border-cyan/40'
    }`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{isLost ? '🔍' : '📦'}</span>
          <span className={`tag text-[10px] ${isLost ? 'tag-red' : 'tag-cyan'}`}>
            {isLost ? 'LOST' : 'FOUND'}
          </span>
          <span className={`tag text-[10px] ${statusColors[item.status] || 'tag-cyan'}`}>
            {item.status.toUpperCase()}
          </span>
        </div>
        <span className="text-xs text-white/25 flex-shrink-0">
          {new Date(item.created_at).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })}
        </span>
      </div>

      <h3 className="font-semibold text-sm mb-1 leading-snug">{item.title}</h3>
      {item.description && (
        <p className="text-xs text-white/50 mb-3 line-clamp-2">{item.description}</p>
      )}

      {item.location && (
        <div className="flex items-center gap-1.5 text-xs text-white/30 mb-3">
          <span>📍</span>
          {item.location}
        </div>
      )}

      {/* Tags */}
      <div className="flex flex-wrap gap-1">
        {item.tags?.map(tag => (
          <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full
                                     bg-obsidian-300 text-white/40 border border-obsidian-500 font-mono">
            #{tag}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function LostFound() {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [filter, setFilter]       = useState('all')   // all | lost | found
  const [search, setSearch]       = useState('')

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['lost-found', filter],
    queryFn: async () => {
      let q = supabase
        .from('lost_found')
        .select('*, profiles(full_name)')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(50)

      if (filter !== 'all') q = q.eq('type', filter)
      if (profile?.university) q = q.eq('university', profile.university)

      const { data, error } = await q
      if (error) throw error
      return data || []
    },
  })

  // Real-time new reports
  useRealtimeTable({
    table: 'lost_found',
    onInsert: (item) => {
      if (filter !== 'all' && item.type !== filter) return
      qc.setQueryData(['lost-found', filter], old => [item, ...(old || [])])
      toast(`New ${item.type} item reported: "${item.title}"`, {
        icon: item.type === 'lost' ? '🔍' : '📦'
      })
    },
  })

  const filtered = items.filter(item =>
    !search ||
    item.title.toLowerCase().includes(search.toLowerCase()) ||
    item.tags?.some(t => t.includes(search.toLowerCase()))
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="section-label">AI-Assisted</p>
          <h1 className="text-2xl font-black tracking-tight">Lost & Found</h1>
          <p className="text-sm text-white/40 mt-1">
            Tag-based matching automatically connects lost & found reports.
          </p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2 self-start">
          <Plus size={16} />
          Report Item
        </button>
      </div>

      {/* How it works */}
      <div className="bg-purple/5 border border-purple/20 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span>🤖</span>
          <span className="text-xs font-bold text-purple uppercase tracking-wider">AI Matching Active</span>
        </div>
        <p className="text-sm text-white/50">
          When you submit a report, our system automatically checks all existing reports for
          overlapping tags. If a match is found, both parties are instantly notified via
          in-app notification. No manual searching needed.
        </p>
      </div>

      {/* Filters + Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input className="input pl-9" placeholder="Search by title or tag..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2">
          {[
            { val: 'all',   label: 'All'   },
            { val: 'lost',  label: '🔍 Lost'  },
            { val: 'found', label: '📦 Found' },
          ].map(({ val, label }) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${
                filter === val
                  ? 'bg-cyan text-obsidian border-cyan'
                  : 'bg-transparent text-white/40 border-obsidian-500 hover:border-cyan/30'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Open Reports', val: items.length, color: 'text-white' },
          { label: 'Lost Items',   val: items.filter(i => i.type === 'lost').length,  color: 'text-plug-red'  },
          { label: 'Found Items',  val: items.filter(i => i.type === 'found').length, color: 'text-cyan'      },
        ].map(({ label, val, color }) => (
          <div key={label} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 text-center">
            <div className={`text-2xl font-black font-mono ${color}`}>{val}</div>
            <div className="text-xs text-white/40 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Items */}
      {isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 animate-pulse h-32" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-white/30">
          <div className="text-4xl mb-4">🔍</div>
          <p className="font-semibold">No reports found</p>
          <p className="text-sm mt-1">
            {search ? 'Try different keywords or tags.' : 'No open reports on your campus right now.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {filtered.map(item => <ItemCard key={item.id} item={item} />)}
        </div>
      )}

      {showModal && <ReportModal onClose={() => setShowModal(false)} profile={profile} />}
    </div>
  )
}
