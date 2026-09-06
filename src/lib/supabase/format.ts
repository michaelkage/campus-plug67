export function formatNaira(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined || !Number.isFinite(kobo)) return '₦0'
  return `₦${(kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

export function toKobo(naira: number | string): number {
  const parsed = Number.parseFloat(String(naira).replace(/,/g, ''))
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

export function timeAgo(timestamp: string | Date | null | undefined): string {
  if (!timestamp) return ''
  const diff = Date.now() - new Date(timestamp).getTime()
  if (!Number.isFinite(diff)) return ''
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' })
}

export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—'
  if (metres < 1000) return `${Math.round(metres)}m`
  return `${(metres / 1000).toFixed(1)}km`
}
