import { daysUntil, shortDate } from '../lib/api'
import { t as tr } from '../lib/prefs'

/**
 * Distributors in Pakistan typically accept returns up to 3-6 months before
 * expiry. After that window closes the stock is the shop's loss, not the
 * supplier's. So the thresholds here are not arbitrary design bands, they
 * track the moment money stops being recoverable.
 */
export function expiryBand(days: number) {
  if (days < 0) return { key: 'expired', label: 'EXPIRED', tone: 'danger' } as const
  if (days <= 90) return { key: 'critical', label: `${days}d`, tone: 'danger' } as const
  if (days <= 180) return { key: 'closing', label: `${Math.round(days / 30)}mo`, tone: 'warn' } as const
  return { key: 'ok', label: `${Math.round(days / 30)}mo`, tone: 'ok' } as const
}

const tones = {
  danger: 'bg-bad/10 text-bad border-bad/25/20',
  warn: 'bg-warn/10 text-warn border-warn/25/20',
  ok: 'bg-screen text-muted border-line'
} as const

export function ExpiryPill({ date, showDate = true }: { date: string | null; showDate?: boolean }) {
  if (!date) return <span className="text-2xs text-muted">{tr('no stock')}</span>
  const days = daysUntil(date)
  const band = expiryBand(days)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-0.5 text-2xs num ${tones[band.tone]}`}
      title={`Expires ${date} (${days} days)`}
    >
      {showDate && <span className="opacity-70">{shortDate(date)}</span>}
      <span className="font-medium">{band.label}</span>
    </span>
  )
}

/** Horizontal runway bar. Full = 2 years out, empty = expiring now. */
export function ExpiryBar({ date }: { date: string | null }) {
  if (!date) return <div className="h-0.5 w-full rounded-lg bg-rule" />
  const days = daysUntil(date)
  const pct = Math.max(0, Math.min(100, (days / 730) * 100))
  const band = expiryBand(days)
  const fill =
    band.tone === 'danger' ? 'bg-danger' : band.tone === 'warn' ? 'bg-warn' : 'bg-accent'
  return (
    <div className="h-0.5 w-full overflow-hidden rounded-lg bg-rule">
      <div className={`h-full ${fill}`} style={{ width: `${Math.max(pct, 3)}%` }} />
    </div>
  )
}

export function ScheduleTag({ schedule }: { schedule: string }) {
  if (schedule === 'otc') return null
  const map: Record<string, { label: string; cls: string }> = {
    g: { label: 'Rx', cls: 'bg-ok/10 text-ok border-ok/25/25' },
    controlled: { label: 'CTRL', cls: 'bg-bad/10 text-bad border-bad/25/25' },
    refrigerated: { label: '2-8°C', cls: 'bg-ok/10 text-ok border-ok/25/25' }
  }
  const m = map[schedule]
  if (!m) return null
  return (
    <span className={`rounded-lg border px-1 py-px text-2xs font-medium ${m.cls}`}>{m.label}</span>
  )
}
