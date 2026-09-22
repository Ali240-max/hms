import { sql, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as s from '../db/schema'
import { documentNo } from './numbering'

/**
 * Receiving a delivery.
 *
 * A delivery is one supplier invoice carrying many medicines, each with its
 * own batch number, expiry and price. Booking them in one at a time is how
 * you end up with half a delivery entered, no record of which invoice the
 * stock came from, and no way to check the bill against what arrived.
 *
 * The whole note lands in one transaction or none of it does.
 */

export type ReceiptLine = {
  productId: number
  batchNo: string
  expiryDate: string
  /** Packs, as counted off the delivery note. Converted to sub-units here. */
  qty: number
  /** Free packs, the "10+1" that distributors here give. Stock, but no cost. */
  bonusQty?: number
  costPaisa: number
  pricePaisa?: number
}

export type GoodsReceipt = {
  supplierId: number
  supplierInvoiceNo: string
  invoiceDate: string
  note?: string
  receivedBy?: string
  lines: ReceiptLine[]
}

export class ReceiptError extends Error {
  constructor(
    message: string,
    public readonly code: 'DUPLICATE_INVOICE' | 'NO_LINES' | 'BAD_LINE' | 'UNKNOWN_PRODUCT',
    public readonly detail?: string
  ) {
    super(message)
  }
}

export async function receiveGoods(db: NodePgDatabase<typeof s>, input: GoodsReceipt) {
  if (!input.lines.length) {
    throw new ReceiptError('Add at least one medicine to this delivery', 'NO_LINES')
  }

  // Two lines for the same product and batch would each try to upsert the
  // same row, and the second would overwrite rather than add. Catch it here
  // with a message that names the batch instead of silently losing stock.
  const seen = new Set<string>()
  for (const l of input.lines) {
    const k = `${l.productId}|${l.batchNo.trim().toUpperCase()}`
    if (seen.has(k)) {
      throw new ReceiptError(
        `Batch ${l.batchNo} appears twice for the same medicine. Combine them into one line.`,
        'BAD_LINE'
      )
    }
    seen.add(k)
    if (l.qty < 1) throw new ReceiptError('Quantity must be at least 1', 'BAD_LINE', l.batchNo)
    if (!l.batchNo.trim()) throw new ReceiptError('Every line needs a batch number', 'BAD_LINE')
  }

  return db.transaction(async (tx) => {
    const dup = await tx.execute<{ id: number }>(sql`
      SELECT id FROM purchases
      WHERE supplier_id = ${input.supplierId}
        AND supplier_invoice_no = ${input.supplierInvoiceNo.trim()}`)
    if (((dup as any).rows ?? []).length) {
      throw new ReceiptError(
        `Invoice ${input.supplierInvoiceNo} has already been received from this supplier`,
        'DUPLICATE_INVOICE',
        'Entering it twice would double the stock. Check the Purchases list.'
      )
    }

    const [purchase] = await tx
      .insert(s.purchases)
      .values({
        supplierId: input.supplierId,
        /*
         * Our own reference for this delivery, issued here.
         *
         * The supplier's number is theirs: two of them reuse the same one and
         * some send none at all, so it cannot identify a delivery on our side.
         */
        grnNo: await documentNo(tx, { prefix: 'GRN', letter: 'G' }),
        supplierInvoiceNo: input.supplierInvoiceNo.trim(),
        invoiceDate: input.invoiceDate,
        note: input.note,
        receivedBy: input.receivedBy,
        totalPaisa: 0
      })
      .returning()

    let total = 0

    for (const line of input.lines) {
      const [product] = await tx
        .select()
        .from(s.products)
        .where(eq(s.products.id, line.productId))
      if (!product) {
        throw new ReceiptError('Medicine not found', 'UNKNOWN_PRODUCT', String(line.productId))
      }

      const packSize = Math.max(1, product.packSize)
      const bonus = Math.max(0, line.bonusQty ?? 0)
      // Bonus packs are real stock and must be counted, but they cost nothing.
      const basePacks = line.qty + bonus
      const baseQty = basePacks * packSize

      const r = await tx.execute<{ id: number; qty_on_hand: number }>(sql`
        /*
         * The batch is stamped with the medicine's price on the day it lands.
         *
         * This is the whole answer to "what happens to old stock when the
         * price changes". A pack carries a printed price, and selling above
         * the price printed on the box is not allowed — so a batch keeps the
         * price it arrived with for its entire life, and repricing the
         * medicine only affects deliveries that come afterwards.
         *
         * The counter sells whichever batch FEFO reaches, at that batch's
         * price. Old stock therefore sells at the old price and clears at the
         * old margin, which is what actually happens behind a counter.
         */
        INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa, price_paisa, qty_on_hand, supplier_id)
        VALUES (${line.productId}, ${line.batchNo.trim()}, ${line.expiryDate}::date,
                ${line.costPaisa},
                COALESCE(${line.pricePaisa ?? null},
                         (SELECT retail_paisa FROM products WHERE id = ${line.productId}), 0),
                ${baseQty}, ${input.supplierId})
        ON CONFLICT (product_id, batch_no) DO UPDATE
          SET qty_on_hand = batches.qty_on_hand + EXCLUDED.qty_on_hand,
              cost_paisa  = EXCLUDED.cost_paisa,
              -- The price stays as the batch was first stamped. Topping up an
              -- existing batch number must not silently reprice what is
              -- already on the shelf.
              supplier_id = EXCLUDED.supplier_id
        RETURNING id, qty_on_hand`)
      const batch = ((r as any).rows ?? [])[0]

      await tx.insert(s.purchaseItems).values({
        purchaseId: purchase.id,
        batchId: Number(batch.id),
        qty: line.qty,
        bonusQty: bonus,
        unitCostPaisa: line.costPaisa
      })

      await tx.insert(s.stockLedger).values({
        batchId: Number(batch.id),
        productId: line.productId,
        qtyDelta: baseQty,
        balanceAfter: Number(batch.qty_on_hand),
        reason: 'purchase',
        refTable: 'purchases',
        refId: purchase.id,
        actor: input.receivedBy,
        note: `Invoice ${input.supplierInvoiceNo.trim()}`
      })

      // Bonus packs excluded: the invoice total is what the shop actually owes.
      total += line.qty * line.costPaisa
    }

    await tx.execute(sql`UPDATE purchases SET total_paisa = ${total} WHERE id = ${purchase.id}`)

    return { purchase: { ...purchase, totalPaisa: total }, lines: input.lines.length }
  })
}
