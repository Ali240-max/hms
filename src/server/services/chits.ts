import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo, nextToken, queueFor } from './numbering'

/**
 * Payment chits.
 *
 * The flow this models, which is how the hospitals here actually work:
 *
 *   1. Doctor orders an x-ray during the consultation.
 *   2. Reception prints a chit for it and hands it to the patient.
 *   3. Patient pays at the cashier or pharmacy counter; the chit reads paid.
 *   4. The radiographer looks the patient up, sees paid, and proceeds.
 *
 * Step 4 is the reason this exists as data rather than only paper. The
 * department needs to check payment without trusting a slip that can be
 * copied, lost, or waved about. The paper is still printed, because the
 * patient needs something to carry and the cashier needs something to stamp.
 *
 * Ordering matters: money is only ever recorded against a chit that exists,
 * and a procedure is only ever recorded against a chit already paid.
 */

export class ChitError extends Error {
  constructor(msg: string, public code: 'NOT_FOUND' | 'ALREADY_PAID' | 'NOT_PAID' | 'NOTHING_TO_BILL' | 'DONE') {
    super(msg)
  }
}

/**
 * CHIT-260918-D00042.
 *
 * The sequence resets each morning, so it never has to be wide enough to hold
 * a decade of trading — a single running number reaching 999999 is a problem
 * a hospital meets mid-queue, on the day it happens.
 */
async function nextChitNo(tx: any): Promise<string> {
  const n = await nextCounter(tx, 'chit')
  return documentNo(tx, { prefix: 'CHIT', letter: 'T' })
}

export const CATEGORY_LABEL: Record<string, string> = {
  lab: 'Laboratory',
  radiology: 'Radiology',
  procedure: 'Procedure',
  other: 'Other services'
}

/**
 * Raise chits for whatever on a visit has not been put on one yet.
 *
 * The one place chits are made — the doctor's orders, the counter's walk-in
 * tests and the "print chits" button all come through here — so the grouping
 * and the token cannot drift apart between them, which is how the walk-in
 * path ended up with its own token counter in the first place.
 *
 * Grouped by department, so a patient sent for two x-rays and three blood
 * tests carries two chits and makes two payments, not five. The department is
 * the one the service's category is mapped to, falling back to the service's
 * own; work with neither is grouped by its kind, as it always was.
 *
 * Each chit carries the token of its department's queue (see nextToken).
 * Chits raised together for the same queue share one token: it is one patient
 * standing in that department's line, not two.
 */
export async function raiseChits(tx: any, input: {
  visitId: number
  createdBy: string
}): Promise<any[]> {
  const pending = (await tx.execute(sql`
    SELECT so.id, so.price_paisa, sv.category,
           COALESCE(sc.department_id, sv.department_id) AS department_id
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    LEFT JOIN service_categories sc ON sc.id = sv.category_id
    WHERE so.visit_id = ${input.visitId} AND so.chit_id IS NULL AND so.status <> 'cancelled'
    ORDER BY sv.category, so.id
    FOR UPDATE OF so`)).rows as any[]
  if (pending.length === 0) return []

  const visit = (await tx.execute(sql`
    SELECT id, patient_id FROM visits WHERE id = ${input.visitId}`)).rows[0] as any
  if (!visit) throw new ChitError('Visit not found', 'NOT_FOUND')

  /*
   * One chit per department AND kind. The kind stays on the chit because the
   * chit list, its printed heading and the counter's collection report all
   * read it; a department mapped from two kinds still gets one token.
   */
  const groups = new Map<string, { kind: string; departmentId: number | null; rows: any[] }>()
  for (const row of pending) {
    const dept = row.department_id == null ? null : Number(row.department_id)
    const key = `${dept ?? '-'}|${row.category}`
    const g = groups.get(key) ?? { kind: String(row.category), departmentId: dept, rows: [] as any[] }
    g.rows.push(row)
    groups.set(key, g)
  }

  const tokens = new Map<string, number>()
  const made: any[] = []
  for (const g of groups.values()) {
    const queue = queueFor(g.departmentId, `kind:${g.kind}`)
    let token = tokens.get(queue)
    if (token === undefined) {
      token = await nextToken(tx, queue)
      tokens.set(queue, token)
    }
    const total = g.rows.reduce((n, l) => n + Number(l.price_paisa), 0)
    const chitNo = await nextChitNo(tx)
    const chit = (await tx.execute(sql`
      INSERT INTO chits (chit_no, visit_id, patient_id, category, total_paisa, created_by,
                         token_no, department_id)
      VALUES (${chitNo}, ${input.visitId}, ${visit.patient_id}, ${g.kind}::service_category,
              ${total}, ${input.createdBy}, ${token}, ${g.departmentId})
      RETURNING *`)).rows[0]
    await tx.execute(sql`
      UPDATE service_orders SET chit_id = ${chit.id}
      WHERE id IN (${sql.join(g.rows.map((l) => sql`${l.id}`), sql`, `)})`)
    made.push(chit)
  }
  return made
}

/**
 * Print chits for everything ordered on a visit that has not been billed yet.
 */
export async function createChitsForVisit(visitId: number, createdBy: string) {
  return db.transaction(async (tx) => {
    const visit = (await tx.execute<any>(sql`
      SELECT v.id FROM visits v WHERE v.id = ${visitId}`)).rows[0]
    if (!visit) throw new ChitError('Visit not found', 'NOT_FOUND')
    const made = await raiseChits(tx, { visitId, createdBy })
    if (made.length === 0) {
      throw new ChitError('Everything ordered on this visit has already been printed', 'NOTHING_TO_BILL')
    }
    return made
  })
}

/** Everything needed to print, in one shape. */
export async function chitForPrint(chitId: number) {
  const chit = (await db.execute<any>(sql`
    SELECT c.*, p.mrn, p.name AS patient_name, p.phone, p.gender, p.age_years,
           v.visit_no, COALESCE(c.token_no, v.token_no) AS token_no, v.created_at,
           dep.name AS department_name,
           st.display_name AS doctor_name, d.specialisation
    FROM chits c
    JOIN patients p ON p.id = c.patient_id
    JOIN visits v   ON v.id = c.visit_id
    LEFT JOIN departments dep ON dep.id = c.department_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st  ON st.id = d.staff_id
    WHERE c.id = ${chitId}`)).rows[0]
  if (!chit) throw new ChitError('Chit not found', 'NOT_FOUND')

  const lines = (await db.execute<any>(sql`
    SELECT so.id, so.service_name, so.price_paisa, so.status
    FROM service_orders so WHERE so.chit_id = ${chitId} ORDER BY so.id`)).rows

  /*
   * "Show this slip at Dental" rather than "at Procedure": the department the
   * chit was raised for, where it has one, is where the patient walks to.
   */
  return { chit, lines,
    categoryLabel: chit.department_name ?? CATEGORY_LABEL[chit.category] ?? chit.category }
}

export async function chitsForVisit(visitId: number) {
  const rows = (await db.execute<any>(sql`
    SELECT c.*,
           (SELECT COUNT(*)::int FROM service_orders so WHERE so.chit_id = c.id) AS line_count
    FROM chits c WHERE c.visit_id = ${visitId} ORDER BY c.id`)).rows

  const unbilled = (await db.execute<any>(sql`
    SELECT s.category, COUNT(*)::int AS n, SUM(so.price_paisa)::bigint AS total_paisa
    FROM service_orders so JOIN services s ON s.id = so.service_id
    WHERE so.visit_id = ${visitId} AND so.chit_id IS NULL AND so.status <> 'cancelled'
    GROUP BY s.category`)).rows

  return { chits: rows, unbilled }
}

/**
 * Take payment.
 *
 * Paying also moves the underlying orders to paid, because that is the flag
 * the department screen reads. Refuses a second payment rather than quietly
 * recording it twice: an unexplained double charge is worse than an error.
 */
export async function payChit(chitId: number, paidBy: string, method: string) {
  return db.transaction(async (tx) => {
    const chit = (await tx.execute<any>(sql`
      SELECT * FROM chits WHERE id = ${chitId} FOR UPDATE`)).rows[0]
    if (!chit) throw new ChitError('Chit not found', 'NOT_FOUND')
    if (chit.status !== 'ordered') {
      throw new ChitError(`This chit is already marked ${chit.status}`, 'ALREADY_PAID')
    }
    const updated = (await tx.execute<any>(sql`
      UPDATE chits SET status = 'paid', paid_at = now(), paid_by = ${paidBy},
                       pay_method = ${method}::pay_method
      WHERE id = ${chitId} RETURNING *`)).rows[0]
    await tx.execute(sql`
      UPDATE service_orders SET status = 'paid' WHERE chit_id = ${chitId} AND status = 'ordered'`)
    return updated
  })
}

/** The department marks the work done. Only ever after payment. */
export async function completeChit(chitId: number, completedBy: string, note?: string) {
  return db.transaction(async (tx) => {
    const chit = (await tx.execute<any>(sql`
      SELECT * FROM chits WHERE id = ${chitId} FOR UPDATE`)).rows[0]
    if (!chit) throw new ChitError('Chit not found', 'NOT_FOUND')
    if (chit.status === 'completed') throw new ChitError('Already marked done', 'DONE')
    if (chit.status !== 'paid') {
      throw new ChitError('This has not been paid for yet. Send the patient to the counter first.', 'NOT_PAID')
    }
    const updated = (await tx.execute<any>(sql`
      UPDATE chits SET status = 'completed', completed_at = now(), completed_by = ${completedBy},
                       note = COALESCE(${note ?? null}, note)
      WHERE id = ${chitId} RETURNING *`)).rows[0]
    await tx.execute(sql`
      UPDATE service_orders SET status = 'completed' WHERE chit_id = ${chitId} AND status = 'paid'`)
    return updated
  })
}

/** The work queue: unpaid at the counter, paid-and-waiting in the department. */
export async function listChits(opts: {
  status?: string; category?: string; q?: string; from?: string; to?: string
}) {
  const { status = 'all', category = 'all', q = '', from, to } = opts
  let where = sql`true`
  if (status !== 'all') where = sql`${where} AND c.status = ${status}::order_status`
  /*
   * `dept:<id>` is a department, as the counter's category filter sends for
   * a category mapped to one. Chits raised before departments were stamped
   * on them match through their kind, so last month's lab chits are still
   * found under the laboratory.
   */
  const dept = /^dept:(\d+)$/.exec(category)
  if (dept) {
    const id = Number(dept[1])
    where = sql`${where} AND (c.department_id = ${id} OR (c.department_id IS NULL AND c.category IN (
      SELECT sc.kind FROM service_categories sc WHERE sc.department_id = ${id})))`
  } else if (['lab', 'radiology', 'procedure', 'other'].includes(category)) {
    where = sql`${where} AND c.category = ${category}::service_category`
  }
  if (from && to) where = sql`${where} AND c.created_at >= ${from}::date AND c.created_at < (${to}::date + interval '1 day')`
  if (q) {
    const like = `%${q}%`
    where = sql`${where} AND (c.chit_no ILIKE ${like} OR p.mrn ILIKE ${like}
                           OR p.name ILIKE ${like} OR p.phone ILIKE ${like}
                           OR COALESCE(c.token_no, v.token_no)::text = ${q})`
  }
  const rows = (await db.execute<any>(sql`
    SELECT c.*, p.mrn, p.name AS patient_name, p.phone,
           COALESCE(c.token_no, v.token_no) AS token_no, v.visit_no,
           st.display_name AS doctor_name, dep.name AS department_name,
           (SELECT COUNT(*)::int FROM service_orders so WHERE so.chit_id = c.id) AS line_count
    FROM chits c
    JOIN patients p ON p.id = c.patient_id
    JOIN visits v   ON v.id = c.visit_id
    LEFT JOIN departments dep ON dep.id = c.department_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st  ON st.id = d.staff_id
    WHERE ${where}
    ORDER BY c.created_at DESC LIMIT 300`)).rows
  return rows
}
