import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Star, Bug, Zap, MessageSquare, Send } from 'lucide-react'
import toast from 'react-hot-toast'

const CATEGORIES = [
  { key: 'Bug',        icon: Bug,         color: 'text-plug-red',   bg: 'bg-plug-red/10 border-plug-red/25'    },
  { key: 'Feature',    icon: Zap,         color: 'text-cyan',       bg: 'bg-cyan/10 border-cyan/25'            },
  { key: 'Experience', icon: MessageSquare,color: 'text-plug-amber', bg: 'bg-plug-amber/10 border-plug-amber/25'},
]

export default function Reviews() {
  const { user, profile } = useAuth()
  const qc = useQueryClient()
  const [category, setCategory] = useState('Experience')
  const [rating, setRating] = useState(0)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const { data: reviews = [] } = useQuery({
    queryKey: ['reviews'],
    queryFn: async () => {
      const { data } = await supabase
        .from('user_feedback')
        .select('*, profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(30)
      return data || []
    },
    staleTime: 60_000,
  })

  const handleSubmit = async () => {
    if (!rating) { toast.error('Please select a rating'); return }
    if (!note.trim()) { toast.error('Please add a note'); return }
    setSubmitting(true)
    const { error } = await supabase.from('user_feedback').insert({
      user_id:  user.id,
      context:  category,
      rating,
      note:     note.trim(),
    })
    if (error) { toast.error(error.message); setSubmitting(false); return }
    toast.success('Thanks for your feedback!')
    setNote(''); setRating(0)
    qc.invalidateQueries({ queryKey: ['reviews'] })
    setSubmitting(false)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <p className="section-label">Community</p>
        <h1 className="text-2xl font-black">Campus Reviews</h1>
        <p className="text-white/40 text-sm mt-1">Help us improve. All feedback is read by the team.</p>
      </div>

      {/* Submit form */}
      <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-6 space-y-5">
        <div className="text-sm font-bold">Submit Feedback</div>

        <div className="flex gap-2">
          {CATEGORIES.map(({ key, icon: Icon, color, bg }) => (
            <button key={key} onClick={() => setCategory(key)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-all ${
                category === key ? bg + ' ' + color : 'border-obsidian-500 text-white/40 hover:border-white/20'
              }`}>
              <Icon size={12} /> {key}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => setRating(s)}>
              <Star size={24} className={s <= rating ? 'text-plug-amber fill-plug-amber' : 'text-white/20'} />
            </button>
          ))}
        </div>

        <textarea className="input resize-none w-full" rows={3}
          placeholder="What happened? What could be better?"
          value={note} onChange={e => setNote(e.target.value)} />

        <button onClick={handleSubmit} disabled={submitting}
          className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <Send size={14} /> {submitting ? 'Sending…' : 'Submit Feedback'}
        </button>
      </div>

      {/* Reviews list */}
      <div className="space-y-3">
        {reviews.map(r => (
          <motion.div key={r.id} initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }}
            className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="tag tag-cyan text-[10px]">{r.context}</span>
                <div className="flex">
                  {[1,2,3,4,5].map(s => <Star key={s} size={11} className={s <= r.rating ? 'text-plug-amber fill-plug-amber' : 'text-white/15'} />)}
                </div>
              </div>
              <span className="text-[10px] text-white/30">{new Date(r.created_at).toLocaleDateString('en-NG')}</span>
            </div>
            <p className="text-sm text-white/70 leading-relaxed">{r.note}</p>
          </motion.div>
        ))}
      </div>
    </div>
  )
}
