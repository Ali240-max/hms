import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'
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


/**
 * When the test was BOOKED: the moment its bill was made at the counter.
 *
 * Not when the sample was drawn and not when the report was written — the
 * report already carries those two — but when the patient paid for the test,
 * which is where a complaint about waiting starts counting from.
 *
 * Read from the invoice line that names this service order (every bill
 * written by completeBill since counter invoices existed has one), or failing
 * that the invoice written for the chit the order was on. Each test on a
 * bill of several gets that one bill's time, because that is when all of them
 * were booked. A test with no counter invoice behind it — bedside work on an
 * admission, anything paid before invoices existed — has no booked time, and
 * NULL is returned rather than borrowing another timestamp that would look
 * right and be wrong.
 */
const BOOKED_AT = sql`COALESCE(
  (SELECT MIN(cb.created_at) FROM counter_bill_items cbi
     JOIN counter_bills cb ON cb.id = cbi.bill_id
    WHERE cbi.ref_type = 'service_order' AND cbi.ref_id = so.id),
  (SELECT MIN(cb.created_at) FROM counter_bills cb
    WHERE so.chit_id IS NOT NULL AND cb.chit_id = so.chit_id))`

export class LabError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'NOT_PAID' | 'WRONG_STATE' | 'NO_VALUES') { super(msg) }
}

/**
 * `partial` sits between running and reported.
 *
 * A technician who fills four of a CBC's twelve lines and goes to answer the
 * phone used to leave a report marked finished: it moved to the Reported
 * list, and it could be printed and handed over with eight blanks on it.
 * Unfinished work now stays visibly unfinished.
 */
export const LAB_STATUS =
  ['pending', 'collected', 'in_progress', 'partial', 'resulted'] as const

/** LAB-000123. */
async function nextReportNo(tx: any): Promise<string> {
  return documentNo(tx, { prefix: 'LAB', letter: 'L' })
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

  /*
   * Cross match never appears in the work list.
   *
   * It has no parameters, its own result screen and its own report, and when
   * it did appear there the Report button next to it produced the ordinary
   * lab report: the wrong format entirely. It lives in the Cross match tab,
   * which is the only place that knows how to finish or print one.
   */
  /*
   * Matched on the name as well as the code.
   *
   * The shipped service carries the code XMATCH, but a hospital that typed
   * its own "Cross Match" in before the migration arrived has one without it,
   * and those were still turning up in the work list with a Report button
   * that printed the wrong format.
   */
  let having = sql`COALESCE(sv.code, '') <> 'XMATCH'
                   AND sv.name !~* 'cross[[:space:]]*match'`
  if (status === 'active') {
    // Anything still needing the bench, half-filled reports included.
    having = sql`${having} AND COALESCE(lo.status, 'pending') <> 'resulted'`
  } else if (status !== 'all') {
    having = sql`${having} AND COALESCE(lo.status, 'pending') = ${status}`
  }

  const r = await db.execute<any>(sql`
    SELECT so.id AS service_order_id, so.service_name, so.price_paisa, so.status AS pay_status,
           sv.category, sv.id AS service_id,
           -- The laboratory screen recognises a cross match by its code, not
           -- its name: a hospital will rename it and the screen has to keep
           -- working afterwards.
           sv.code AS service_code,
           lo.id AS lab_order_id, lo.report_no, lo.sample_type,
           ${BOOKED_AT} AS booked_at,
           lo.collected_at, lo.collected_by, lo.started_at, lo.resulted_at, lo.resulted_by,
           lo.verified_at, lo.verified_by, lo.notes,
           COALESCE(lo.status, 'pending') AS lab_status,
           -- The department's own token from the chit; the visit's for work
           -- ordered before tokens were per department.
           v.id AS visit_id, COALESCE(ch.token_no, v.token_no) AS token_no,
           v.visit_no, v.visit_type, v.created_at AS visit_at,
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
    LEFT JOIN chits ch      ON ch.id = so.chit_id
    WHERE sv.category IN ('lab', 'radiology', 'procedure')
      AND so.status <> 'cancelled'
      AND (${category} = 'all' OR sv.category::text = ${category})
      ${excludeCategory ? sql`AND sv.category::text <> ${excludeCategory}` : sql``}
      AND (${q} = '' OR p.name ILIKE ${like} OR p.mrn ILIKE ${like}
           OR so.service_name ILIKE ${like} OR lo.report_no ILIKE ${like}
           OR COALESCE(ch.token_no, v.token_no)::text = ${q})
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

  /*
   * One normal value per row, worked out once and read everywhere.
   *
   * The results screen was building this itself from the low and high, so a
   * test set up as a written range showed a leftover numeric range instead of
   * "< 0.50" — the technologist typing the result was checking it against the
   * wrong thing. Worked out here, every screen and the report agree.
   */
  return (r.rows as any[]).map((p) => ({ ...p, display_range: displayRange(p) }))
}

export function displayRange(p: any): string {
  const n = (v: any) => {
    const x = Number(v)
    return Number.isFinite(x) ? String(x) : String(v ?? '')
  }
  if (p.ref_op && p.ref_value != null) return `${p.ref_op} ${n(p.ref_value)}`
  if (p.has_sex_ranges) {
    return [
      p.male_low != null && p.male_high != null
        ? `M: ${n(p.male_low)} - ${n(p.male_high)}` : null,
      p.female_low != null && p.female_high != null
        ? `F: ${n(p.female_low)} - ${n(p.female_high)}` : null
    ].filter(Boolean).join('\n')
  }
  if (p.ref_low != null && p.ref_high != null) {
    return `${n(p.ref_low)} - ${n(p.ref_high)}`
  }
  return p.ref_text ?? ''
}

/**
 * High, low or normal, worked out from the test's setup as it stands now.
 *
 * Three ways a normal value can be written, and each is compared differently.
 * Getting this wrong in either direction is worse than not flagging at all: a
 * red arrow on a normal result sends a patient back to a doctor for nothing,
 * and a missing one on an abnormal result reads as reassurance.
 *
 *   numbers            below the low is low, above the high is high
 *   numbers with M/F   the same, against the patient's own sex
 *   written range      "> 0.8" means anything ABOVE 0.8 is normal, so 0.9 is
 *                      normal and 0.7 is LOW. The operator says which side is
 *                      acceptable; there is no second bound to be high of.
 *   positive/negative  never flagged. "Reactive" is not greater than anything.
 *
 * Computed when the report is drawn rather than stored when the result is
 * typed, so correcting a range corrects every report that already exists.
 */
export function flagFor(value: any, p: {
  ref_op?: string | null; ref_value?: any
  ref_low?: any; ref_high?: any
  has_sex_ranges?: boolean
  male_low?: any; male_high?: any; female_low?: any; female_high?: any
}, gender?: string | null): string | null {
  const n = Number(value)
  if (!Number.isFinite(n) || String(value ?? '').trim() === '') return null
  if (!p) return null

  /*
   * A written range is one-sided, and that is the whole point of it.
   *
   * "> 0.8" was being treated as though it also had an upper bound, so 0.9
   * came out high when it is exactly what the test wants to see.
   */
  if (p.ref_op && p.ref_value != null && p.ref_value !== '') {
    const limit = Number(p.ref_value)
    if (!Number.isFinite(limit)) return null
    switch (p.ref_op) {
      case '<':  return n < limit ? 'normal' : 'high'
      case '<=': return n <= limit ? 'normal' : 'high'
      case '>':  return n > limit ? 'normal' : 'low'
      case '>=': return n >= limit ? 'normal' : 'low'
      case '=':  return n === limit ? 'normal' : 'high'
      default:   return null
    }
  }

  let low = p.ref_low
  let high = p.ref_high
  if (p.has_sex_ranges) {
    const female = String(gender ?? '').toLowerCase().startsWith('f')
    low = female ? p.female_low : p.male_low
    high = female ? p.female_high : p.male_high
  }

  if (low == null || high == null) return null
  if (n < Number(low)) return 'low'
  if (n > Number(high)) return 'high'
  return 'normal'
}

export async function saveParameters(serviceId: number, rows: {
  name: string; unit?: string | null; refLow?: number | null
  refHigh?: number | null; refText?: string | null
  /**
   * Normal values that differ by sex.
   *
   * Haemoglobin is 13.0 to 17.5 for a man and 11.5 to 15.0 for a woman. One
   * column could only hold one of them, so every CBC printed a range that was
   * wrong for half the patients who read it.
   *
   * The switch is stored rather than worked out from the two fields being
   * filled, so turning it off does not throw away what was typed.
   */
  /*
   * A range per sex, as numbers.
   *
   * Text could not be compared without parsing English back into digits, and
   * it competed with the low and high boxes on the same row for the right to
   * say what normal meant.
   */
  maleLow?: number | null
  maleHigh?: number | null
  femaleLow?: number | null
  femaleHigh?: number | null
  hasSexRanges?: boolean
  /**
   * A normal value written as an operator and a number: "<" and 0.50.
   *
   * As free text nothing could compare a result against it, so those tests
   * never flagged high or low. Split in two, the comparison is arithmetic
   * again.
   */
  refOp?: string | null
  refValue?: number | null
  /**
   * The heading this parameter starts, if any.
   *
   * A glucose tolerance test is three timed blocks in one table: the first
   * parameter of each block carries the heading, the rest carry nothing. A
   * test with no sections at all is the normal case and reads exactly as it
   * always has.
   */
  section?: string | null
}[]) {
  return db.transaction(async (tx) => {
    /*
     * Only the fields this test's layout uses are written.
     *
     * A row that kept a low and high from when it was a numbers test, plus an
     * operator from when it became a written range, gave two answers to one
     * question and different screens picked different ones. The layout
     * decides, and everything it does not use is stored as null.
     */
    const layout = await reportLayoutFor(serviceId)

    await tx.execute(sql`DELETE FROM service_parameters WHERE service_id = ${serviceId}`)
    let order = 0
    for (const p of rows) {
      await tx.execute(sql`
        INSERT INTO service_parameters
          (service_id, name, unit, ref_low, ref_high, ref_text,
           male_low, male_high, female_low, female_high,
           has_sex_ranges, ref_op, ref_value, section, display_order)
        VALUES (${serviceId}, ${p.name.trim()}, ${p.unit?.trim() || null},
                ${layout === 'standard' ? (p.refLow ?? null) : null},
                ${layout === 'standard' ? (p.refHigh ?? null) : null},
                ${layout === 'qualitative' ? (p.refText?.trim() || null) : null},
                ${p.maleLow ?? null}, ${p.maleHigh ?? null},
                ${p.femaleLow ?? null}, ${p.femaleHigh ?? null},
                ${p.hasSexRanges ?? false},
                ${layout === 'ranges' ? (p.refOp?.trim() || null) : null},
                ${layout === 'ranges' ? (p.refValue ?? null) : null},
                ${p.section?.trim() || null}, ${order++})`)
    }
    return parametersFor(serviceId)
  })
}

/**
 * How a test's report is laid out.
 *
 * 'standard'    test / result / reference range / units — a chemistry panel
 * 'qualitative' test / result / normal range — POSITIVE or NEGATIVE, where
 *               units and a numeric range are two empty columns that read as
 *               missing information rather than as not applicable
 */
export async function reportLayoutFor(serviceId: number): Promise<string> {
  const row = ((await db.execute<any>(sql`
    SELECT report_layout FROM services WHERE id = ${serviceId}`)).rows as any[])[0]
  return row?.report_layout || 'standard'
}

export async function saveReportLayout(serviceId: number, layout: string) {
  /*
   * 'ranges' is for tests whose normal value is written rather than measured:
   * "< 0.50", "Non reactive", "Upto 15 Years: < 345". Three columns, no units
   * and no numeric low and high, because there is nothing numeric about it.
   */
  const clean = ['qualitative', 'ranges'].includes(layout)
    ? layout : 'standard'
  await db.execute(sql`
    UPDATE services SET report_layout = ${clean} WHERE id = ${serviceId}`)
  return { layout: clean }
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
           ${BOOKED_AT} AS booked_at, lo.collected_at, lo.resulted_at,
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
      -- The patient's sex comes with it, because a range that differs by sex
      -- can only be compared against the right one.
      SELECT lo.*, so.service_id, p.gender
      FROM lab_orders lo
      JOIN service_orders so ON so.id = lo.service_order_id
      JOIN patients p ON p.id = lo.patient_id
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

      // The same rule the report uses, so a stored flag and a printed one
      // can never disagree.
      const flag = flagFor(v.value, p ?? {}, lo.gender)

      await tx.execute(sql`
        INSERT INTO lab_values (lab_order_id, name, value, unit, ref_text, flag, display_order)
        VALUES (${input.labOrderId}, ${v.name}, ${v.value ?? ''},
                ${v.unit ?? p?.unit ?? null}, ${refText}, ${flag}, ${order++})`)
    }

    /*
     * Finished, or only started.
     *
     * A report counts as finished when every line the test defines carries a
     * value. A test with no parameters at all — an x-ray, an ultrasound — is
     * finished once anything has been written, because its one field is the
     * whole report.
     *
     * The distinction is the point: a half-filled CBC that says "resulted"
     * can be printed and handed to a patient with blanks where the platelets
     * should be.
     */
    const expected = params.length > 0
      ? params.map((p) => String(p.name).toLowerCase())
      : input.values.map((v) => v.name.toLowerCase())
    const filled = new Set(input.values
      .filter((v) => String(v.value ?? '').trim() !== '')
      .map((v) => v.name.toLowerCase()))
    const complete = expected.every((name) => filled.has(name))
    const status = complete ? 'resulted' : 'partial'

    await tx.execute(sql`
      UPDATE lab_orders
      SET status = ${status},
          -- Only a finished report carries a reported time and a name against
          -- it. A partial one has nobody to attribute yet.
          resulted_at = ${complete ? sql`now()` : sql`NULL`},
          resulted_by = ${complete ? input.by : null},
          -- A report that goes back to partial loses any verification it had:
          -- what was checked is no longer what is on it.
          verified_at = ${complete ? sql`lab_orders.verified_at` : sql`NULL`},
          verified_by = ${complete ? sql`lab_orders.verified_by` : sql`NULL`},
          notes = ${input.notes ?? null}
      WHERE id = ${input.labOrderId}`)

    return {
      serviceId: lo.service_id, alreadyTaken: !!lo.supplies_taken_at,
      status, complete,
      missing: expected.filter((n) => !filled.has(n)).length
    }
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

  return {
    used, problems,
    status: outcome.status, complete: outcome.complete, missing: outcome.missing
  }
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
           ${BOOKED_AT} AS booked_at,
           -- Needed to look up the test's interpretation bands when printing.
           sv.id AS service_id,
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
    /*
     * The section heading comes from the test's setup, not from the saved
     * value: a technologist types results, not headings, and a report printed
     * after the sections were rearranged should follow the current layout.
     */
    SELECT lv.*, sp.section, sp.has_sex_ranges,
           sp.male_low, sp.male_high, sp.female_low, sp.female_high,
           sp.ref_op, sp.ref_value, sp.ref_low AS p_low, sp.ref_high AS p_high,
           sp.ref_text AS p_text, pt.gender AS patient_gender
    FROM lab_values lv
    LEFT JOIN lab_orders lo    ON lo.id = lv.lab_order_id
    -- A lab order points at the service through the order it was raised from;
    -- there is no service_id on lab_orders itself.
    LEFT JOIN service_orders so ON so.id = lo.service_order_id
    LEFT JOIN service_parameters sp
      ON sp.service_id = so.service_id
     AND lower(sp.name) = lower(lv.name)
    LEFT JOIN patients pt ON pt.id = lo.patient_id
    WHERE lv.lab_order_id = ${labOrderId}
    ORDER BY lv.display_order, lv.id`)).rows
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

/* ------------------------------------------------- what a result means */

/**
 * The interpretation block printed under a test.
 *
 * "Deficiency < 20, Sufficiency 21 - 30, Desirable 31 - 100." It belongs to
 * the test rather than to any one result, because it is identical on every
 * copy and a laboratory changes it when its method changes, not per patient.
 *
 * The range is free text. Laboratories write "Adults: 30 - 115" and
 * "Upto 15 Years: < 345" on the same report, and forcing those into a pair of
 * numbers would lose them.
 */
export async function interpretationsFor(serviceId: number) {
  // A missing id would otherwise interpolate as nothing and produce a syntax
  // error rather than an empty list.
  if (!Number.isFinite(Number(serviceId))) return []
  const r = await db.execute<any>(sql`
    SELECT id, title, range_text, display_order
    FROM service_interpretations
    WHERE service_id = ${serviceId}
    ORDER BY display_order, id`)
  return r.rows
}

/**
 * The note printed at the foot of this test's report, and its heading.
 *
 * Per test rather than per hospital. A Vitamin D report ends with a line about
 * seasonal variation, a CBC with one about slide review; a single setting for
 * every test was right for none of them.
 */
export async function reportNoteFor(serviceId: number) {
  const row = ((await db.execute<any>(sql`
    SELECT note_heading, note_text FROM services WHERE id = ${serviceId}`)).rows as any[])[0]
  return {
    noteHeading: row?.note_heading ?? '',
    noteText: row?.note_text ?? ''
  }
}

export async function saveReportNote(serviceId: number, input: {
  noteHeading?: string | null; noteText?: string | null
}) {
  await db.execute(sql`
    UPDATE services SET
      note_heading = ${input.noteHeading?.trim() || null},
      note_text    = ${input.noteText?.trim() || null}
    WHERE id = ${serviceId}`)
  return reportNoteFor(serviceId)
}

export async function saveInterpretations(serviceId: number, rows: {
  title: string; rangeText: string
}[]) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM service_interpretations WHERE service_id = ${serviceId}`)
    let order = 0
    for (const row of rows) {
      if (!row.title.trim()) continue
      await tx.execute(sql`
        INSERT INTO service_interpretations (service_id, title, range_text, display_order)
        VALUES (${serviceId}, ${row.title.trim()}, ${row.rangeText.trim()}, ${order++})`)
    }
    return interpretationsFor(serviceId)
  })
}

/* ----------------------------------------------------- who signs reports */

export async function signatories() {
  const r = await db.execute<any>(sql`
    SELECT * FROM lab_signatories WHERE is_active ORDER BY display_order, id`)
  return r.rows
}

export async function saveSignatories(rows: {
  id?: number
  name: string
  qualification?: string | null
  designation?: string | null
  registration?: string | null
  signature?: string | null
}[]) {
  return db.transaction(async (tx) => {
    /*
     * Rewritten as a set rather than patched row by row.
     *
     * The order matters — they print left to right along the foot — and
     * keeping order in step through individual inserts and deletes is more
     * code than replacing the list. There are never more than a handful.
     */
    await tx.execute(sql`DELETE FROM lab_signatories`)
    let order = 0
    for (const row of rows) {
      if (!row.name.trim()) continue
      await tx.execute(sql`
        INSERT INTO lab_signatories
          (name, qualification, designation, registration, signature, display_order)
        VALUES (${row.name.trim()}, ${row.qualification ?? null}, ${row.designation ?? null},
                ${row.registration ?? null}, ${row.signature ?? null}, ${order++})`)
    }
    return signatories()
  })
}
