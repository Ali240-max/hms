import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Hospital stores.
 *
 * Consumables that get used rather than sold: gauze, cannulas, gloves, IV
 * sets, syringes, linen. They come in by the carton and go out to a
 * department, and the only questions anyone asks of them are "have we got
 * any" and "who is getting through it".
 *
 * Two rules shape everything here.
 *
 * Stock lives in batches, and issuing takes the nearest expiry first. A store
 * that hands out whichever box is nearest the door throws away the rest, and
 * IV fluids and sutures do expire.
 *
 * Every movement is written down, signed positive or negative. The batch rows
 * tell you what is on the shelf now; the movement rows are the only thing that
 * can answer a question about last month once a batch has been used up.
 */

export class SupplyError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'NO_STOCK' | 'BAD_QTY' | 'IN_USE') { super(msg) }
}

export const CATEGORIES = [
  'consumable', 'instrument', 'linen', 'ppe', 'cleaning', 'stationery', 'other'
] as const

export const MOVEMENT_KINDS = ['receive', 'issue', 'return', 'waste', 'adjust'] as const

/* ----------------------------------------------------------------- items */

export async function listItems(opts: {
  q?: string; category?: string; filter?: string
} = {}) {
  const { q = '', category = 'all', filter = 'all' } = opts
  const like = `%${q}%`
  const r = await db.execute<any>(sql`
    WITH stock AS (
      SELECT b.item_id,
             SUM(b.qty_on_hand) FILTER (
               WHERE b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)::int AS on_hand,
             SUM(b.qty_on_hand) FILTER (
               WHERE b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE)::int AS expired,
             MIN(b.expiry_date) FILTER (
               WHERE b.qty_on_hand > 0 AND b.expiry_date > CURRENT_DATE) AS nearest_expiry,
             SUM(b.qty_on_hand * b.cost_paisa)::bigint AS value_paisa
      FROM supply_batches b WHERE b.qty_on_hand > 0 GROUP BY b.item_id
    ),
    burn AS (
      -- Average daily use over the last month, from what actually went out.
      SELECT m.item_id, (SUM(-m.qty)::numeric / 30) AS per_day
      FROM supply_movements m
      WHERE m.kind IN ('issue', 'waste') AND m.moved_at >= now() - interval '30 days'
      GROUP BY m.item_id
    )
    SELECT i.*,
           COALESCE(s.on_hand, 0) AS on_hand,
           COALESCE(s.expired, 0) AS expired_qty,
           s.nearest_expiry,
           COALESCE(s.value_paisa, 0) AS value_paisa,
           COALESCE(b.per_day, 0)::float AS per_day,
           CASE WHEN COALESCE(b.per_day, 0) > 0
                THEN ROUND(COALESCE(s.on_hand, 0) / b.per_day)::int END AS days_left
    FROM supply_items i
    LEFT JOIN stock s ON s.item_id = i.id
    LEFT JOIN burn  b ON b.item_id = i.id
    WHERE (${q} = '' OR i.name ILIKE ${like} OR i.code ILIKE ${like})
      AND (${category} = 'all' OR i.category = ${category})
      AND CASE ${filter}
            WHEN 'archived' THEN NOT i.is_active
            WHEN 'out'      THEN i.is_active AND COALESCE(s.on_hand, 0) = 0
            WHEN 'low'      THEN i.is_active AND i.reorder_level > 0
                                 AND COALESCE(s.on_hand, 0) <= i.reorder_level
            WHEN 'expiring' THEN i.is_active AND s.nearest_expiry IS NOT NULL
                                 AND s.nearest_expiry <= CURRENT_DATE + 90
            ELSE i.is_active
          END
    ORDER BY i.name LIMIT 500`)
  return r.rows
}

export async function summary() {
  const r = await db.execute<any>(sql`
    WITH stock AS (
      SELECT item_id,
             SUM(qty_on_hand) FILTER (
               WHERE expiry_date IS NULL OR expiry_date > CURRENT_DATE)::int AS on_hand,
             MIN(expiry_date) FILTER (
               WHERE qty_on_hand > 0 AND expiry_date > CURRENT_DATE) AS nearest_expiry,
             SUM(qty_on_hand * cost_paisa)::bigint AS value_paisa
      FROM supply_batches WHERE qty_on_hand > 0 GROUP BY item_id
    )
    SELECT COUNT(*) FILTER (WHERE i.is_active)::int AS all_count,
           COUNT(*) FILTER (WHERE i.is_active AND COALESCE(s.on_hand,0) = 0)::int AS out_count,
           COUNT(*) FILTER (WHERE i.is_active AND i.reorder_level > 0
                            AND COALESCE(s.on_hand,0) <= i.reorder_level)::int AS low_count,
           COUNT(*) FILTER (WHERE i.is_active AND s.nearest_expiry IS NOT NULL
                            AND s.nearest_expiry <= CURRENT_DATE + 90)::int AS expiring_count,
           COUNT(*) FILTER (WHERE NOT i.is_active)::int AS archived_count,
           COALESCE(SUM(s.value_paisa) FILTER (WHERE i.is_active), 0)::bigint AS total_value_paisa
    FROM supply_items i LEFT JOIN stock s ON s.item_id = i.id`)
  return (r.rows as any[])[0]
}

export async function createItem(b: any) {
  const r = await db.execute<any>(sql`
    INSERT INTO supply_items
      (name, code, category, unit_label, pack_size, reorder_level, tracks_expiry, storage_note)
    VALUES (${b.name.trim()}, ${b.code?.trim() || null}, ${b.category ?? 'consumable'},
            ${b.unitLabel ?? 'piece'}, ${Math.max(1, b.packSize ?? 1)},
            ${Math.max(0, b.reorderLevel ?? 0)}, ${b.tracksExpiry ?? true},
            ${b.storageNote?.trim() || null})
    RETURNING *`)
  return (r.rows as any[])[0]
}

export async function updateItem(id: number, b: any) {
  const r = await db.execute<any>(sql`
    UPDATE supply_items SET
      name = COALESCE(${b.name ?? null}, name),
      code = ${b.code === undefined ? sql`code` : sql`${b.code?.trim() || null}`},
      category = COALESCE(${b.category ?? null}, category),
      unit_label = COALESCE(${b.unitLabel ?? null}, unit_label),
      pack_size = COALESCE(${b.packSize ?? null}, pack_size),
      reorder_level = COALESCE(${b.reorderLevel ?? null}, reorder_level),
      tracks_expiry = COALESCE(${b.tracksExpiry ?? null}, tracks_expiry),
      storage_note = ${b.storageNote === undefined ? sql`storage_note` : sql`${b.storageNote?.trim() || null}`},
      is_active = COALESCE(${b.isActive ?? null}, is_active)
    WHERE id = ${id} RETURNING *`)
  const row = (r.rows as any[])[0]
  if (!row) throw new SupplyError('Item not found', 'NOT_FOUND')
  return row
}

/** Archive rather than delete: the movement history refers to it. */
export async function archiveItem(id: number) {
  const left = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(qty_on_hand), 0)::int AS n FROM supply_batches WHERE item_id = ${id}`)).rows[0]
  if (Number(left.n) > 0) {
    throw new SupplyError(
      `${left.n} still on the shelf. Issue or write them off first.`, 'IN_USE')
  }
  const r = await db.execute<any>(sql`
    UPDATE supply_items SET is_active = false WHERE id = ${id} RETURNING *`)
  const row = (r.rows as any[])[0]
  if (!row) throw new SupplyError('Item not found', 'NOT_FOUND')
  return row
}

/* -------------------------------------------------------------- movement */

/** Goods in. One delivery note, many items, each its own batch. */
export async function receiveSupplies(input: {
  supplierId?: number | null
  invoiceNo?: string | null
  lines: { itemId: number; batchNo?: string | null; expiryDate?: string | null
           qty: number; costPaisa?: number }[]
  receivedBy: string
}) {
  if (input.lines.some((l) => l.qty <= 0)) {
    throw new SupplyError('Every line needs a quantity above zero', 'BAD_QTY')
  }
  return db.transaction(async (tx) => {
    const made: any[] = []
    for (const l of input.lines) {
      const batch = (await tx.execute<any>(sql`
        INSERT INTO supply_batches
          (item_id, batch_no, expiry_date, qty_on_hand, cost_paisa, supplier_id, invoice_no, received_by)
        VALUES (${l.itemId}, ${l.batchNo?.trim() || null},
                ${l.expiryDate ? sql`${l.expiryDate}::date` : sql`NULL`},
                ${l.qty}, ${l.costPaisa ?? 0}, ${input.supplierId ?? null},
                ${input.invoiceNo?.trim() || null}, ${input.receivedBy})
        RETURNING *`)).rows[0]
      await tx.execute(sql`
        INSERT INTO supply_movements
          (item_id, batch_id, kind, qty, reason, cost_paisa, moved_by)
        VALUES (${l.itemId}, ${batch.id}, 'receive', ${l.qty},
                ${input.invoiceNo ? `Invoice ${input.invoiceNo}` : null},
                ${(l.costPaisa ?? 0) * l.qty}, ${input.receivedBy})`)
      made.push(batch)
    }
    return made
  })
}

/**
 * Issue to a department, nearest expiry first.
 *
 * Rows are locked before the count is read, so two store keepers issuing the
 * last box at the same moment cannot both succeed. Without the lock the stock
 * figure goes negative and nobody can explain how.
 */
export async function issueSupplies(input: {
  itemId: number
  qty: number
  departmentId?: number | null
  issuedTo?: string | null
  reason?: string | null
  by: string
}) {
  if (input.qty <= 0) throw new SupplyError('Quantity must be above zero', 'BAD_QTY')

  return db.transaction(async (tx) => {
    const item = (await tx.execute<any>(sql`
      SELECT * FROM supply_items WHERE id = ${input.itemId}`)).rows[0]
    if (!item) throw new SupplyError('Item not found', 'NOT_FOUND')

    const batches = (await tx.execute<any>(sql`
      SELECT * FROM supply_batches
      WHERE item_id = ${input.itemId} AND qty_on_hand > 0
        AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
      ORDER BY expiry_date NULLS LAST, id
      FOR UPDATE`)).rows as any[]

    const available = batches.reduce((n, b) => n + Number(b.qty_on_hand), 0)
    if (available < input.qty) {
      throw new SupplyError(
        `Only ${available} ${item.unit_label}${available === 1 ? '' : 's'} of ${item.name} on the shelf`,
        'NO_STOCK')
    }

    let left = input.qty
    const taken: any[] = []
    for (const b of batches) {
      if (left <= 0) break
      const take = Math.min(left, Number(b.qty_on_hand))
      await tx.execute(sql`
        UPDATE supply_batches SET qty_on_hand = qty_on_hand - ${take} WHERE id = ${b.id}`)
      await tx.execute(sql`
        INSERT INTO supply_movements
          (item_id, batch_id, kind, qty, department_id, issued_to, reason, cost_paisa, moved_by)
        VALUES (${input.itemId}, ${b.id}, 'issue', ${-take},
                ${input.departmentId ?? null}, ${input.issuedTo?.trim() || null},
                ${input.reason?.trim() || null}, ${-take * Number(b.cost_paisa)}, ${input.by})`)
      taken.push({ batchId: b.id, batchNo: b.batch_no, expiry: b.expiry_date, qty: take })
      left -= take
    }
    return { item, taken, qty: input.qty }
  })
}

/** Written off: expired, broken, contaminated. Same locking as an issue. */
export async function wasteSupplies(input: {
  itemId: number; qty: number; reason: string; by: string
}) {
  if (input.qty <= 0) throw new SupplyError('Quantity must be above zero', 'BAD_QTY')
  return db.transaction(async (tx) => {
    const batches = (await tx.execute<any>(sql`
      SELECT * FROM supply_batches
      WHERE item_id = ${input.itemId} AND qty_on_hand > 0
      ORDER BY expiry_date NULLS LAST, id
      FOR UPDATE`)).rows as any[]
    const available = batches.reduce((n, b) => n + Number(b.qty_on_hand), 0)
    if (available < input.qty) {
      throw new SupplyError(`Only ${available} on the shelf`, 'NO_STOCK')
    }
    let left = input.qty
    for (const b of batches) {
      if (left <= 0) break
      const take = Math.min(left, Number(b.qty_on_hand))
      await tx.execute(sql`
        UPDATE supply_batches SET qty_on_hand = qty_on_hand - ${take} WHERE id = ${b.id}`)
      await tx.execute(sql`
        INSERT INTO supply_movements (item_id, batch_id, kind, qty, reason, cost_paisa, moved_by)
        VALUES (${input.itemId}, ${b.id}, 'waste', ${-take}, ${input.reason},
                ${-take * Number(b.cost_paisa)}, ${input.by})`)
      left -= take
    }
    return { qty: input.qty }
  })
}

/**
 * A physical count that disagrees with the system.
 *
 * Recorded as its own movement kind rather than by quietly editing the number,
 * because a stock figure that changes with no explanation is how a store stops
 * being trusted. The reason is required.
 */
export async function adjustStock(input: {
  itemId: number; countedQty: number; reason: string; by: string
}) {
  return db.transaction(async (tx) => {
    const batches = (await tx.execute<any>(sql`
      SELECT * FROM supply_batches WHERE item_id = ${input.itemId}
      ORDER BY expiry_date NULLS LAST, id FOR UPDATE`)).rows as any[]
    const onHand = batches.reduce((n, b) => n + Number(b.qty_on_hand), 0)
    const diff = input.countedQty - onHand
    if (diff === 0) return { diff: 0, onHand }

    if (diff > 0) {
      // Found more than expected: add to the newest batch, or open one.
      const target = batches[batches.length - 1]
      if (target) {
        await tx.execute(sql`
          UPDATE supply_batches SET qty_on_hand = qty_on_hand + ${diff} WHERE id = ${target.id}`)
      } else {
        await tx.execute(sql`
          INSERT INTO supply_batches (item_id, qty_on_hand, received_by)
          VALUES (${input.itemId}, ${diff}, ${input.by})`)
      }
    } else {
      let left = -diff
      for (const b of batches) {
        if (left <= 0) break
        const take = Math.min(left, Number(b.qty_on_hand))
        await tx.execute(sql`
          UPDATE supply_batches SET qty_on_hand = qty_on_hand - ${take} WHERE id = ${b.id}`)
        left -= take
      }
    }

    await tx.execute(sql`
      INSERT INTO supply_movements (item_id, kind, qty, reason, moved_by)
      VALUES (${input.itemId}, 'adjust', ${diff},
              ${`Counted ${input.countedQty}, system said ${onHand}. ${input.reason}`}, ${input.by})`)
    return { diff, onHand, counted: input.countedQty }
  })
}

/* ------------------------------------------------------------- reporting */

export async function movements(opts: {
  itemId?: number; departmentId?: number; kind?: string; from?: string; to?: string
} = {}) {
  let where = sql`true`
  if (opts.itemId) where = sql`${where} AND m.item_id = ${opts.itemId}`
  if (opts.departmentId) where = sql`${where} AND m.department_id = ${opts.departmentId}`
  if (opts.kind && opts.kind !== 'all') where = sql`${where} AND m.kind = ${opts.kind}`
  if (opts.from && opts.to) {
    where = sql`${where} AND m.moved_at >= ${opts.from}::date AND m.moved_at < (${opts.to}::date + interval '1 day')`
  }
  const r = await db.execute<any>(sql`
    SELECT m.*, i.name AS item_name, i.unit_label, d.name AS department_name, b.batch_no
    FROM supply_movements m
    JOIN supply_items i ON i.id = m.item_id
    LEFT JOIN departments d ON d.id = m.department_id
    LEFT JOIN supply_batches b ON b.id = m.batch_id
    WHERE ${where}
    ORDER BY m.moved_at DESC, m.id DESC LIMIT 400`)
  return r.rows
}

/** Who is getting through what. The report a hospital actually acts on. */
export async function consumptionByDepartment(days = 30) {
  const r = await db.execute<any>(sql`
    SELECT COALESCE(d.name, 'Not recorded') AS department,
           COUNT(DISTINCT m.item_id)::int AS items,
           SUM(-m.qty)::int AS units,
           SUM(-m.cost_paisa)::bigint AS value_paisa
    FROM supply_movements m
    LEFT JOIN departments d ON d.id = m.department_id
    WHERE m.kind = 'issue' AND m.moved_at >= now() - (${days} || ' days')::interval
    GROUP BY d.name ORDER BY value_paisa DESC`)
  return r.rows
}

export async function topConsumed(days = 30) {
  const r = await db.execute<any>(sql`
    SELECT i.name, i.unit_label, SUM(-m.qty)::int AS units,
           SUM(-m.cost_paisa)::bigint AS value_paisa
    FROM supply_movements m JOIN supply_items i ON i.id = m.item_id
    WHERE m.kind = 'issue' AND m.moved_at >= now() - (${days} || ' days')::interval
    GROUP BY i.name, i.unit_label ORDER BY value_paisa DESC LIMIT 10`)
  return r.rows
}

export async function expiringSoon(days = 90) {
  const r = await db.execute<any>(sql`
    SELECT b.*, i.name AS item_name, i.unit_label,
           (b.expiry_date - CURRENT_DATE)::int AS days_left,
           (b.qty_on_hand * b.cost_paisa)::bigint AS value_paisa
    FROM supply_batches b JOIN supply_items i ON i.id = b.item_id
    WHERE b.qty_on_hand > 0 AND b.expiry_date IS NOT NULL
      AND b.expiry_date <= CURRENT_DATE + ${days}::int
    ORDER BY b.expiry_date LIMIT 200`)
  return r.rows
}
