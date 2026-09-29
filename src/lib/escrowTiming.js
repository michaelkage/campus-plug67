export const MEETUP_RELEASE_DELAY_MS = 24 * 60 * 60 * 1000

export function getMeetupReleaseAt(meetupInitiatedAt) {
  if (!meetupInitiatedAt) return null
  const timestamp = new Date(meetupInitiatedAt).getTime()
  if (!Number.isFinite(timestamp)) return null
  return timestamp + MEETUP_RELEASE_DELAY_MS
}

export function getReleaseRemainingMs(meetupInitiatedAt, now = Date.now()) {
  const releaseAt = getMeetupReleaseAt(meetupInitiatedAt)
  if (releaseAt === null) return null
  return Math.max(0, releaseAt - now)
}

export function isReleaseGateOpen(meetupInitiatedAt, now = Date.now()) {
  const remaining = getReleaseRemainingMs(meetupInitiatedAt, now)
  return remaining !== null && remaining === 0
}

export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}
