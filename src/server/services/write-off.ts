import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { dateSegment } from './numbering'
import type { Window } from './pharma-reports'

/**
 * Stock that leaves without being sold.
 *
 * A carton goes on the floor; a box goes past its date. Either way units come
 * off a batch and money leaves the shop, and both have to be answerable in
 * March when somebody asks why the shelf and the ledger disagree in October.
 *
 * ONE MECHANISM, TWO SCREENS.
 *
 * Damage and expiry differ in who notices and when — breakage is logged at
 * the counter the moment it happens, expiry is a monthly walk of the racks
 * with a list. Mechanically they are the same event, so they run through the
 * same code. A difference in behaviour between them would be a bug.
 *
 * THREE RULES THAT MATTER, in the order they bite:
 *
 *   It refuses rather than clamps. Asking to write off more than a batch
 *   holds is a counting mistake, and silently taking what is there turns it
 *   into a figure nobody can reconstruct. A negative batch is worse: it
 *   poisons FEFO and the error spreads into sales.
 *
 *   The cost is frozen off the batch. Two batches bought six months apart
 *   cost different money, so valuing August's breakage at today's rate would
 *   rewrite every past figure each time a distributor raised a price.
 *
 *   It goes in the ledger. `damage` and `expiry_writeoff` have been in the
 *   movement_reason enum since the first migration and nothing had ever
 *   written one. Stock that moves without a ledger row is stock that cannot
 *   be traced, which is the entire problem this screen exists to stop.
 */

export class WriteOffError extends Error {
  constructor(msg: string, public code:
    'NO_LINES' | 'BAD_LINE' | 'NOT_ENOUGH' | 'NOT_FOUND') { super(msg) }
}

export type WriteOffKind = 'damage' | 'expiry'

/** The ledger word each kind is written under. Fixed by the enum, not by us. */
const LEDGER_REASON: Record<WriteOffKind, string> = {
  damage: 'damage',
  expiry: 'expiry_writeoff'
}

/** The tracking prefix. Three letters, so the number fits a printed column. */
const PREFIX: Record<WriteOffKind, string> = { damage: 'DMG', expiry: 'EXP' }

/* ------------------------------------------------------- what is offered */

/**
 * The batches a write-off can be made against.
 *
 * BATCH BY BATCH, not summed per medicine.
 *
 * The screen has to show batches because the person is holding a box with a
 * batch number printed on it. Offering "Augmentin, 80 in stock" would make
 * them pick a medicine and leave the system to guess which batch the broken
 * one came from — and the guess decides both the expiry date that comes off
 * the shelf and the money the loss is valued at.
 *
 * `expiringWithinDays` is what makes this serve two screens from one query:
 *
 *   undefined   everything with stock on it, which is the damage screen
 *   0           what has gone out of date, and what goes today
 *   30, 60, 90  what has gone AND what is about to
 *
 * Zero includes the already-expired rather than meaning "nothing", because
 * there is no sensible reading of a zero-day expiry window that excludes the
 * stock that is the whole reason somebody opened the screen.
 *
 * IT ALSO INCLUDES TODAY, and that is worth being exact about. The window is
 * `expiry_date <= CURRENT_DATE` while the `expired` flag is
 * `expiry_date < CURRENT_DATE`, so a batch whose date is today appears in
 * the list and is NOT flagged expired. Both are right: it has not passed
 * yet, and it is the batch most urgently needing to come off the shelf. The
 * screen's label says so rather than calling it expired, which is the part
 * that was wrong — the dropdown read "Already expired" over a list that
 * included stock still technically in date.
 */
export async function shelf(opts: {
  q?: string
  expiringWithinDays?: number
  limit?: number
}) {
  const q = (opts.q ?? '').trim()
  const like = `%${q}%`

  const r = await db.execute<any>(sql`
    SELECT b.id            AS batch_id,
           b.batch_no,
           b.expiry_date,
           b.qty_on_hand,
           b.cost_paisa,
           b.price_paisa,
           p.id            AS product_id,
           p.name          AS product_name,
           p.pack_label,
           p.pack_size,
           p.unit_label,
           p.rack_location,
           m.name          AS manufacturer,
           (b.expiry_date < CURRENT_DATE) AS expired,
           (b.expiry_date - CURRENT_DATE) AS days_left
    FROM batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE b.qty_on_hand > 0
      ${q ? sql`AND (p.name ILIKE ${like} OR b.batch_no ILIKE ${like}
                     OR m.name ILIKE ${like})` : sql``}
      ${opts.expiringWithinDays !== undefined
        ? sql`AND b.expiry_date <= CURRENT_DATE
                                 + ${opts.expiringWithinDays}::int`
        : sql``}
    /*
     * Oldest expiry first, because that is the order stock comes off the
     * shelf and so the order somebody walking the racks finds it in.
     */
    ORDER BY b.expiry_date, p.name, b.id
    LIMIT ${Math.min(500, Math.max(1, opts.limit ?? 300))}`)

  return (r.rows as any[]).map((x) => ({
    ...x,
    expired: x.expired === true,
    days_left: Number(x.days_left)
  }))
}

/* ---------------------------------------------------------- making one */

export type WriteOffLine = {
  productId: number
  /** The batch off the box, where somebody could read one. */
  batchId?: number | null
  qty: number
  reason?: string | null
}

/**
 * Take the stock off and keep the record.
 *
 * One transaction. A write-off that removed the stock and then failed to
 * write its own record would be indistinguishable from theft, so either all
 * of it lands or none of it does.
 */
export async function createWriteOff(input: {
  kind: WriteOffKind
  by: string
  note?: string | null
  lines: WriteOffLine[]
}) {
  /*
   * Nothing with a quantity on it is not a form, it is an accident.
   *
   * Checked before the transaction opens so an empty submission costs a
   * refusal rather than a numbering slot: counters do not roll back usefully,
   * and a day whose damage slips run 01, 03, 07 invites somebody to go
   * looking for the two that are missing.
   */
  const wanted = (input.lines ?? []).filter((l) => Number(l.qty) > 0)
  if (wanted.length === 0) {
    throw new WriteOffError('Nothing to write off', 'NO_LINES')
  }

  return db.transaction(async (tx) => {
    const day = dateSegment()
    const n = await nextCounter(tx, `write_off:${input.kind}:${day}`)
    const no = `${PREFIX[input.kind]}-${day}-${String(n).padStart(2, '0')}`

    const head = ((await tx.execute(sql`
      INSERT INTO write_offs (write_off_no, kind, note, created_by)
      VALUES (${no}, ${input.kind}, ${input.note?.trim() || null}, ${input.by})
      RETURNING *`)).rows as any[])[0]

    let lines = 0, units = 0, value = 0

    for (const l of wanted) {
      const qty = Math.floor(Number(l.qty))

      const product = ((await tx.execute(sql`
        SELECT id, name FROM products WHERE id = ${Number(l.productId)}`))
        .rows as any[])[0]
      if (!product) {
        throw new WriteOffError('That medicine does not exist', 'BAD_LINE')
      }

      /*
       * Which batches to take it off, locked for the length of the
       * transaction.
       *
       * Named batch: that one and no other, because somebody read the number
       * off the box and substituting a different batch would file the loss
       * against stock that is still sitting there.
       *
       * No batch named — the carton-on-the-floor case, label torn off — take
       * it in expiry order. That is the stock that would have sold first, so
       * it is the stock most likely to be the stock that went.
       */
      const batches = (await tx.execute(sql`
        SELECT id, batch_no, expiry_date, qty_on_hand, cost_paisa
        FROM batches
        WHERE product_id = ${product.id} AND qty_on_hand > 0
          ${l.batchId ? sql`AND id = ${Number(l.batchId)}` : sql``}
        ORDER BY expiry_date, id
        FOR UPDATE`)).rows as any[]

      if (l.batchId && batches.length === 0) {
        throw new WriteOffError(
          'That batch does not belong to that medicine, or has nothing left on it',
          'BAD_LINE')
      }

      /*
       * Counted before anything is written.
       *
       * Refusing halfway through would leave the earlier lines already taken
       * off inside a transaction that is about to roll back — correct, but it
       * means the error message names the medicine that failed rather than
       * the shortfall, and the person has to work out which one.
       */
      const available = batches.reduce((t, b) => t + Number(b.qty_on_hand), 0)
      if (available < qty) {
        throw new WriteOffError(
          `${product.name}: ${qty} asked for, ${available} on the shelf`,
          'NOT_ENOUGH')
      }

      let left = qty
      for (const b of batches) {
        if (left <= 0) break
        const take = Math.min(left, Number(b.qty_on_hand))
        const after = Number(b.qty_on_hand) - take
        const cost = Number(b.cost_paisa)
        const lineValue = take * cost

        await tx.execute(sql`
          UPDATE batches SET qty_on_hand = ${after} WHERE id = ${b.id}`)

        await tx.execute(sql`
          INSERT INTO write_off_items
            (write_off_id, product_id, batch_id, qty, unit_cost_paisa,
             value_paisa, product_name, batch_no, expiry_date, reason)
          VALUES (${head.id}, ${product.id}, ${b.id}, ${take}, ${cost},
                  ${lineValue}, ${product.name}, ${b.batch_no},
                  ${b.expiry_date}, ${l.reason?.trim() || null})`)

        /*
         * The ledger row carries the tracking number in its note, so a
         * movement found while chasing a discrepancy leads straight back to
         * the slip rather than to an id somebody has to go and look up.
         */
        await tx.execute(sql`
          INSERT INTO stock_ledger
            (batch_id, product_id, qty_delta, balance_after, reason,
             ref_table, ref_id, note, actor)
          VALUES (${b.id}, ${product.id}, ${-take}, ${after},
                  ${LEDGER_REASON[input.kind]}::movement_reason,
                  'write_offs', ${head.id}, ${no}, ${input.by})`)

        lines++; units += take; value += lineValue
        left -= take
      }
    }

    /*
     * The totals are counted from the rows that were written, not from the
     * form that was submitted. One line of seventy spread over two batches is
     * two rows, and a head that said "1 line" would disagree with its own
     * detail.
     */
    const saved = ((await tx.execute(sql`
      UPDATE write_offs
         SET lines = ${lines}, units = ${units}, value_paisa = ${value}
       WHERE id = ${head.id}
       RETURNING *`)).rows as any[])[0]

    const items = (await tx.execute(sql`
      SELECT * FROM write_off_items WHERE write_off_id = ${head.id}
      ORDER BY id`)).rows as any[]

    return { ...saved, items }
  })
}

/* ----------------------------------------------------------- reading it */

/** One instance, with the lines that made it up. */
export async function writeOff(id: number) {
  const head = ((await db.execute<any>(sql`
    SELECT * FROM write_offs WHERE id = ${id}`)).rows as any[])[0]
  if (!head) throw new WriteOffError('No such write-off', 'NOT_FOUND')

  const items = (await db.execute<any>(sql`
    SELECT i.*, m.name AS manufacturer, p.pack_label
    FROM write_off_items i
    JOIN products p ON p.id = i.product_id
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE i.write_off_id = ${id}
    ORDER BY i.id`)).rows as any[]

  return { ...head, items }
}

/**
 * The register.
 *
 * Newest first, because somebody looking one up has almost always just made
 * it — a slip printed wrong, a quantity typed twice. The month-old one is
 * found by searching its number, which is why the number carries the date.
 */
export async function writeOffs(opts: {
  kind?: WriteOffKind
  q?: string
  from?: string
  to?: string
  limit?: number
}) {
  const q = (opts.q ?? '').trim()
  const like = `%${q}%`

  const r = await db.execute<any>(sql`
    SELECT * FROM write_offs
    WHERE TRUE
      ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
      ${opts.from ? sql`AND created_at >= ${opts.from}::date` : sql``}
      ${opts.to ? sql`AND created_at < (${opts.to}::date + 1)` : sql``}
      ${q ? sql`AND (write_off_no ILIKE ${like} OR note ILIKE ${like}
                     OR created_by ILIKE ${like}
                     OR EXISTS (SELECT 1 FROM write_off_items i
                                 WHERE i.write_off_id = write_offs.id
                                   AND (i.product_name ILIKE ${like}
                                        OR i.batch_no ILIKE ${like})))` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(500, Math.max(1, opts.limit ?? 200))}`)

  return r.rows as any[]
}

/* -------------------------------------------------------------- reports */

/**
 * Every line, over a window. The detail report.
 *
 * One row per batch written off, which is the level the question gets asked
 * at: not "we lost twelve thousand rupees in October" but "which batch, and
 * who signed for it".
 */
export async function writeOffItems(w: Window & { kind?: WriteOffKind }) {
  const r = await db.execute<any>(sql`
    SELECT w.write_off_no, w.kind, w.created_by,
           to_char(w.created_at, 'DD Mon YY HH24:MI') AS when,
           i.product_name, m.name AS manufacturer,
           i.batch_no, i.expiry_date, i.qty,
           i.unit_cost_paisa, i.value_paisa, i.reason
    FROM write_off_items i
    JOIN write_offs w ON w.id = i.write_off_id
    JOIN products p ON p.id = i.product_id
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE w.created_at >= ${w.from}::date
      AND w.created_at < (${w.to}::date + 1)
      ${w.kind ? sql`AND w.kind = ${w.kind}` : sql``}
    ORDER BY w.created_at DESC, i.id`)

  return (r.rows as any[]).map((x) => ({
    ...x,
    kind_label: x.kind === 'damage' ? 'Damage' : 'Expiry',
    expiry_date: x.expiry_date ? String(x.expiry_date).slice(0, 10) : ''
  }))
}

/**
 * What keeps going in the bin.
 *
 * Grouped by medicine and sorted by money, because the point of this one is
 * to change an ordering decision. A medicine that expires three times a year
 * is being over-ordered, and the figure that makes anybody act on it is the
 * rupees rather than the count.
 */
export async function writeOffsByProduct(w: Window & { kind?: WriteOffKind }) {
  const r = await db.execute<any>(sql`
    SELECT i.product_name, m.name AS manufacturer,
           COUNT(DISTINCT w.id)::int AS times,
           SUM(i.qty)::int           AS units,
           SUM(i.value_paisa)::bigint AS value_paisa
    FROM write_off_items i
    JOIN write_offs w ON w.id = i.write_off_id
    JOIN products p ON p.id = i.product_id
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE w.created_at >= ${w.from}::date
      AND w.created_at < (${w.to}::date + 1)
      ${w.kind ? sql`AND w.kind = ${w.kind}` : sql``}
    GROUP BY i.product_name, m.name
    ORDER BY SUM(i.value_paisa) DESC, i.product_name`)

  return r.rows as any[]
}

/** The register as a report: one row per instance. */
export async function writeOffRegister(w: Window & { kind?: WriteOffKind }) {
  const r = await db.execute<any>(sql`
    SELECT w.write_off_no, w.kind,
           to_char(w.created_at, 'DD Mon YY HH24:MI') AS when,
           w.lines, w.units, w.value_paisa, w.created_by, w.note
    FROM write_offs w
    WHERE w.created_at >= ${w.from}::date
      AND w.created_at < (${w.to}::date + 1)
      ${w.kind ? sql`AND w.kind = ${w.kind}` : sql``}
    ORDER BY w.created_at DESC, w.id DESC`)

  return (r.rows as any[]).map((x) => ({
    ...x,
    kind_label: x.kind === 'damage' ? 'Damage' : 'Expiry',
    note: x.note ?? ''
  }))
}

/**
 * The figures above the table: how much went, and split which way.
 *
 * Damage and expiry are separated here even though the report lists them
 * together, because they call for different action. Expiry is an ordering
 * problem, breakage is a handling problem, and a single total tells you to
 * fix neither.
 */
export async function writeOffSummary(w: Window & { kind?: WriteOffKind }) {
  const r = ((await db.execute<any>(sql`
    SELECT
      COALESCE(SUM(value_paisa) FILTER (WHERE kind = 'damage'), 0)::bigint AS dmg,
      COALESCE(SUM(value_paisa) FILTER (WHERE kind = 'expiry'), 0)::bigint AS exp,
      COALESCE(SUM(units), 0)::int AS units
    FROM write_offs
    WHERE created_at >= ${w.from}::date
      AND created_at < (${w.to}::date + 1)
      ${w.kind ? sql`AND kind = ${w.kind}` : sql``}`)).rows as any[])[0]

  const money = (p: number) =>
    (Number(p) / 100).toLocaleString('en-PK',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const dmg = Number(r.dmg), exp = Number(r.exp)

  /*
   * Plain strings, padded into columns, because that is what the report
   * footer prints. The same shape the stock adjustment report uses.
   */
  return {
    notes: [
      `Lost to damage        Rs ${money(dmg)}`,
      `Lost to expiry        Rs ${money(exp)}`,
      `Written off in total  Rs ${money(dmg + exp)} ` +
        `across ${Number(r.units)} units`
    ]
  }
}
