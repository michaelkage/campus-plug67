import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/queryKeys'
import { listMarketplaceListings, getMarketplaceListingById, type MarketplaceListingFilters } from './listingRepository'

export interface UseMarketplaceListingsOptions extends MarketplaceListingFilters {
  myOnly?: boolean
  userId?: string | null
  university?: string | null
}
export function useMarketplaceListings(options: UseMarketplaceListingsOptions) {
  const filters: MarketplaceListingFilters = {
    category: options.category || undefined,
    hostel: options.hostel || undefined,
    sellerId: options.myOnly ? options.userId || undefined : undefined,
    verifiedOnly: options.verifiedOnly === true,
    search: options.search?.trim() || undefined,
    sort: options.sort || 'newest',
    page: options.page ?? 0,
    pageSize: options.pageSize ?? 24,
  }
  return useQuery({
    queryKey: queryKeys.listings.marketplaceFeed({
      category: options.category || '', hostel: options.hostel || '',
      myOnly: options.myOnly === true, verifiedOnly: options.verifiedOnly === true,
      userId: options.userId || '', university: options.university || '',
      search: filters.search || '', sort: filters.sort || 'newest', page: filters.page || 0,
    }),
    enabled: Boolean(options.userId),
    queryFn: () => listMarketplaceListings(filters),
    staleTime: 30_000,
    placeholderData: (previousData) => previousData,
  })
}
export function useMarketplaceListing(listingId?: string) {
  return useQuery({
    queryKey: queryKeys.listingDetail(listingId || ''),
    enabled: Boolean(listingId),
    queryFn: () => getMarketplaceListingById(listingId || ''),
    staleTime: 30_000,
  })
}
