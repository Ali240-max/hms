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
import {
  companiesFor, addCompany, removeCompany, slotsFor, addSlot, removeSlot,
  suppliersWithTerms, orderSheet, createOrder, listOrders, orderDetail,
  deleteOrder, setOpeningStock, openingSheet, OrderError
} from '../services/ordering'
import { purchaseOrderPdf } from '../services/order-pdf'
import { getSetting, setSetting } from '../services/settings'
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
  if (err instanceof OrderError) {
    return c.json({ error: err.message, detail: err.detail, code: err.code },
      err.code === 'NOT_FOUND' ? 404 : 409)
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
  /*
   * The real check on giving money back, which until now did not exist.
   *
   * The Returns tab used to be hidden unless you held sale.return, and that
   * hiding was doing all the work — this route never asked. Anyone who could
   * reach the pharmacy at all could post a refund by calling it directly.
   *
   * Now that the tab is visible to everybody at the counter, as it should be
   * (a customer with a strip to bring back is the most ordinary thing that
   * happens at a till), the permission has to be enforced where it actually
   * matters. Finding the screen and being allowed to refund are two
   * different questions.
   */
  const u = me(c)
  if (u.role !== 'admin' && !(await hasPermission(u.id, 'sale.return'))) {
    return c.json({
      error: 'Your account is not set up to give goods back. ' +
        'Ask whoever manages access to tick "Take goods back".',
      code: 'NOT_ALLOWED'
    }, 403)
  }
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

/* ======================================================= supplier terms */

/**
 * Who supplies what, and when they take orders.
 *
 * Reads are open to anybody who can reach the pharmacy: the order screen
 * needs them and the counter staff raising an order are not the people who
 * manage suppliers. Writes need party.manage, same as creating a supplier.
 */
async function canManageParties(c: any) {
  const u = me(c)
  if (u.role === 'admin') return true
  return hasPermission(u.id, 'party.manage')
}

const partyGuard = async (c: any) => {
  if (!(await canManageParties(c))) {
    return c.json({ error: 'You are not set up to manage suppliers', code: 'NOT_ALLOWED' }, 403)
  }
  return null
}

pharma.get('/suppliers/terms', async (c) => c.json(await suppliersWithTerms()))

pharma.get('/suppliers/:id/companies', async (c) =>
  c.json(await companiesFor(Number(c.req.param('id')))))

pharma.post('/suppliers/:id/companies', async (c) => {
  const no = await partyGuard(c); if (no) return no
  const b = z.object({ manufacturerId: z.number().int() }).parse(await c.req.json())
  return c.json(await addCompany(Number(c.req.param('id')), b.manufacturerId))
})

pharma.delete('/suppliers/:id/companies/:mfrId', async (c) => {
  const no = await partyGuard(c); if (no) return no
  return c.json(await removeCompany(
    Number(c.req.param('id')), Number(c.req.param('mfrId'))))
})

pharma.get('/suppliers/:id/slots', async (c) =>
  c.json(await slotsFor(Number(c.req.param('id')))))

pharma.post('/suppliers/:id/slots', async (c) => {
  const no = await partyGuard(c); if (no) return no
  const b = z.object({
    weekday: z.number().int().min(0).max(6),
    atTime: z.string().min(3),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await addSlot(Number(c.req.param('id')), b.weekday, b.atTime, b.note))
})

pharma.delete('/suppliers/:id/slots/:slotId', async (c) => {
  const no = await partyGuard(c); if (no) return no
  return c.json(await removeSlot(
    Number(c.req.param('id')), Number(c.req.param('slotId'))))
})

/* ====================================================== purchase orders */

/**
 * The order sheet for one supplier.
 *
 * Needs purchase.receive rather than a permission of its own. Raising an
 * order and booking the delivery against it are the same job done by the
 * same person, and a separate tick would mean somebody can order but not
 * receive, which describes nobody at this counter.
 */
async function canOrder(c: any) {
  const u = me(c)
  if (u.role === 'admin') return true
  return hasPermission(u.id, 'purchase.receive')
}

const orderGuard = async (c: any) => {
  if (!(await canOrder(c))) {
    return c.json({ error: 'You are not set up to raise orders', code: 'NOT_ALLOWED' }, 403)
  }
  return null
}

pharma.get('/orders/sheet', async (c) => {
  const no = await orderGuard(c); if (no) return no
  return c.json(await orderSheet({
    supplierId: Number(c.req.query('supplier') ?? 0),
    windowDays: Number(c.req.query('days') ?? 7)
  }))
})

pharma.get('/orders', async (c) => c.json(await listOrders({
  status: c.req.query('status') ?? undefined,
  supplierId: c.req.query('supplier') ? Number(c.req.query('supplier')) : undefined,
  from: c.req.query('from') ?? undefined,
  to: c.req.query('to') ?? undefined
})))

pharma.get('/orders/:id', async (c) => c.json(await orderDetail(Number(c.req.param('id')))))

pharma.post('/orders', async (c) => {
  const no = await orderGuard(c); if (no) return no
  const b = z.object({
    supplierId: z.number().int(),
    windowDays: z.number().int().min(1).max(365).optional(),
    note: z.string().nullable().optional(),
    lines: z.array(z.object({
      productId: z.number().int(),
      /* PACKS. The distributor ships packs; the order asks in packs. */
      orderPacks: z.number().int().min(0),
      soldUnits: z.number().int().min(0).optional(),
      stockUnits: z.number().int().min(0).optional()
    })).min(1)
  }).parse(await c.req.json())
  // The person comes from the session, never the request body.
  return c.json(await createOrder({ ...b, by: me(c).displayName }), 201)
})

pharma.delete('/orders/:id', async (c) => {
  const no = await orderGuard(c); if (no) return no
  return c.json(await deleteOrder(Number(c.req.param('id')), me(c).displayName))
})

pharma.get('/orders/:id/pdf', async (c) => {
  const order = await orderDetail(Number(c.req.param('id')))
  const pdf = await purchaseOrderPdf(order, me(c).displayName)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="${order.order_no}.pdf"`
    }
  })
})

/* ======================================================= opening stock */

/**
 * Typing in what is already on the shelves, on the first day.
 *
 * Its own permission, off for everybody by default, because this is the one
 * screen that can make stock appear with no delivery and no count behind it.
 * The pharmacy administrator turns it on for whoever is doing the changeover
 * and turns it off again afterwards.
 */
async function canOpen(c: any) {
  const u = me(c)
  if (u.role === 'admin') return true
  return hasPermission(u.id, 'stock.opening')
}

pharma.get('/opening-stock', async (c) => {
  if (!(await canOpen(c))) {
    return c.json({ error: 'You are not set up to set opening stock', code: 'NOT_ALLOWED' }, 403)
  }
  return c.json(await openingSheet(c.req.query('q') ?? undefined))
})

pharma.put('/opening-stock', async (c) => {
  if (!(await canOpen(c))) {
    return c.json({ error: 'You are not set up to set opening stock', code: 'NOT_ALLOWED' }, 403)
  }
  const b = z.object({
    lines: z.array(z.object({
      productId: z.number().int(),
      units: z.number().int().min(0)
    })).min(1)
  }).parse(await c.req.json())
  return c.json(await setOpeningStock({ lines: b.lines, by: me(c).displayName }))
})

/* ===================================================== pharmacy settings */

/**
 * How the till behaves, rather than anything about a sale.
 *
 * Readable by anybody who can reach the pharmacy, because the billing screen
 * needs to know whether to offer a discount box at all. Writable only by an
 * administrator: a cashier who can raise their own discount ceiling does not
 * have a ceiling.
 */
pharma.get('/settings', async (c) => c.json({
  discountEnabled: ((await getSetting('pharmacy.discountEnabled')) ?? 'true') !== 'false',
  /* Zero means no ceiling, which is how the till behaved before this existed. */
  discountMaxPct: Number((await getSetting('pharmacy.discountMaxPct')) ?? '0')
}))

pharma.put('/settings', async (c) => {
  const u = me(c)
  if (u.role !== 'admin' && !(await hasPermission(u.id, 'staff.access'))) {
    return c.json({
      error: 'Only an administrator can change how the till behaves',
      code: 'NOT_ALLOWED'
    }, 403)
  }
  const b = z.object({
    discountEnabled: z.boolean().optional(),
    /* 0 to 100. Zero is no ceiling rather than "no discount allowed" — that
     * is what the switch above is for, and conflating the two would make
     * "zero per cent" ambiguous. */
    discountMaxPct: z.number().int().min(0).max(100).optional()
  }).parse(await c.req.json())

  if (b.discountEnabled !== undefined) {
    await setSetting('pharmacy.discountEnabled', b.discountEnabled ? 'true' : 'false')
  }
  if (b.discountMaxPct !== undefined) {
    await setSetting('pharmacy.discountMaxPct', String(b.discountMaxPct))
  }
  return c.json({
    discountEnabled: ((await getSetting('pharmacy.discountEnabled')) ?? 'true') !== 'false',
    discountMaxPct: Number((await getSetting('pharmacy.discountMaxPct')) ?? '0')
  })
})
