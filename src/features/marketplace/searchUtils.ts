/** Pure input normalization shared by marketplace search and unit tests. */
export function normalizeMarketplaceSearchTerm(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120)
}
