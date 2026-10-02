import { beforeEach, describe, expect, it, vi } from 'vitest'

const maybeSingle = vi.fn()
const filters: [string, unknown][] = []

vi.mock('@/lib/supabase/client', () => {
  const build = (): Record<string, unknown> => ({
    select: () => build(),
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return build()
    },
    maybeSingle,
  })
  return {
    supabase: {
      from: vi.fn(() => build()),
    },
  }
})

const load = () => import('@/lib/supabase/queries')

beforeEach(() => {
  filters.length = 0
  maybeSingle.mockReset()
})

describe('education email gating', () => {
  it('accepts an explicitly configured institution domain', async () => {
    maybeSingle.mockResolvedValue({ data: { institution_name: 'University of Lagos' } })

    const { validateEduEmail } = await load()
    await expect(validateEduEmail('student@unilag.edu.ng')).resolves.toEqual({
      valid: true,
      university: 'University of Lagos',
    })
  })

  it('scopes the lookup to the exact domain and only active institutions', async () => {
    maybeSingle.mockResolvedValue({ data: null })

    const { validateEduEmail } = await load()
    await validateEduEmail('Student@UNILAG.EDU.NG')

    expect(filters).toEqual([
      ['domain', 'unilag.edu.ng'],
      ['active', true],
    ])
  })

  it('rejects an unlisted domain without falling back to a suffix match', async () => {
    maybeSingle.mockResolvedValue({ data: null })

    const { validateEduEmail } = await load()
    await expect(validateEduEmail('attacker@uni-lagos.edu.ng')).resolves.toEqual({
      valid: false,
      university: null,
    })
  })

  it('rejects an address with no domain at all', async () => {
    const { validateEduEmail } = await load()
    await expect(validateEduEmail('not-an-email')).resolves.toEqual({ valid: false, university: null })
    await expect(validateEduEmail('')).resolves.toEqual({ valid: false, university: null })
    expect(maybeSingle).not.toHaveBeenCalled()
  })
})