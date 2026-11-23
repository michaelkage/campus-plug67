import type { Database } from '@/types/database'
import { supabase } from '@/lib/supabase/client'
import { normalizeMarketplaceSearchTerm } from './searchUtils'
export { normalizeMarketplaceSearchTerm } from './searchUtils'
export { matchesMarketplaceListing, upsertMarketplaceListing, removeMarketplaceListing } from './listingCache'

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
  profiles?: { id?: string; full_name?: string | null; university?: string | null; avatar_url?: string | null; is_verified?: boolean | null; badges?: string[] | null; plug_score?: number | null; total_sales?: number | null } | null
}
export type MarketplaceSort = 'newest' | 'oldest' | 'price-low' | 'price-high'
export interface MarketplaceListingFilters {
  category?: string
  hostel?: string
  sellerId?: string
  verifiedOnly?: boolean
  search?: string
  sort?: MarketplaceSort
  page?: number
  pageSize?: number
}
const MARKETPLACE_SELECT = '*, profiles!listings_seller_id_fkey(full_name, university, avatar_url, is_verified)'

/** Server-side bounded search. Campus is never an access boundary; RLS is. */
export async function listMarketplaceListings(filters: MarketplaceListingFilters = {}): Promise<MarketplaceListing[]> {
  const page = Number.isInteger(filters.page) && (filters.page ?? 0) >= 0 ? filters.page as number : 0
  const pageSize = Number.isInteger(filters.pageSize) ? Math.min(60, Math.max(1, filters.pageSize as number)) : 24
  let query = supabase.from('listings').select(MARKETPLACE_SELECT).eq('status', 'active')
  if (filters.category) query = query.eq('category', filters.category)
  if (filters.hostel) query = query.eq('hostel', filters.hostel)
  if (filters.sellerId) query = query.eq('seller_id', filters.sellerId)
  if (filters.verifiedOnly) query = query.eq('metadata_verified', true)
  const search = filters.search ? normalizeMarketplaceSearchTerm(filters.search) : ''
  if (search) query = query.textSearch('search_vector', search, { config: 'simple', type: 'plain' })
  switch (filters.sort ?? 'newest') {
    case 'oldest': query = query.order('created_at', { ascending: true }).order('id', { ascending: true }); break
    case 'price-low': query = query.order('price', { ascending: true }).order('id', { ascending: true }); break
    case 'price-high': query = query.order('price', { ascending: false }).order('id', { ascending: true }); break
    default: query = query.order('created_at', { ascending: false }).order('id', { ascending: false })
  }
  const from = page * pageSize
  const { data, error } = await query.range(from, from + pageSize - 1)
  if (error) throw new Error(`Unable to load marketplace listings: ${error.message}`, { cause: error })
  return (data ?? []) as unknown as MarketplaceListing[]
}
const LISTING_DETAIL_SELECT = '*, profiles!listings_seller_id_fkey(id, full_name, university, plug_score, total_sales, avatar_url, badges, is_verified)'
export async function getMarketplaceListingById(listingId: string): Promise<MarketplaceListing | null> {
  if (!listingId) throw new Error('A listing ID is required')
  const { data, error } = await supabase.from('listings').select(LISTING_DETAIL_SELECT).eq('id', listingId).maybeSingle()
  if (error) throw new Error(`Unable to load listing: ${error.message}`, { cause: error })
  return (data ?? null) as unknown as MarketplaceListing | null
}
