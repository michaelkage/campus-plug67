import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const rpc = vi.fn()
const setSession = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke },
    rpc,
    auth: { setSession },
  },
}))

const load = () => import('@/lib/sessionHandoff')

beforeEach(() => {
  invoke.mockReset()
  rpc.mockReset()
  setSession.mockReset()
})

describe('mobile session handoff', () => {
  it('creates a handoff through the server RPC only', async () => {
    rpc.mockResolvedValue({ data: { token: 'opaque-token', expires_at: '2026-01-01T00:05:00Z', handoff_id: 'h1', transaction_id: 'tx1' }, error: null })

    const { createSessionHandoff } = await load()
    const result = await createSessionHandoff('tx1')

    expect(rpc).toHaveBeenCalledWith('create_session_handoff', { p_transaction_id: 'tx1' })
    expect(result.token).toBe('opaque-token')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('refuses to mint a handoff when the server returns no token', async () => {
    rpc.mockResolvedValue({ data: null, error: null })

    const { createSessionHandoff } = await load()
    await expect(createSessionHandoff('tx1')).rejects.toThrow('Unable to create mobile handoff')
  })

  it('propagates the RPC error instead of inventing a token', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Authentication required' } })

    const { createSessionHandoff } = await load()
    await expect(createSessionHandoff('tx1')).rejects.toMatchObject({ message: 'Authentication required' })
  })

  it('establishes the session server session tokens from the exchange', async () => {
    invoke.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', transaction_id: 'tx1' }, error: null })
    setSession.mockResolvedValue({ data: { session: { id: 's1' } }, error: null })

    const { consumeSessionHandoff } = await load()
    const result = await consumeSessionHandoff('opaque-token')

    expect(invoke).toHaveBeenCalledWith('session-handoff', { body: { token: 'opaque-token' } })
    expect(setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' })
    expect(result.transactionId).toBe('tx1')
  })

  it('does not open a session when the exchange returns no access token', async () => {
    invoke.mockResolvedValue({ data: { error: 'Handoff token expired' }, error: null })

    const { consumeSessionHandoff } = await load()
    await expect(consumeSessionHandoff('stale-token')).rejects.toThrow('Handoff token expired')
    expect(setSession).not.toHaveBeenCalled()
  })

  it('does not open a session when only half the token pair is returned', async () => {
    invoke.mockResolvedValue({ data: { access_token: 'at' }, error: null })

    const { consumeSessionHandoff } = await load()
    await expect(consumeSessionHandoff('partial-token')).rejects.toThrow('Mobile handoff failed')
    expect(setSession).not.toHaveBeenCalled()
  })

  it('surfaces a rejected exchange without touching client auth state', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'Function failure' } })

    const { consumeSessionHandoff } = await load()
    await expect(consumeSessionHandoff('bad-token')).rejects.toMatchObject({ message: 'Function failure' })
    expect(setSession).not.toHaveBeenCalled()
  })

  it('reports a setSession failure rather than reporting success', async () => {
    invoke.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt' }, error: null })
    setSession.mockResolvedValue({ data: null, error: { message: 'Invalid token' } })

    const { consumeSessionHandoff } = await load()
    await expect(consumeSessionHandoff('token')).rejects.toMatchObject({ message: 'Invalid token' })
  })
})