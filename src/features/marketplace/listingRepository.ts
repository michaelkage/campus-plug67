import type { Database } from '@/types/database'
import { supabase } from '@/lib/supabase/client'

type ListingRow = Database['public']['Tables']['listings']['Row']

export type MarketplaceListing = ListingRow & {
  title: string
  description: string | null
  hostel?: string | null
  metadata_verified?: boolean | null
  floor_override?: boolean | null
  listing_mode?: 'sale' | 'both' | null
  rental_daily_rate_kobo?: number | null
  rental_security_deposit_kobo?: number | null
  rental_min_days?: number | null
  rental_max_days?: number | null
  profiles?: {
    id?: string
    full_name?: string | null
    university?: string | null
    avatar_url?: string | null
    is_verified?: boolean | null
    plug_score?: number | null
    total_sales?: number | null
  } | null
}

export interface MarketplaceListingFilters {
  category?: string
  hostel?: string
  sellerId?: string
  verifiedOnly?: boolean
}

const MARKETPLACE_SELECT =
  '*, profiles!listings_seller_id_fkey(full_name, university, avatar_url, is_verified)'

/**
 * Reads active listings through the single marketplace data boundary.
 *
 * Campus is deliberately not a hard filter: users can browse listings from
 * other institutions, while the UI ranks their own campus first.
 * RLS remains the security boundary; these filters are presentation filters.
 */
export async function listMarketplaceListings(
  filters: MarketplaceListingFilters = {},
): Promise<MarketplaceListing[]> {
  let query = supabase
    .from('listings')
    .select(MARKETPLACE_SELECT)
    .eq('status', 'active')
    .order('created_at', { ascending: false })

  if (filters.category) query = query.eq('category', filters.category)
  if (filters.hostel) query = query.eq('hostel', filters.hostel)
  if (filters.sellerId) query = query.eq('seller_id', filters.sellerId)
  if (filters.verifiedOnly) query = query.eq('metadata_verified', true)

  const { data, error } = await query
  if (error) {
    throw new Error(`Unable to load marketplace listings: ${error.message}`, {
      cause: error,
    })
  }

  return (data ?? []) as unknown as MarketplaceListing[]
}

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
