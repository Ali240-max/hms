import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { dateSegment } from './numbering'

/**
 * Stock audits, and the adjustments that follow them.
 *
 * An audit is a count sheet: what the system thinks is on the shelf, printed
 * with blank columns for somebody to walk the racks and write what is really
 * there. It changes nothing.
 *
 * An adjustment is typing those numbers back in. That is the one place in the
 * pharmacy where stock can be made to appear or disappear by typing, so every
 * line is kept forever with who, when, and all three quantities.
 */

export class AuditError extends Error {
  constructor(msg: string, public code:
    'EMPTY' | 'NOT_FOUND' | 'CLOSED' | 'BAD_COUNT') { super(msg) }
}

/*
 * The ledger reason an adjustment is written under.
 *
 * `stock_count` already exists in the movement_reason enum and means exactly
 * this. Adding an 'adjustment' value beside it would have given the same
 * event two names, and reports that filter on one would quietly miss the
 * other.
 */
const LEDGER_REASON = 'stock_count'

/** What the system believes is on the shelf, right now. */
const ON_HAND = sql`
  COALESCE((SELECT SUM(b.qty_on_hand)::int FROM batches b
            WHERE b.product_id = p.id AND b.qty_on_hand > 0), 0)`

/* ------------------------------------------------------- building a sheet */

/**
 * The medicines a sheet would cover, before it is saved.
 *
 * Three ways to choose them, because three different people count stock:
 * somebody chasing a particular medicine types its name, somebody auditing a
 * supplier takes a whole company, and somebody walking the floor takes a
 * rack. The sheet that comes out is identical in all three cases.
 */
export async function previewScope(opts: {
  scope: 'product' | 'manufacturer' | 'rack'
  ref?: string | null
  productIds?: number[]
}) {
  if (opts.scope === 'product') {
    const ids = opts.productIds ?? []
    if (ids.length === 0) return []
    const r = await db.execute<any>(sql`
      SELECT p.id, p.name, p.pack_label, p.rack_location,
             m.name AS manufacturer, ${ON_HAND} AS on_hand
      FROM products p
      LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
      WHERE p.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY p.name`)
    return r.rows
  }

  if (opts.scope === 'manufacturer') {
    const r = await db.execute<any>(sql`
      SELECT p.id, p.name, p.pack_label, p.rack_location,
             m.name AS manufacturer, ${ON_HAND} AS on_hand
      FROM products p
      JOIN manufacturers m ON m.id = p.manufacturer_id
      WHERE p.is_active AND lower(m.name) = lower(${opts.ref ?? ''})
      ORDER BY p.name`)
    return r.rows
  }

  /*
   * Rack A should find "A", "A-1" and "A3", because that is how a shelf is
   * labelled in practice. Matching the whole string exactly would return
   * nothing on most real data.
   */
  const r = await db.execute<any>(sql`
    SELECT p.id, p.name, p.pack_label, p.rack_location,
           m.name AS manufacturer, ${ON_HAND} AS on_hand
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.is_active
      AND p.rack_location IS NOT NULL
      AND lower(p.rack_location) LIKE lower(${(opts.ref ?? '') + '%'})
    ORDER BY p.rack_location, p.name`)
  return r.rows
}

export async function createAudit(input: {
  scope: 'product' | 'manufacturer' | 'rack'
  ref?: string | null
  productIds?: number[]
  title?: string | null
  note?: string | null
  by: string
}) {
  const rows = await previewScope({
    scope: input.scope, ref: input.ref, productIds: input.productIds
  }) as any[]

  if (rows.length === 0) {
    throw new AuditError(
      input.scope === 'manufacturer'
        ? `No products found for "${input.ref}".`
        : input.scope === 'rack'
          ? `No products are shelved under "${input.ref}".`
          : 'Add at least one medicine to the sheet.',
      'EMPTY')
  }

  return db.transaction(async (tx) => {
    /*
     * AUD-09102026-04, not AUD-000004.
     *
     * A bare sequence number is read aloud across a pharmacy and written on
     * paper, and two sheets a month apart that differ by one digit get
     * confused. With the date in it the number carries when it was printed,
     * which is the first thing anybody asks about a sheet found on a desk.
     *
     * The sequence restarts each day, like every other document number here.
     */
    const day = dateSegment()
    const n = await nextCounter(tx, `stock_audit:${day}`)
    const auditNo = `AUD-${day}-${String(n).padStart(2, '0')}`

    const audit = ((await tx.execute(sql`
      INSERT INTO stock_audits (audit_no, scope, scope_ref, title, note, created_by)
      VALUES (${auditNo}, ${input.scope}, ${input.ref ?? null},
              ${input.title ?? null}, ${input.note ?? null}, ${input.by})
      RETURNING *`)).rows as any[])[0]

    let order = 0
    for (const p of rows) {
      await tx.execute(sql`
        INSERT INTO stock_audit_items
          (audit_id, product_id, expected_qty, product_name, manufacturer,
           rack_location, pack_label, display_order)
        VALUES (${audit.id}, ${p.id}, ${Number(p.on_hand)}, ${p.name},
                ${p.manufacturer ?? null}, ${p.rack_location ?? null},
                ${p.pack_label ?? null}, ${order++})`)
    }

    return { ...audit, lines: rows.length }
  })
}

export async function audits(opts: {
  status?: string; q?: string; from?: string; to?: string; limit?: number
} = {}) {
  const like = `%${opts.q ?? ''}%`
  const r = await db.execute<any>(sql`
    SELECT a.*,
           (SELECT COUNT(*)::int FROM stock_audit_items i WHERE i.audit_id = a.id)
             AS lines,
           (SELECT COUNT(*)::int FROM stock_adjustments adj WHERE adj.audit_id = a.id)
             AS adjustments
    FROM stock_audits a
    WHERE ${opts.status && opts.status !== 'all'
      ? sql`a.status = ${opts.status}` : sql`true`}
      AND ${opts.q
        ? sql`(a.audit_no ILIKE ${like} OR a.title ILIKE ${like}
               OR a.scope_ref ILIKE ${like})` : sql`true`}
      AND ${opts.from ? sql`a.created_at >= ${opts.from}::date` : sql`true`}
      AND ${opts.to ? sql`a.created_at < ${opts.to}::date + 1` : sql`true`}
    ORDER BY a.created_at DESC
    LIMIT ${opts.limit ?? 100}`)
  return r.rows
}

/**
 * One audit, with both the frozen and the live quantity on every line.
 *
 * The adjustment screen needs both: what the sheet said when it printed, and
 * what the system says now. Showing only one of them is how a day of sales
 * gets quietly reversed.
 */
export async function audit(id: number) {
  const a = ((await db.execute<any>(sql`
    SELECT * FROM stock_audits WHERE id = ${id}`)).rows as any[])[0]
  if (!a) throw new AuditError('No such audit', 'NOT_FOUND')

  const items = (await db.execute<any>(sql`
    SELECT i.*, ${ON_HAND} AS on_hand_now
    FROM stock_audit_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.audit_id = ${id}
    ORDER BY i.display_order, i.id`)).rows

  return { audit: a, items }
}

export async function closeAudit(id: number, by: string) {
  await db.execute(sql`
    UPDATE stock_audits SET status = 'closed', closed_by = ${by}, closed_at = now()
    WHERE id = ${id}`)
  return { ok: true }
}

/* ----------------------------------------------------- making it true */

/**
 * Apply a count.
 *
 * Only the lines that differ are written. Counting forty medicines and
 * finding two wrong should produce an adjustment with two lines, not forty
 * with thirty-eight zeroes — otherwise the report of what was adjusted is
 * mostly noise and the two that matter are invisible.
 */
export async function createAdjustment(input: {
  auditId: number
  counts: { productId: number; countedQty: number }[]
  note?: string | null
  by: string
}) {
  const { audit: a } = await audit(input.auditId)
  if (a.status === 'closed') {
    throw new AuditError('That audit is closed.', 'CLOSED')
  }

  return db.transaction(async (tx) => {
    const day = dateSegment()
    const n = await nextCounter(tx, `stock_adjustment:${day}`)
    const adjNo = `ADJ-${day}-${String(n).padStart(2, '0')}`

    const adj = ((await tx.execute(sql`
      INSERT INTO stock_adjustments (adjustment_no, audit_id, note, created_by)
      VALUES (${adjNo}, ${input.auditId}, ${input.note ?? null}, ${input.by})
      RETURNING *`)).rows as any[])[0]

    let changed = 0

    for (const c of input.counts) {
      if (c.countedQty < 0) {
        throw new AuditError(
          'A counted quantity cannot be negative.', 'BAD_COUNT')
      }

      const line = ((await tx.execute(sql`
        SELECT i.product_id, i.expected_qty, i.product_name, i.manufacturer
        FROM stock_audit_items i
        WHERE i.audit_id = ${input.auditId} AND i.product_id = ${c.productId}`))
        .rows as any[])[0]
      /*
       * A product not on the sheet is refused.
       *
       * This is the rule that makes an audit worth anything: an adjustment
       * can only touch what somebody actually counted. Without it, the sheet
       * becomes a cover story for changing the stock of something nobody
       * looked at.
       */
      if (!line) {
        throw new AuditError(
          'That medicine is not on this audit sheet.', 'NOT_FOUND')
      }

      /*
       * The batch rows are locked first, then summed.
       *
       * Postgres refuses FOR UPDATE alongside an aggregate, and the lock is
       * the point: the counter may be selling this very medicine while
       * somebody types the count, and two people writing the same batch is
       * how stock goes wrong in a way nobody can reconstruct afterwards.
       */
      const held = (await tx.execute(sql`
        SELECT qty_on_hand, cost_paisa FROM batches
        WHERE product_id = ${c.productId} AND qty_on_hand > 0
        FOR UPDATE`)).rows as any[]
      const now = held.reduce((n, b) => n + Number(b.qty_on_hand), 0)

      const delta = c.countedQty - now
      if (delta === 0) continue

      /*
       * What a unit of this is worth, weighted across the batches on the
       * shelf right now.
       *
       * The weighted average rather than one batch's cost, because a
       * shortfall of a hundred units does not come from a single batch and
       * the cheapest or dearest batch would both be a lie. Where nothing is
       * on the shelf there is nothing to weight, so the product's purchase
       * price stands in — that is the surplus case, stock appearing from
       * somewhere, and the purchase price is the honest guess for it.
       *
       * Frozen onto the line. Reading the cost at report time instead would
       * revalue every past correction each time a distributor raised a rate.
       */
      const costNow = now > 0
        ? Math.round(held.reduce(
            (n, b) => n + Number(b.qty_on_hand) * Number(b.cost_paisa), 0) / now)
        : Number(((await tx.execute(sql`
            SELECT purchase_paisa FROM products WHERE id = ${c.productId}`))
            .rows as any[])[0]?.purchase_paisa ?? 0)

      await tx.execute(sql`
        INSERT INTO stock_adjustment_items
          (adjustment_id, product_id, expected_qty, before_qty, counted_qty,
           delta_qty, product_name, manufacturer, unit_cost_paisa, value_paisa)
        VALUES (${adj.id}, ${c.productId}, ${line.expected_qty}, ${now},
                ${c.countedQty}, ${delta}, ${line.product_name},
                ${line.manufacturer ?? null}, ${costNow}, ${delta * costNow})`)

      await applyDelta(tx, c.productId, delta, adj.id, adjNo, input.by)
      changed++
    }

    await tx.execute(sql`
      UPDATE stock_audits SET status = 'counted' WHERE id = ${input.auditId}`)

    return { ...adj, changed }
  })
}

/**
 * Move the stock, and say so in the ledger.
 *
 * Shortfalls come off the batch expiring soonest, because that is the stock
 * that would have sold first and so the stock most likely to have gone
 * missing. A surplus goes onto the newest batch rather than inventing one:
 * a counted extra strip came from somewhere, and guessing a batch number for
 * it would put a fiction into the expiry report.
 */
async function applyDelta(tx: any, productId: number, delta: number,
  adjustmentId: number, adjustmentNo: string, by: string) {

  if (delta < 0) {
    let left = -delta
    const batches = (await tx.execute(sql`
      SELECT id, qty_on_hand FROM batches
      WHERE product_id = ${productId} AND qty_on_hand > 0
      ORDER BY expiry_date NULLS LAST, id
      FOR UPDATE`)).rows as any[]

    for (const b of batches) {
      if (left <= 0) break
      const take = Math.min(left, Number(b.qty_on_hand))
      const after = Number(b.qty_on_hand) - take

      await tx.execute(sql`
        UPDATE batches SET qty_on_hand = ${after} WHERE id = ${b.id}`)
      await tx.execute(sql`
        INSERT INTO stock_ledger
          (batch_id, product_id, qty_delta, balance_after, reason,
           ref_table, ref_id, note, actor)
        VALUES (${b.id}, ${productId}, ${-take}, ${after}, 'stock_count',
                'stock_adjustments', ${adjustmentId}, ${adjustmentNo}, ${by})`)
      left -= take
    }

    /*
     * Counted fewer than any batch holds.
     *
     * The batches are already at zero and there is nothing left to take off,
     * so the shortfall is recorded against no batch rather than dropped. A
     * missing quantity nobody can account for is exactly the thing an audit
     * exists to surface.
     */
    if (left > 0) {
      await tx.execute(sql`
        INSERT INTO stock_ledger
          (batch_id, product_id, qty_delta, balance_after, reason,
           ref_table, ref_id, note, actor)
        VALUES (NULL, ${productId}, ${-left}, 0, 'stock_count',
                'stock_adjustments', ${adjustmentId},
                ${adjustmentNo + ' (no batch had the stock)'}, ${by})`)
    }
    return
  }

  const newest = ((await tx.execute(sql`
    SELECT id, qty_on_hand FROM batches
    WHERE product_id = ${productId}
    ORDER BY expiry_date DESC NULLS FIRST, id DESC
    LIMIT 1 FOR UPDATE`)).rows as any[])[0]

  if (newest) {
    const after = Number(newest.qty_on_hand) + delta
    await tx.execute(sql`
      UPDATE batches SET qty_on_hand = ${after} WHERE id = ${newest.id}`)
    await tx.execute(sql`
      INSERT INTO stock_ledger
        (batch_id, product_id, qty_delta, balance_after, reason,
         ref_table, ref_id, note, actor)
      VALUES (${newest.id}, ${productId}, ${delta}, ${after}, 'stock_count',
              'stock_adjustments', ${adjustmentId}, ${adjustmentNo}, ${by})`)
    return
  }

  /*
   * A surplus of something with no batch at all.
   *
   * Somebody found stock the system has never heard of. One is made, marked
   * so nobody mistakes it for a received batch, because the alternative is
   * refusing a count that is demonstrably correct.
   */
  const made = ((await tx.execute(sql`
    INSERT INTO batches (product_id, batch_no, expiry_date, qty_on_hand,
                         cost_paisa, price_paisa)
    /*
     * An expiry a year out, because the column requires one and nobody knows
     * the real date for stock that was simply found. Far enough ahead that it
     * does not appear on tomorrow's expiry report as a false alarm, near
     * enough that it surfaces within the year to be looked at properly.
     */
    VALUES (${productId}, ${'FOUND-' + adjustmentNo}, CURRENT_DATE + 365,
            ${delta}, 0, 0)
    RETURNING id`)).rows as any[])[0]
  await tx.execute(sql`
    INSERT INTO stock_ledger
      (batch_id, product_id, qty_delta, balance_after, reason,
       ref_table, ref_id, note, actor)
    VALUES (${made.id}, ${productId}, ${delta}, ${delta}, 'stock_count',
            'stock_adjustments', ${adjustmentId},
            ${adjustmentNo + ' (no batch existed)'}, ${by})`)
}

/* ------------------------------------------------------------- reading back */

export async function adjustments(opts: {
  from?: string; to?: string; q?: string; limit?: number
} = {}) {
  const like = `%${opts.q ?? ''}%`
  const r = await db.execute<any>(sql`
    SELECT adj.*, a.audit_no, a.scope, a.scope_ref,
           (SELECT COUNT(*)::int FROM stock_adjustment_items i
            WHERE i.adjustment_id = adj.id) AS lines,
           COALESCE((SELECT SUM(i.delta_qty) FROM stock_adjustment_items i
                     WHERE i.adjustment_id = adj.id AND i.delta_qty > 0), 0)::int
             AS added,
           COALESCE((SELECT -SUM(i.delta_qty) FROM stock_adjustment_items i
                     WHERE i.adjustment_id = adj.id AND i.delta_qty < 0), 0)::int
             AS removed
    FROM stock_adjustments adj
    JOIN stock_audits a ON a.id = adj.audit_id
    WHERE ${opts.from ? sql`adj.created_at >= ${opts.from}::date` : sql`true`}
      AND ${opts.to ? sql`adj.created_at < ${opts.to}::date + 1` : sql`true`}
      AND ${opts.q
        ? sql`(adj.adjustment_no ILIKE ${like} OR a.audit_no ILIKE ${like}
               OR adj.created_by ILIKE ${like})` : sql`true`}
    ORDER BY adj.created_at DESC
    LIMIT ${opts.limit ?? 200}`)
  return r.rows
}

export async function adjustment(id: number) {
  const adj = ((await db.execute<any>(sql`
    SELECT adj.*, a.audit_no, a.scope, a.scope_ref, a.created_by AS audit_by,
           a.created_at AS audit_at
    FROM stock_adjustments adj
    JOIN stock_audits a ON a.id = adj.audit_id
    WHERE adj.id = ${id}`)).rows as any[])[0]
  if (!adj) throw new AuditError('No such adjustment', 'NOT_FOUND')

  const items = (await db.execute<any>(sql`
    SELECT * FROM stock_adjustment_items
    WHERE adjustment_id = ${id} ORDER BY product_name`)).rows

  return { adjustment: adj, items }
}

/**
 * Every time a medicine was adjusted, one row per instance.
 *
 * Panadol adjusted five times is five rows with their own before, after and
 * time — not one row saying "net −12", which hides the pattern that makes
 * somebody look twice.
 */
export async function adjustmentHistory(opts: {
  from?: string; to?: string; productId?: number; manufacturer?: string
} = {}) {
  const r = await db.execute<any>(sql`
    SELECT i.*, adj.adjustment_no, adj.created_by, a.audit_no
    FROM stock_adjustment_items i
    JOIN stock_adjustments adj ON adj.id = i.adjustment_id
    JOIN stock_audits a ON a.id = adj.audit_id
    WHERE ${opts.from ? sql`i.created_at >= ${opts.from}::date` : sql`true`}
      AND ${opts.to ? sql`i.created_at < ${opts.to}::date + 1` : sql`true`}
      AND ${opts.productId ? sql`i.product_id = ${opts.productId}` : sql`true`}
      AND ${opts.manufacturer
        ? sql`lower(i.manufacturer) = lower(${opts.manufacturer})` : sql`true`}
    ORDER BY i.product_name, i.created_at DESC`)
  return r.rows
}

/** Which companies' stock keeps turning out wrong. */
export async function adjustmentsByCompany(opts: {
  from?: string; to?: string
} = {}) {
  const r = await db.execute<any>(sql`
    SELECT COALESCE(i.manufacturer, '(none)') AS manufacturer,
           COUNT(*)::int                               AS lines,
           COUNT(DISTINCT i.product_id)::int           AS products,
           COALESCE(SUM(i.delta_qty) FILTER (WHERE i.delta_qty > 0), 0)::int
             AS added,
           COALESCE(-SUM(i.delta_qty) FILTER (WHERE i.delta_qty < 0), 0)::int
             AS removed,
           SUM(i.delta_qty)::int                       AS net,
           /* The same three in money, which is the question that follows. */
           COALESCE(SUM(i.value_paisa) FILTER (WHERE i.delta_qty > 0), 0)::bigint
             AS added_paisa,
           COALESCE(-SUM(i.value_paisa) FILTER (WHERE i.delta_qty < 0), 0)::bigint
             AS removed_paisa,
           COALESCE(SUM(i.value_paisa), 0)::bigint      AS net_paisa
    FROM stock_adjustment_items i
    WHERE ${opts.from ? sql`i.created_at >= ${opts.from}::date` : sql`true`}
      AND ${opts.to ? sql`i.created_at < ${opts.to}::date + 1` : sql`true`}
    GROUP BY COALESCE(i.manufacturer, '(none)')
    ORDER BY removed DESC, lines DESC`)
  return r.rows
}
