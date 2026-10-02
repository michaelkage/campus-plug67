import { describe, expect, it } from 'vitest'
import {
  MEETUP_RELEASE_DELAY_MS,
  formatCountdown,
  getMeetupReleaseAt,
  getReleaseRemainingMs,
  isReleaseGateOpen,
} from '@/lib/escrowTiming'

const HOUR = 60 * 60 * 1000

describe('escrow release timing gate', () => {
  it('keeps the release gate closed for the full window after meetup initiation', () => {
    const initiated = '2026-01-01T00:00:00.000Z'
    const initiatedAt = new Date(initiated).getTime()

    expect(MEETUP_RELEASE_DELAY_MS).toBe(24 * HOUR)
    expect(getMeetupReleaseAt(initiated)).toBe(initiatedAt + 24 * HOUR)
    expect(getReleaseRemainingMs(initiated, initiatedAt)).toBe(24 * HOUR)
    expect(isReleaseGateOpen(initiated, initiatedAt)).toBe(false)
  })

  it('never reports a negative remaining window, so the gate cannot reopen after expiry', () => {
    const initiated = '2026-01-01T00:00:00.000Z'
    const initiatedAt = new Date(initiated).getTime()

    expect(getReleaseRemainingMs(initiated, initiatedAt + 25 * HOUR)).toBe(0)
    expect(getReleaseRemainingMs(initiated, initiatedAt + 500 * HOUR)).toBe(0)
    expect(isReleaseGateOpen(initiated, initiatedAt + 25 * HOUR)).toBe(true)
  })

  it('refuses to compute a release time from missing or unparseable input', () => {
    expect(getMeetupReleaseAt(null)).toBeNull()
    expect(getMeetupReleaseAt(undefined)).toBeNull()
    expect(getMeetupReleaseAt('not-a-date')).toBeNull()
    expect(getReleaseRemainingMs(null)).toBeNull()
    expect(isReleaseGateOpen(undefined)).toBe(false)
  })

  it('formats the countdown for the meetup UI', () => {
    expect(formatCountdown(0)).toBe('00:00:00')
    expect(formatCountdown(24 * HOUR)).toBe('24:00:00')
    expect(formatCountdown(90_000)).toBe('00:01:30')
    // Sub-second precision must not leak into the display.
    expect(formatCountdown(1)).toBe('00:00:01')
    // Negative input (already expired) must clamp rather than show a negative clock.
    expect(formatCountdown(-5_000)).toBe('00:00:00')
  })
})