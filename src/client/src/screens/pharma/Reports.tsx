import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, rs, openDocument, today, type SessionUser } from '../../lib/api'
import { Card, Empty, ErrorNote, Stat, Th, SkeletonRows } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Reports.
 *
 * One screen per report, listed down the side. The server holds a single
 * definition for each — its columns, what to chart, what to total — and both
 * this screen and the printed PDF are built from it, so the paper and the
 * screen cannot drift apart.
 *
 * The printed copy is deliberately not this page sent to a printer. It is a
 * separate, plainer layout that matches what the pharmacy has been reading for
 * twenty years: monospaced columns, ruled lines, sub-totals and a grand total.
 * Staff compare this month's sheet against last month's by eye, and that only
 * works if the columns sit in the same place.
 */

const RANGES: [string, () => { from: string; to: string }][] = [
  ['Today', () => ({ from: today(), to: today() })],
  ['Yesterday', () => { const d = shift(-1); return { from: d, to: d } }],
  ['Last 7 days', () => ({ from: shift(-6), to: today() })],
  ['This month', () => ({ from: today().slice(0, 8) + '01', to: today() })],
  ['Last 30 days', () => ({ from: shift(-29), to: today() })],
  ['Last 90 days', () => ({ from: shift(-89), to: today() })]
]

function shift(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function Reports({ me }: { me: SessionUser }) {
  const [catalogue, setCatalogue] = useState<any[]>([])
  const [selected, setSelected] = useState<string>('')
  const [range, setRange] = useState('Last 30 days')
  const [from, setFrom] = useState(shift(-29))
  const [to, setTo] = useState(today())
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.allReports().then((r) => {
      setCatalogue(r)
      // Open on the first report this person can actually see, whichever
      // module they belong to.
      if (r[0]) setSelected((s) => s || r[0].id)
    }).catch(() => {})
  }, [])

  const def = catalogue.find((r) => r.id === selected)

  const load = useCallback(() => {
    if (!selected) return
    setLoading(true); setErr(null)
    api.runAnyReport(selected, { from, to })
      .then(setData).catch((e: any) => setErr(e.message)).finally(() => setLoading(false))
  }, [selected, from, to])
  useEffect(load, [load])

  function pickRange(label: string) {
    setRange(label)
    const r = RANGES.find(([l]) => l === label)
    if (r) { const w = r[1](); setFrom(w.from); setTo(w.to) }
  }

  const groups = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const r of catalogue) {
      const list = m.get(r.group) ?? []
      list.push(r)
      m.set(r.group, list)
    }
    return [...m.entries()]
  }, [catalogue])

  return (
    <div className="grid h-full min-h-0 gap-4 p-4 lg:grid-cols-[250px_1fr]">
      {/* ------------------------------------------------ the catalogue */}
      <div className="min-h-0 overflow-auto">
        <Card title={tr('Reports')} hint={`${catalogue.length} ${tr('available')}`}>
          <div className="space-y-4">
            {groups.map(([group, items]) => (
              <div key={group}>
                <p className="label">{tr(group)}</p>
                <ul className="space-y-0.5">
                  {items.map((r: any) => (
                    <li key={r.id}>
                      <button onClick={() => setSelected(r.id)}
                        className={`w-full rounded-lg px-2 py-1.5 text-left text-2xs transition-colors ${
                          selected === r.id
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-body hover:bg-raised'}`}>
                        {tr(r.title)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------- the report */}
      <div className="min-h-0 space-y-4 overflow-auto">
        <Card title={def ? tr(def.title) : tr('Reports')} hint={def ? tr(def.blurb) : undefined}
          action={
            <button
              onClick={() => openDocument(
                `/reports/print/${selected}/pdf?from=${from}&to=${to}`)
                .catch((e: any) => setErr(e.message))}
              disabled={!data} className="btn-primary">
              {tr('Print / PDF')}
            </button>
          }>
          <ErrorNote>{err}</ErrorNote>

          {def?.dated !== false && (
            <div className="flex flex-wrap items-end gap-2">
              {RANGES.map(([label]) => (
                <button key={label} onClick={() => pickRange(label)}
                  className={`rounded-xl px-2.5 py-1.5 text-2xs transition-colors ${
                    range === label ? 'bg-brand text-white'
                      : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
                  {tr(label)}
                </button>
              ))}
              <label className="ml-auto block">
                <span className="label">{tr('From')}</span>
                <input type="date" value={from}
                  onChange={(e) => { setFrom(e.target.value); setRange('') }}
                  className="field num w-36 py-1.5 text-2xs" />
              </label>
              <label className="block">
                <span className="label">{tr('To')}</span>
                <input type="date" value={to}
                  onChange={(e) => { setTo(e.target.value); setRange('') }}
                  className="field num w-36 py-1.5 text-2xs" />
              </label>
            </div>
          )}

          {data?.stats && <Headline stats={data.stats} />}
        </Card>

        {data?.chart && data.rows.length > 0 && (
          <Card title={tr('At a glance')}
            hint={`${tr('Top')} ${Math.min(data.rows.length, 14)} ${tr('by')} ${
              tr(columnLabel(data, data.chart.value))}`}>
            <Chart rows={data.rows} chart={data.chart} />
          </Card>
        )}

        <Card title={tr('Detail')}
          hint={data ? `${data.rows.length} ${tr('rows')}` : undefined}>
          {loading ? <SkeletonRows rows={7} cols={5} />
            : !data || data.rows.length === 0
              ? <Empty title={tr('Nothing to report for this period')} />
              : <Table data={data} />}
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- pieces */

function columnLabel(data: any, key: string) {
  return data.columns.find((c: any) => c.key === key)?.label ?? key
}

/** The figures worth seeing before the table. */
function Headline({ stats }: { stats: any }) {
  const cards: [string, string, string | undefined][] = []
  if (stats.invoices != null) {
    cards.push([tr('Invoices'), String(stats.invoices),
      stats.credit_invoices ? `${stats.credit_invoices} ${tr('on credit')}` : undefined])
  }
  if (stats.revenue_paisa != null) {
    cards.push([tr('Revenue'), `Rs ${rs(stats.revenue_paisa)}`,
      stats.average_paisa ? `${tr('avg')} Rs ${rs(stats.average_paisa)}` : undefined])
  }
  if (stats.margin_paisa != null) {
    cards.push([tr('Margin'), `Rs ${rs(stats.margin_paisa)}`,
      `${Number(stats.margin_pct ?? 0).toFixed(1)}% ${tr('of revenue')}`])
  }
  if (stats.deliveries != null) {
    cards.push([tr('Deliveries'), String(stats.deliveries),
      stats.suppliers ? `${stats.suppliers} ${tr('suppliers')}` : undefined])
  }
  if (stats.total_paisa != null && stats.revenue_paisa == null) {
    cards.push([tr('Purchased'), `Rs ${rs(stats.total_paisa)}`,
      stats.bonus_packs ? `${stats.bonus_packs} ${tr('bonus packs')}` : undefined])
  }
  if (stats.returns != null) {
    cards.push([tr('Returns'), String(stats.returns),
      `Rs ${rs(stats.returned_paisa)} ${tr('returned')}`])
  }
  if (cards.length === 0) return null
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.slice(0, 4).map(([label, value, sub]) => (
        <Stat key={label} label={label} value={value} sub={sub} tone="accent" />
      ))}
    </div>
  )
}

/**
 * A plain bar chart.
 *
 * Drawn by hand rather than pulled from a charting library: the whole thing is
 * a row of divs, it themes with the rest of the application, and it adds
 * nothing to the bundle that a pharmacy PC has to load over a LAN.
 */
function Chart({ rows, chart }: { rows: any[]; chart: any }) {
  const top = rows.slice(0, 14)
  const values = top.map((r) => Math.abs(Number(r[chart.value] ?? 0)))
  const peak = Math.max(...values, 1)
  const money = /paisa/.test(chart.value)

  return (
    <div>
      <div className="flex h-52 items-end gap-1.5">
        {top.map((r, i) => {
          const v = Number(r[chart.value] ?? 0)
          const h = (Math.abs(v) / peak) * 100
          return (
            <div key={i} className="group relative flex flex-1 flex-col justify-end"
              title={`${r[chart.label]} — ${money ? 'Rs ' + rs(v) : v}`}>
              <span className="mb-1 text-center text-[0.6rem] text-muted opacity-0
                               transition-opacity group-hover:opacity-100">
                {money ? rs(v) : v}
              </span>
              <div className={`w-full rounded-t-lg transition-colors ${
                v < 0 ? 'bg-bad/70 group-hover:bg-bad' : 'bg-primary/70 group-hover:bg-primary'}`}
                style={{ height: `${Math.max(h, 2)}%` }} />
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex gap-1.5">
        {top.map((r, i) => (
          <div key={i} className="flex-1 truncate text-center text-[0.6rem] text-muted"
            title={String(r[chart.label])}>
            {String(r[chart.label]).slice(0, 10)}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The same columns the printed copy uses, in the same order. */
function Table({ data }: { data: any }) {
  const cols = data.columns as any[]
  const totals = data.totals ?? {}
  const hasTotals = (data.totalKeys ?? []).length > 0

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="thead-strip">
          <tr>
            {cols.map((c) => (
              <Th key={c.key} right={c.money || c.align === 'right'}>{tr(c.label)}</Th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-divide rows-striped anim-rows">
          {data.rows.map((row: any, i: number) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = row[c.key]
                const right = c.money || c.align === 'right'
                return (
                  <td key={c.key}
                    className={`px-3 py-1.5 text-2xs ${right ? 'text-right num' : 'text-body'} ${
                      c.money && Number(v) < 0 ? 'text-bad' : ''}`}>
                    {c.money ? rs(v) : (v ?? '—')}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-t-2 border-line bg-raised">
              {cols.map((c, i) => (
                <td key={c.key}
                  className={`px-3 py-2 text-2xs font-semibold ${
                    c.money || c.align === 'right' ? 'text-right num text-primary' : 'text-muted'}`}>
                  {(data.totalKeys ?? []).includes(c.key)
                    ? (c.money ? rs(totals[c.key]) : totals[c.key])
                    : i === 0 ? tr('Grand Total') : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
