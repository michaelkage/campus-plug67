import { describe, expect, it } from 'vitest'
import {
  matchesMarketplaceListing,
  removeMarketplaceListing,
  upsertMarketplaceListing,
} from './listingCache'
import type { MarketplaceListing } from './listingRepository'

function listing(overrides: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: 'listing-1',
    title: 'Textbook',
    description: 'A course textbook',
    category: 'Textbooks',
    seller_id: 'seller-1',
    status: 'active',
    price: 250000,
    condition: 'used',
    images: [],
    created_at: '2026-11-22T10:00:00.000Z',
    updated_at: '2026-11-22T10:00:00.000Z',
    university: 'University of Lagos',
    hostel: 'Jaja Hall',
    metadata_verified: true,
    ...overrides,
  } as MarketplaceListing
}

describe('marketplace listing repository helpers', () => {
  it('applies all active-feed filters without treating campus as an access boundary', () => {
    const row = listing()
    expect(matchesMarketplaceListing(row, {
      category: 'Textbooks',
      hostel: 'Jaja Hall',
      sellerId: 'seller-1',
      verifiedOnly: true,
    })).toBe(true)
    expect(matchesMarketplaceListing(
      listing({ university: 'University of Ibadan' }),
      { category: 'Textbooks' },
    )).toBe(true)
  })

  it('rejects inactive, unverified and mismatched rows', () => {
    expect(matchesMarketplaceListing(listing({ status: 'sold' }), {})).toBe(false)
    expect(matchesMarketplaceListing(listing({ metadata_verified: false }), {
      verifiedOnly: true,
    })).toBe(false)
    expect(matchesMarketplaceListing(listing({ hostel: 'Moremi Hall' }), {
      hostel: 'Jaja Hall',
    })).toBe(false)
  })

  it('upserts by id without duplicating realtime inserts', () => {
    const original = listing()
    const updated = listing({ title: 'Updated textbook' })
    const inserted = upsertMarketplaceListing([original], listing({ id: 'listing-2' }))
    const replaced = upsertMarketplaceListing(inserted, updated)

    expect(inserted).toHaveLength(2)
    expect(replaced).toHaveLength(2)
    expect(replaced.find((row) => row.id === 'listing-1')?.title).toBe('Updated textbook')
  })

  it('removes a listing when a realtime update makes it unavailable', () => {
    expect(removeMarketplaceListing([listing(), listing({ id: 'listing-2' })], 'listing-1'))
      .toHaveLength(1)
  })
})
