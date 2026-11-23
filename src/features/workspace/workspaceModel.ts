export type WorkspaceAction = {
  id: string
  kind: 'purchase' | 'service' | 'rental'
  title: string
  detail: string
  href: string
  priority: 'urgent' | 'normal'
}

type TransactionLike = {
  id: string
  buyer_id: string
  seller_id: string
  listing_id: string | null
  status: string
  escrow_status: string
}

type BookingLike = {
  id: string
  client_id: string
  seller_id: string
  status: string
  gigs?: { title?: string | null } | null
}

type RentalLike = {
  id: string
  borrower_id: string
  lender_id: string
  rental_status: string
}

export function buildWorkspaceActions(
  userId: string,
  transactions: TransactionLike[],
  bookings: BookingLike[],
  rentals: RentalLike[],
): WorkspaceAction[] {
  const actions: WorkspaceAction[] = []

  for (const transaction of transactions) {
    if (['cancelled', 'released'].includes(transaction.status) ||
        ['released', 'refunded'].includes(transaction.escrow_status)) continue

    const isBuyer = transaction.buyer_id === userId
    const disputed = transaction.status === 'disputed'
    const title = disputed
      ? 'Dispute needs attention'
      : transaction.status === 'release_requested'
        ? isBuyer ? 'Inspect item and respond' : 'Awaiting buyer inspection'
        : transaction.status === 'meetup_initiated'
          ? 'Finish the handoff'
          : transaction.status === 'locked'
            ? isBuyer ? 'Arrange item pickup' : 'Prepare item handoff'
            : 'Complete purchase payment'
    actions.push({
      id: `purchase:${transaction.id}`,
      kind: 'purchase',
      title,
      detail: isBuyer ? 'You are the buyer' : 'You are the seller',
      href: transaction.listing_id ? `/marketplace/${transaction.listing_id}` : '/chat',
      priority: disputed ? 'urgent' : 'normal',
    })
  }

  for (const booking of bookings) {
    if (['completed', 'cancelled'].includes(booking.status)) continue
    const isClient = booking.client_id === userId
    const title = booking.status === 'disputed'
      ? 'Service dispute needs attention'
      : booking.status === 'delivered'
        ? isClient ? 'Review delivered service' : 'Awaiting customer review'
        : booking.status === 'in_progress'
          ? isClient ? 'Service in progress' : 'Continue service delivery'
          : booking.status === 'quoted'
            ? isClient ? 'Review provider quote' : 'Quote sent, awaiting response'
            : booking.status === 'confirmed'
              ? isClient ? 'Fund service booking' : 'Booking confirmed'
              : 'Respond to service request'
    actions.push({
      id: `service:${booking.id}`,
      kind: 'service',
      title,
      detail: booking.gigs?.title || 'Student service booking',
      href: '/gigs',
      priority: booking.status === 'disputed' || booking.status === 'delivered' ? 'urgent' : 'normal',
    })
  }

  for (const rental of rentals) {
    if (['completed', 'cancelled'].includes(rental.rental_status)) continue
    const isBorrower = rental.borrower_id === userId
    const title = rental.rental_status === 'disputed'
      ? 'Rental dispute needs attention'
      : rental.rental_status === 'payment_pending'
        ? 'Complete rental payment'
        : rental.rental_status === 'funds_escrowed'
          ? isBorrower ? 'Arrange item pickup' : 'Prepare item for pickup'
          : rental.rental_status === 'active'
            ? isBorrower ? 'Rental active, return item on time' : 'Rental item is with borrower'
            : rental.rental_status === 'return_pending'
              ? 'Verify returned item'
              : rental.rental_status === 'return_inspection'
                ? 'Complete return inspection'
                : 'Review rental status'
    actions.push({
      id: `rental:${rental.id}`,
      kind: 'rental',
      title,
      detail: isBorrower ? 'You borrowed this item' : 'You lent this item',
      href: '/rentals',
      priority: rental.rental_status === 'disputed' || rental.rental_status === 'return_pending' || rental.rental_status === 'return_inspection' ? 'urgent' : 'normal',
    })
  }

  return actions.sort((a, b) =>
    Number(b.priority === 'urgent') - Number(a.priority === 'urgent'),
  ).slice(0, 8)
}
