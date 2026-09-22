import { Hono } from 'hono'
import { sql, eq, and, gt, ilike, or, asc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client'
import * as s from '../db/schema'
import { createSale, StockError, ComplianceError } from '../services/sales'
import { receiveGoods, ReceiptError } from '../services/purchase'
import type { SessionUser } from '../services/auth'

/**
 * The pharmacy, carried over from the standalone till.
 *
 * The batch and FEFO logic, pack/loose selling and goods-receipt flow are the
 * same code that has been running at a counter; only the transport changed
 * from Electron IPC to HTTP. What is new is the link to a prescription: a sale
 * can settle one, which marks its lines dispensed.
 */
export const pharmacy = new Hono()

const me = (c: any): SessionUser => c.get('user')

pharmacy.onError((err, c) => {
  if (err instanceof ComplianceError) {
    return c.json({ error: err.message, code: err.code, products: err.products }, 422)
  }
  if (err instanceof StockError) {
    return c.json({ error: err.message, code: err.code, productId: err.productId }, 409)
  }
  if (err instanceof ReceiptError) {
    return c.json({ error: err.message, detail: err.detail, code: err.code }, 409)
  }
  console.error('[pharmacy]', err)
  return c.json({ error: err.message ?? 'Something went wrong' }, 500)
})

/* -------------------------------------------------------------- products */

const productSchema = z.object({
  name: z.string().min(1),
  barcode: z.string().nullable().optional(),
  productCode: z.string().nullable().optional(),
  genericName: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  form: z.string().nullable().optional(),
  strength: z.string().nullable().optional(),
  unitLabel: z.string().default('unit'),
  subUnitLabel: z.string().nullable().optional(),
  packSize: z.number().int().min(1).default(1),
  allowLoose: z.boolean().default(false),
  schedule: z.enum(['otc', 'g', 'controlled', 'refrigerated']).default('otc'),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
  reorderLevel: z.number().int().min(0).default(0),
  rackLocation: z.string().nullable().optional(),
  /**
   * Prices, per single unit and in paisa. A pack price is this times the pack
   * size and is never stored: two numbers that should agree eventually do not.
   */
  purchasePaisa: z.number().int().min(0).default(0),
  tradePaisa: z.number().int().min(0).default(0),
  retailPaisa: z.number().int().min(0).default(0),
  saltId: z.number().int().nullable().optional(),
  groupId: z.number().int().nullable().optional(),
  manufacturerId: z.number().int().nullable().optional(),
  packLabel: z.string().nullable().optional()
})

pharmacy.post('/products', async (c) => {
  const b = productSchema.parse(await c.req.json())
  const [row] = await db.insert(s.products).values(b).returning()
  return c.json(row, 201)
})

pharmacy.patch('/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = productSchema.partial().parse(await c.req.json())

  /**
   * A price change is recorded rather than silently applied. The old system
   * kept these going back to 2012 and it is the first thing anyone reaches for
   * in an argument about margin.
   */
  const before = ((await db.execute<any>(sql`
    SELECT purchase_paisa, trade_paisa, retail_paisa FROM products WHERE id = ${id}`))
    .rows as any[])[0]

  const [row] = await db.update(s.products).set({ ...b, updatedAt: new Date() })
    .where(eq(s.products.id, id)).returning()
  if (!row) return c.json({ error: 'Medicine not found' }, 404)

  if (before) {
    const moved = ['purchase_paisa', 'trade_paisa', 'retail_paisa'].some((k) => {
      const key = k.replace(/_(\w)/g, (_, c2) => c2.toUpperCase()) as keyof typeof b
      return b[key] !== undefined && Number(b[key]) !== Number(before[k])
    })
    if (moved) {
      await db.execute(sql`
        INSERT INTO price_history
          (product_id, old_purchase_paisa, new_purchase_paisa, old_trade_paisa, new_trade_paisa,
           old_retail_paisa, new_retail_paisa, changed_by, reason)
        VALUES (${id}, ${before.purchase_paisa}, ${(row as any).purchasePaisa ?? 0},
                ${before.trade_paisa}, ${(row as any).tradePaisa ?? 0},
                ${before.retail_paisa}, ${(row as any).retailPaisa ?? 0},
                ${(c as any).get('user')?.displayName ?? 'unknown'}, 'Edited on the medicine')`)
    }
  }
  return c.json(row)
})

/** Archive, never delete: old invoices reference the product. */
pharmacy.post('/products/:id/archive', async (c) => {
  const id = Number(c.req.param('id'))
  const st = await db.execute<any>(sql`
    SELECT COALESCE(SUM(qty_on_hand),0)::int AS n FROM batches
    WHERE product_id = ${id} AND qty_on_hand > 0 AND expiry_date > CURRENT_DATE`)
  const left = Number((st.rows as any[])[0].n)
  if (left > 0) {
    return c.json({ error: `${left} units are still in stock. Sell or write them off first.` }, 409)
  }
  const [row] = await db.update(s.products).set({ isActive: false })
    .where(eq(s.products.id, id)).returning()
  return c.json(row)
})

pharmacy.post('/products/:id/restore', async (c) => {
  const [row] = await db.update(s.products).set({ isActive: true })
    .where(eq(s.products.id, Number(c.req.param('id')))).returning()
  return c.json(row)
})

pharmacy.get('/products/:id/batches', async (c) =>
  c.json(await db.select().from(s.batches)
    .where(and(eq(s.batches.productId, Number(c.req.param('id'))), gt(s.batches.qtyOnHand, 0)))
    .orderBy(asc(s.batches.expiryDate))))

/* ------------------------------------------------------------- inventory */

pharmacy.get('/inventory', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const filter = c.req.query('filter') ?? 'all'
  const mfr = (c.req.query('manufacturer') ?? '').trim()
  const supplierId = Number(c.req.query('supplierId') ?? 0)
  const like = `%${q}%`

  const r = await db.execute<any>(sql`
    WITH stock AS (
      SELECT product_id,
             SUM(qty_on_hand) FILTER (WHERE expiry_date > CURRENT_DATE)::int AS live_qty,
             SUM(qty_on_hand) FILTER (WHERE expiry_date <= CURRENT_DATE)::int AS dead_qty,
             COUNT(*) FILTER (WHERE expiry_date > CURRENT_DATE)::int          AS batch_count,
             MIN(expiry_date) FILTER (WHERE expiry_date > CURRENT_DATE)       AS nearest_expiry,
             SUM(qty_on_hand * cost_paisa)::bigint                            AS stock_value_paisa
      FROM batches WHERE qty_on_hand > 0 GROUP BY product_id
    )
    SELECT p.*, COALESCE(st.live_qty,0) AS in_stock, COALESCE(st.dead_qty,0) AS expired_qty,
           COALESCE(st.batch_count,0) AS batch_count, st.nearest_expiry,
           COALESCE(st.stock_value_paisa,0) AS stock_value_paisa,
           latest.price_paisa,
           -- The names, so the edit form can show what was chosen without a
           -- second round trip per medicine.
           slt.name AS salt_name, mf.name AS manufacturer_name, grp.name AS group_name
    FROM products p
    LEFT JOIN salts slt ON slt.id = p.salt_id
    LEFT JOIN manufacturers mf ON mf.id = p.manufacturer_id
    LEFT JOIN product_groups grp ON grp.id = p.group_id
    LEFT JOIN stock st ON st.product_id = p.id
    LEFT JOIN LATERAL (SELECT price_paisa FROM batches WHERE product_id = p.id
                       ORDER BY received_at DESC LIMIT 1) latest ON true
    WHERE (${q} = '' OR p.name ILIKE ${like} OR p.generic_name ILIKE ${like}
           OR p.manufacturer ILIKE ${like} OR p.barcode = ${q} OR p.product_code ILIKE ${like})
      AND (${mfr} = '' OR p.manufacturer = ${mfr})
      AND (${supplierId} = 0 OR EXISTS (SELECT 1 FROM batches b
            WHERE b.product_id = p.id AND b.supplier_id = ${supplierId}))
      AND CASE ${filter}
            WHEN 'archived' THEN NOT p.is_active
            WHEN 'out'      THEN p.is_active AND COALESCE(st.live_qty,0) = 0
            WHEN 'low'      THEN p.is_active AND p.reorder_level > 0
                                 AND COALESCE(st.live_qty,0) <= p.reorder_level
            WHEN 'expiring' THEN p.is_active AND st.nearest_expiry IS NOT NULL
                                 AND st.nearest_expiry <= CURRENT_DATE + 90
            ELSE p.is_active
          END
    ORDER BY p.name LIMIT 500`)
  return c.json(r.rows)
})

pharmacy.get('/inventory/summary', async (c) => {
  const r = await db.execute<any>(sql`
    WITH stock AS (
      SELECT product_id,
             SUM(qty_on_hand) FILTER (WHERE expiry_date > CURRENT_DATE)::int AS live_qty,
             MIN(expiry_date) FILTER (WHERE expiry_date > CURRENT_DATE) AS nearest_expiry,
             SUM(qty_on_hand*cost_paisa) FILTER (WHERE expiry_date > CURRENT_DATE)::bigint AS val
      FROM batches WHERE qty_on_hand > 0 GROUP BY product_id)
    SELECT COUNT(*) FILTER (WHERE p.is_active)::int AS all_count,
           COUNT(*) FILTER (WHERE p.is_active AND COALESCE(st.live_qty,0)=0)::int AS out_count,
           COUNT(*) FILTER (WHERE p.is_active AND p.reorder_level>0
                            AND COALESCE(st.live_qty,0)<=p.reorder_level)::int AS low_count,
           COUNT(*) FILTER (WHERE p.is_active AND st.nearest_expiry IS NOT NULL
                            AND st.nearest_expiry <= CURRENT_DATE+90)::int AS expiring_count,
           COUNT(*) FILTER (WHERE NOT p.is_active)::int AS archived_count,
           COALESCE(SUM(st.val) FILTER (WHERE p.is_active),0)::bigint AS total_value_paisa
    FROM products p LEFT JOIN stock st ON st.product_id = p.id`)
  return c.json((r.rows as any[])[0])
})

pharmacy.get('/inventory/filters', async (c) => {
  const mfrs = await db.execute<any>(sql`
    SELECT manufacturer AS name, COUNT(*)::int AS n FROM products
    WHERE is_active AND manufacturer IS NOT NULL AND manufacturer <> ''
    GROUP BY manufacturer ORDER BY manufacturer`)
  const sups = await db.execute<any>(sql`
    SELECT su.id, su.name, COUNT(DISTINCT b.product_id)::int AS n
    FROM suppliers su JOIN batches b ON b.supplier_id = su.id AND b.qty_on_hand > 0
    WHERE su.is_active GROUP BY su.id, su.name ORDER BY su.name`)
  return c.json({ manufacturers: mfrs.rows, suppliers: sups.rows })
})

/* ------------------------------------------------------------- suppliers */

const supplierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  ntn: z.string().nullable().optional()
})

pharmacy.get('/suppliers', async (c) => {
  const all = c.req.query('all') === '1'
  const r = await db.execute<any>(sql`
    SELECT su.*, COALESCE(p.deliveries,0)::int AS deliveries,
           COALESCE(p.total_paisa,0)::bigint AS total_paisa, p.last_delivery
    FROM suppliers su
    LEFT JOIN LATERAL (SELECT COUNT(*) AS deliveries, SUM(total_paisa) AS total_paisa,
                       MAX(invoice_date) AS last_delivery
                       FROM purchases WHERE supplier_id = su.id) p ON true
    WHERE ${all ? sql`true` : sql`su.is_active`} ORDER BY su.name`)
  return c.json(r.rows)
})

pharmacy.post('/suppliers', async (c) => {
  const [row] = await db.insert(s.suppliers).values(supplierSchema.parse(await c.req.json())).returning()
  return c.json(row, 201)
})

pharmacy.patch('/suppliers/:id', async (c) => {
  const [row] = await db.update(s.suppliers).set(supplierSchema.partial().parse(await c.req.json()))
    .where(eq(s.suppliers.id, Number(c.req.param('id')))).returning()
  return c.json(row)
})

pharmacy.post('/suppliers/:id/restore', async (c) => {
  const [row] = await db.update(s.suppliers).set({ isActive: true })
    .where(eq(s.suppliers.id, Number(c.req.param('id')))).returning()
  return c.json(row)
})

/** Deletes only when nothing references it, otherwise archives. */
pharmacy.delete('/suppliers/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const refs = await db.execute<any>(sql`
    SELECT (SELECT COUNT(*)::int FROM purchases WHERE supplier_id=${id}) AS deliveries,
           (SELECT COUNT(*)::int FROM batches WHERE supplier_id=${id}) AS batches`)
  const { deliveries, batches } = (refs.rows as any[])[0]
  if (Number(deliveries) > 0 || Number(batches) > 0) {
    const [row] = await db.update(s.suppliers).set({ isActive: false })
      .where(eq(s.suppliers.id, id)).returning()
    return c.json({
      action: 'archived', supplier: row,
      reason: `On ${deliveries} deliveries and ${batches} batches, so the records stay. Hidden from the list instead.`
    })
  }
  await db.delete(s.suppliers).where(eq(s.suppliers.id, id))
  return c.json({ action: 'deleted' })
})

/* ------------------------------------------------------------- purchases */

pharmacy.get('/purchases', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const supplierId = Number(c.req.query('supplier') ?? 0)
  const from = c.req.query('from') ?? null
  const to = c.req.query('to') ?? null
  let where = sql`true`
  if (supplierId > 0) where = sql`${where} AND p.supplier_id = ${supplierId}`
  if (from && to) where = sql`${where} AND p.invoice_date BETWEEN ${from}::date AND ${to}::date`
  if (q) where = sql`${where} AND (p.supplier_invoice_no ILIKE ${'%'+q+'%'} OR su.name ILIKE ${'%'+q+'%'})`

  const r = await db.execute<any>(sql`
    SELECT p.*, su.name AS supplier_name, su.phone AS supplier_phone,
           (SELECT COUNT(*)::int FROM purchase_items pi WHERE pi.purchase_id=p.id) AS line_count,
           (SELECT COALESCE(SUM(pi.qty),0)::int FROM purchase_items pi WHERE pi.purchase_id=p.id) AS pack_count
    FROM purchases p JOIN suppliers su ON su.id = p.supplier_id
    WHERE ${where} ORDER BY p.invoice_date DESC, p.id DESC LIMIT 300`)
  return c.json(r.rows)
})

pharmacy.get('/purchases/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const head = await db.execute<any>(sql`
    SELECT p.*, su.name AS supplier_name, su.phone AS supplier_phone,
           su.address AS supplier_address, su.ntn AS supplier_ntn
    FROM purchases p JOIN suppliers su ON su.id=p.supplier_id WHERE p.id=${id}`)
  const purchase = (head.rows as any[])[0]
  if (!purchase) return c.json({ error: 'Delivery not found' }, 404)
  const lines = await db.execute<any>(sql`
    SELECT pi.*, b.batch_no, b.expiry_date, b.price_paisa, b.qty_on_hand,
           pr.name AS product_name, pr.unit_label, pr.sub_unit_label, pr.pack_size,
           pr.generic_name, pr.manufacturer
    FROM purchase_items pi JOIN batches b ON b.id=pi.batch_id
    JOIN products pr ON pr.id=b.product_id WHERE pi.purchase_id=${id} ORDER BY pi.id`)
  return c.json({ purchase, lines: lines.rows })
})

pharmacy.post('/purchases', async (c) => {
  const b = z.object({
    supplierId: z.number().int(),
    supplierInvoiceNo: z.string().min(1),
    invoiceDate: z.string(),
    note: z.string().optional(),
    lines: z.array(z.object({
      productId: z.number().int(), batchNo: z.string().min(1), expiryDate: z.string(),
      qty: z.number().int().min(1), bonusQty: z.number().int().min(0).optional(),
      costPaisa: z.number().int().min(0),
      /**
       * Optional, and normally left out.
       *
       * A batch is stamped with whatever the medicine sells for on the day it
       * arrives, and keeps that price for its whole life. Passing one here is
       * for the rare case where a delivery carries a different printed price
       * from the current one.
       */
      pricePaisa: z.number().int().min(0).optional()
    })).min(1)
  }).parse(await c.req.json())
  return c.json(await receiveGoods(db, { ...b, receivedBy: me(c).displayName }), 201)
})

/* ----------------------------------------------------------------- sales */

pharmacy.post('/sales', async (c) => {
  const b = z.object({
    lines: z.array(z.object({
      productId: z.number().int(), qty: z.number().int().min(1),
      soldAs: z.enum(['pack', 'unit']).optional(),
      batchId: z.number().int().optional(),
      discountPaisa: z.number().int().min(0).optional()
    })).min(1),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    doctorName: z.string().optional(),
    payMethod: z.enum(['cash', 'card', 'easypaisa', 'jazzcash', 'credit']).optional(),
    paidPaisa: z.number().int().optional(),
    /** When set, this sale settles a prescription. */
    visitId: z.number().int().optional(),
    patientId: z.number().int().optional()
  }).parse(await c.req.json())

  const u = me(c)
  // The cashier comes from the session, never the request body.
  const result = await createSale(db, {
    ...b, cashier: u.displayName, cashierStaffId: u.id
  })

  /**
   * Settling a prescription marks its lines dispensed.
   *
   * Matched on product, so a doctor's free-text line that the pharmacy filled
   * with a different brand is deliberately left pending rather than silently
   * closed: the record should show what was actually handed over.
   */
  if (b.visitId) {
    await db.execute(sql`
      UPDATE prescription_items pi
      SET qty_dispensed = pi.qty_dispensed + sold.qty,
          status = CASE WHEN pi.qty_dispensed + sold.qty >= pi.qty_prescribed
                        THEN 'dispensed'::dispense_status ELSE 'partial'::dispense_status END
      FROM (
        SELECT si.product_id, SUM(si.display_qty)::int AS qty
        FROM sale_items si WHERE si.sale_id = ${result.sale.id} GROUP BY si.product_id
      ) sold
      JOIN prescriptions pr ON pr.visit_id = ${b.visitId}
      WHERE pi.prescription_id = pr.id AND pi.product_id = sold.product_id`)
  }

  const items = await db.select().from(s.saleItems).where(eq(s.saleItems.saleId, result.sale.id))
  return c.json({ sale: result.sale, items }, 201)
})

pharmacy.get('/sales', async (c) => {
  const mode = c.req.query('mode') ?? 'today'
  const from = c.req.query('from') ?? null
  const to = c.req.query('to') ?? null
  const seqFrom = c.req.query('seqFrom') ? Number(c.req.query('seqFrom')) : null
  const seqTo = c.req.query('seqTo') ? Number(c.req.query('seqTo')) : null
  const amtFrom = c.req.query('amtFrom') ? Number(c.req.query('amtFrom')) : null
  const amtTo = c.req.query('amtTo') ? Number(c.req.query('amtTo')) : null
  const q = (c.req.query('q') ?? '').trim()
  const sort = c.req.query('sort') ?? 'newest'
  const cashierId = Number(c.req.query('cashier') ?? 0)

  let where = sql`sa.status <> 'voided'`
  if (mode === 'today') {
    where = sql`${where} AND sa.sold_at >= date_trunc('day', now())
                       AND sa.sold_at < date_trunc('day', now()) + interval '1 day'`
  } else if (mode === 'range' && from && to) {
    where = sql`${where} AND sa.sold_at >= ${from}::date AND sa.sold_at < (${to}::date + interval '1 day')`
  } else if (mode === 'amount' && (amtFrom !== null || amtTo !== null)) {
    const lo = amtFrom ?? 0, hi = amtTo ?? Number.MAX_SAFE_INTEGER
    where = sql`${where} AND sa.total_paisa BETWEEN ${Math.min(lo, hi)} AND ${Math.max(lo, hi)}`
  } else if (mode === 'bills' && seqFrom !== null && seqTo !== null) {
    where = sql`${where} AND sa.invoice_seq BETWEEN ${Math.min(seqFrom, seqTo)} AND ${Math.max(seqFrom, seqTo)}`
  }
  if (cashierId > 0) where = sql`${where} AND sa.cashier_staff_id = ${cashierId}`
  if (q) {
    const asPaisa = /^\d+(\.\d{1,2})?$/.test(q) ? Math.round(parseFloat(q) * 100) : null
    where = sql`${where} AND (sa.invoice_no ILIKE ${'%'+q+'%'} OR sa.customer_name ILIKE ${'%'+q+'%'}
                          OR sa.customer_phone ILIKE ${'%'+q+'%'} OR sa.doctor_name ILIKE ${'%'+q+'%'}
                          ${asPaisa !== null ? sql`OR sa.total_paisa = ${asPaisa}` : sql``})`
  }
  const order = { oldest: sql`sa.sold_at ASC`, highest: sql`sa.total_paisa DESC, sa.sold_at DESC`,
    lowest: sql`sa.total_paisa ASC, sa.sold_at DESC`, bill_asc: sql`sa.invoice_seq ASC`,
    bill_desc: sql`sa.invoice_seq DESC` }[sort] ?? sql`sa.sold_at DESC`

  const rows = await db.execute<any>(sql`
    SELECT sa.*, p.name AS patient_name, p.mrn,
           COALESCE(li.line_count,0)::int AS line_count,
           COALESCE(li.unit_count,0)::int AS unit_count,
           COALESCE(li.margin_paisa,0)::bigint AS margin_paisa
    FROM sales sa
    LEFT JOIN patients p ON p.id = sa.patient_id
    LEFT JOIN LATERAL (SELECT COUNT(*) AS line_count, SUM(display_qty) AS unit_count,
                       SUM((line_total_paisa - line_tax_paisa) - unit_cost_paisa*qty) AS margin_paisa
                       FROM sale_items WHERE sale_id = sa.id) li ON true
    WHERE ${where} ORDER BY ${order} LIMIT 500`)
  const totals = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS bill_count,
           COALESCE(SUM(sa.total_paisa),0)::bigint AS revenue_paisa,
           COALESCE(SUM(sa.tax_paisa),0)::bigint AS tax_paisa,
           COALESCE(SUM(sa.discount_paisa),0)::bigint AS discount_paisa
    FROM sales sa WHERE ${where}`)
  return c.json({ rows: rows.rows, totals: (totals.rows as any[])[0] })
})

pharmacy.get('/sales/bounds', async (c) => {
  const r = await db.execute<any>(sql`
    SELECT COALESCE(MIN(invoice_seq),0)::int AS min_seq, COALESCE(MAX(invoice_seq),0)::int AS max_seq
    FROM sales WHERE status <> 'voided'`)
  return c.json((r.rows as any[])[0])
})

pharmacy.get('/sales/cashiers', async (c) => {
  const r = await db.execute<any>(sql`
    SELECT st.id, st.display_name, COUNT(sa.id)::int AS bills
    FROM staff st JOIN sales sa ON sa.cashier_staff_id = st.id AND sa.status <> 'voided'
    GROUP BY st.id, st.display_name ORDER BY st.display_name`)
  return c.json(r.rows)
})

pharmacy.get('/sales/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [sale] = await db.select().from(s.sales).where(eq(s.sales.id, id))
  if (!sale) return c.json({ error: 'Invoice not found' }, 404)
  const items = await db.execute<any>(sql`
    SELECT si.*, p.schedule, p.unit_label, p.sub_unit_label
    FROM sale_items si JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ${id} ORDER BY si.id`)
  return c.json({ sale, items: items.rows })
})

/* --------------------------------------------------------------- reports */

pharmacy.get('/reports/expiring', async (c) => {
  const days = Number(c.req.query('days') ?? 90)
  const r = await db.execute<any>(sql`
    SELECT b.id, b.batch_no, b.expiry_date, b.qty_on_hand, b.cost_paisa,
           (b.qty_on_hand*b.cost_paisa)::bigint AS value_at_risk_paisa,
           (b.expiry_date - CURRENT_DATE)::int AS days_left,
           p.name AS product_name, p.id AS product_id
    FROM batches b JOIN products p ON p.id = b.product_id
    WHERE b.qty_on_hand > 0 AND b.expiry_date <= CURRENT_DATE + ${days}::int
    ORDER BY b.expiry_date LIMIT 300`)
  return c.json(r.rows)
})

pharmacy.get('/reports/low-stock', async (c) => {
  const r = await db.execute<any>(sql`
    SELECT p.id, p.name, p.reorder_level, p.rack_location, p.pack_size, p.unit_label,
           COALESCE(SUM(b.qty_on_hand),0)::int AS in_stock
    FROM products p
    LEFT JOIN batches b ON b.product_id=p.id AND b.qty_on_hand>0 AND b.expiry_date>CURRENT_DATE
    WHERE p.is_active AND p.reorder_level > 0
    GROUP BY p.id HAVING COALESCE(SUM(b.qty_on_hand),0) <= p.reorder_level
    ORDER BY (COALESCE(SUM(b.qty_on_hand),0)::float / NULLIF(p.reorder_level,0)) LIMIT 200`)
  return c.json(r.rows)
})

/* ------------------------------------------------------------- dashboard */

pharmacy.get('/dashboard', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30), 1), 365)
  const today = days === 1
  const since = today ? sql`date_trunc('day', now())` : sql`now() - (${days} || ' days')::interval`

  const kpi = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(total_paisa) FILTER (WHERE sold_at >= date_trunc('day',now())),0)::bigint AS today_revenue,
           COUNT(*) FILTER (WHERE sold_at >= date_trunc('day',now()))::int AS today_bills,
           COALESCE(SUM(total_paisa) FILTER (WHERE sold_at >= date_trunc('day',now()) - interval '1 day'
             AND sold_at < date_trunc('day',now())),0)::bigint AS yesterday_revenue,
           COALESCE(SUM(total_paisa) FILTER (WHERE sold_at >= ${since}),0)::bigint AS window_revenue,
           COUNT(*) FILTER (WHERE sold_at >= ${since})::int AS window_bills
    FROM sales WHERE status <> 'voided'`)).rows[0]

  const margin = (await db.execute<any>(sql`
    SELECT COALESCE(SUM((si.line_total_paisa - si.line_tax_paisa) - si.unit_cost_paisa*si.qty)
             FILTER (WHERE sa.sold_at >= ${since}),0)::bigint AS window_margin,
           COALESCE(SUM(si.unit_cost_paisa*si.qty) FILTER (WHERE sa.sold_at >= ${since}),0)::bigint AS window_cogs
    FROM sale_items si JOIN sales sa ON sa.id=si.sale_id WHERE sa.status <> 'voided'`)).rows[0]

  const trend = (await db.execute<any>(sql`
    SELECT g.d::date AS day, COALESCE(s2.revenue,0)::bigint AS revenue_paisa,
           COALESCE(s2.bills,0)::int AS bills
    FROM generate_series(date_trunc('day',now()) - ((${Math.max(days,7)} - 1)||' days')::interval,
                         date_trunc('day',now()), '1 day') g(d)
    LEFT JOIN (SELECT date_trunc('day',sold_at) AS d, SUM(total_paisa) AS revenue, COUNT(*) AS bills
               FROM sales WHERE status<>'voided' GROUP BY 1) s2 ON s2.d = g.d
    ORDER BY g.d`)).rows

  const expiry = (await db.execute<any>(sql`
    SELECT CASE WHEN expiry_date <= CURRENT_DATE THEN 'expired'
                WHEN expiry_date <= CURRENT_DATE+30 THEN 'd30'
                WHEN expiry_date <= CURRENT_DATE+60 THEN 'd60'
                WHEN expiry_date <= CURRENT_DATE+90 THEN 'd90' ELSE 'safe' END AS bucket,
           COUNT(*)::int AS batches, SUM(qty_on_hand)::int AS units,
           SUM(qty_on_hand*cost_paisa)::bigint AS value_paisa
    FROM batches WHERE qty_on_hand > 0 GROUP BY 1`)).rows

  const payment = (await db.execute<any>(sql`
    SELECT pay_method, COUNT(*)::int AS bills, SUM(total_paisa)::bigint AS revenue_paisa
    FROM sales WHERE status<>'voided' AND sold_at >= ${since}
    GROUP BY 1 ORDER BY revenue_paisa DESC`)).rows

  const topRevenue = (await db.execute<any>(sql`
    SELECT si.product_name AS name, SUM(si.display_qty)::int AS units,
           SUM(si.line_total_paisa)::bigint AS revenue_paisa
    FROM sale_items si JOIN sales sa ON sa.id=si.sale_id
    WHERE sa.status<>'voided' AND sa.sold_at >= ${since}
    GROUP BY 1 ORDER BY revenue_paisa DESC LIMIT 8`)).rows

  const stock = (await db.execute<any>(sql`
    WITH live AS (SELECT p.id, p.reorder_level,
      COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.expiry_date>CURRENT_DATE),0)::int AS qty,
      COALESCE(SUM(b.qty_on_hand*b.cost_paisa) FILTER (WHERE b.expiry_date>CURRENT_DATE),0)::bigint AS val
      FROM products p LEFT JOIN batches b ON b.product_id=p.id AND b.qty_on_hand>0
      WHERE p.is_active GROUP BY p.id, p.reorder_level)
    SELECT COALESCE(SUM(val),0)::bigint AS stock_value_paisa, COUNT(*)::int AS product_count,
           COUNT(*) FILTER (WHERE qty=0)::int AS out_count,
           COUNT(*) FILTER (WHERE reorder_level>0 AND qty<=reorder_level)::int AS low_count
    FROM live`)).rows[0]

  const cashUp = today ? (await db.execute<any>(sql`
    SELECT COALESCE(SUM(total_paisa) FILTER (WHERE pay_method='cash'),0)::bigint AS cash_paisa,
           COALESCE(SUM(total_paisa) FILTER (WHERE pay_method<>'cash'),0)::bigint AS digital_paisa,
           COUNT(*) FILTER (WHERE pay_method='cash')::int AS cash_bills,
           COALESCE(SUM(discount_paisa),0)::bigint AS discount_paisa
    FROM sales WHERE status<>'voided' AND sold_at >= date_trunc('day',now())`)).rows[0] : null

  const dailyCogs = Number(margin.window_cogs) / days
  return c.json({
    days, today, kpi: { ...kpi, ...margin },
    coverDays: dailyCogs > 0 ? Math.round(Number(stock.stock_value_paisa) / dailyCogs) : null,
    stock, trend, expiry, payment, topRevenue, cashUp
  })
})
