import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { postLedger } from './pharma'

/**
 * Goods coming back over the counter.
 *
 * Always against the original invoice. A return with no bill behind it is how
 * a counter quietly leaks money — someone walks in with a strip bought
 * elsewhere, or bought here at a discount and refunded at full price. Finding
 * the bill first also settles the price argument before it starts: the refund
 * is whatever that line was actually charged, discount included.
 *
 * Two decisions are made per line and they are separate on purpose:
 *
 *   how many come back            — may be fewer than were sold
 *   does it go back on the shelf  — a sealed box does, a half-used bottle
 *                                   does not, and a refund is still owed
 *
 * Collapsing those into one action is how expired or tampered stock finds its
 * way back into saleable inventory.
 */

export class ReturnError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'TOO_MANY' | 'NOTHING' | 'CANCELLED') { super(msg) }
}

/** The invoice, with how much of each line is still returnable. */
export async function returnableSale(opts: { saleId?: number; invoiceNo?: string }) {
  const sale = ((await db.execute<any>(sql`
    SELECT sa.*, pt.name AS party_name
    FROM sales sa LEFT JOIN parties pt ON pt.id = sa.party_id
    WHERE ${opts.saleId ? sql`sa.id = ${opts.saleId}` : sql`sa.invoice_no = ${opts.invoiceNo ?? ''}`}`))
    .rows as any[])[0]
  if (!sale) throw new ReturnError('No invoice with that number', 'NOT_FOUND')
  if (sale.cancelled_at) {
    throw new ReturnError('That invoice was cancelled, so there is nothing to return', 'CANCELLED')
  }

  const items = (await db.execute<any>(sql`
    SELECT si.*,
           COALESCE((SELECT SUM(ri.qty)::int FROM sale_return_items ri
                     JOIN sale_returns r ON r.id = ri.return_id
                     WHERE r.sale_id = si.sale_id AND ri.product_id = si.product_id
                       AND COALESCE(ri.batch_id, -1) = COALESCE(si.batch_id, -1)), 0)
             AS already_returned,
           p.allow_loose, p.unit_label, p.sub_unit_label
    FROM sale_items si
    LEFT JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ${sale.id} ORDER BY si.id`)).rows as any[]

  return {
    sale,
    items: items.map((i) => ({
      ...i,
      returnable: Math.max(0, Number(i.display_qty) - Number(i.already_returned)),
      /** What one unit was actually charged, discount included. */
      unit_refund_paisa: Number(i.display_qty) > 0
        ? Math.round(Number(i.line_total_paisa) / Number(i.display_qty)) : 0
    }))
  }
}

export async function createReturn(input: {
  saleId: number
  lines: { saleItemId: number; qty: number; restock: boolean }[]
  reason?: string | null
  refundMethod?: string
  by: string
}) {
  const wanted = input.lines.filter((l) => l.qty > 0)
  if (wanted.length === 0) throw new ReturnError('Nothing selected to return', 'NOTHING')

  return db.transaction(async (tx) => {
    const sale = ((await tx.execute<any>(sql`
      SELECT * FROM sales WHERE id = ${input.saleId} FOR UPDATE`)).rows as any[])[0]
    if (!sale) throw new ReturnError('Invoice not found', 'NOT_FOUND')
    if (sale.cancelled_at) throw new ReturnError('That invoice was cancelled', 'CANCELLED')

    const n = await nextCounter(tx, 'sale_return')
    const returnNo = `SR-${String(n).padStart(6, '0')}`

    const ret = (await tx.execute<any>(sql`
      INSERT INTO sale_returns (return_no, sale_id, party_id, customer_name,
                                total_paisa, reason, returned_by)
      VALUES (${returnNo}, ${sale.id}, ${sale.party_id}, ${sale.customer_name},
              0, ${input.reason ?? null}, ${input.by})
      RETURNING *`)).rows[0]

    let refund = 0
    const done: any[] = []

    for (const line of wanted) {
      const item = ((await tx.execute<any>(sql`
        SELECT * FROM sale_items WHERE id = ${line.saleItemId} AND sale_id = ${sale.id}`))
        .rows as any[])[0]
      if (!item) throw new ReturnError('That line is not on this invoice', 'NOT_FOUND')

      const already = Number(((await tx.execute<any>(sql`
        SELECT COALESCE(SUM(ri.qty),0)::int AS n FROM sale_return_items ri
        JOIN sale_returns r ON r.id = ri.return_id
        WHERE r.sale_id = ${sale.id} AND ri.product_id = ${item.product_id}
          AND COALESCE(ri.batch_id,-1) = COALESCE(${item.batch_id ?? null},-1)
          AND r.id <> ${ret.id}`)).rows as any[])[0].n)

      const left = Number(item.display_qty) - already
      if (line.qty > left) {
        throw new ReturnError(
          `Only ${left} of ${item.product_name} can still be returned on this invoice`, 'TOO_MANY')
      }

      // The refund is what was charged, not today's price. A line sold at a
      // discount comes back at the discounted amount.
      const unit = Number(item.display_qty) > 0
        ? Math.round(Number(item.line_total_paisa) / Number(item.display_qty)) : 0
      const lineRefund = unit * line.qty
      refund += lineRefund

      await tx.execute(sql`
        INSERT INTO sale_return_items (return_id, product_id, batch_id, product_name,
                                       qty, unit_price_paisa, line_total_paisa, restock)
        VALUES (${ret.id}, ${item.product_id}, ${item.batch_id}, ${item.product_name},
                ${line.qty}, ${unit}, ${lineRefund}, ${line.restock})`)

      if (line.restock && item.batch_id) {
        /**
         * Back to the batch it came from, not to any batch of that medicine.
         * Expiry belongs to the batch, so putting it anywhere else would
         * quietly extend the life of stock that is about to expire.
         */
        const units = item.sold_as === 'pack'
          ? line.qty * Number(((await tx.execute<any>(sql`
              SELECT pack_size FROM products WHERE id = ${item.product_id}`))
              .rows as any[])[0]?.pack_size ?? 1)
          : line.qty
        await tx.execute(sql`
          UPDATE batches SET qty_on_hand = qty_on_hand + ${units} WHERE id = ${item.batch_id}`)
      }

      // Put the medicine back on the prescription if it came from one, so the
      // pharmacy queue stops showing it as dispensed.
      if (sale.visit_id && item.product_id) {
        await tx.execute(sql`
          UPDATE prescription_items pi
          SET qty_dispensed = GREATEST(0, pi.qty_dispensed - ${line.qty}),
              status = CASE WHEN GREATEST(0, pi.qty_dispensed - ${line.qty}) = 0
                            THEN 'pending' ELSE 'partial' END
          FROM prescriptions pr
          WHERE pr.id = pi.prescription_id AND pr.visit_id = ${sale.visit_id}
            AND pi.product_id = ${item.product_id}`)
      }

      done.push({ ...item, returned: line.qty, refund: lineRefund, restock: line.restock })
    }

    await tx.execute(sql`
      UPDATE sale_returns SET total_paisa = ${refund} WHERE id = ${ret.id}`)

    /**
     * A credit sale is refunded on the ledger, not out of the drawer — the
     * money never came in, so handing cash back would pay them twice.
     */
    if (sale.sale_kind === 'credit' && sale.party_id) {
      await postLedger({
        tx, partyKind: 'customer', partyRef: sale.party_id,
        description: `Return ${returnNo} against ${sale.invoice_no}`,
        creditPaisa: refund, source: 'return', sourceId: ret.id, by: input.by
      })
    }

    return {
      ...ret, total_paisa: refund, items: done,
      refund_to: sale.sale_kind === 'credit' ? 'ledger' : (input.refundMethod ?? 'cash'),
      invoice_no: sale.invoice_no
    }
  })
}

export async function listReturns(opts: { from?: string; to?: string; q?: string } = {}) {
  let where = sql`true`
  if (opts.from && opts.to) {
    where = sql`${where} AND r.returned_at >= ${opts.from}::date
                       AND r.returned_at < (${opts.to}::date + interval '1 day')`
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    where = sql`${where} AND (r.return_no ILIKE ${like} OR r.customer_name ILIKE ${like}
                              OR sa.invoice_no ILIKE ${like})`
  }
  const r = await db.execute<any>(sql`
    SELECT r.*, sa.invoice_no, sa.sale_kind,
           (SELECT COUNT(*)::int FROM sale_return_items ri WHERE ri.return_id = r.id) AS lines,
           (SELECT COUNT(*)::int FROM sale_return_items ri
            WHERE ri.return_id = r.id AND NOT ri.restock) AS written_off
    FROM sale_returns r LEFT JOIN sales sa ON sa.id = r.sale_id
    WHERE ${where} ORDER BY r.returned_at DESC LIMIT 200`)
  return r.rows
}

export async function returnForPrint(returnId: number) {
  const head = ((await db.execute<any>(sql`
    SELECT r.*, sa.invoice_no, sa.sold_at, sa.sale_kind
    FROM sale_returns r LEFT JOIN sales sa ON sa.id = r.sale_id
    WHERE r.id = ${returnId}`)).rows as any[])[0]
  if (!head) throw new ReturnError('Return not found', 'NOT_FOUND')
  const items = (await db.execute<any>(sql`
    SELECT * FROM sale_return_items WHERE return_id = ${returnId} ORDER BY id`)).rows
  return { head, items }
}
