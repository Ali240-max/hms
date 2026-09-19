import { Hono } from 'hono'
import { REPORTS, reportById } from '../services/report-catalogue'
import { reportPdf } from '../services/report-pdf'

/**
 * Every report in the system, in one place.
 *
 * Each module used to carry its own reporting; the pharmacy's arrived first
 * and the rest followed the same shape. Rather than four separate endpoints
 * that drift apart, there is one catalogue and one runner, and a role decides
 * which slice of it a person sees.
 *
 * The scoping rule is that a module's staff see their own module's reports,
 * and the reports desk and administrators see all of them. Nobody is ever
 * hidden from the reports describing their own work.
 */
export const reports = new Hono()

const me = (c: any) => c.get('user')

/** Which modules a role may look at. */
function modulesFor(role: string): string[] | 'all' {
  switch (role) {
    case 'admin':
    case 'reports':         return 'all'
    case 'pharmacist':
    case 'pharmacy_admin':  return ['pharmacy']
    case 'lab_tech':        return ['laboratory']
    case 'radiology':       return ['radiology']
    case 'main_counter':    return ['counter']
    default:                return []
  }
}

function visible(c: any) {
  const allowed = modulesFor(me(c).role)
  return allowed === 'all' ? REPORTS : REPORTS.filter((r) => allowed.includes(r.module))
}

function mayRun(c: any, id: string) {
  return visible(c).some((r) => r.id === id)
}

function window_(c: any) {
  const today = new Date().toISOString().slice(0, 10)
  return { from: c.req.query('from') || today, to: c.req.query('to') || today }
}

reports.get('/', (c) =>
  c.json(visible(c).map((r) => ({
    id: r.id, group: r.group, module: r.module, title: r.title, blurb: r.blurb,
    dated: r.dated, columns: r.columns, chart: r.chart, totalKeys: r.totalKeys
  }))))

reports.get('/run/:id', async (c) => {
  const id = c.req.param('id')
  if (!mayRun(c, id)) return c.json({ error: 'That report is not yours to open' }, 403)
  const def = reportById(id)!
  const w = window_(c)
  const q = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const [rows, stats] = await Promise.all([
    def.run(w, q), def.stats ? def.stats(w, q) : Promise.resolve(null)
  ])
  return c.json({
    id: def.id, title: def.title, blurb: def.blurb, window: w,
    columns: def.columns, chart: def.chart, totalKeys: def.totalKeys,
    rows, stats,
    totals: Object.fromEntries((def.totalKeys ?? []).map((k) =>
      [k, rows.reduce((n: number, r: any) => n + Number(r[k] ?? 0), 0)]))
  })
})

reports.get('/print/:id/pdf', async (c) => {
  const id = c.req.param('id')
  if (!mayRun(c, id)) return c.json({ error: 'That report is not yours to open' }, 403)
  const def = reportById(id)!
  const w = window_(c)
  const q = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const rows = await def.run(w, q)

  const notes: string[] = []
  if (def.stats) {
    const s: any = await def.stats(w, q)
    if (s?.margin_pct != null) notes.push(`Margin ${Number(s.margin_pct).toFixed(1)}% of revenue`)
    if (s?.pending) notes.push(`${s.pending} still to be reported`)
    if (s?.unpaid_chits) notes.push(`${s.unpaid_chits} chits still unpaid in this period`)
  }

  const pdf = await reportPdf({
    title: def.title,
    from: def.dated ? w.from : undefined,
    to: def.dated ? w.to : undefined,
    columns: def.columns, rows, totalKeys: def.totalKeys,
    groupBy: def.groupBy, groupLabel: def.groupLabel,
    landscape: def.landscape, notes,
    user: me(c).displayName
  })

  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${def.id}-${w.from}-to-${w.to}.pdf"`
    }
  })
})
