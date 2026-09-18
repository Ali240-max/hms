import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Reports.
 *
 * Built as one module with a shared date window rather than sixty separate
 * queries, because the old system's sixty report screens were mostly the same
 * question asked with a different GROUP BY, and each one was maintained by
 * hand. Here the grouping is a parameter.
 *
 * Every figure is derived from the transaction rows. Nothing reads a
 * pre-computed monthly bucket, so a correction to an old invoice shows up in
 * last month's report immediately instead of leaving two numbers that
 * disagree and no way to tell which is right.
 *
 * Cost of sale uses the cost snapshotted onto the sale line at the time, not
 * today's purchase price. Otherwise repricing a medicine silently rewrites
 * last year's margin.
 */

export type Window = { from: string; to: string }

const between = (col: string, w: Window) =>
  sql`${sql.raw(col)} >= ${w.from}::date AND ${sql.raw(col)} < (${w.to}::date + interval '1 day')`

const LIVE = sql`sa.status <> 'voided' AND sa.cancelled_at IS NULL`

/* ------------------------------------------------------------- summary */

/** The one screen an owner looks at. Everything else explains a number here. */
export async function salesSummary(w: Window) {
  const head = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS invoices,
           COALESCE(SUM(sa.total_paisa),0)::bigint AS revenue_paisa,
           COALESCE(SUM(sa.discount_paisa),0)::bigint AS discount_paisa,
           COALESCE(SUM(sa.tax_paisa),0)::bigint AS tax_paisa,
           COUNT(*) FILTER (WHERE sa.sale_kind = 'credit')::int AS credit_invoices,
           COALESCE(SUM(sa.total_paisa) FILTER (WHERE sa.sale_kind = 'credit'),0)::bigint
             AS credit_paisa,
           COALESCE(AVG(sa.total_paisa),0)::bigint AS average_paisa
    FROM sales sa WHERE ${LIVE} AND ${between('sa.sold_at', w)}`)).rows[0]

  const cost = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(si.unit_cost_paisa * si.qty),0)::bigint AS cost_paisa,
           COALESCE(SUM((si.line_total_paisa - si.line_tax_paisa)
                        - si.unit_cost_paisa * si.qty),0)::bigint AS margin_paisa,
           COALESCE(SUM(si.display_qty),0)::int AS units
    FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
    WHERE ${LIVE} AND ${between('sa.sold_at', w)}`)).rows[0]

  const returns = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS returns,
           COALESCE(SUM(total_paisa),0)::bigint AS returned_paisa
    FROM sale_returns WHERE ${between('returned_at', w)}`)).rows[0]

  const cancelled = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS cancelled,
           COALESCE(SUM(total_paisa),0)::bigint AS cancelled_paisa
    FROM sales WHERE cancelled_at IS NOT NULL AND ${between('cancelled_at', w)}`)).rows[0]

  const revenue = Number(head.revenue_paisa)
  return {
    ...head, ...cost, ...returns, ...cancelled,
    net_paisa: revenue - Number(returns.returned_paisa),
    margin_pct: revenue > 0 ? (Number(cost.margin_paisa) / revenue) * 100 : 0
  }
}

/* --------------------------------------------------------- sales, sliced */

/**
 * The same question, grouped differently. `by` replaces about a dozen of the
 * old system's separate report screens.
 */
export async function salesBy(w: Window, by:
  'day' | 'month' | 'product' | 'manufacturer' | 'salt' | 'group' |
  'party' | 'cashier' | 'salesman' | 'hour' | 'kind') {

  const dimension = {
    day:          sql`to_char(sa.sold_at, 'YYYY-MM-DD')`,
    month:        sql`to_char(sa.sold_at, 'YYYY-MM')`,
    hour:         sql`to_char(sa.sold_at, 'HH24') || ':00'`,
    product:      sql`si.product_name`,
    manufacturer: sql`COALESCE(mf.name, 'Not recorded')`,
    salt:         sql`COALESCE(slt.name, 'Not recorded')`,
    group:        sql`COALESCE(grp.name, 'Not grouped')`,
    party:        sql`COALESCE(pt.name, sa.customer_name, 'Walk-in')`,
    cashier:      sql`COALESCE(sa.cashier, 'Not recorded')`,
    salesman:     sql`COALESCE(sa.salesman, 'Not recorded')`,
    kind:         sql`sa.sale_kind`
  }[by]

  const needsItems = ['product', 'manufacturer', 'salt', 'group'].includes(by)

  if (needsItems) {
    const r = await db.execute<any>(sql`
      SELECT ${dimension} AS label,
             COUNT(DISTINCT sa.id)::int AS invoices,
             COALESCE(SUM(si.display_qty),0)::int AS units,
             COALESCE(SUM(si.line_total_paisa),0)::bigint AS revenue_paisa,
             COALESCE(SUM(si.unit_cost_paisa * si.qty),0)::bigint AS cost_paisa,
             COALESCE(SUM((si.line_total_paisa - si.line_tax_paisa)
                          - si.unit_cost_paisa * si.qty),0)::bigint AS margin_paisa,
             COALESCE(SUM(si.discount_paisa),0)::bigint AS discount_paisa
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      LEFT JOIN products p  ON p.id = si.product_id
      LEFT JOIN manufacturers mf ON mf.id = p.manufacturer_id
      LEFT JOIN salts slt   ON slt.id = p.salt_id
      LEFT JOIN product_groups grp ON grp.id = p.group_id
      WHERE ${LIVE} AND ${between('sa.sold_at', w)}
      GROUP BY 1 ORDER BY revenue_paisa DESC LIMIT 400`)
    return r.rows
  }

  const r = await db.execute<any>(sql`
    SELECT ${dimension} AS label,
           COUNT(*)::int AS invoices,
           COALESCE(SUM(sa.total_paisa),0)::bigint AS revenue_paisa,
           COALESCE(SUM(sa.discount_paisa),0)::bigint AS discount_paisa,
           COALESCE(SUM(sa.tax_paisa),0)::bigint AS tax_paisa,
           COALESCE(AVG(sa.total_paisa),0)::bigint AS average_paisa,
           COALESCE((SELECT SUM((si2.line_total_paisa - si2.line_tax_paisa)
                                - si2.unit_cost_paisa * si2.qty)
                     FROM sale_items si2 WHERE si2.sale_id = ANY(array_agg(sa.id))),0)::bigint
             AS margin_paisa
    FROM sales sa
    LEFT JOIN parties pt ON pt.id = sa.party_id
    WHERE ${LIVE} AND ${between('sa.sold_at', w)}
    GROUP BY 1 ORDER BY ${by === 'day' || by === 'month' || by === 'hour'
      ? sql`1` : sql`revenue_paisa DESC`} LIMIT 400`)
  return r.rows
}

/** Invoice by invoice, for the day-book. */
export async function invoiceRegister(w: Window, opts: {
  kind?: string; partyId?: number; q?: string } = {}) {
  let where = sql`${between('sa.sold_at', w)}`
  if (opts.kind && opts.kind !== 'all') {
    if (opts.kind === 'cancelled') where = sql`${where} AND sa.cancelled_at IS NOT NULL`
    else where = sql`${where} AND sa.sale_kind = ${opts.kind} AND sa.cancelled_at IS NULL`
  }
  if (opts.partyId) where = sql`${where} AND sa.party_id = ${opts.partyId}`
  if (opts.q) {
    const like = `%${opts.q}%`
    where = sql`${where} AND (sa.invoice_no ILIKE ${like} OR sa.customer_name ILIKE ${like})`
  }
  const r = await db.execute<any>(sql`
    SELECT sa.id, sa.invoice_no, sa.sold_at, sa.sale_kind, sa.total_paisa,
           sa.discount_paisa, sa.tax_paisa, sa.pay_method, sa.cashier,
           sa.cancelled_at, sa.cancel_reason,
           COALESCE(pt.name, sa.customer_name, 'Walk-in') AS party_name,
           (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = sa.id) AS lines,
           COALESCE((SELECT SUM((si.line_total_paisa - si.line_tax_paisa)
                                - si.unit_cost_paisa * si.qty)
                     FROM sale_items si WHERE si.sale_id = sa.id),0)::bigint AS margin_paisa
    FROM sales sa LEFT JOIN parties pt ON pt.id = sa.party_id
    WHERE ${where} ORDER BY sa.sold_at DESC LIMIT 500`)
  return r.rows
}

/* ----------------------------------------------------- purchase reports */

export async function purchaseSummary(w: Window) {
  const head = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS deliveries,
           COALESCE(SUM(p.total_paisa),0)::bigint AS total_paisa,
           COALESCE(SUM(p.discount_paisa),0)::bigint AS discount_paisa,
           COUNT(DISTINCT p.supplier_id)::int AS suppliers
    FROM purchases p WHERE ${between('p.invoice_date', w)}`)).rows[0]
  const lines = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(pi.qty),0)::int AS packs,
           COALESCE(SUM(pi.bonus_qty),0)::int AS bonus_packs,
           COUNT(DISTINCT pi.id)::int AS lines
    FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
    WHERE ${between('p.invoice_date', w)}`)).rows[0]
  const rets = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS returns, COALESCE(SUM(total_paisa),0)::bigint AS returned_paisa
    FROM purchase_returns WHERE ${between('returned_at', w)}`)).rows[0]
  return { ...head, ...lines, ...rets,
    net_paisa: Number(head.total_paisa) - Number(rets.returned_paisa) }
}

export async function purchaseBy(w: Window, by:
  'day' | 'month' | 'supplier' | 'product' | 'manufacturer') {
  const dimension = {
    day:          sql`to_char(p.invoice_date, 'YYYY-MM-DD')`,
    month:        sql`to_char(p.invoice_date, 'YYYY-MM')`,
    supplier:     sql`s.name`,
    product:      sql`pr.name`,
    manufacturer: sql`COALESCE(mf.name, 'Not recorded')`
  }[by]

  const r = await db.execute<any>(sql`
    SELECT ${dimension} AS label,
           COUNT(DISTINCT p.id)::int AS deliveries,
           COALESCE(SUM(pi.qty),0)::int AS packs,
           COALESCE(SUM(pi.bonus_qty),0)::int AS bonus_packs,
           COALESCE(SUM(pi.qty * pi.unit_cost_paisa),0)::bigint AS total_paisa
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN batches b ON b.id = pi.batch_id
    JOIN products pr ON pr.id = b.product_id
    LEFT JOIN manufacturers mf ON mf.id = pr.manufacturer_id
    WHERE ${between('p.invoice_date', w)}
    GROUP BY 1 ORDER BY ${by === 'day' || by === 'month' ? sql`1` : sql`total_paisa DESC`}
    LIMIT 400`)
  return r.rows
}

/* -------------------------------------------------------- stock reports */

/** What is sitting on the shelf, what it cost, what it is worth. */
export async function stockStatement(opts: { manufacturerId?: number; groupId?: number } = {}) {
  let where = sql`p.is_active`
  if (opts.manufacturerId) where = sql`${where} AND p.manufacturer_id = ${opts.manufacturerId}`
  if (opts.groupId) where = sql`${where} AND p.group_id = ${opts.groupId}`

  const r = await db.execute<any>(sql`
    SELECT p.id, p.name, p.pack_label, p.pack_size, p.unit_label,
           p.purchase_paisa, p.trade_paisa, p.retail_paisa, p.reorder_level,
           mf.name AS manufacturer, slt.name AS salt, grp.name AS group_name,
           COALESCE(st.on_hand, 0) AS on_hand,
           COALESCE(st.on_hand, 0) * p.purchase_paisa AS cost_value_paisa,
           COALESCE(st.on_hand, 0) * p.retail_paisa AS retail_value_paisa,
           (COALESCE(st.on_hand,0) * (p.retail_paisa - p.purchase_paisa))::bigint
             AS potential_margin_paisa,
           st.nearest_expiry
    FROM products p
    LEFT JOIN manufacturers mf ON mf.id = p.manufacturer_id
    LEFT JOIN salts slt ON slt.id = p.salt_id
    LEFT JOIN product_groups grp ON grp.id = p.group_id
    LEFT JOIN LATERAL (
      SELECT SUM(b.qty_on_hand)::int AS on_hand,
             MIN(b.expiry_date) FILTER (WHERE b.expiry_date > CURRENT_DATE) AS nearest_expiry
      FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0
    ) st ON true
    WHERE ${where} ORDER BY p.name LIMIT 3000`)
  return r.rows
}

/** Bought, never sold. Money asleep on a shelf. */
export async function zeroSaleStock(days = 90) {
  const r = await db.execute<any>(sql`
    SELECT p.id, p.name, p.pack_label, p.purchase_paisa,
           mf.name AS manufacturer,
           COALESCE(SUM(b.qty_on_hand),0)::int AS on_hand,
           (COALESCE(SUM(b.qty_on_hand),0) * p.purchase_paisa)::bigint AS tied_up_paisa,
           MAX(b.received_at) AS last_received
    FROM products p
    LEFT JOIN manufacturers mf ON mf.id = p.manufacturer_id
    JOIN batches b ON b.product_id = p.id AND b.qty_on_hand > 0
    WHERE p.is_active
      AND NOT EXISTS (
        SELECT 1 FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
        WHERE si.product_id = p.id
          AND sa.sold_at >= now() - (${days} || ' days')::interval)
    GROUP BY p.id, p.name, p.pack_label, p.purchase_paisa, mf.name
    ORDER BY tied_up_paisa DESC LIMIT 300`)
  return r.rows
}

/** Everything that happened to one medicine. */
export async function productMovement(productId: number, w: Window) {
  const r = await db.execute<any>(sql`
    SELECT * FROM (
      SELECT p.invoice_date AS at, 'Received' AS kind,
             s.name AS party, pi.qty + COALESCE(pi.bonus_qty,0) AS qty_in, 0 AS qty_out,
             (pi.qty * pi.unit_cost_paisa) AS amount_paisa, p.supplier_invoice_no AS reference
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      JOIN suppliers s ON s.id = p.supplier_id
      JOIN batches b ON b.id = pi.batch_id
      WHERE b.product_id = ${productId} AND ${between('p.invoice_date', w)}

      UNION ALL

      SELECT sa.sold_at::date, 'Sold',
             COALESCE(pt.name, sa.customer_name, 'Walk-in'),
             0, si.display_qty, si.line_total_paisa, sa.invoice_no
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      LEFT JOIN parties pt ON pt.id = sa.party_id
      WHERE si.product_id = ${productId} AND ${LIVE} AND ${between('sa.sold_at', w)}

      UNION ALL

      SELECT r.returned_at::date, 'Returned by customer',
             COALESCE(r.customer_name, 'Walk-in'),
             CASE WHEN ri.restock THEN ri.qty ELSE 0 END, 0,
             ri.line_total_paisa, r.return_no
      FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
      WHERE ri.product_id = ${productId} AND ${between('r.returned_at', w)}
    ) m ORDER BY m.at DESC, m.kind LIMIT 500`)
  return r.rows
}

/* ------------------------------------------------------ profit reports */

/** Margin by manufacturer — which companies are worth stocking. */
export async function profitByManufacturer(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT COALESCE(mf.name, 'Not recorded') AS label,
           COUNT(DISTINCT si.product_id)::int AS products,
           COALESCE(SUM(si.display_qty),0)::int AS units,
           COALESCE(SUM(si.line_total_paisa),0)::bigint AS revenue_paisa,
           COALESCE(SUM(si.unit_cost_paisa * si.qty),0)::bigint AS cost_paisa,
           COALESCE(SUM((si.line_total_paisa - si.line_tax_paisa)
                        - si.unit_cost_paisa * si.qty),0)::bigint AS margin_paisa,
           CASE WHEN SUM(si.line_total_paisa) > 0
             THEN ROUND(100.0 * SUM((si.line_total_paisa - si.line_tax_paisa)
                        - si.unit_cost_paisa * si.qty) / SUM(si.line_total_paisa), 1)
             ELSE 0 END AS margin_pct
    FROM sale_items si
    JOIN sales sa ON sa.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
    LEFT JOIN manufacturers mf ON mf.id = p.manufacturer_id
    WHERE ${LIVE} AND ${between('sa.sold_at', w)}
    GROUP BY 1 ORDER BY margin_paisa DESC LIMIT 200`)
  return r.rows
}

/** Where the discount went. The old system watched this monthly. */
export async function discountMonitor(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT si.product_name AS label,
           COALESCE(SUM(si.display_qty),0)::int AS units,
           COALESCE(SUM(si.line_total_paisa),0)::bigint AS revenue_paisa,
           COALESCE(SUM(si.discount_paisa),0)::bigint AS discount_paisa,
           CASE WHEN SUM(si.line_total_paisa + si.discount_paisa) > 0
             THEN ROUND(100.0 * SUM(si.discount_paisa)
                        / SUM(si.line_total_paisa + si.discount_paisa), 1)
             ELSE 0 END AS discount_pct
    FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
    WHERE ${LIVE} AND ${between('sa.sold_at', w)} AND si.discount_paisa > 0
    GROUP BY 1 ORDER BY discount_paisa DESC LIMIT 200`)
  return r.rows
}
