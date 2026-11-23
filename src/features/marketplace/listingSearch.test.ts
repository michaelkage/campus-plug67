import { describe, expect, it } from 'vitest'
import { normalizeMarketplaceSearchTerm } from './searchUtils'

describe('marketplace search normalization', () => {
  it('normalizes whitespace without interpreting user text as query syntax', () => {
    expect(normalizeMarketplaceSearchTerm('  Organic   Chemistry  ')).toBe('Organic Chemistry')
    expect(normalizeMarketplaceSearchTerm('title OR description')).toBe('title OR description')
  })

  it('bounds search input length', () => {
    expect(normalizeMarketplaceSearchTerm('x'.repeat(200))).toHaveLength(120)
  })
})
