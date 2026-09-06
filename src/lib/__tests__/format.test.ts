import { describe, expect, it } from 'vitest'
import { formatNaira, toKobo, formatDistance } from '@/lib/supabase/format'

describe('currency and distance formatting', () => {
  it('formats kobo as Nigerian naira', () => {
    expect(formatNaira(125000)).toBe('₦1,250')
    expect(formatNaira(null)).toBe('₦0')
  })

  it('converts naira strings to integer kobo', () => {
    expect(toKobo('1,250.50')).toBe(125050)
    expect(toKobo('invalid')).toBe(0)
  })

  it('formats metre distances compactly', () => {
    expect(formatDistance(350)).toBe('350m')
    expect(formatDistance(1500)).toBe('1.5km')
  })
})
