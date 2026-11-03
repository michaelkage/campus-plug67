import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, KeyRound, PackageCheck, ShieldAlert } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/AuthContext'
import { formatNaira, supabase } from '@/lib/supabase'

type ListingForRental = {
  id: string
  seller_id: string
  status: string
  listing_mode: 'sale' | 'both'
  rental_daily_rate_kobo: number | null
  rental_security_deposit_kobo: number
  rental_min_days: number
  rental_max_days: number
  title: string
}

type Rental = {
  id: string
  listing_id: string
  borrower_id: string
  lender_id: string
  rental_status: string
  start_date: string
  end_date: string
  rental_fee_kobo: number
  security_deposit_kobo: number
  total_held_kobo: number
  created_at: string
  dispute_reason: string | null
}

function localDateInputValue() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function inclusiveDays(start: string, end: string) {
  if (!start || !end) return 0
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.floor((b - a) / 86_400_000) + 1 : 0
}

async function rentalRpc<T = Record<string, unknown>>(name: string, params: Record<string, unknown>): Promise<T> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    rpcName: string,
    rpcParams: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: { message: string } | null }>
  const { data, error } = await rpc(name, params)
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Rental service returned no result')
  const result = data as T & { success?: boolean; message?: string }
  if (result.success === false) throw new Error(result.message || 'Rental action could not be completed')
  return result
}

const STATUS_COPY: Record<string, string> = {
  funds_escrowed: 'Payment and security deposit are held. The lender must generate a pickup code, then the borrower confirms the handoff.',
  active: 'The borrower has the item. Keep it safe and return it to the lender by the agreed end date.',
  return_pending: 'The borrower generated a return code. The lender must inspect the item and confirm receipt.',
  completed: 'Return confirmed. The rental fee was released to the lender and the security deposit was returned to the borrower.',
  cancelled: 'Cancelled before pickup. The full wallet hold was refunded to the borrower.',
  disputed: 'Funds remain held while Campus Plug reviews the dispute. Neither party can settle this rental directly.',
  resolved: 'Campus Plug reviewed the dispute and settled the held funds.',
}

export default function GearRentalPanel({ listing, allowRequest = true }: { listing: ListingForRental; allowRequest?: boolean }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [pickupCode, setPickupCode] = useState('')
  const [pickupInput, setPickupInput] = useState('')
  const [returnCode, setReturnCode] = useState('')
  const [returnInput, setReturnInput] = useState('')
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeFor, setDisputeFor] = useState<string | null>(null)

  const isOwner = user?.id === listing.seller_id
  const days = inclusiveDays(startDate, endDate)
  const dailyRate = Number(listing.rental_daily_rate_kobo || 0)
  const deposit = Number(listing.rental_security_deposit_kobo || 0)
  const rentalFee = dailyRate * days
  const total = rentalFee + deposit
  const estimateValid = days >= listing.rental_min_days && days <= listing.rental_max_days && total > 0 && total <= 1_000_000

  const { data: rentals = [], isLoading } = useQuery<Rental[]>({
    queryKey: ['gear-rentals', listing.id, user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gear_rentals')
        .select('id,listing_id,borrower_id,lender_id,rental_status,start_date,end_date,rental_fee_kobo,security_deposit_kobo,total_held_kobo,created_at,dispute_reason')
        .eq('listing_id', listing.id)
        .or(`borrower_id.eq.${user!.id},lender_id.eq.${user!.id}`)
        .order('created_at', { ascending: false })
        .limit(20)
      if (error) throw error
      return (data || []) as Rental[]
    },
    refetchInterval: 10_000,
  })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['gear-rentals', listing.id] }),
      queryClient.invalidateQueries({ queryKey: ['listing', listing.id] }),
    ])
  }

  const createMutation = useMutation({
    mutationFn: () => rentalRpc('create_gear_rental_request', {
      p_listing_id: listing.id,
      p_start_date: startDate,
      p_end_date: endDate,
      p_request_key: crypto.randomUUID(),
    }),
    onSuccess: async () => {
      toast.success('Rental reserved. Your wallet payment and security deposit are now held.')
      setStartDate('')
      setEndDate('')
      await invalidate()
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not reserve this rental'),
  })

  const pickupCodeMutation = useMutation({
    mutationFn: (rentalId: string) => rentalRpc<{ pickup_code: string }>('create_gear_rental_pickup_code', { p_rental_id: rentalId }),
    onSuccess: data => { setPickupCode(data.pickup_code); setPickupInput(''); toast.success('Pickup code generated. Share it only at the physical handoff.') },
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not generate pickup code'),
  })
  const confirmPickupMutation = useMutation({
    mutationFn: (rentalId: string) => rentalRpc('confirm_gear_rental_pickup', { p_rental_id: rentalId, p_pickup_code: pickupInput.trim().toUpperCase() }),
    onSuccess: async () => { setPickupInput(''); toast.success('Pickup confirmed. Rental is now active.'); await invalidate() },
    onError: error => toast.error(error instanceof Error ? error.message : 'Pickup verification failed'),
  })
  const returnCodeMutation = useMutation({
    mutationFn: (rentalId: string) => rentalRpc<{ return_code: string }>('create_gear_rental_return_code', { p_rental_id: rentalId }),
    onSuccess: data => { setReturnCode(data.return_code); setReturnInput(''); toast.success('Return code generated. Show it to the lender when handing the item back.') },
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not generate return code'),
  })
  const confirmReturnMutation = useMutation({
    mutationFn: (rentalId: string) => rentalRpc('confirm_gear_rental_return', { p_rental_id: rentalId, p_return_code: returnInput.trim().toUpperCase() }),
    onSuccess: async () => { setReturnInput(''); toast.success('Return confirmed. Rental fee released and deposit refunded.'); await invalidate() },
    onError: error => toast.error(error instanceof Error ? error.message : 'Return verification failed'),
  })
  const cancelMutation = useMutation({
    mutationFn: (rentalId: string) => rentalRpc('cancel_gear_rental_request', { p_rental_id: rentalId }),
    onSuccess: async () => { toast.success('Rental cancelled and wallet hold refunded.'); await invalidate() },
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not cancel rental'),
  })
  const disputeMutation = useMutation({
    mutationFn: ({ rentalId, reason }: { rentalId: string; reason: string }) => rentalRpc('open_gear_rental_dispute', { p_rental_id: rentalId, p_reason: reason }),
    onSuccess: async () => { setDisputeFor(null); setDisputeReason(''); toast.success('Dispute opened. Funds remain held pending review.'); await invalidate() },
    onError: error => toast.error(error instanceof Error ? error.message : 'Could not open dispute'),
  })

  const busy = createMutation.isPending || pickupCodeMutation.isPending || confirmPickupMutation.isPending ||
    returnCodeMutation.isPending || confirmReturnMutation.isPending || cancelMutation.isPending || disputeMutation.isPending

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('Code copied')
    } catch {
      toast.error('Copy unavailable. Select and copy the code manually.')
    }
  }

  const canRequest = Boolean(allowRequest && user && !isOwner && listing.status === 'active' && listing.listing_mode === 'both')

  return (
    <section className="surface space-y-4 p-4 sm:p-5" aria-labelledby="gear-rental-title">
      <div className="flex items-center gap-2">
        <PackageCheck size={16} className="text-primary" />
        <h2 id="gear-rental-title" className="font-bold text-sm">Rent this item</h2>
        <span className="ml-auto rounded-sm border border-primary/20 bg-primary/5 px-2 py-1 text-[10px] font-bold text-primary">CAMPUS WALLET</span>
      </div>
      <div className="rounded-md border border-outline-variant bg-surface-container p-3 text-xs leading-5 text-on-surface-variant">
        <p>Rental fee: <strong className="text-on-surface">{formatNaira(dailyRate)} per day</strong></p>
        <p>Refundable security deposit: <strong className="text-on-surface">{formatNaira(deposit)}</strong></p>
        <p>Duration: {listing.rental_min_days} to {listing.rental_max_days} days. Total wallet hold must not exceed ₦10,000.</p>
      </div>

      {canRequest && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-semibold text-on-surface-variant">
              Start date
              <input className="input" type="date" min={localDateInputValue()} value={startDate} onChange={event => setStartDate(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs font-semibold text-on-surface-variant">
              End date
              <input className="input" type="date" min={startDate || localDateInputValue()} value={endDate} onChange={event => setEndDate(event.target.value)} />
            </label>
          </div>
          {days > 0 && (
            <div className="rounded-md border border-outline-variant p-3 text-xs">
              <div className="flex justify-between"><span>{days} day{days === 1 ? '' : 's'} × {formatNaira(dailyRate)}</span><strong>{formatNaira(rentalFee)}</strong></div>
              <div className="mt-1 flex justify-between"><span>Refundable deposit</span><strong>{formatNaira(deposit)}</strong></div>
              <div className="mt-2 flex justify-between border-t border-outline-variant pt-2 text-sm"><span className="font-bold">Total held now</span><strong className="font-black text-primary">{formatNaira(total)}</strong></div>
            </div>
          )}
          <button type="button" className="btn-primary w-full" disabled={!estimateValid || busy || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? 'Securing rental…' : 'Reserve dates and hold wallet funds'}
          </button>
          <p className="text-[11px] leading-5 text-on-surface-variant">Funds stay in Campus Wallet escrow. The lender receives the rental fee only after confirming the item has been returned. The security deposit is refunded at the same time. No cash handoff is required.</p>
        </div>
      )}
      {!user && <p className="text-xs text-on-surface-variant">Sign in to reserve this item.</p>}
      {isOwner && <p className="text-xs text-on-surface-variant">This is your listing. You can manage incoming rental requests below.</p>}
      {allowRequest && listing.listing_mode !== 'both' && <p className="text-xs text-on-surface-variant">The owner has not enabled rentals for this listing.</p>}

      {user && (
        <div className="space-y-3 border-t border-outline-variant pt-4">
          <h3 className="text-xs font-bold">Your rentals for this item</h3>
          {isLoading ? <p className="text-xs text-on-surface-variant">Loading rental activity…</p> : rentals.length === 0 ? <p className="text-xs text-on-surface-variant">No rental reservations yet.</p> : rentals.map(rental => {
            const borrower = rental.borrower_id === user.id
            const lender = rental.lender_id === user.id
            return (
              <article key={rental.id} className="rounded-md border border-outline-variant p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold">{borrower ? 'You are renting this item' : 'You are lending this item'}</p>
                    <p className="mt-1 text-[11px] text-on-surface-variant">{rental.start_date} to {rental.end_date} · {formatNaira(rental.total_held_kobo)} held</p>
                  </div>
                  <span className="rounded-sm bg-surface-container px-2 py-1 text-[10px] font-bold uppercase">{rental.rental_status.replaceAll('_', ' ')}</span>
                </div>
                <p className="text-xs leading-5 text-on-surface-variant">{STATUS_COPY[rental.rental_status] || 'Rental status updated.'}</p>

                {rental.rental_status === 'funds_escrowed' && lender && (
                  <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => pickupCodeMutation.mutate(rental.id)}>
                    <KeyRound size={14} /> Generate pickup code
                  </button>
                )}
                {rental.rental_status === 'funds_escrowed' && borrower && (
                  <div className="flex gap-2">
                    <input className="input min-w-0" value={pickupInput} onChange={event => setPickupInput(event.target.value.toUpperCase().slice(0, 8))} placeholder="8-character pickup code" autoComplete="one-time-code" />
                    <button type="button" className="btn-primary shrink-0" disabled={busy || pickupInput.trim().length !== 8} onClick={() => confirmPickupMutation.mutate(rental.id)}>Confirm pickup</button>
                  </div>
                )}
                {rental.rental_status === 'active' && borrower && (
                  <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => returnCodeMutation.mutate(rental.id)}>
                    <KeyRound size={14} /> Generate return code
                  </button>
                )}
                {rental.rental_status === 'return_pending' && borrower && (
                  <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => returnCodeMutation.mutate(rental.id)}>
                    Generate a fresh return code
                  </button>
                )}
                {rental.rental_status === 'return_pending' && lender && (
                  <div className="flex gap-2">
                    <input className="input min-w-0" value={returnInput} onChange={event => setReturnInput(event.target.value.toUpperCase().slice(0, 8))} placeholder="8-character return code" autoComplete="one-time-code" />
                    <button type="button" className="btn-primary shrink-0" disabled={busy || returnInput.trim().length !== 8} onClick={() => confirmReturnMutation.mutate(rental.id)}>Confirm return</button>
                  </div>
                )}

                {pickupCode && lender && rental.rental_status === 'funds_escrowed' && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                    <p className="text-[10px] font-bold uppercase text-primary">One-time pickup code</p>
                    <div className="mt-2 flex items-center justify-between gap-2"><code className="text-lg font-black tracking-widest">{pickupCode}</code><button type="button" onClick={() => void copyCode(pickupCode)} className="btn-secondary"><Copy size={13} /> Copy</button></div>
                    <p className="mt-1 text-[10px] text-on-surface-variant">Valid for 15 minutes. Give this to the borrower only when physically handing over the item.</p>
                  </div>
                )}
                {returnCode && borrower && ['active','return_pending'].includes(rental.rental_status) && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                    <p className="text-[10px] font-bold uppercase text-primary">One-time return code</p>
                    <div className="mt-2 flex items-center justify-between gap-2"><code className="text-lg font-black tracking-widest">{returnCode}</code><button type="button" onClick={() => void copyCode(returnCode)} className="btn-secondary"><Copy size={13} /> Copy</button></div>
                    <p className="mt-1 text-[10px] text-on-surface-variant">Valid for 15 minutes. Share it only when returning the item to its owner.</p>
                  </div>
                )}

                {rental.rental_status === 'funds_escrowed' && (
                  <button type="button" className="text-xs font-semibold text-error" disabled={busy} onClick={() => {
                    if (window.confirm('Cancel this rental before pickup? The full wallet hold will be refunded to the borrower.')) cancelMutation.mutate(rental.id)
                  }}>Cancel before pickup</button>
                )}
                {['funds_escrowed','active','return_pending'].includes(rental.rental_status) && (
                  <div className="space-y-2">
                    {disputeFor === rental.id ? (
                      <>
                        <textarea className="input w-full" rows={3} maxLength={2000} value={disputeReason} onChange={event => setDisputeReason(event.target.value)} placeholder="Describe the issue in at least 20 characters." />
                        <div className="flex gap-2"><button type="button" className="btn-secondary flex-1" onClick={() => { setDisputeFor(null); setDisputeReason('') }}>Keep rental active</button><button type="button" className="btn-primary flex-1" disabled={busy || disputeReason.trim().length < 20} onClick={() => disputeMutation.mutate({ rentalId: rental.id, reason: disputeReason.trim() })}>Open dispute</button></div>
                      </>
                    ) : <button type="button" className="text-xs font-semibold text-error" disabled={busy} onClick={() => setDisputeFor(rental.id)}><ShieldAlert size={13} className="inline mr-1" />Report a problem</button>}
                  </div>
                )}
                {rental.rental_status === 'completed' && <div className="flex items-center gap-2 text-xs text-primary"><CheckCircle2 size={14} /> Return verified and funds settled</div>}
                {rental.rental_status === 'disputed' && <div className="flex items-center gap-2 text-xs text-tertiary"><ShieldAlert size={14} /> Under Campus Plug review</div>}
                {rental.rental_status === 'resolved' && <div className="flex items-center gap-2 text-xs text-primary"><CheckCircle2 size={14} /> Dispute settlement complete</div>}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
