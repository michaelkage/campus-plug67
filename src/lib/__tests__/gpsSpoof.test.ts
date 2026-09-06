import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  },
}))

describe('gpsWeight', () => {
  beforeEach(() => vi.resetModules())

  it('keeps clean users at full trust', async () => {
    const { gpsWeight } = await import('@/lib/gpsSpoof')
    expect(gpsWeight(0)).toBe(1)
  })

  it('discounts trust progressively', async () => {
    const { gpsWeight } = await import('@/lib/gpsSpoof')
    expect(gpsWeight(1)).toBe(0.8)
    expect(gpsWeight(3)).toBe(0.6)
    expect(gpsWeight(5)).toBe(0.4)
  })
})
