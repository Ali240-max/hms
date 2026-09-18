import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { issueSupplies } from './supplies'

/**
 * The laboratory.
 *
 * A lab order is the working life of a test a doctor already ordered and a
 * patient already paid for: sample taken, test run, values entered, report
 * printed. It carries no money at all — the charge lives on the service_order
 * and was settled at the main counter when the chit was paid.
 *
 * Payment is the gate, and it is enforced here rather than by hiding a button.
 * A technician who starts before the chit is settled has given the hospital's
 * reagents away, and there is no way to bill for it afterwards.
 */

export class LabError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'NOT_PAID' | 'WRONG_STATE' | 'NO_VALUES') { super(msg) }
}

export const LAB_STATUS = ['pending', 'collected', 'in_progress', 'resulted'] as const

/** LAB-000123. */
async function nextReportNo(tx: any): Promise<string> {
  return `LAB-${String(await nextCounter(tx, 'lab_report')).padStart(6, '0')}`
}

/**
 * The work list.
 *
 * Built from service_orders rather than from lab_orders, because a test that
 * has been paid for but not started has no lab_order row yet — and that is
 * precisely the queue the technician needs to see.
 */
export async function labQueue(opts: {
  status?: string; q?: string; category?: string; excludeCategory?: string
} = {}) {
  const { status = 'active', q = '', category = 'all', excludeCategory } = opts
  const like = `%${q}%`

  let having = sql`true`
  if (status === 'active') {
    having = sql`COALESCE(lo.status, 'pending') <> 'resulted'`
  } else if (status !== 'all') {
    having = sql`COALESCE(lo.status, 'pending') = ${status}`
  }

  const r = await db.execute<any>(sql`
    SELECT so.id AS service_order_id, so.service_name, so.price_paisa, so.status AS pay_status,
           sv.category, sv.id AS service_id,
           lo.id AS lab_order_id, lo.report_no, lo.sample_type,
           lo.collected_at, lo.collected_by, lo.started_at, lo.resulted_at, lo.resulted_by,
           lo.verified_at, lo.verified_by, lo.notes,
           COALESCE(lo.status, 'pending') AS lab_status,
           v.id AS visit_id, v.token_no, v.visit_no, v.visit_type, v.created_at AS visit_at,
           p.id AS patient_id, p.mrn, p.name AS patient_name, p.age_years, p.gender, p.phone,
           st.display_name AS doctor_name,
           (SELECT COUNT(*)::int FROM service_parameters sp
            WHERE sp.service_id = sv.id AND sp.is_active) AS parameter_count
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    JOIN visits v    ON v.id = so.visit_id
    JOIN patients p  ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st  ON st.id = d.staff_id
    LEFT JOIN lab_orders lo ON lo.service_order_id = so.id
    WHERE sv.category IN ('lab', 'radiology', 'procedure')
      AND so.status <> 'cancelled'
      AND (${category} = 'all' OR sv.category::text = ${category})
      ${excludeCategory ? sql`AND sv.category::text <> ${excludeCategory}` : sql``}
      AND (${q} = '' OR p.name ILIKE ${like} OR p.mrn ILIKE ${like}
           OR so.service_name ILIKE ${like} OR lo.report_no ILIKE ${like}
           OR v.token_no::text = ${q})
      AND ${having}
    ORDER BY (so.status = 'paid') DESC, so.ordered_at DESC
    LIMIT 300`)
  return r.rows
}

/** The parameters a test reports, used to build the entry form. */
export async function parametersFor(serviceId: number) {
  const r = await db.execute<any>(sql`
    SELECT * FROM service_parameters
    WHERE service_id = ${serviceId} AND is_active ORDER BY display_order, id`)
  return r.rows
}

export async function saveParameters(serviceId: number, rows: {
  name: string; unit?: string | null; refLow?: number | null
  refHigh?: number | null; refText?: string | null
}[]) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM service_parameters WHERE service_id = ${serviceId}`)
    let order = 0
    for (const p of rows) {
      await tx.execute(sql`
        INSERT INTO service_parameters (service_id, name, unit, ref_low, ref_high, ref_text, display_order)
        VALUES (${serviceId}, ${p.name.trim()}, ${p.unit?.trim() || null},
                ${p.refLow ?? null}, ${p.refHigh ?? null}, ${p.refText?.trim() || null}, ${order++})`)
    }
    return parametersFor(serviceId)
  })
}

/* ------------------------------------------------------------- the recipe */

export async function consumablesFor(serviceId: number) {
  const r = await db.execute<any>(sql`
    SELECT sc.*, i.name AS item_name, i.unit_label,
           COALESCE((SELECT SUM(b.qty_on_hand)::int FROM supply_batches b
                     WHERE b.item_id = sc.item_id AND b.qty_on_hand > 0
                       AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)), 0) AS on_hand
    FROM service_consumables sc
    JOIN supply_items i ON i.id = sc.item_id
    WHERE sc.service_id = ${serviceId} ORDER BY i.name`)
  return r.rows
}

export async function saveConsumables(serviceId: number, rows: { itemId: number; qty: number }[]) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM service_consumables WHERE service_id = ${serviceId}`)
    for (const c of rows) {
      if (c.qty <= 0) continue
      await tx.execute(sql`
        INSERT INTO service_consumables (service_id, item_id, qty)
        VALUES (${serviceId}, ${c.itemId}, ${c.qty})
        ON CONFLICT (service_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`)
    }
    return consumablesFor(serviceId)
  })
}

/* --------------------------------------------------------------- the work */

async function loadOrder(tx: any, serviceOrderId: number) {
  const row = ((await tx.execute(sql`
    SELECT so.*, sv.category, v.patient_id
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    JOIN visits v ON v.id = so.visit_id
    WHERE so.id = ${serviceOrderId}`)).rows as any[])[0]
  if (!row) throw new LabError('That test is not on the list', 'NOT_FOUND')
  return row
}

/**
 * Sample taken. The first step, and the one that has to be blocked until the
 * money is in — everything after it costs the hospital something.
 */
export async function collectSample(input: {
  serviceOrderId: number; sampleType?: string | null; by: string
}) {
  const made = await db.transaction(async (tx) => {
    const so = await loadOrder(tx, input.serviceOrderId)
    if (so.status !== 'paid' && so.status !== 'completed') {
      throw new LabError(
        'This has not been paid for yet. Send the patient to the main counter first.', 'NOT_PAID')
    }

    const existing = (await tx.execute<any>(sql`
      SELECT * FROM lab_orders WHERE service_order_id = ${input.serviceOrderId}`)).rows[0]
    if (existing) {
      const r = (await tx.execute<any>(sql`
        UPDATE lab_orders SET status = 'collected', collected_at = now(),
               collected_by = ${input.by}, sample_type = ${input.sampleType ?? null}
        WHERE id = ${existing.id} RETURNING *`)).rows[0]
      return r
    }

    const reportNo = await nextReportNo(tx)
    return (await tx.execute<any>(sql`
      INSERT INTO lab_orders
        (report_no, service_order_id, visit_id, patient_id, status,
         sample_type, collected_at, collected_by)
      VALUES (${reportNo}, ${input.serviceOrderId}, ${so.visit_id}, ${so.patient_id},
              'collected', ${input.sampleType ?? null}, now(), ${input.by})
      RETURNING *`)).rows[0]
  })

  /**
   * The store is charged when the sample is taken, not when the result is
   * typed.
   *
   * That is when the syringe, the vial and the gloves are actually used. A
   * test that is collected and then abandoned still consumed them, and
   * waiting for a result meant the shelf count was wrong for as long as the
   * sample sat on the bench.
   *
   * Outside the transaction on purpose: issuing locks batch rows, and a busy
   * store must never be able to block a technician from taking blood. A
   * failure to deduct is reported back and corrected by a count.
   */
  const used: any[] = []
  const problems: string[] = []
  if (!made.supplies_taken_at) {
    const soRow = ((await db.execute<any>(sql`
      SELECT service_id FROM service_orders WHERE id = ${input.serviceOrderId}`))
      .rows as any[])[0]
    for (const c of await consumablesFor(soRow.service_id)) {
      try {
        await issueSupplies({
          itemId: c.item_id, qty: c.qty,
          reason: `Lab sample — ${made.report_no}`, by: input.by
        })
        used.push({ item: c.item_name, qty: c.qty })
      } catch (e: any) { problems.push(`${c.item_name}: ${e.message}`) }
    }
    await db.execute(sql`
      UPDATE lab_orders SET supplies_taken_at = now() WHERE id = ${made.id}`)
  }

  return { ...made, used, problems }
}

/**
 * Take one sample for everything this patient is waiting on.
 *
 * A doctor who orders CBC, LFT and RFT is ordering one blood draw, not three.
 * Making the technician press a button per test invites a second needle and
 * makes the counts disagree with reality, so the whole visit is collected
 * together and each test still gets its own report number.
 */
export async function collectVisit(input: {
  visitId: number
  sampleType?: string | null
  category?: string
  by: string
}) {
  const pending = (await db.execute<any>(sql`
    SELECT so.id
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    LEFT JOIN lab_orders lo ON lo.service_order_id = so.id
    WHERE so.visit_id = ${input.visitId}
      AND sv.category IN ('lab','radiology','procedure')
      AND so.status IN ('paid','completed')
      AND COALESCE(lo.status, 'pending') = 'pending'
      ${input.category && input.category !== 'all'
        ? sql`AND sv.category::text = ${input.category}` : sql``}
    ORDER BY so.id`)).rows as any[]

  if (pending.length === 0) {
    throw new LabError('Nothing on this visit is waiting for a sample', 'WRONG_STATE')
  }

  const made: any[] = []
  for (const row of pending) {
    made.push(await collectSample({
      serviceOrderId: row.id, sampleType: input.sampleType, by: input.by
    }))
  }
  return made
}

/** Everything the lab is doing for one visit, in one shape. */
export async function visitWork(visitId: number) {
  const r = await db.execute<any>(sql`
    SELECT so.id AS service_order_id, so.service_name, so.status AS pay_status,
           sv.id AS service_id, sv.category,
           lo.id AS lab_order_id, lo.report_no, lo.status AS lab_status,
           lo.sample_type, lo.notes, lo.verified_at,
           (SELECT COUNT(*)::int FROM service_parameters sp
            WHERE sp.service_id = sv.id AND sp.is_active) AS parameter_count
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    LEFT JOIN lab_orders lo ON lo.service_order_id = so.id
    WHERE so.visit_id = ${visitId}
      AND sv.category IN ('lab','radiology','procedure')
      AND so.status <> 'cancelled'
    ORDER BY sv.category, so.id`)
  return r.rows
}

export async function startTest(labOrderId: number, by: string) {
  const r = await db.execute<any>(sql`
    UPDATE lab_orders SET status = 'in_progress', started_at = now(), started_by = ${by}
    WHERE id = ${labOrderId} AND status = 'collected' RETURNING *`)
  const row = (r.rows as any[])[0]
  if (!row) throw new LabError('Take the sample first', 'WRONG_STATE')
  return row
}

/**
 * Enter the results.
 *
 * Two things happen alongside saving the values. Each one is flagged against
 * its reference range so the report can mark it without the technician
 * deciding; and the consumables the test uses are taken off the store, once,
 * guarded by a timestamp so re-saving a corrected value cannot deduct twice.
 *
 * A short store is not allowed to block a result. The test has already been
 * run — the reagents are gone whatever the system thinks — so a failure to
 * deduct is reported back rather than thrown, and the result still saves.
 */
export async function saveResults(input: {
  labOrderId: number
  values: { name: string; value: string; unit?: string | null; refText?: string | null }[]
  notes?: string | null
  by: string
}) {
  if (input.values.length === 0) throw new LabError('Nothing to save', 'NO_VALUES')

  const outcome = await db.transaction(async (tx) => {
    const lo = (await tx.execute<any>(sql`
      SELECT lo.*, so.service_id FROM lab_orders lo
      JOIN service_orders so ON so.id = lo.service_order_id
      WHERE lo.id = ${input.labOrderId}`)).rows[0]
    if (!lo) throw new LabError('Report not found', 'NOT_FOUND')
    if (lo.status === 'pending') throw new LabError('Take the sample first', 'WRONG_STATE')

    const params = (await tx.execute<any>(sql`
      SELECT * FROM service_parameters WHERE service_id = ${lo.service_id}`)).rows as any[]
    const byName = new Map(params.map((p) => [String(p.name).toLowerCase(), p]))

    await tx.execute(sql`DELETE FROM lab_values WHERE lab_order_id = ${input.labOrderId}`)

    let order = 0
    for (const v of input.values) {
      const p = byName.get(v.name.toLowerCase())
      /**
       * Postgres hands back numeric as "70.000", which reads badly on a
       * report next to a result of 105. Trailing zeros are dropped so a range
       * prints the way a lab writes it.
       */
      const tidy = (n: any) => {
        const x = Number(n)
        return Number.isFinite(x) ? String(x) : String(n)
      }
      const refText = v.refText ?? p?.ref_text ??
        (p?.ref_low != null && p?.ref_high != null
          ? `${tidy(p.ref_low)} - ${tidy(p.ref_high)}` : null)

      // Flagged only where there is a numeric range and a numeric value.
      let flag: string | null = null
      const n = Number(v.value)
      if (!Number.isNaN(n) && v.value.trim() !== '' && p?.ref_low != null && p?.ref_high != null) {
        if (n < Number(p.ref_low)) flag = 'low'
        else if (n > Number(p.ref_high)) flag = 'high'
        else flag = 'normal'
      }

      await tx.execute(sql`
        INSERT INTO lab_values (lab_order_id, name, value, unit, ref_text, flag, display_order)
        VALUES (${input.labOrderId}, ${v.name}, ${v.value ?? ''},
                ${v.unit ?? p?.unit ?? null}, ${refText}, ${flag}, ${order++})`)
    }

    await tx.execute(sql`
      UPDATE lab_orders SET status = 'resulted', resulted_at = now(), resulted_by = ${input.by},
             notes = ${input.notes ?? null}
      WHERE id = ${input.labOrderId}`)

    return { serviceId: lo.service_id, alreadyTaken: !!lo.supplies_taken_at }
  })

  /**
   * Nothing is deducted here any more.
   *
   * Consumables come off when the sample is taken, which is when they are
   * really used. The timestamp guard remains so an older order collected
   * before that change still charges its recipe once, rather than never.
   */
  const used: any[] = []
  const problems: string[] = []
  if (!outcome.alreadyTaken) {
    for (const c of await consumablesFor(outcome.serviceId)) {
      try {
        await issueSupplies({
          itemId: c.item_id, qty: c.qty, reason: `Lab test — report ${input.labOrderId}`,
          by: input.by
        })
        used.push({ item: c.item_name, qty: c.qty })
      } catch (e: any) { problems.push(`${c.item_name}: ${e.message}`) }
    }
    await db.execute(sql`
      UPDATE lab_orders SET supplies_taken_at = now() WHERE id = ${input.labOrderId}`)
  }

  return { used, problems }
}

export async function verifyResult(labOrderId: number, by: string) {
  const r = await db.execute<any>(sql`
    UPDATE lab_orders SET verified_at = now(), verified_by = ${by}
    WHERE id = ${labOrderId} AND status = 'resulted' RETURNING *`)
  const row = (r.rows as any[])[0]
  if (!row) throw new LabError('Enter the results first', 'WRONG_STATE')
  return row
}

/** Everything a report needs, in one shape. */
export async function reportFor(labOrderId: number) {
  const head = (await db.execute<any>(sql`
    SELECT lo.*, so.service_name, so.price_paisa, sv.category,
           p.mrn, p.name AS patient_name, p.age_years, p.gender, p.phone, p.cnic,
           v.visit_no, v.token_no, v.created_at AS visit_at,
           st.display_name AS doctor_name, d.specialisation
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    JOIN patients p ON p.id = lo.patient_id
    JOIN visits v ON v.id = lo.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE lo.id = ${labOrderId}`)).rows[0]
  if (!head) throw new LabError('Report not found', 'NOT_FOUND')

  const values = (await db.execute<any>(sql`
    SELECT * FROM lab_values WHERE lab_order_id = ${labOrderId} ORDER BY display_order, id`)).rows
  return { report: head, values }
}

/** `scope` keeps each department's counts to its own work. */
export async function labStats(scope: 'all' | 'radiology' | 'not-radiology' = 'all') {
  const where = scope === 'radiology' ? sql`sv.category = 'radiology'`
    : scope === 'not-radiology' ? sql`sv.category <> 'radiology'`
    : sql`true`
  const r = await db.execute<any>(sql`
    SELECT COUNT(*) FILTER (WHERE so.status = 'paid'
             AND COALESCE(lo.status,'pending') = 'pending')::int AS waiting,
           COUNT(*) FILTER (WHERE COALESCE(lo.status,'') = 'collected')::int AS collected,
           COUNT(*) FILTER (WHERE COALESCE(lo.status,'') = 'in_progress')::int AS in_progress,
           COUNT(*) FILTER (WHERE lo.resulted_at >= date_trunc('day', now()))::int AS resulted_today,
           COUNT(*) FILTER (WHERE so.status = 'ordered')::int AS unpaid
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    LEFT JOIN lab_orders lo ON lo.service_order_id = so.id
    WHERE sv.category IN ('lab','radiology','procedure') AND so.status <> 'cancelled'
      AND ${where}
      AND so.ordered_at >= now() - interval '30 days'`)
  return (r.rows as any[])[0]
}
