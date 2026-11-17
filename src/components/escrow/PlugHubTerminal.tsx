import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import GearRentalPanel from '@/components/gear/GearRentalPanel'

type Props = { rentalId: string; transactionId?: string }

export default function PlugHubTerminal({ rentalId }: Props) {
  const { data: rental, isLoading: rentalLoading, error: rentalError } = useQuery({
    queryKey: ['gear-rental-terminal', rentalId],
    enabled: Boolean(rentalId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gear_rentals')
        .select('id, listing_id, rental_status')
        .eq('id', rentalId)
        .single()
      if (error) throw error
      return data
    },
  })

  const { data: listing, isLoading: listingLoading, error: listingError } = useQuery({
    queryKey: ['gear-rental-listing', rental?.listing_id],
    enabled: Boolean(rental?.listing_id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('listings')
        .select('id, seller_id, status, listing_mode, rental_daily_rate_kobo, rental_security_deposit_kobo, rental_min_days, rental_max_days, title')
        .eq('id', rental!.listing_id)
        .single()
      if (error) throw error
      return data
    },
  })

  if (rentalLoading || listingLoading) {
    return <div className="surface p-8 text-center text-on-surface-variant animate-pulse">Loading rental details…</div>
  }
  if (rentalError || listingError || !rental || !listing) {
    return <div className="surface p-8 text-center text-error">This rental is unavailable or you are not a participant.</div>
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <p className="text-xs text-on-surface-variant">
        Rental {rental.id.slice(0, 8).toUpperCase()} · {rental.rental_status.replaceAll('_', ' ')}
      </p>
      <GearRentalPanel listing={listing} />
    </div>
  )
}
