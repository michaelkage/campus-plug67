import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Scale, Lock, Clock, ChevronRight, CheckCircle2, Shield } from 'lucide-react'

const STORAGE_KEY = 'cp_jury_tutorial_seen'

const SLIDES = [
  {
    Icon: Scale, color: 'text-cyan', bg: 'bg-cyan/15 border-cyan/25',
    title: 'Your Role as a Juror', subtitle: 'Anonymous. Accountable. Fair.',
    bullets: ['You review anonymised disputes — no real names, no bias', 'You see the full sanitized chat history as evidence', 'Your verdict is 1 of 3–5 votes needed to resolve', 'Correct verdicts earn +20 PlugScore + ₦100 PlugCredit'],
    note: 'Your identity is never revealed to the disputing parties.', NoteIcon: Shield, noteColor: 'text-plug-green',
  },
  {
    Icon: Lock, color: 'text-purple', bg: 'bg-purple/15 border-purple/25',
    title: 'The Evidence is Immutable', subtitle: 'Messages lock after 60 seconds.',
    bullets: ['Chat messages are locked 60s after being sent', 'All edits archived in a tamper-proof audit log', 'The evidence you see is the unaltered record', 'Even Campus Plug staff cannot modify the logs'],
    note: 'What you read is what actually happened.', NoteIcon: Lock, noteColor: 'text-cyan',
  },
  {
    Icon: Clock, color: 'text-plug-amber', bg: 'bg-plug-amber/15 border-plug-amber/25',
    title: 'The Review Rule', subtitle: 'You must actually read before you vote.',
    bullets: ['Standard cases: 5s minimum review (server-enforced)', 'High-value (₦50k+): 20s minimum — no rushing', 'Timing validated on the server, client cannot fake it', 'Silent jurors replaced after 30 minutes (-5 PlugScore)'],
    note: '3 correct verdicts/week → Magistrate badge + 3 free listing tokens.', NoteIcon: CheckCircle2, noteColor: 'text-plug-amber',
  },
]

export function useJurorTutorial() {
  const seen = typeof window !== 'undefined' && !!localStorage.getItem(STORAGE_KEY)
  return { needsTutorial: !seen }
}

export function JurorTutorial({ onComplete }) {
  const [slide, setSlide] = useState(0)
  const isLast = slide === SLIDES.length - 1
  const { Icon, color, bg, title, subtitle, bullets, note, NoteIcon, noteColor } = SLIDES[slide]

  const finish = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    onComplete?.()
  }

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
        <motion.div initial={{ scale: 0.92, y: 16 }} animate={{ scale: 1, y: 0 }}
          className="w-full max-w-md bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
          <div className="flex gap-1.5 p-4 pb-0">
            {SLIDES.map((_, i) => (
              <div key={i} className={`flex-1 h-1 rounded-full transition-all ${i <= slide ? 'bg-cyan' : 'bg-obsidian-300'}`} />
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={slide} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }} className="p-6">
              <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center mb-5 ${bg}`}>
                <Icon size={26} className={color} />
              </div>
              <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Step {slide + 1} of {SLIDES.length}</div>
              <h2 className="text-xl font-black mb-1">{title}</h2>
              <p className="text-sm text-white/50 mb-5">{subtitle}</p>
              <div className="space-y-3 mb-5">
                {bullets.map((b, i) => (
                  <motion.div key={i} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.06 }} className="flex items-start gap-3">
                    <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-current ${color}`} />
                    <span className="text-sm text-white/70 leading-relaxed">{b}</span>
                  </motion.div>
                ))}
              </div>
              <div className="flex items-center gap-2 p-3 rounded-xl bg-obsidian-300 border border-obsidian-500">
                <NoteIcon size={13} className={`${noteColor} flex-shrink-0`} />
                <span className={`text-xs font-semibold ${noteColor}`}>{note}</span>
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="px-6 pb-6 flex items-center justify-between">
            {slide > 0
              ? <button onClick={() => setSlide(s => s - 1)} className="text-sm text-white/30 hover:text-white/60">← Back</button>
              : <div />
            }
            <motion.button whileTap={{ scale: 0.96 }} onClick={isLast ? finish : () => setSlide(s => s + 1)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan text-obsidian font-bold text-sm">
              {isLast ? <><CheckCircle2 size={15} /> I Understand</> : <>Next <ChevronRight size={15} /></>}
            </motion.button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
