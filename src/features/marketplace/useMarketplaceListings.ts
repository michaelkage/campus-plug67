import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/queryKeys'
import {
  listMarketplaceListings,
  type MarketplaceListingFilters,
} from './listingRepository'

export interface UseMarketplaceListingsOptions extends MarketplaceListingFilters {
  userId?: string | null
  university?: string | null
}

export function useMarketplaceListings(options: UseMarketplaceListingsOptions) {
  const filters: MarketplaceListingFilters = {
    category: options.category || undefined,
    hostel: options.hostel || undefined,
    sellerId: options.myOnly ? options.userId || undefined : undefined,
    verifiedOnly: options.verifiedOnly === true,
  }

  return useQuery({
    queryKey: queryKeys.listings.marketplaceFeed({
      category: options.category || '',
      hostel: options.hostel || '',
      myOnly: options.myOnly === true,
      verifiedOnly: options.verifiedOnly === true,
      userId: options.userId || '',
      university: options.university || '',
    }),
    enabled: Boolean(options.userId),
    queryFn: () => listMarketplaceListings(filters),
    staleTime: 30_000,
    placeholderData: (previousData) => previousData,
  })
}
