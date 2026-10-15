import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { dateSegment } from './numbering'

/**
 * Deciding what to buy, and from whom.
 *
 * This is the half of the pharmacy that was never written down. Stock
 * arriving had a record and stock leaving had a record; the decision in
 * between happened on a scrap of paper at the counter on a Saturday evening
 * and was gone by Monday.
 *
 * Three ideas hold it together:
 *
 *   A supplier carries particular COMPANIES. Choosing the supplier therefore
 *   narrows the list of medicines to what they can actually bring, which is
 *   the difference between a screen of forty rows and a screen of nine
 *   hundred.
 *
 *   An order is written in UNITS. The pack is the distributor's unit, not the
 *   shop's; a pharmacist thinks in tablets and dividing by ten in your head
 *   at a counter is how you order ten times too many.
 *
 *   The quantity is SUGGESTED from what sold, and the sales figure is kept
 *   beside it. An order read back later with no figures behind it is a number
 *   nobody can argue with.
 */

export class OrderError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_LINES' | 'NO_SUPPLIER' | 'BAD_LINE' | 'NOT_FOUND' | 'ALREADY_CLOSED',
    public readonly detail?: string
  ) {
    super(message)
  }
}

/* ======================================================== the supplier card */

/** Which companies this distributor carries. */
export async function companiesFor(supplierId: number) {
  const r = await db.execute<any>(sql`
    SELECT m.id, m.name, m.short_name,
           (SELECT count(*)::int FROM products p
             WHERE p.manufacturer_id = m.id AND p.is_active) AS product_count
    FROM supplier_companies sc
    JOIN manufacturers m ON m.id = sc.manufacturer_id
    WHERE sc.supplier_id = ${supplierId}
    ORDER BY m.name`)
  return r.rows
}

export async function addCompany(supplierId: number, manufacturerId: number) {
  await db.execute(sql`
    INSERT INTO supplier_companies (supplier_id, manufacturer_id)
    VALUES (${supplierId}, ${manufacturerId})
    ON CONFLICT (supplier_id, manufacturer_id) DO NOTHING`)
  return companiesFor(supplierId)
}

export async function removeCompany(supplierId: number, manufacturerId: number) {
  await db.execute(sql`
    DELETE FROM supplier_companies
    WHERE supplier_id = ${supplierId} AND manufacturer_id = ${manufacturerId}`)
  return companiesFor(supplierId)
}

/** When they take orders. Usually one standing slot, sometimes two. */
export async function slotsFor(supplierId: number) {
  const r = await db.execute<any>(sql`
    SELECT id, weekday, at_time, note FROM supplier_booking_slots
    WHERE supplier_id = ${supplierId}
    ORDER BY weekday, at_time`)
  return r.rows
}

export async function addSlot(
  supplierId: number, weekday: number, atTime: string, note?: string | null
) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new OrderError('Pick a day of the week', 'BAD_LINE')
  }
  if (!/^\d{1,2}:\d{2}$/.test(atTime)) {
    throw new OrderError('Give the time as HH:MM, for example 19:00', 'BAD_LINE')
  }
  await db.execute(sql`
    INSERT INTO supplier_booking_slots (supplier_id, weekday, at_time, note)
    VALUES (${supplierId}, ${weekday}, ${atTime}::time, ${note ?? null})
    ON CONFLICT (supplier_id, weekday, at_time) DO NOTHING`)
  return slotsFor(supplierId)
}

export async function removeSlot(supplierId: number, id: number) {
  await db.execute(sql`
    DELETE FROM supplier_booking_slots WHERE id = ${id} AND supplier_id = ${supplierId}`)
  return slotsFor(supplierId)
}

/** Every supplier with their companies and slots folded in, for the list. */
export async function suppliersWithTerms() {
  const r = await db.execute<any>(sql`
    SELECT s.id, s.name, s.phone, s.address, s.is_active,
           COALESCE(c.companies, '[]'::json) AS companies,
           COALESCE(b.slots,     '[]'::json) AS slots
    FROM suppliers s
    LEFT JOIN (
      SELECT sc.supplier_id,
             json_agg(json_build_object('id', m.id, 'name', m.name)
                      ORDER BY m.name) AS companies
      FROM supplier_companies sc JOIN manufacturers m ON m.id = sc.manufacturer_id
      GROUP BY sc.supplier_id
    ) c ON c.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_id,
             json_agg(json_build_object('id', id, 'weekday', weekday,
                                        'at_time', at_time, 'note', note)
                      ORDER BY weekday, at_time) AS slots
      FROM supplier_booking_slots GROUP BY supplier_id
    ) b ON b.supplier_id = s.id
    ORDER BY s.name`)
  return r.rows
}

/* ====================================================== building an order */

/**
 * What to put on the order sheet for one supplier.
 *
 * The suggestion is the number of units that left the shelf in the window,
 * flat. Not scaled, and not reduced by what is still in stock: asked for
 * directly, the pharmacist wanted the sales figure itself, and a formula that
 * quietly subtracts stock produces numbers nobody can check by eye.
 *
 * Stock on hand is returned anyway, in its own column. It is the figure that
 * makes somebody override the suggestion, and leaving it off the screen would
 * mean reordering a medicine with two hundred units sitting on the shelf.
 *
 * Sales are counted in BASE UNITS, which is what sale_items holds, so a shop
 * selling loose tablets and full packs of the same medicine gets one honest
 * total rather than two incompatible ones.
 */
export async function orderSheet(opts: { supplierId: number; windowDays?: number }) {
  const days = Math.max(1, Math.min(365, Math.trunc(opts.windowDays ?? 7)))

  const r = await db.execute<any>(sql`
    WITH mine AS (
      SELECT manufacturer_id FROM supplier_companies WHERE supplier_id = ${opts.supplierId}
    ),
    /*
     * A supplier with no companies recorded yet shows every medicine rather
     * than none. An empty list almost always means nobody has filled the
     * card in, and a blank order screen looks like a broken feature.
     */
    scoped AS (
      SELECT p.* FROM products p
      WHERE p.is_active
        AND (NOT EXISTS (SELECT 1 FROM mine)
             OR p.manufacturer_id IN (SELECT manufacturer_id FROM mine))
    ),
    /*
     * si.qty is already in base units — it is the quantity taken off a
     * batch, so a shop that sells both loose tablets and whole strips of the
     * same medicine gets one honest total rather than two that cannot be
     * added together.
     *
     * The live-sale filter is the same one every other pharmacy report uses.
     * Spelling it differently here would quietly give the order screen a
     * different idea of what sold than the sales reports have.
     */
    sold AS (
      SELECT si.product_id, SUM(si.qty)::int AS units
      FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
      WHERE sa.created_at >= now() - (${days} || ' days')::interval
        AND sa.status <> 'voided' AND sa.cancelled_at IS NULL
      GROUP BY si.product_id
    ),
    /*
     * Goods that came straight back are not demand.
     *
     * Without this, a customer who buys forty and returns thirty leaves the
     * order screen suggesting forty, and the shelf fills up with something
     * nobody wanted. Only the window is netted, so a return against an older
     * sale does not distort it.
     */
    came_back AS (
      SELECT ri.product_id, SUM(ri.qty)::int AS units
      FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
      WHERE r.returned_at >= now() - (${days} || ' days')::interval
      GROUP BY ri.product_id
    ),
    held AS (
      SELECT product_id, SUM(qty_on_hand)::int AS units
      FROM batches GROUP BY product_id
    )
    SELECT sc.id AS product_id, sc.name AS product_name, sc.pack_size, sc.pack_label,
           sc.unit_label, sc.reorder_level, sc.purchase_paisa, sc.trade_paisa,
           m.name AS manufacturer,
           GREATEST(COALESCE(sold.units, 0) - COALESCE(came_back.units, 0), 0) AS sold_units,
           COALESCE(held.units, 0) AS stock_units
    FROM scoped sc
    LEFT JOIN manufacturers m ON m.id = sc.manufacturer_id
    LEFT JOIN sold ON sold.product_id = sc.id
    LEFT JOIN came_back ON came_back.product_id = sc.id
    LEFT JOIN held ON held.product_id = sc.id
    ORDER BY GREATEST(COALESCE(sold.units, 0) - COALESCE(came_back.units, 0), 0) DESC,
             sc.name`)

  return {
    windowDays: days,
    rows: (r.rows as any[]).map((x) => {
      const packSize = Math.max(1, Number(x.pack_size ?? 1))
      const sold = Number(x.sold_units)
      return {
        ...x,
        pack_size: packSize,
        sold_units: sold,
        stock_units: Number(x.stock_units),
        /*
         * The suggestion, in PACKS, because that is what the order asks for.
         *
         * Rounded UP. Selling 95 tablets of a pack of ten means ten packs was
         * the demand, not nine — a depot cannot split a pack, and rounding
         * down quietly short-orders every line that does not divide evenly.
         */
        suggest_packs: sold > 0 ? Math.ceil(sold / packSize) : 0,
        /* Kept for the record: the demand the suggestion came from. */
        suggest_units: sold
      }
    })
  }
}

export type OrderLine = {
  productId: number
  /** PACKS. What the distributor is being asked for. */
  orderPacks: number
  soldUnits?: number
  stockUnits?: number
}

export async function createOrder(input: {
  supplierId: number
  windowDays?: number
  note?: string | null
  by: string
  lines: OrderLine[]
}) {
  if (!input.supplierId) throw new OrderError('Choose a supplier first', 'NO_SUPPLIER')

  /*
   * A row left at zero is not an order line. The sheet opens with every
   * medicine the supplier carries listed, so most rows are meant to be
   * nothing — filtering here rather than making the screen delete them keeps
   * "clear this one" as simply emptying the box.
   */
  const lines = input.lines.filter((l) => Math.trunc(l.orderPacks) > 0)
  if (!lines.length) {
    throw new OrderError('Put a number of packs against at least one medicine', 'NO_LINES')
  }

  const seen = new Set<number>()
  for (const l of lines) {
    if (seen.has(l.productId)) {
      throw new OrderError('The same medicine appears twice on this order', 'BAD_LINE')
    }
    seen.add(l.productId)
  }

  return db.transaction(async (tx) => {
    const day = dateSegment()
    const n = await nextCounter(tx, `purchase_order:${day}`)
    const orderNo = `PO-${day}-${String(n).padStart(2, '0')}`

    const po = ((await tx.execute<any>(sql`
      INSERT INTO purchase_orders (order_no, supplier_id, window_days, note, created_by)
      VALUES (${orderNo}, ${input.supplierId},
              ${Math.max(1, Math.trunc(input.windowDays ?? 7))},
              ${input.note ?? null}, ${input.by})
      RETURNING *`)).rows as any[])[0]

    let i = 0
    for (const l of lines) {
      const p = ((await tx.execute<any>(sql`
        SELECT p.id, p.name, p.pack_size, p.pack_label, m.name AS manufacturer
        FROM products p LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
        WHERE p.id = ${l.productId}`)).rows as any[])[0]
      if (!p) throw new OrderError('Medicine not found', 'BAD_LINE', String(l.productId))

      const packSize = Math.max(1, Number(p.pack_size ?? 1))
      const packs = Math.trunc(l.orderPacks)
      await tx.execute(sql`
        INSERT INTO purchase_order_items
          (order_id, product_id, order_packs, order_units, sold_units, stock_units,
           product_name, manufacturer, pack_size, pack_label, display_order)
        VALUES (${po.id}, ${l.productId}, ${packs}, ${packs * packSize},
                ${Math.max(0, Math.trunc(l.soldUnits ?? 0))},
                ${Math.max(0, Math.trunc(l.stockUnits ?? 0))},
                ${p.name}, ${p.manufacturer ?? null},
                ${packSize}, ${p.pack_label ?? null}, ${i++})`)
    }

    return orderDetail(po.id, tx)
  })
}

/* ========================================================= reading orders */

export async function listOrders(opts: {
  status?: string; from?: string; to?: string; supplierId?: number
} = {}) {
  let where = sql`true`
  if (opts.status) where = sql`${where} AND po.status = ${opts.status}`
  if (opts.supplierId) where = sql`${where} AND po.supplier_id = ${opts.supplierId}`
  if (opts.from && opts.to) {
    where = sql`${where} AND po.created_at >= ${opts.from}::date
                       AND po.created_at < (${opts.to}::date + interval '1 day')`
  }

  const r = await db.execute<any>(sql`
    SELECT po.*, s.name AS supplier_name,
           (SELECT count(*)::int FROM purchase_order_items i WHERE i.order_id = po.id) AS lines,
           (SELECT COALESCE(SUM(i.order_packs), 0)::int FROM purchase_order_items i
             WHERE i.order_id = po.id) AS packs,
           (SELECT COALESCE(SUM(i.order_units), 0)::int FROM purchase_order_items i
             WHERE i.order_id = po.id) AS units,
           (SELECT p.grn_no FROM purchases p WHERE p.purchase_order_id = po.id
             ORDER BY p.id LIMIT 1) AS grn_no
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE ${where}
    ORDER BY po.created_at DESC
    LIMIT 400`)
  return r.rows
}

export async function orderDetail(id: number, conn: any = db) {
  const head = ((await conn.execute(sql`
    SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone,
           s.address AS supplier_address
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = ${id}`)).rows as any[])[0]
  if (!head) throw new OrderError('That order does not exist', 'NOT_FOUND')

  /*
   * Stock is read LIVE here, not taken from the frozen figure on the line.
   *
   * The frozen one says what the shelf held when the order went out, which is
   * the right thing on a printed sheet. Someone opening the order today to
   * receive against it wants to know what is there now.
   */
  /*
   * The medicine's own rates ride along with each line.
   *
   * Receiving fills purchase rate, sales tax and retail rate from the
   * medicine's setup, and a delivery raised against an order has to fill them
   * the same way a delivery typed in by hand does. Without these the three
   * boxes came up empty on exactly the deliveries that have the most lines in
   * them, which is the worst place to make somebody type.
   *
   * Read live rather than frozen onto the order: these are defaults for a box
   * somebody is about to correct against the paper in front of them, not a
   * record of anything.
   */
  const items = (await conn.execute(sql`
    SELECT i.*,
           COALESCE((SELECT SUM(b.qty_on_hand)::int FROM batches b
                      WHERE b.product_id = i.product_id), 0) AS stock_now,
           p.purchase_paisa, p.retail_paisa, p.tax_rate_bp, p.unit_label
    FROM purchase_order_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ${id}
    ORDER BY i.display_order, i.id`)).rows as any[]

  return { ...head, items }
}

/**
 * Throwing an order away.
 *
 * Only while nothing has been received against it. Once a delivery points at
 * an order, deleting the order would leave that delivery pointing at nothing
 * and lose the only link between the stock on the shelf and the decision to
 * buy it. Those get cancelled instead, which keeps the paper trail.
 */
export async function deleteOrder(id: number, by: string) {
  return db.transaction(async (tx) => {
    const po = ((await tx.execute<any>(sql`
      SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`)).rows as any[])[0]
    if (!po) throw new OrderError('That order does not exist', 'NOT_FOUND')

    const used = ((await tx.execute<any>(sql`
      SELECT count(*)::int AS n FROM purchases WHERE purchase_order_id = ${id}`))
      .rows as any[])[0]

    if (Number(used.n) > 0) {
      /*
       * Cancelled, not deleted, and said plainly. "Cannot delete" with no
       * reason is the kind of message people work around by deleting the
       * delivery instead.
       */
      await tx.execute(sql`
        UPDATE purchase_orders
        SET status = 'cancelled', closed_by = ${by}, closed_at = now()
        WHERE id = ${id}`)
      return {
        deleted: false, cancelled: true, orderNo: po.order_no,
        reason: `${used.n} delivery(ies) were received against ${po.order_no}, ` +
          'so it has been marked cancelled rather than removed. The stock and ' +
          'the deliveries are untouched.'
      }
    }

    await tx.execute(sql`DELETE FROM purchase_orders WHERE id = ${id}`)
    return { deleted: true, cancelled: false, orderNo: po.order_no }
  })
}

/* ========================================================= opening stock */

/**
 * Typing in what is already on the shelves, on the first day.
 *
 * A shop switching over to this system has stock it never bought through it.
 * Receiving it as a delivery would invent a supplier invoice that does not
 * exist, and counting it as an audit adjustment would compare it against a
 * system figure of zero and read as a loss of everything.
 *
 * So it goes in as its own thing: one batch per medicine named OPENING, with
 * a ledger line that says `opening`. The figure SETS the quantity rather than
 * adding to it, because somebody correcting a typo on the first morning
 * expects the box to mean what it says.
 */
export async function setOpeningStock(input: {
  by: string
  lines: { productId: number; units: number }[]
}) {
  const lines = input.lines.filter((l) => Number.isFinite(l.units) && l.units >= 0)
  if (!lines.length) throw new OrderError('Nothing to set', 'NO_LINES')

  return db.transaction(async (tx) => {
    let changed = 0
    const touched: any[] = []

    for (const l of lines) {
      const p = ((await tx.execute<any>(sql`
        SELECT id, name, retail_paisa, purchase_paisa FROM products WHERE id = ${l.productId}`))
        .rows as any[])[0]
      if (!p) continue

      const units = Math.trunc(l.units)

      /*
       * Read before writing, so the ledger line can carry a real delta.
       *
       * The box SETS the figure rather than adding to it, which means the
       * movement is the difference between what the row said and what was
       * typed. Writing the typed figure as the delta would make a correction
       * from 100 to 90 look like ninety units arriving.
       */
      const prior = Number((((await tx.execute<any>(sql`
        SELECT qty_on_hand FROM batches
        WHERE product_id = ${l.productId} AND batch_no = 'OPENING'
        FOR UPDATE`)).rows as any[])[0]?.qty_on_hand) ?? 0)

      /*
       * One batch per medicine, always the same batch number.
       *
       * Opening stock is a mixture of whatever was on the shelf, with no
       * single batch number or expiry that would be true. Giving it one
       * named row keeps it honest and keeps it findable later; the expiry is
       * a year out so FEFO sells it before new stock, which is what you want
       * for stock of unknown age.
       */
      const b = ((await tx.execute<any>(sql`
        INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa,
                             price_paisa, qty_on_hand)
        VALUES (${l.productId}, 'OPENING', CURRENT_DATE + 365,
                ${Number(p.purchase_paisa ?? 0)}, ${Number(p.retail_paisa ?? 0)}, ${units})
        ON CONFLICT (product_id, batch_no) DO UPDATE
          SET qty_on_hand = EXCLUDED.qty_on_hand
        RETURNING id, qty_on_hand`)).rows as any[])[0]

      if (units !== prior) {
        await tx.execute(sql`
          INSERT INTO stock_ledger (batch_id, product_id, qty_delta, balance_after,
                                    reason, ref_table, actor, note)
          VALUES (${Number(b.id)}, ${l.productId}, ${units - prior}, ${units},
                  'opening', 'products', ${input.by},
                  ${prior === 0 ? 'Opening stock' : `Opening stock corrected from ${prior}`})`)
        changed++
      }

      touched.push({ productId: l.productId, name: p.name, units, previous: prior })
    }

    return { changed, lines: touched }
  })
}

/** Every medicine with what it currently holds, for the opening-stock screen. */
export async function openingSheet(q?: string) {
  const term = (q ?? '').trim()
  const where = term
    ? sql`p.is_active AND (p.name ILIKE ${'%' + term + '%'}
                           OR p.generic_name ILIKE ${'%' + term + '%'})`
    : sql`p.is_active`

  const r = await db.execute<any>(sql`
    SELECT p.id AS product_id, p.name AS product_name, p.pack_size, p.pack_label,
           p.unit_label, p.rack_location, m.name AS manufacturer,
           COALESCE((SELECT SUM(b.qty_on_hand)::int FROM batches b
                      WHERE b.product_id = p.id), 0) AS stock_units,
           COALESCE((SELECT b.qty_on_hand FROM batches b
                      WHERE b.product_id = p.id AND b.batch_no = 'OPENING'), 0) AS opening_units
    FROM products p LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE ${where}
    ORDER BY p.name
    LIMIT 2000`)
  return r.rows
}
