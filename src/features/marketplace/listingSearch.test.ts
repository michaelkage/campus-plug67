import { describe, expect, it } from 'vitest'
import { escapeMarketplaceSearchTerm } from './listingRepository'

describe('marketplace search input', () => {
  it('escapes LIKE wildcards and escape characters as literal input', () => {
    expect(escapeMarketplaceSearchTerm('100%_ready\\book')).toBe('100\\%\\_ready\\\\book')
  })

  it('preserves ordinary search text', () => {
    expect(escapeMarketplaceSearchTerm('Organic Chemistry')).toBe('Organic Chemistry')
  })
})
