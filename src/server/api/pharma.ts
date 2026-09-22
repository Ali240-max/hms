import { Hono } from 'hono'
import { z } from 'zod'
import {
  listSalts, createSalt, brandsOfSalt, listManufacturers, createManufacturer,
  listGroups, createGroup, listParties, createParty, statement, outstanding,
  recordPayment, repriceProduct, priceHistory, permissionsFor, savePermissions,
  pharmacyStaff, hasPermission, PERMISSIONS, PharmaError
} from '../services/pharma'
import {
  salesSummary, salesBy, invoiceRegister, purchaseSummary, purchaseBy,
  stockStatement, zeroSaleStock, productMovement, profitByManufacturer, discountMonitor
} from '../services/pharma-reports'
import { REPORTS, reportById } from '../services/report-catalogue'
import {
  returnableSale, createReturn, listReturns, returnForPrint, ReturnError
} from '../services/returns'
import { reportPdf } from '../services/report-pdf'

/**
 * The rebuilt pharmacy: masters, money and reports.
 *
 * Mounted under /pharma rather than added to /pharmacy so the till keeps
 * working untouched while this grows alongside it.
 */
export const pharma = new Hono()

const me = (c: any) => c.get('user')

pharma.onError((err: any, c) => {
  if (err instanceof ReturnError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  if (err instanceof PharmaError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  console.error('[pharma]', err)
  return c.json({ error: err.message ?? 'Something went wrong' }, 500)
})

/** Today, unless asked otherwise. Most reports are opened to check today. */
function window_(c: any) {
  const today = new Date().toISOString().slice(0, 10)
  return { from: c.req.query('from') || today, to: c.req.query('to') || today }
}

/* -------------------------------------------------------------- masters */

pharma.get('/salts', async (c) => c.json(await listSalts(c.req.query('q') ?? '')))
pharma.post('/salts', async (c) => {
  const b = z.object({ name: z.string().min(1) }).parse(await c.req.json())
  return c.json(await createSalt(b.name), 201)
})
pharma.get('/salts/:id/brands', async (c) =>
  c.json(await brandsOfSalt(Number(c.req.param('id')))))

pharma.get('/manufacturers', async (c) =>
  c.json(await listManufacturers(c.req.query('q') ?? '')))
pharma.post('/manufacturers', async (c) =>
  c.json(await createManufacturer(await c.req.json()), 201))

pharma.get('/groups', async (c) => c.json(await listGroups()))
pharma.post('/groups', async (c) => {
  const b = z.object({ name: z.string().min(1) }).parse(await c.req.json())
  return c.json(await createGroup(b.name), 201)
})

pharma.get('/parties', async (c) =>
  c.json(await listParties({ q: c.req.query('q') ?? '', kind: c.req.query('kind') ?? 'all' })))
pharma.post('/parties', async (c) =>
  c.json(await createParty({ ...(await c.req.json()), by: me(c).displayName }), 201))

/* --------------------------------------------------------------- money */

pharma.get('/ledger/:kind/:id', async (c) =>
  c.json(await statement(c.req.param('kind'), Number(c.req.param('id')),
    c.req.query('from') || undefined, c.req.query('to') || undefined)))

pharma.get('/outstanding/:kind', async (c) =>
  c.json(await outstanding(c.req.param('kind') as any)))

pharma.post('/payments', async (c) => {
  const b = z.object({
    kind: z.enum(['receipt', 'payment']),
    partyKind: z.enum(['customer', 'supplier']),
    partyRef: z.number().int(),
    amountPaisa: z.number().int().min(1),
    method: z.string().default('cash'),
    reference: z.string().nullable().optional(),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await recordPayment({ ...b, by: me(c).displayName }), 201)
})

/* ------------------------------------------------------------- pricing */

pharma.post('/products/:id/price', async (c) => {
  const b = z.object({
    purchasePaisa: z.number().int().min(0).optional(),
    tradePaisa: z.number().int().min(0).optional(),
    retailPaisa: z.number().int().min(0).optional(),
    reason: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await repriceProduct(Number(c.req.param('id')),
    { ...b, by: me(c).displayName }))
})

pharma.get('/price-history', async (c) =>
  c.json(await priceHistory({
    productId: c.req.query('product') ? Number(c.req.query('product')) : undefined,
    from: c.req.query('from') ?? undefined, to: c.req.query('to') ?? undefined
  })))

/* --------------------------------------------------------- permissions */

/**
 * Deciding what other people can do is itself a permission.
 *
 * Checked on the server, not just hidden in the interface: an administrator
 * granting themselves the rest of the till by hand-crafting a request is
 * exactly what this table is supposed to prevent.
 */
async function canSetAccess(c: any) {
  const u = me(c)
  if (u.role === 'admin') return true
  return hasPermission(u.id, 'staff.access')
}

pharma.get('/permissions', (c) => c.json(PERMISSIONS))

pharma.get('/staff', async (c) => {
  if (!(await canSetAccess(c))) {
    return c.json({ error: 'You are not set up to manage access', code: 'NOT_ALLOWED' }, 403)
  }
  return c.json(await pharmacyStaff())
})
pharma.get('/permissions/:staffId', async (c) =>
  c.json(await permissionsFor(Number(c.req.param('staffId')))))
pharma.put('/permissions/:staffId', async (c) => {
  if (!(await canSetAccess(c))) {
    return c.json({ error: 'You are not set up to manage access', code: 'NOT_ALLOWED' }, 403)
  }
  const b = z.object({ allowed: z.array(z.string()) }).parse(await c.req.json())
  return c.json(await savePermissions(Number(c.req.param('staffId')), b.allowed))
})

/* ------------------------------------------------------------- reports */

pharma.get('/reports/sales/summary', async (c) => c.json(await salesSummary(window_(c))))

pharma.get('/reports/sales/by/:dimension', async (c) =>
  c.json(await salesBy(window_(c), c.req.param('dimension') as any)))

pharma.get('/reports/sales/register', async (c) =>
  c.json(await invoiceRegister(window_(c), {
    kind: c.req.query('kind') ?? 'all',
    partyId: c.req.query('party') ? Number(c.req.query('party')) : undefined,
    q: c.req.query('q') ?? ''
  })))

pharma.get('/reports/purchase/summary', async (c) => c.json(await purchaseSummary(window_(c))))
pharma.get('/reports/purchase/by/:dimension', async (c) =>
  c.json(await purchaseBy(window_(c), c.req.param('dimension') as any)))

pharma.get('/reports/stock/statement', async (c) =>
  c.json(await stockStatement({
    manufacturerId: c.req.query('manufacturer') ? Number(c.req.query('manufacturer')) : undefined,
    groupId: c.req.query('group') ? Number(c.req.query('group')) : undefined
  })))
pharma.get('/reports/stock/zero-sale', async (c) =>
  c.json(await zeroSaleStock(Number(c.req.query('days') ?? 90))))
pharma.get('/reports/stock/movement/:productId', async (c) =>
  c.json(await productMovement(Number(c.req.param('productId')), window_(c))))

pharma.get('/reports/profit/manufacturer', async (c) =>
  c.json(await profitByManufacturer(window_(c))))
pharma.get('/reports/profit/discount', async (c) => c.json(await discountMonitor(window_(c))))

/* --------------------------------------------------------------- returns */

/** Find the invoice first. Everything else follows from it. */
pharma.get('/returns/lookup', async (c) => {
  const invoiceNo = c.req.query('invoice')
  const saleId = c.req.query('sale')
  return c.json(await returnableSale({
    invoiceNo: invoiceNo ?? undefined,
    saleId: saleId ? Number(saleId) : undefined
  }))
})

pharma.post('/returns', async (c) => {
  const b = z.object({
    saleId: z.number().int(),
    lines: z.array(z.object({
      saleItemId: z.number().int(),
      qty: z.number().int().min(0),
      restock: z.boolean().default(true)
    })).min(1),
    reason: z.string().nullable().optional(),
    refundMethod: z.string().default('cash')
  }).parse(await c.req.json())
  return c.json(await createReturn({ ...b, by: me(c).displayName }), 201)
})

pharma.get('/returns', async (c) =>
  c.json(await listReturns({
    from: c.req.query('from') ?? undefined,
    to: c.req.query('to') ?? undefined,
    q: c.req.query('q') ?? undefined
  })))

pharma.get('/returns/:id', async (c) =>
  c.json(await returnForPrint(Number(c.req.param('id')))))

/* --------------------------------------------------- the report catalogue */

/**
 * One definition per report drives both the screen and the printed copy, so
 * the two cannot drift apart.
 */
pharma.get('/reports', (c) =>
  c.json(REPORTS.map((r) => ({
    id: r.id, group: r.group, title: r.title, blurb: r.blurb,
    permission: r.permission, dated: r.dated,
    columns: r.columns, chart: r.chart, totalKeys: r.totalKeys
  }))))

/** Run one, for the screen. */
pharma.get('/reports/run/:id', async (c) => {
  const def = reportById(c.req.param('id'))
  if (!def) return c.json({ error: 'No such report' }, 404)
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

/** And print it, in the layout the hospital has read for twenty years. */
pharma.get('/reports/print/:id/pdf', async (c) => {
  const def = reportById(c.req.param('id'))
  if (!def) return c.json({ error: 'No such report' }, 404)
  const w = window_(c)
  const q = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const rows = await def.run(w, q)

  const notes: string[] = []
  if (def.stats) {
    const s: any = await def.stats(w, q)
    if (s?.margin_pct != null) notes.push(`Margin ${Number(s.margin_pct).toFixed(1)}% of revenue`)
    if (s?.returns) notes.push(`${s.returns} returns worth ${(Number(s.returned_paisa)/100).toFixed(2)}`)
    if (s?.cancelled) notes.push(`${s.cancelled} invoices cancelled in this period`)
  }

  const pdf = await reportPdf({
    title: def.title,
    from: def.dated ? w.from : undefined,
    to: def.dated ? w.to : undefined,
    columns: def.columns, rows, totalKeys: def.totalKeys,
    groupBy: def.groupBy, groupLabel: def.groupLabel,
    subGroupBy: def.subGroupBy, subGroupLabel: def.subGroupLabel,
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

/** One call for the dashboard, so it does not fire ten requests on open. */
pharma.get('/reports/overview', async (c) => {
  const w = window_(c)
  const [summary, daily, topProducts, topManufacturers, purchases] = await Promise.all([
    salesSummary(w), salesBy(w, 'day'), salesBy(w, 'product'),
    profitByManufacturer(w), purchaseSummary(w)
  ])
  return c.json({ window: w, summary, daily,
    topProducts: topProducts.slice(0, 10),
    topManufacturers: topManufacturers.slice(0, 8), purchases })
})
