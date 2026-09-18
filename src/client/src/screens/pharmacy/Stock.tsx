import { useEffect, useState } from 'react'
import { api, rs, shortDate } from '../../lib/api'
import { Card, Empty, Stat, Th } from '../../components/ui'
import { ExpiryPill } from '../../components/Expiry'
import { t as tr } from '../../lib/prefs'

/** Expiry watch and reorder list — the two things worth acting on this week. */
export function StockScreen() {
  const [tab, setTab] = useState<'expiry' | 'reorder'>('expiry')
  return (
    <div className="space-y-4 p-4">
      <div className="flex gap-1">
        {(['expiry', 'reorder'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-xl px-3 py-1.5 text-sm ${
              tab === t ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
            {t === 'expiry' ? 'Expiry watch' : 'Reorder list'}
          </button>
        ))}
      </div>
      {tab === 'expiry' ? <ExpiryTab /> : <ReorderTab />}
    </div>
  )
}

function ExpiryTab() {
  const [days, setDays] = useState(90)
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { api.ph.expiring(days).then(setRows).catch(() => {}) }, [days])

  const expired = rows.filter((r) => r.days_left <= 0)
  const atRisk = rows.filter((r) => r.days_left > 0)
  const value = rows.reduce((n, r) => n + Number(r.value_at_risk_paisa), 0)

  return (
    <Card title={tr('Expiry watch')} hint={tr('Batches close to their date, soonest first')}
      action={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field w-36 py-1.5 text-2xs">
          {[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>Next {d} days</option>)}
        </select>
      }>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tr('Already expired')} value={String(expired.length)} tone={expired.length ? 'bad' : undefined} />
        <Stat label={tr('Expiring soon')} value={String(atRisk.length)} tone={atRisk.length ? 'warn' : undefined} />
        <Stat label={tr('Value at risk')} value={`Rs ${rs(value)}`} />
      </div>

      {rows.length === 0 ? <Empty title={tr('Nothing expiring in that window')} /> : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full">
            <thead className="thead-strip">
              <tr><Th>{tr('Medicine')}</Th><Th w="w-28">{tr('Batch')}</Th><Th w="w-36">{tr('Expires')}</Th>
                <Th w="w-24" right>{tr('Units')}</Th><Th w="w-28" right>{tr('Value')}</Th></tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-sm text-heading">{r.product_name}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">{r.batch_no}</td>
                  <td className="px-3 py-2">
                    <ExpiryPill date={r.expiry_date} />
                    <span className="ml-2 num text-2xs text-muted">{shortDate(r.expiry_date)}</span>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs">{r.qty_on_hand}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-primary">{rs(r.value_at_risk_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function ReorderTab() {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { api.ph.lowStock().then(setRows).catch(() => {}) }, [])

  return (
    <Card title={tr('Reorder list')} hint={tr('At or below the level you set, most urgent first')}>
      {rows.length === 0 ? (
        <Empty title={tr('Nothing needs reordering')}
          hint={tr('Set a reorder level on a medicine to have it appear here.')} />
      ) : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr><Th>{tr('Medicine')}</Th><Th w="w-24">{tr('Rack')}</Th><Th w="w-24" right>{tr('In stock')}</Th>
              <Th w="w-24" right>{tr('Reorder at')}</Th><Th w="w-32">{tr('Cover')}</Th></tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((p) => {
              const pct = p.reorder_level > 0 ? Math.min(100, (p.in_stock / p.reorder_level) * 100) : 0
              return (
                <tr key={p.id}>
                  <td className="px-3 py-2 text-sm text-heading">{p.name}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">{p.rack_location ?? '—'}</td>
                  <td className={`px-3 py-2 text-right num text-sm font-medium ${
                    p.in_stock === 0 ? 'text-bad' : 'text-warn'}`}>{p.in_stock}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{p.reorder_level}</td>
                  <td className="px-3 py-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-screen">
                      <div className={`h-full rounded-full ${p.in_stock === 0 ? 'bg-bad' : 'bg-warn'}`}
                        style={{ width: `${Math.max(pct, 3)}%` }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
