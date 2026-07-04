import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, callEdgeFunction, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Scale, Clock, Shield, CheckCircle2, AlertTriangle, Award, Eye, ChevronRight } from 'lucide-react'
import toast from 'react-hot-toast'

// ── Evidence viewer ────────────────────────────────────────────────────────────
function EvidenceViewer({ messages }: { messages: any[] }) {
  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {!messages?.length && (
        <div className="text-center text-sm text-white/30 py-4">No chat evidence for this transaction.</div>
      )}
      {messages?.map((m: any, i: number) => (
        <div key={i} className={`flex gap-2 text-xs ${m.is_system ? 'justify-center' : ''}`}>
          {m.is_system ? (
            <div className="px-3 py-1.5 rounded-full bg-obsidian-300 text-white/40 italic">{m.body}</div>
          ) : (
            <>
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-cyan/40 to-purple/40 flex-shrink-0
                              flex items-center justify-center text-[9px] font-bold text-white">
                {m.is_claimant ? 'C' : 'R'}
              </div>
              <div className={`flex-1 rounded-xl px-3 py-2 ${
                m.is_claimant ? 'bg-cyan/8 border border-cyan/15' : 'bg-obsidian-300 border border-obsidian-500'
              } ${m.flagged ? 'ring-1 ring-plug-amber/40' : ''}`}>
                <div className="font-semibold text-white/60 mb-0.5">
                  {m.is_claimant ? 'Claimant' : 'Respondent'}
                  {m.flagged && <span className="ml-2 text-plug-amber text-[9px] font-bold">⚠️ FLAGGED: {m.flag_type}</span>}
                </div>
                <div className="text-white/80 leading-relaxed">{m.body}</div>
                <div className="text-white/25 mt-1">{new Date(m.created_at).toLocaleString('en-NG', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ── High-value review timer ────────────────────────────────────────────────────
function ReviewTimer({ required, onReady }: { required: boolean; onReady: () => void }) {
  const [elapsed, setElapsed] = useState(0)
  const ready = !required || elapsed >= 20

  useEffect(() => {
    if (!required || ready) { if (required && elapsed >= 20) onReady(); return }
    const id = setInterval(() => setElapsed(p => {
      if (p >= 20) { clearInterval(id); onReady(); return 20 }
      return p + 1
    }), 1000)
    return () => clearInterval(id)
  }, [required, ready])

  if (!required) return null

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
      ready ? 'border-plug-green/30 bg-plug-green/8' : 'border-plug-amber/30 bg-plug-amber/8'
    }`}>
      <Clock size={14} className={ready ? 'text-plug-green' : 'text-plug-amber'} />
      <div className="flex-1">
        <div className={`text-xs font-bold ${ready ? 'text-plug-green' : 'text-plug-amber'}`}>
          {ready ? 'Review Complete — You May Vote' : `High-Value Case: Review for ${20 - elapsed}s more`}
        </div>
        <div className="h-1 mt-1.5 bg-obsidian-300 rounded-full overflow-hidden">
          <motion.div className={`h-full rounded-full ${ready ? 'bg-plug-green' : 'bg-plug-amber'}`}
            animate={{ width: `${Math.min(elapsed / 20 * 100, 100)}%` }}
            transition={{ duration: 0.5 }} />
        </div>
      </div>
    </div>
  )
}

// ── Single case view ──────────────────────────────────────────────────────────
function CaseView({ juryCase, onVoted }: any) {
  const { session, user } = useAuth()
  const [verdict,     setVerdict]    = useState<string | null>(null)
  const [reasoning,   setReasoning]  = useState('')
  const [reviewReady, setReviewReady] = useState(!juryCase.high_value)
  const [submitting,  setSubmitting]  = useState(false)
  const [startedAt]                   = useState(Date.now())
  const [tab,         setTab]         = useState<'summary'|'evidence'>('summary')

  const msgs = (juryCase.evidence_messages || []).map((m: any, i: number, arr: any[]) => ({
    ...m,
    // Anonymise: claimant vs respondent only
    is_claimant: m.sender_id === juryCase.claimant_id,
  }))

  const handleSubmit = async () => {
    if (!verdict) { toast.error('Select a verdict first'); return }
    if (!reviewReady) { toast.error('Please review the evidence before voting'); return }
    setSubmitting(true)

    const reviewed = Math.floor((Date.now() - startedAt) / 1000)
    const { data, error } = await callEdgeFunction('process-dispute', {
      action:        'submit_vote',
      case_id:       juryCase.id,
      verdict,
      reasoning:     reasoning.trim() || null,
      reviewed_for_s: reviewed,
    }, session?.access_token)

    setSubmitting(false)
    if (error) { toast.error(error); return }

    toast.success(data?.case_closed
      ? `⚖️ Verdict reached: ${data.verdict}. Justice served.`
      : `✓ Vote recorded. ${data?.votes_cast} vote(s) so far.`
    )
    onVoted?.()
  }

  return (
    <div className="space-y-5">
      {/* Case header */}
      <div className="bg-obsidian-300 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2 mb-3">
          <Scale size={14} className="text-cyan" />
          <span className="text-xs font-bold text-cyan uppercase tracking-wider">Peer Jury Case</span>
          {juryCase.high_value && (
            <span className="ml-auto tag tag-amber text-[9px]">⚠️ HIGH VALUE ₦50,000+</span>
          )}
        </div>
        <div className="text-sm font-semibold text-white/80 leading-relaxed">
          "{juryCase.dispute_reason}"
        </div>
        <div className="flex items-center gap-4 text-xs text-white/40 pt-2 border-t border-obsidian-500">
          <span>Amount: <span className="text-white/70 font-mono font-bold">{formatNaira(juryCase.amount)}</span></span>
          <span>Votes needed: <span className="text-white/70 font-bold">{juryCase.required_votes}</span></span>
          <span>Filed: <span className="text-white/70">{new Date(juryCase.created_at).toLocaleDateString('en-NG')}</span></span>
        </div>
      </div>

      {/* Tabs: Summary / Evidence */}
      <div className="flex bg-obsidian-300 rounded-xl p-1">
        {(['summary','evidence'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? 'bg-cyan text-obsidian' : 'text-white/40 hover:text-white/60'
            }`}>
            {t === 'summary' ? 'Case Summary' : `Evidence (${msgs.length})`}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <div className="bg-obsidian-300 rounded-xl p-4 space-y-3 text-sm">
          <div className="flex items-start gap-3 pb-3 border-b border-obsidian-500">
            <div className="w-7 h-7 rounded-full bg-cyan/20 flex items-center justify-center text-xs font-bold text-cyan flex-shrink-0">C</div>
            <div>
              <div className="text-xs font-bold text-cyan mb-1">Claimant (Filed Dispute)</div>
              <div className="text-white/70">{juryCase.dispute_reason}</div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-full bg-purple/20 flex items-center justify-center text-xs font-bold text-purple flex-shrink-0">R</div>
            <div>
              <div className="text-xs font-bold text-purple mb-1">Respondent (Defending)</div>
              <div className="text-white/40 italic">No statement submitted — review chat evidence.</div>
            </div>
          </div>
        </div>
      )}

      {tab === 'evidence' && <EvidenceViewer messages={msgs} />}

      {/* High-value review timer */}
      <ReviewTimer required={juryCase.high_value} onReady={() => setReviewReady(true)} />

      {/* Verdict selection */}
      <div>
        <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">Your Verdict</div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { key:'claimant',   label:'Claimant Wins',   desc:'Dispute is valid',     color:'text-plug-green border-plug-green/30 bg-plug-green/10' },
            { key:'split',      label:'Split Decision',  desc:'Both at fault',         color:'text-plug-amber border-plug-amber/30 bg-plug-amber/10' },
            { key:'respondent', label:'Respondent Wins', desc:'Dispute unfounded',     color:'text-purple border-purple/30 bg-purple/10' },
          ].map(v => (
            <button key={v.key} onClick={() => setVerdict(v.key)}
              className={`border rounded-xl p-3 text-left transition-all ${
                verdict === v.key ? v.color : 'border-obsidian-500 bg-transparent text-white/50 hover:border-white/20'
              }`}>
              <div className="text-xs font-bold mb-0.5">{v.label}</div>
              <div className="text-[10px] opacity-70">{v.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Reasoning */}
      <div>
        <label className="label">Your Reasoning (optional)</label>
        <textarea className="input resize-none" rows={2}
          placeholder="Explain your verdict briefly…"
          value={reasoning} onChange={e => setReasoning(e.target.value)} />
      </div>

      {/* Submit */}
      <motion.button whileTap={{ scale: 0.97 }} onClick={handleSubmit}
        disabled={!verdict || !reviewReady || submitting}
        className="w-full py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2
                   bg-cyan text-obsidian disabled:opacity-30 disabled:cursor-not-allowed transition-all">
        <Scale size={15} />
        {submitting ? 'Submitting…' : 'Submit Verdict'}
      </motion.button>

      <p className="text-center text-xs text-white/25">
        Correct verdicts earn +20 PlugScore · All votes are anonymous
      </p>
    </div>
  )
}

// ── Jury Portal main ──────────────────────────────────────────────────────────

/**
 * JuryPortal — the full peer jury interface.
 * Shows open cases assigned to this juror, accuracy stats, and rewards.
 */
export function JuryPortal() {
  const { user, profile } = useAuth()
  const qc = useQueryClient()
  const [activeCase, setActiveCase] = useState<any>(null)

  const { data: cases = [], isLoading } = useQuery({
    queryKey: ['jury-cases', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('jury_cases')
        .select('*')
        .eq('status', 'deliberating')
        .contains('jurors_assigned', [user!.id])
        .order('created_at', { ascending: true })
      return data || []
    },
    enabled: !!user?.id,
    staleTime: 30_000,
  })

  // Filter cases the user hasn't voted on yet
  const { data: myVotes = [] } = useQuery({
    queryKey: ['my-jury-votes', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('jury_votes').select('case_id').eq('juror_id', user!.id)
      return (data || []).map(v => v.case_id)
    },
    enabled: !!user?.id,
  })

  const pendingCases = cases.filter(c => !myVotes.includes(c.id))

  if (!profile?.juror_enabled) return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-6 text-center">
      <Scale size={28} className="mx-auto mb-3 text-white/20" />
      <div className="font-bold text-sm mb-1">Jury Access Required</div>
      <p className="text-xs text-white/40">
        Juror status is granted to Trusted+ users with ≥10 completed trades and no active disputes.
      </p>
    </div>
  )

  return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-obsidian-500 bg-cyan/5">
        <div className="flex items-center gap-2">
          <Scale size={16} className="text-cyan" />
          <span className="font-bold text-sm">Jury Portal</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {profile.magistrate_at && (
            <span className="tag tag-amber text-[10px]">⚖️ Magistrate</span>
          )}
          <div className="text-white/40">
            Accuracy: <span className="font-mono font-bold text-cyan">{profile.rolling_accuracy || 0}%</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-0 border-b border-obsidian-500">
        {[
          { label:'Pending Cases',    val: pendingCases.length,                   color:'text-cyan'       },
          { label:'This Week',        val: profile.juror_streak || 0,             color:'text-plug-green' },
          { label:'Free Tokens',      val: profile.free_listing_tokens || 0,      color:'text-plug-amber' },
        ].map(({ label, val, color }, i) => (
          <div key={label} className={`text-center py-4 ${i < 2 ? 'border-r border-obsidian-500' : ''}`}>
            <div className={`text-xl font-black font-mono ${color}`}>{val}</div>
            <div className="text-[10px] text-white/40 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Case list or active case */}
      <div className="p-5">
        <AnimatePresence mode="wait">
          {activeCase ? (
            <motion.div key="case" initial={{ opacity:0, x:20 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:-20 }}>
              <button onClick={() => setActiveCase(null)}
                className="flex items-center gap-1.5 text-xs text-white/40 hover:text-cyan mb-5 transition-colors">
                ← Back to cases
              </button>
              <CaseView juryCase={activeCase} onVoted={() => {
                setActiveCase(null)
                qc.invalidateQueries({ queryKey: ['jury-cases'] })
                qc.invalidateQueries({ queryKey: ['my-jury-votes'] })
              }} />
            </motion.div>
          ) : (
            <motion.div key="list" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}>
              {isLoading && (
                <div className="space-y-3">
                  {[1,2].map(i => <div key={i} className="h-20 bg-obsidian-300 rounded-xl animate-pulse" />)}
                </div>
              )}
              {!isLoading && pendingCases.length === 0 && (
                <div className="text-center py-8">
                  <CheckCircle2 size={28} className="mx-auto mb-3 text-plug-green/40" />
                  <div className="text-sm font-semibold text-white/50">No Pending Cases</div>
                  <div className="text-xs text-white/30 mt-1">You're all caught up. Check back later.</div>
                </div>
              )}
              {pendingCases.map(c => (
                <motion.button key={c.id} whileHover={{ x: 2 }} whileTap={{ scale: 0.98 }}
                  onClick={() => setActiveCase(c)}
                  className="w-full flex items-center gap-3 p-4 bg-obsidian-300 border border-obsidian-500
                             rounded-xl mb-3 text-left hover:border-cyan/30 transition-all">
                  <div className="w-8 h-8 rounded-lg bg-cyan/10 border border-cyan/20 flex items-center justify-center flex-shrink-0">
                    <Scale size={14} className="text-cyan" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{c.dispute_reason.slice(0, 60)}…</div>
                    <div className="flex items-center gap-3 text-xs text-white/40 mt-0.5">
                      <span>{formatNaira(c.amount)}</span>
                      <span>{c.votes_cast}/{c.required_votes} votes</span>
                      {c.high_value && <span className="text-plug-amber font-bold">⚠️ HIGH VALUE</span>}
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-white/20 flex-shrink-0" />
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
