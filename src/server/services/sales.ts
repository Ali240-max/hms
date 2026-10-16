import { sql, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { db } from '../db/client'
import { dateSegment } from './numbering'
import { getSetting } from './settings'
import * as s from '../db/schema'

export type CartLine = {
  productId: number
  /** How many of the chosen thing: 1 strip, or 4 tablets. */
  qty: number
  /**
   * 'pack' sells a whole strip/bottle; 'unit' breaks it open and sells loose
   * tablets. Defaults to 'pack' so every existing caller keeps working.
   */
  soldAs?: 'pack' | 'unit'
  /** Override FEFO and force a specific batch (customer wants a longer expiry). */
  batchId?: number
  discountPaisa?: number
}

export type NewSaleInput = {
  lines: CartLine[]
  customerName?: string
  customerPhone?: string
  doctorName?: string
  payMethod?: 'cash' | 'card' | 'easypaisa' | 'jazzcash' | 'credit'
  paidPaisa?: number
  cashier?: string
  cashierStaffId?: number
  /** Set when this sale settles a prescription rather than a walk-in. */
  visitId?: number
  patientId?: number
  /** Allow selling stock that expires within N days. Default: block expired only. */
  allowExpiringWithinDays?: number
  /**
   * 'counter' paid now, 'credit' owed by a customer, 'department' issued to a
   * hospital department. Defaults from the pay method, so a credit sale from
   * the till is a credit bill even when the caller does not say so.
   */
  saleKind?: 'counter' | 'credit' | 'department'
  /** The hospital department a 'department' bill is issued to. */
  departmentId?: number
  /**
   * Generated once per bill by the screen. A second request with the same key
   * gets the first bill back instead of a second one, so a double click or a
   * retry after a dropped connection cannot take the stock twice.
   */
  requestKey?: string
}

export class StockError extends Error {
  constructor(
    message: string,
    public readonly code: 'INSUFFICIENT_STOCK' | 'BATCH_EXPIRED' | 'BATCH_NOT_FOUND',
    public readonly productId: number
  ) {
    super(message)
  }
}

/**
 * Controlled drugs cannot leave the counter without a recorded prescriber.
 * Enforced here rather than in the UI because the UI is one client of an HTTP
 * API: a second counter, a script, or a future mobile app would otherwise walk
 * straight past the check. The rule belongs where the write happens.
 */
export class ComplianceError extends Error {
  constructor(
    message: string,
    public readonly code: 'PRESCRIBER_REQUIRED' | 'LOOSE_NOT_ALLOWED'
      | 'DISCOUNT_OFF' | 'DISCOUNT_TOO_BIG',
    public readonly products: string[]
  ) {
    super(message)
  }
}

/**
 * Price of one loose sub-unit, rounded UP.
 *
 * A strip of 8 at Rs 45.00 gives 5.625 per tablet. Rounding down would mean
 * eight loose tablets fetch less than the strip they came from, so the shop
 * loses money every time someone breaks a pack. Rounding up matches what
 * pharmacies actually charge and keeps the loose price at or above pro-rata.
 */
export function unitPriceFromPack(packPricePaisa: number, packSize: number): number {
  if (packSize <= 1) return packPricePaisa
  return Math.ceil(packPricePaisa / packSize)
}

type Allocation = {
  batchId: number
  batchNo: string
  expiryDate: string
  qty: number
  unitPricePaisa: number
  unitCostPaisa: number
}

/**
 * First Expiry, First Out.
 *
 * Locks candidate rows FOR UPDATE so two counters billing the same product
 * cannot both allocate the last 5 units. Postgres serialises them: the second
 * transaction blocks on the lock, then re-reads the decremented quantity.
 * Without FOR UPDATE this oversells silently under concurrency.
 *
 * NOT `SKIP LOCKED` — skipping a locked batch would hand the customer a
 * later-expiring batch and quietly break FEFO.
 */
async function allocateFefo(
  tx: NodePgDatabase<typeof s>,
  productId: number,
  qtyNeeded: number,
  opts: { forceBatchId?: number; cutoffDate: string; multipleOf?: number }
): Promise<Allocation[]> {
  const rows = await tx.execute<{
    id: number
    batch_no: string
    expiry_date: string
    qty_on_hand: number
    price_paisa: string
    cost_paisa: string
  }>(sql`
    SELECT id, batch_no, expiry_date, qty_on_hand, price_paisa, cost_paisa
    FROM batches
    WHERE product_id = ${productId}
      AND qty_on_hand > 0
      AND expiry_date > ${opts.cutoffDate}::date
      ${opts.forceBatchId ? sql`AND id = ${opts.forceBatchId}` : sql``}
    ORDER BY expiry_date ASC, id ASC
    FOR UPDATE
  `)

  const batches: any[] = (rows as any).rows ?? (rows as unknown as any[])

  /**
   * Selling whole packs means each batch can only give up whole packs. A
   * batch holding 15 tablets of a 10-tablet strip has one sellable strip and
   * 5 loose tablets, not one and a half strips. Without this a two-strip sale
   * would take 15 from one batch and 5 from another and record a fractional
   * pack, which is both arithmetically wrong and physically impossible.
   *
   * The loose remainder stays on the shelf and is still sellable per tablet.
   */
  const step = Math.max(1, opts.multipleOf ?? 1)
  const usable = (b: any) => Math.floor(Number(b.qty_on_hand) / step) * step

  const available = batches.reduce((n: number, b: any) => n + usable(b), 0)
  const loose = batches.reduce((n: number, b: any) => n + Number(b.qty_on_hand), 0)

  if (available < qtyNeeded) {
    // The code reflects whether the product exists on the shelf at all, not
    // whether it exists in whole packs. Seven loose tablets with no full strip
    // is INSUFFICIENT_STOCK, not BATCH_NOT_FOUND — reporting "not in stock"
    // would send staff looking for a delivery they do not need.
    throw new StockError(
      step > 1 && loose > available
        ? `Only ${available / step} full packs available (${loose} loose units in stock)`
        : `Only ${available} in stock, ${qtyNeeded} requested`,
      loose === 0 ? 'BATCH_NOT_FOUND' : 'INSUFFICIENT_STOCK',
      productId
    )
  }

  const out: Allocation[] = []
  let remaining = qtyNeeded

  for (const b of batches) {
    if (remaining <= 0) break
    const take = Math.min(remaining, usable(b))
    if (take <= 0) continue
    out.push({
      batchId: Number(b.id),
      batchNo: b.batch_no,
      // Guaranteed 'YYYY-MM-DD' by the DATE type parser installed in db/client.
      expiryDate: String(b.expiry_date),
      qty: take,
      unitPricePaisa: Number(b.price_paisa),
      unitCostPaisa: Number(b.cost_paisa)
    })
    remaining -= take
  }

  return out
}

/**
 * PH-260618-S00123.
 *
 * Dated and reset daily, the same as every other document. `invoiceSeq` is
 * kept because the till and the day's reports sort on it; it is the day's
 * sequence now rather than an all-time one, which is what makes the printed
 * number short enough to read down a phone.
 *
 * The row lock inside the counter is what keeps two cashiers from taking the
 * same number, and it is held until the transaction commits.
 */
async function nextInvoiceNo(
  tx: NodePgDatabase<typeof s>
): Promise<{ invoiceNo: string; invoiceSeq: number }> {
  const day = dateSegment()
  const r = await tx.execute<{ value: number }>(sql`
    INSERT INTO counters (key, value) VALUES (${'ph:' + day}, 1)
    ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
    RETURNING value
  `)
  const rows = r.rows ?? (r as unknown as any[])
  const n = Number(rows[0].value)
  return { invoiceNo: `PH-${day}-S${String(n).padStart(5, '0')}`, invoiceSeq: n }
}

/**
 * Tax is computed per line on the discounted amount, because product tax rates
 * differ (most medicines are exempt, but supplements and devices are not).
 * Rounding happens once per line, at the line level, using half-up. Rounding
 * per unit and multiplying drifts by a paisa or two on large quantities and
 * makes the day-close report disagree with the sum of receipts.
 */
function priceLine(qty: number, unitPaisa: number, discountPaisa: number, taxRateBp: number) {
  const gross = qty * unitPaisa
  const net = Math.max(0, gross - discountPaisa)
  const tax = Math.round((net * taxRateBp) / 10000)
  return { gross, net, tax, lineTotal: net + tax }
}

export async function createSale(db: NodePgDatabase<typeof s>, input: NewSaleInput) {
  if (!input.lines.length) throw new Error('Cannot bill an empty cart')

  const saleKind = input.saleKind
    ?? (input.departmentId ? 'department' : input.payMethod === 'credit' ? 'credit' : 'counter')
  if (saleKind === 'department' && !input.departmentId) {
    throw new Error('A department bill needs a department')
  }

  return db.transaction(async (tx) => {
    /*
     * The same request twice returns the first bill.
     *
     * The lock is taken on the key before looking, so two copies of one
     * request arriving together are serialised: the second waits, then finds
     * the first one's bill. Without the lock both would look, both find
     * nothing, and the unique index would turn the second into an error
     * instead of the answer it should have had.
     */
    if (input.requestKey) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(32, hashtext(${input.requestKey}))`)
      const [already] = await tx.select().from(s.sales)
        .where(sql`request_key = ${input.requestKey}`).limit(1)
      if (already) {
        const n = await tx.execute<any>(sql`
          SELECT COUNT(*)::int AS n FROM sale_items WHERE sale_id = ${already.id}`)
        return { sale: already, items: Number((n.rows as any[])[0].n), duplicate: true }
      }
    }

    if (saleKind === 'department') {
      const dept = await tx.execute<any>(sql`
        SELECT id FROM departments WHERE id = ${input.departmentId!} AND is_active`)
      if (!(dept.rows as any[]).length) throw new Error('That department does not exist or is switched off')
    }

    // Compliance runs before anything is locked or decremented, so a rejected
    // bill never leaves half-allocated batches behind.
    const controlled = await tx.execute<{ name: string }>(sql`
      SELECT name FROM products
      WHERE id IN (${sql.join(input.lines.map((l) => sql`${l.productId}`), sql`, `)})
        AND schedule = 'controlled'
      ORDER BY name
    `)
    const controlledNames = ((controlled as any).rows ?? []).map((r: any) => r.name)
    if (controlledNames.length > 0 && !input.doctorName?.trim()) {
      throw new ComplianceError(
        `A prescriber must be recorded before selling ${controlledNames.join(', ')}.`,
        'PRESCRIBER_REQUIRED',
        controlledNames
      )
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + (input.allowExpiringWithinDays ?? 0))
    const cutoffDate = cutoff.toISOString().slice(0, 10)

    const { invoiceNo, invoiceSeq } = await nextInvoiceNo(tx)

    let subtotal = 0
    let taxTotal = 0
    let discountTotal = 0

    type Pending = {
      alloc: Allocation
      productId: number
      productName: string
      taxRateBp: number
      discountPaisa: number
      soldAs: 'pack' | 'unit'
      displayQty: number
      displayPricePaisa: number
      unitCostPaisa: number
      lineTaxPaisa: number
      lineTotalPaisa: number
    }
    const pending: Pending[] = []

    for (const line of input.lines) {
      const [product] = await tx
        .select()
        .from(s.products)
        .where(eq(s.products.id, line.productId))
        .limit(1)
      if (!product) throw new StockError('Product not found', 'BATCH_NOT_FOUND', line.productId)

      const packSize = Math.max(1, product.packSize)
      const soldAs = line.soldAs ?? 'pack'

      if (soldAs === 'unit' && !product.allowLoose) {
        throw new ComplianceError(
          `${product.name} cannot be split. Sell it as a whole ${product.unitLabel}.`,
          'LOOSE_NOT_ALLOWED',
          [product.name]
        )
      }

      // Everything below this point is in base sub-units. One strip of 10
      // takes 10 out of stock; four loose tablets take 4.
      const baseQty = soldAs === 'pack' ? line.qty * packSize : line.qty

      const allocations = await allocateFefo(tx, line.productId, baseQty, {
        forceBatchId: line.batchId,
        cutoffDate,
        multipleOf: soldAs === 'pack' ? packSize : 1
      })

      // Spread a line-level discount across allocations proportionally, giving
      // the remainder to the last allocation so the paisa always reconciles.
      const lineDiscount = line.discountPaisa ?? 0
      let discountLeft = lineDiscount

      allocations.forEach((a, i) => {
        const isLast = i === allocations.length - 1
        const share = isLast ? discountLeft : Math.round((lineDiscount * a.qty) / baseQty)
        discountLeft -= share

        // a.qty is base units taken from this batch. Convert back into what
        // the customer is being charged for.
        const displayQty = soldAs === 'pack' ? a.qty / packSize : a.qty
        const displayPrice =
          soldAs === 'pack'
            ? a.unitPricePaisa
            : unitPriceFromPack(a.unitPricePaisa, packSize)

        const p = priceLine(displayQty, displayPrice, share, product.taxRateBp)
        subtotal += p.gross
        discountTotal += share
        taxTotal += p.tax

        pending.push({
          alloc: a,
          productId: product.id,
          productName: product.name,
          taxRateBp: product.taxRateBp,
          discountPaisa: share,
          soldAs,
          displayQty,
          displayPricePaisa: displayPrice,
          // Cost is always per base unit so margin is unaffected by whether
          // the customer took a strip or four tablets out of it.
          unitCostPaisa: Math.round(a.unitCostPaisa / packSize),
          lineTaxPaisa: p.tax,
          lineTotalPaisa: p.lineTotal
        })
      })
    }

    /*
     * The discount rules, checked after the lines are priced.
     *
     * Here rather than on each line because a ceiling is a percentage of the
     * BILL: three lines at five per cent each is five per cent of the bill,
     * and the same three with one at thirty is not. Checking per line would
     * let a cashier split a big discount across lines and pass every one.
     *
     * Read at sale time rather than cached, so turning discounts off takes
     * effect on the next sale instead of the next sign-in.
     */
    if (discountTotal > 0) {
      const enabled = ((await getSetting('pharmacy.discountEnabled')) ?? 'true') !== 'false'
      if (!enabled) {
        throw new ComplianceError(
          'Discounts are switched off for the pharmacy. ' +
          'An administrator can turn them back on under Settings.',
          'DISCOUNT_OFF', [])
      }
      const maxPct = Number((await getSetting('pharmacy.discountMaxPct')) ?? '0')
      /* Zero means no ceiling, which is how the till behaved before this. */
      if (maxPct > 0) {
        const ceiling = Math.floor((subtotal * maxPct) / 100)
        if (discountTotal > ceiling) {
          throw new ComplianceError(
            `That discount is ${(discountTotal * 100 / Math.max(1, subtotal)).toFixed(1)}% ` +
            `of the bill. The most allowed is ${maxPct}%, which on this bill is ` +
            `Rs ${(ceiling / 100).toFixed(2)}.`,
            'DISCOUNT_TOO_BIG', [])
        }
      }
    }

    const total = subtotal - discountTotal + taxTotal

    const [sale] = await tx
      .insert(s.sales)
      .values({
        invoiceNo,
        invoiceSeq,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        doctorName: input.doctorName,
        subtotalPaisa: subtotal,
        discountPaisa: discountTotal,
        taxPaisa: taxTotal,
        totalPaisa: total,
        /*
         * Nothing is taken at the counter for a credit or department bill,
         * whatever the caller sent. The till used to send the full total for
         * every non-cash method, credit included, which made every credit
         * bill look paid and counted it as money collected the day it was
         * written. What comes in later is recorded in sale_payments.
         */
        paidPaisa: saleKind === 'counter' ? (input.paidPaisa ?? total) : 0,
        payMethod: saleKind === 'counter' ? (input.payMethod ?? 'cash') : 'credit',
        cashier: input.cashier,
        cashierStaffId: input.cashierStaffId,
        visitId: input.visitId ?? null,
        patientId: input.patientId ?? null
      })
      .returning()

    // Columns that exist only in SQL (0008, 0039), not in schema.ts.
    await tx.execute(sql`
      UPDATE sales SET sale_kind = ${saleKind}, department_id = ${input.departmentId ?? null},
                       request_key = ${input.requestKey ?? null}
      WHERE id = ${sale.id}`)

    for (const p of pending) {
      await tx.insert(s.saleItems).values({
        saleId: sale.id,
        batchId: p.alloc.batchId,
        productId: p.productId,
        productName: p.productName,
        batchNo: p.alloc.batchNo,
        expiryDate: p.alloc.expiryDate,
        qty: p.alloc.qty,
        soldAs: p.soldAs,
        displayQty: p.displayQty,
        unitPricePaisa: p.displayPricePaisa,
        unitCostPaisa: p.unitCostPaisa,
        discountPaisa: p.discountPaisa,
        taxRateBp: p.taxRateBp,
        lineTaxPaisa: p.lineTaxPaisa,
        lineTotalPaisa: p.lineTotalPaisa
      })

      const updated = await tx.execute<{ qty_on_hand: number }>(sql`
        UPDATE batches SET qty_on_hand = qty_on_hand - ${p.alloc.qty}
        WHERE id = ${p.alloc.batchId}
        RETURNING qty_on_hand
      `)
      const uRows = updated.rows ?? (updated as unknown as any[])
      const balanceAfter = Number(uRows[0].qty_on_hand)

      // Belt and braces: the FOR UPDATE lock should make this unreachable.
      if (balanceAfter < 0) throw new Error(`Batch ${p.alloc.batchId} went negative`)

      await tx.insert(s.stockLedger).values({
        batchId: p.alloc.batchId,
        productId: p.productId,
        qtyDelta: -p.alloc.qty,
        balanceAfter,
        reason: 'sale',
        refTable: 'sales',
        refId: sale.id,
        actor: input.cashier
      })
    }

    return { sale, items: pending.length, duplicate: false }
  })
}

/**
 * One sale with its lines, for printing.
 *
 * Its own function rather than reusing the screen's query, because the printed
 * copy needs the product name resolved and nothing else: a receipt does not
 * care about schedules, batches or stock levels.
 */
export async function saleForPrint(saleId: number) {
  const sale = ((await db.execute<any>(sql`
    SELECT * FROM sales WHERE id = ${saleId}`)).rows as any[])[0]
  if (!sale) throw new Error('No such invoice')

  const items = (await db.execute<any>(sql`
    SELECT si.*, p.name AS product_name, p.unit_label, p.sub_unit_label
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ${saleId}
    ORDER BY si.id`)).rows

  return { sale, items }
}
