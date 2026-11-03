import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PackageSearch } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import GearRentalPanel from '@/components/gear/GearRentalPanel'

export default function MyRentals() {
  const { user } = useAuth()
  const userId = user?.id
  const { data: rentalRows = [], isLoading: rentalsLoading, error: rentalsError } = useQuery({
    queryKey: ['my-gear-rentals', userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gear_rentals')
        .select('id,listing_id')
        .or(`borrower_id.eq.${userId},lender_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      return data || []
    },
    refetchInterval: 15_000,
  })
  const listingIds = useMemo(() => [...new Set(rentalRows.map(row => row.listing_id).filter(Boolean))], [rentalRows])
  const { data: listings = [], isLoading: listingsLoading, error: listingsError } = useQuery({
    queryKey: ['my-gear-rental-listings', listingIds],
    enabled: listingIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('listings')
        .select('id,title,seller_id,status,listing_mode,rental_daily_rate_kobo,rental_security_deposit_kobo,rental_min_days,rental_max_days')
        .in('id', listingIds)
      if (error) throw error
      return data || []
    },
  })

  const isLoading = rentalsLoading || listingsLoading
  const error = rentalsError || listingsError

  return (
    <div className="page-shell max-w-4xl space-y-5">
      <header>
        <p className="section-label">Campus Gear</p>
        <h1 className="text-2xl font-black tracking-tight">My Rentals</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Track reservations, pickup codes, active rentals, returns, deposits and disputes in one place.</p>
      </header>

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-bold">How rental custody works</h2>
        <ol className="grid gap-3 sm:grid-cols-2">
          <li className="rounded-md border border-outline-variant bg-surface-container p-3"><strong className="text-xs text-primary">1. Reserve and pay</strong><p className="mt-1 text-xs leading-5 text-on-surface-variant">Campus Wallet holds the rental fee and refundable deposit before pickup.</p></li>
          <li className="rounded-md border border-outline-variant bg-surface-container p-3"><strong className="text-xs text-primary">2. Verify pickup</strong><p className="mt-1 text-xs leading-5 text-on-surface-variant">The lender generates a one-time code. The borrower enters it at the physical handoff.</p></li>
          <li className="rounded-md border border-outline-variant bg-surface-container p-3"><strong className="text-xs text-primary">3. Return the item</strong><p className="mt-1 text-xs leading-5 text-on-surface-variant">The borrower generates a return code and gives it to the lender with the item.</p></li>
          <li className="rounded-md border border-outline-variant bg-surface-container p-3"><strong className="text-xs text-primary">4. Settle the hold</strong><p className="mt-1 text-xs leading-5 text-on-surface-variant">The lender confirms return. The rental fee is released and the deposit is refunded. Disputes keep funds held.</p></li>
        </ol>
        <p className="text-[11px] leading-5 text-on-surface-variant">Rental payments currently use Campus Wallet only and are capped at ₦10,000 per reservation. Cash and Paystack rental checkout are not supported in this release.</p>
      </section>

      {isLoading ? <div className="surface p-8 text-center text-sm text-on-surface-variant">Loading your rentals…</div>
        : error ? <div className="surface p-6 text-sm text-error">Could not load rentals. {error instanceof Error ? error.message : ''}</div>
        : listings.length === 0 ? <div className="surface flex flex-col items-center p-10 text-center"><PackageSearch size={32} className="mb-3 text-on-surface-variant/40"/><h2 className="font-bold">No rentals yet</h2><p className="mt-1 max-w-sm text-sm text-on-surface-variant">When you reserve or lend an item, its pickup, return and settlement steps will appear here.</p></div>
        : <div className="space-y-5">{listings.map(listing => <GearRentalPanel key={listing.id} listing={listing} allowRequest={false} />)}</div>}
    </div>
  )
}
