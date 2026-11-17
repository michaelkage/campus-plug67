import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck } from 'lucide-react'
import { deriveTransactionLifecycle } from '@/lib/transactionLifecycle'

export default function TransactionStatusBanner({ transaction, status }) {
  const lifecycle = deriveTransactionLifecycle(transaction ?? { status: String(status ?? '').toLowerCase() })
  const tone = lifecycle.tone
  const Icon = tone === 'danger' ? AlertTriangle : tone === 'success' ? CheckCircle2 : tone === 'warning' ? Clock3 : ShieldCheck
  const styles = tone === 'danger'
    ? 'border-[var(--md-error)]/40 bg-[var(--md-error)]/5'
    : tone === 'success'
      ? 'border-primary/20 bg-primary/5'
      : tone === 'warning'
        ? 'border-tertiary/30 bg-tertiary/5'
        : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]'

  return (
    <div className={`rounded-md border p-4 ${styles}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="flex gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="text-sm font-black">{lifecycle.title}</div>
          <p className="mt-1 text-xs leading-5 text-on-surface/60">{lifecycle.description}</p>
          {lifecycle.status === 'released' && (
            <p className="mt-2 text-xs font-semibold">{lifecycle.payout.title}</p>
          )}
        </div>
      </div>
    </div>
  )
}
