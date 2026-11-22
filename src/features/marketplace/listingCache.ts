import type { MarketplaceListing, MarketplaceListingFilters } from './listingRepository'

export function matchesMarketplaceListing(
  listing: Partial<MarketplaceListing>,
  filters: MarketplaceListingFilters,
): boolean {
  if (listing.status !== 'active') return false
  if (filters.category && listing.category !== filters.category) return false
  if (filters.hostel && listing.hostel !== filters.hostel) return false
  if (filters.sellerId && listing.seller_id !== filters.sellerId) return false
  if (filters.verifiedOnly && listing.metadata_verified !== true) return false
  return true
}

export function upsertMarketplaceListing(
  current: MarketplaceListing[] | undefined,
  incoming: MarketplaceListing,
): MarketplaceListing[] {
  const rows = current ?? []
  const index = rows.findIndex((row) => row.id === incoming.id)

  if (index === -1) return [incoming, ...rows]

  const next = rows.slice()
  next[index] = { ...next[index], ...incoming }
  return next.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )
}

export function removeMarketplaceListing(
  current: MarketplaceListing[] | undefined,
  listingId: string,
): MarketplaceListing[] {
  return (current ?? []).filter((listing) => listing.id !== listingId)
}
