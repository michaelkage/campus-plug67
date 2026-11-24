import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileSearch, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

const BUCKET = 'campus-verification-evidence'

export default function CampusVerificationReview() {
  const queryClient = useQueryClient()
  const [reasons, setReasons] = useState({})
  const [previewUrls, setPreviewUrls] = useState({})
  const [busyId, setBusyId] = useState('')

  const { data: requests = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-campus-verification-queue'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_campus_verification_review_queue')
      if (error) throw error
      return Array.isArray(data) ? data : []
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  })

  const previewEvidence = async request => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(request.evidence_path, 60)
    if (error) {
      toast.error(error.message || 'Unable to open private evidence')
      return
    }
    setPreviewUrls(current => ({ ...current, [request.id]: data.signedUrl }))
  }

  const review = async (request, decision) => {
    const reason = String(reasons[request.id] || '').trim()
    if (decision === 'rejected' && reason.length < 8) {
      toast.error('Add a clear rejection reason of at least 8 characters')
      return
    }
    setBusyId(request.id)
    const { error } = await supabase.rpc('review_campus_verification_request', {
      p_request_id: request.id,
      p_decision: decision,
      p_reason: decision === 'rejected' ? reason : null,
    })
    if (error) {
      setBusyId('')
      toast.error(error.message || 'Campus review failed')
      return
    }

    // Evidence is no longer needed after the decision. Removal is best-effort;
    // the private bucket and its short-lived signed URLs remain access controlled.
    const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([request.evidence_path])
    setBusyId('')
    setReasons(current => ({ ...current, [request.id]: '' }))
    setPreviewUrls(current => {
      const next = { ...current }
      delete next[request.id]
      return next
    })
    await queryClient.invalidateQueries({ queryKey: ['admin-campus-verification-queue'] })
    await queryClient.invalidateQueries({ queryKey: ['admin-console-snapshot'] })
    if (cleanupError) toast.error('Decision saved, but evidence cleanup failed. Keep this request in the retention cleanup queue.')
    else toast.success(decision === 'approved' ? 'Campus membership approved and evidence deleted' : 'Campus membership rejected and evidence deleted')
  }

  return (
    <section className="space-y-4">
      <header className="surface flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="font-black">Campus membership review</h2>
          <p className="mt-1 text-xs text-on-surface-variant">Review private student evidence. Peer vouches are supplemental and never approve membership automatically.</p>
        </div>
        <button className="btn-secondary text-sm" onClick={() => void refetch()} disabled={isLoading}>
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Refresh queue
        </button>
      </header>

      {isError && <div className="surface p-4 text-sm text-error" role="alert">The campus verification queue could not be loaded.</div>}
      {isLoading ? <div className="surface p-8 text-center text-sm text-on-surface-variant">Loading verification requests…</div>
        : requests.length === 0 ? <div className="surface p-8 text-center text-sm text-on-surface-variant">No campus verification requests are awaiting review.</div>
          : requests.map(request => (
            <article key={request.id} className="surface space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold">{request.applicant_name || 'Student account'}</h3>
                  <p className="mt-1 text-xs text-on-surface-variant">{request.applicant_email}</p>
                  <p className="mt-1 text-xs font-semibold text-primary">{request.institution_name}</p>
                </div>
                <span className="rounded-sm bg-surface-container px-2 py-1 text-[11px] font-bold">{request.vouch_count} peer vouch{request.vouch_count === 1 ? '' : 'es'}</span>
              </div>
              {request.peer_vouches?.length > 0 && (
                <div className="rounded-md border border-outline-variant p-3">
                  <p className="text-xs font-bold">Peer attestations</p>
                  <ul className="mt-2 space-y-1 text-xs text-on-surface-variant">
                    {request.peer_vouches.map((vouch, index) => (
                      <li key={index}>{vouch.name || 'Verified campus member'} · account since {new Date(vouch.account_created_at).toLocaleDateString()}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <div><p className="text-on-surface-variant">Matric number</p><p className="mt-1 font-mono font-semibold">{request.matric_number}</p></div>
                <div><p className="text-on-surface-variant">Submitted</p><p className="mt-1 font-semibold">{new Date(request.submitted_at).toLocaleString()}</p></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-secondary text-sm" onClick={() => void previewEvidence(request)}>
                  <FileSearch size={14} /> Generate 60-second evidence link
                </button>
                {previewUrls[request.id] && <a className="text-sm font-semibold text-primary underline" href={previewUrls[request.id]} target="_blank" rel="noreferrer">Open private evidence</a>}
              </div>
              <label className="block space-y-1 text-xs font-semibold text-on-surface-variant" htmlFor={`campus-review-reason-${request.id}`}>
                Reviewer note (required for rejection)
                <textarea id={`campus-review-reason-${request.id}`} className="input min-h-20 w-full" value={reasons[request.id] || ''} onChange={event => setReasons(current => ({ ...current, [request.id]: event.target.value }))} maxLength={1000} placeholder="Record a concise, actionable reason…" />
              </label>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary" disabled={busyId === request.id} onClick={() => void review(request, 'approved')}>
                  <CheckCircle2 size={15} /> Approve membership
                </button>
                <button className="btn-secondary text-error" disabled={busyId === request.id} onClick={() => void review(request, 'rejected')}>
                  <XCircle size={15} /> Reject request
                </button>
                {busyId === request.id && <span className="self-center text-xs text-on-surface-variant">Saving decision…</span>}
              </div>
              <p className="flex items-start gap-2 text-[11px] leading-4 text-on-surface-variant"><ShieldAlert size={14} className="shrink-0" /> Approval grants campus membership only. It does not grant platform-admin access or a trust-score reward.</p>
            </article>
          ))}
    </section>
  )
}
