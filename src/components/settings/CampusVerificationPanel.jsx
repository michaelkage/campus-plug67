import { useCallback, useEffect, useState } from 'react'
import { FileCheck2, GraduationCap, ShieldCheck, Upload, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import toast from 'react-hot-toast'

const BUCKET = 'campus-verification-evidence'
const MAX_FILE_BYTES = 5 * 1024 * 1024
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

export default function CampusVerificationPanel() {
  const { user, profile, refreshProfile } = useAuth()
  const [institutions, setInstitutions] = useState([])
  const [memberships, setMemberships] = useState([])
  const [requests, setRequests] = useState([])
  const [institutionId, setInstitutionId] = useState('')
  const [matricNumber, setMatricNumber] = useState('')
  const [evidence, setEvidence] = useState(null)
  const [vouchCode, setVouchCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const loadData = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    const [directory, membershipRows, requestRows] = await Promise.all([
      supabase.from('institutions').select('id,name').eq('is_active', true).order('name'),
      supabase.from('institution_memberships').select('id,institution_id,status,is_primary,verified_at').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('campus_verification_requests').select('id,institution_id,status,submitted_at,review_reason,reviewed_at').eq('user_id', user.id).order('submitted_at', { ascending: false }),
    ])
    setLoading(false)
    const failed = [directory, membershipRows, requestRows].find(result => result.error)
    if (failed?.error) {
      toast.error(failed.error.message || 'Unable to load campus verification')
      return
    }
    setInstitutions(directory.data || [])
    setMemberships(membershipRows.data || [])
    setRequests(requestRows.data || [])
    setInstitutionId(current => current || directory.data?.[0]?.id || '')
  }, [user?.id])

  useEffect(() => { void loadData() }, [loadData])

  const verifyInstitutionEmail = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('claim_my_institution_membership')
    setLoading(false)
    if (error) {
      toast.error(error.message || 'Institutional email verification failed')
      return
    }
    await refreshProfile()
    await loadData()
    toast.success(data?.institution_name ? `Verified ${data.institution_name}` : 'Campus membership verified')
  }

  const submitEvidence = async event => {
    event.preventDefault()
    if (!user?.id || !institutionId || !evidence) return
    const extension = EXTENSIONS[evidence.type]
    if (!extension) {
      toast.error('Upload a JPG, PNG, WebP image or PDF')
      return
    }
    if (evidence.size <= 0 || evidence.size > MAX_FILE_BYTES) {
      toast.error('Evidence must be between 1 byte and 5 MB')
      return
    }
    const normalizedMatric = matricNumber.trim().toUpperCase().replace(/\s+/g, '')
    if (!/^[A-Z0-9/-]{4,32}$/.test(normalizedMatric)) {
      toast.error('Enter a matric number using 4 to 32 letters, numbers, hyphens or slashes')
      return
    }

    setSubmitting(true)
    const objectPath = `${user.id}/${institutionId}/${crypto.randomUUID()}.${extension}`
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, evidence, {
      cacheControl: '3600',
      upsert: false,
      contentType: evidence.type,
    })
    if (uploadError) {
      setSubmitting(false)
      toast.error(uploadError.message || 'Evidence upload failed')
      return
    }

    const { error } = await supabase.rpc('submit_my_campus_verification', {
      p_institution_id: institutionId,
      p_matric_number: normalizedMatric,
      p_evidence_path: objectPath,
      p_evidence_mime_type: evidence.type,
    })
    if (error) {
      const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([objectPath])
      setSubmitting(false)
      toast.error(cleanupError
        ? `${error.message}. Evidence cleanup needs support review.`
        : error.message || 'Campus verification submission failed')
      return
    }

    setMatricNumber('')
    setEvidence(null)
    event.target.reset()
    setSubmitting(false)
    await loadData()
    toast.success('Campus evidence submitted. Your membership stays pending until an authorized reviewer approves it.')
  }

  const submitVouch = async event => {
    event.preventDefault()
    const requestId = vouchCode.trim()
    if (!requestId) return
    setSubmitting(true)
    const { error } = await supabase.rpc('vouch_for_campus_verification', { p_request_id: requestId })
    setSubmitting(false)
    if (error) {
      toast.error(error.message || 'Unable to submit campus vouch')
      return
    }
    setVouchCode('')
    toast.success('Your vouch was recorded as supplemental evidence. It does not approve the membership.')
  }

  const institutionName = id => institutions.find(item => item.id === id)?.name || 'Campus'
  const verifiedMemberships = memberships.filter(item => item.status === 'verified')
  const hasPending = requests.some(item => item.status === 'pending_review')

  return (
    <section className="surface space-y-5 p-5">
      <div className="flex items-center gap-3">
        <GraduationCap size={19} className="text-primary" />
        <div>
          <h2 className="font-black">Campus identity</h2>
          <p className="text-xs text-on-surface/50">Account email confirmation and student membership verification are separate checks.</p>
        </div>
      </div>

      <div className="rounded-md border border-outline-variant p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="mt-0.5 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Institutional email</p>
            <p className="mt-1 text-xs text-on-surface/50">If your university issued you an approved campus email, confirm it on this account and claim membership automatically.</p>
            <p className="mt-2 break-all font-mono text-xs text-on-surface/70">{user?.email}</p>
          </div>
        </div>
        <button className="btn-secondary mt-3" onClick={() => void verifyInstitutionEmail()} disabled={loading || !user?.email}>
          Verify approved university email
        </button>
      </div>

      <form onSubmit={submitEvidence} className="space-y-3 rounded-md border border-outline-variant p-4" aria-busy={submitting}>
        <div>
          <h3 className="text-sm font-bold">No access to a university email?</h3>
          <p className="mt-1 text-xs leading-5 text-on-surface/50">Use your personal confirmed email, select your institution and submit student evidence for human review. Matric format checks are not proof by themselves.</p>
        </div>
        <div>
          <label className="label" htmlFor="campus-evidence-institution">Institution</label>
          <select id="campus-evidence-institution" className="input" value={institutionId} onChange={event => setInstitutionId(event.target.value)} required disabled={loading || institutions.length === 0}>
            <option value="">Select your institution</option>
            {institutions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="campus-evidence-matric">Matric number</label>
          <input id="campus-evidence-matric" className="input" value={matricNumber} onChange={event => setMatricNumber(event.target.value)} minLength={4} maxLength={32} autoComplete="off" required />
          <p className="mt-1 text-[11px] text-on-surface/45">Visible only to you and authorized reviewers. Never shown on your public profile.</p>
        </div>
        <div>
          <label className="label" htmlFor="campus-evidence-file">Student ID or enrollment evidence</label>
          <input id="campus-evidence-file" className="input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => setEvidence(event.target.files?.[0] || null)} required />
          <p className="mt-1 text-[11px] leading-4 text-on-surface/45">Private upload, JPG/PNG/WebP/PDF, maximum 5 MB. Remove unrelated personal details before upload. Reviewers delete evidence after a decision; pending evidence remains private while awaiting review.</p>
        </div>
        <button type="submit" className="btn-primary w-full sm:w-auto" disabled={submitting || loading || !institutionId || !evidence || hasPending}>
          <Upload size={15} /> {submitting ? 'Submitting securely…' : hasPending ? 'Request awaiting review' : 'Submit for campus review'}
        </button>
      </form>

      <div className="space-y-2">
        <div className="flex items-center gap-2"><FileCheck2 size={17} className="text-primary" /><h3 className="text-sm font-bold">Verification history</h3></div>
        {loading && <p className="text-xs text-on-surface/45">Loading campus status…</p>}
        {!loading && requests.length === 0 && <p className="rounded-md bg-surface-container p-3 text-xs text-on-surface/55">No manual verification requests yet.</p>}
        {requests.map(request => (
          <article key={request.id} className="rounded-md border border-outline-variant p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-sm font-semibold">{institutionName(request.institution_id)}</p><p className="text-[11px] text-on-surface/45">{new Date(request.submitted_at).toLocaleString()}</p></div>
              <span className="rounded-sm bg-surface-container px-2 py-1 text-[11px] font-bold capitalize">{request.status.replace('_', ' ')}</span>
            </div>
            {request.review_reason && <p className="mt-2 text-xs text-on-surface/60">Reviewer note: {request.review_reason}</p>}
            <p className="mt-2 break-all font-mono text-[10px] text-on-surface/30">Vouch code: {request.id}</p>
          </article>
        ))}
      </div>

      {verifiedMemberships.length > 0 && (
        <form onSubmit={submitVouch} className="space-y-2 rounded-md border border-outline-variant p-4" aria-busy={submitting}>
          <div className="flex items-center gap-2"><Users size={17} className="text-primary" /><h3 className="text-sm font-bold">Vouch for a classmate</h3></div>
          <p className="text-xs leading-5 text-on-surface/50">Only verified members of the same institution with an account at least 30 days old can vouch. A vouch is supporting evidence, never automatic approval.</p>
          <label className="label" htmlFor="campus-vouch-code">Classmate’s verification code</label>
          <input id="campus-vouch-code" className="input font-mono" value={vouchCode} onChange={event => setVouchCode(event.target.value)} placeholder="Paste the request code they shared" required />
          <button className="btn-secondary" type="submit" disabled={submitting || !vouchCode.trim()}>Submit peer vouch</button>
        </form>
      )}

      <div className="text-xs text-on-surface/45">
        {verifiedMemberships.length
          ? `Verified memberships: ${verifiedMemberships.map(item => institutionName(item.institution_id)).join(', ')}`
          : 'Campus-only privileges, verified badges and trust rewards remain locked until membership is approved.'}
        {profile?.university && <span className="block mt-1">Legacy campus label: {profile.university}</span>}
      </div>
    </section>
  )
}
