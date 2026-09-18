import { useEffect, useState } from 'react'
import { api, rs } from '../../lib/api'
import { Card, Empty, Stat } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']] as const

/** How the shop is doing. Today's tab doubles as the cash-up sheet. */
export function Overview() {
  const [days, setDays] = useState(30)
  const [d, setD] = useState<any>(null)
  useEffect(() => { api.ph.dashboard(days).then(setD).catch(() => {}) }, [days])

  if (!d) return <p className="p-6 text-sm text-muted">{tr('Loading…')}</p>

  const k = d.kpi
  const change = Number(k.yesterday_revenue) > 0
    ? ((Number(k.today_revenue) - Number(k.yesterday_revenue)) / Number(k.yesterday_revenue)) * 100
    : null
  const marginPct = Number(k.window_revenue) > 0
    ? (Number(k.window_margin) / Number(k.window_revenue)) * 100 : 0
  const peak = Math.max(...d.trend.map((t: any) => Number(t.revenue_paisa)), 1)
  const expired = d.expiry.find((e: any) => e.bucket === 'expired')
  const soon = d.expiry.filter((e: any) => ['d30', 'd60', 'd90'].includes(e.bucket))
    .reduce((n: number, e: any) => n + Number(e.value_paisa), 0)

  return (
    <div className="space-y-4 p-4">
      <div className="flex gap-1">
        {RANGES.map(([n, label]) => (
          <button key={n} onClick={() => setDays(n)}
            className={`rounded-xl px-3 py-1.5 text-sm ${
              days === n ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
            {tr(label)}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={tr('Today')} value={`Rs ${rs(k.today_revenue)}`} tone="accent"
          sub={change === null ? `${k.today_bills} bills`
            : `${change >= 0 ? '+' : ''}${change.toFixed(0)}% on yesterday · ${k.today_bills} bills`} />
        <Stat label={`Revenue, ${days === 1 ? 'today' : `${days} days`}`}
          value={`Rs ${rs(k.window_revenue)}`} sub={`${k.window_bills} bills`} />
        <Stat label={tr('Gross margin')} value={`Rs ${rs(k.window_margin)}`}
          sub={`${marginPct.toFixed(1)}% of revenue`} />
        <Stat label={tr('Stock on hand')} value={`Rs ${rs(d.stock.stock_value_paisa)}`}
          sub={d.coverDays ? `About ${d.coverDays} days of cover` : `${d.stock.product_count} medicines`} />
      </div>

      {d.cashUp && (
        <Card title={tr('Cash up')} hint={tr('What should physically be in the drawer at close')}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={tr('Cash taken')} value={`Rs ${rs(d.cashUp.cash_paisa)}`} tone="ok"
              sub={`${d.cashUp.cash_bills} cash bills`} />
            <Stat label={tr('Card and wallets')} value={`Rs ${rs(d.cashUp.digital_paisa)}`}
              sub={tr('Settles to the bank, not the drawer')} />
            <Stat label={tr('Discount given')} value={`Rs ${rs(d.cashUp.discount_paisa)}`} />
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={tr('Daily takings')}>
          {d.trend.length === 0 ? <Empty title={tr('No sales yet')} /> : (
            <div className="flex h-40 items-end gap-1">
              {d.trend.map((t: any) => (
                <div key={t.day} className="group relative flex-1" title={`${t.day}: Rs ${rs(t.revenue_paisa)}`}>
                  <div className="w-full rounded-t-lg bg-primary/70 transition-colors group-hover:bg-primary"
                    style={{ height: `${Math.max((Number(t.revenue_paisa) / peak) * 150, 2)}px` }} />
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-2xs text-muted">
            {d.trend.length} days to {new Date(d.trend[d.trend.length - 1]?.day).toLocaleDateString('en-GB')}
          </p>
        </Card>

        <Card title={tr('How people paid')}>
          {d.payment.length === 0 ? <Empty title={tr('No sales in this window')} /> : (
            <ul className="space-y-2">
              {d.payment.map((p: any) => {
                const pct = (Number(p.revenue_paisa) / Number(k.window_revenue || 1)) * 100
                return (
                  <li key={tr(p.pay_method)}>
                    <div className="flex justify-between text-2xs">
                      <span className="capitalize text-body">{tr(p.pay_method)}</span>
                      <span className="num text-muted">Rs {rs(p.revenue_paisa)} · {pct.toFixed(0)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-screen">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title={tr('Expiry risk')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={tr('Already expired')} value={`Rs ${rs(expired?.value_paisa ?? 0)}`}
              tone={expired ? 'bad' : undefined}
              sub={expired ? `${expired.units} units still on the shelf` : 'Nothing expired'} />
            <Stat label={tr('Expiring within 90 days')} value={`Rs ${rs(soon)}`} tone={soon > 0 ? 'warn' : undefined} />
          </div>
        </Card>

        <Card title={tr('Best sellers')} hint={tr('By revenue in this window')}>
          {d.topRevenue.length === 0 ? <Empty title={tr('No sales in this window')} /> : (
            <ul className="divide-y divide-divide">
              {d.topRevenue.map((p: any, i: number) => (
                <li key={p.name} className="flex items-center justify-between py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="num w-4 text-2xs text-muted">{i + 1}</span>
                    <span className="truncate text-sm text-heading">{p.name}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num text-sm text-primary">Rs {rs(p.revenue_paisa)}</span>
                    <span className="block num text-2xs text-muted">{p.units} sold</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
