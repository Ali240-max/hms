import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'

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

/** CHIT-000123. Gapless, because unexplained gaps in a money document invite suspicion. */
async function nextChitNo(tx: any): Promise<string> {
  const n = await nextCounter(tx, 'chit')
  return `CHIT-${String(n).padStart(6, '0')}`
}

export const CATEGORY_LABEL: Record<string, string> = {
  lab: 'Laboratory',
  radiology: 'Radiology',
  procedure: 'Procedure',
  other: 'Other services'
}

/**
 * Print chits for everything ordered on a visit that has not been billed yet.
 *
 * Grouped by department, so a patient sent for two x-rays and three blood
 * tests carries two chits and makes two payments, not five.
 */
export async function createChitsForVisit(visitId: number, createdBy: string) {
  return db.transaction(async (tx) => {
    const visit = (await tx.execute<any>(sql`
      SELECT v.id, v.patient_id FROM visits v WHERE v.id = ${visitId}`)).rows[0]
    if (!visit) throw new ChitError('Visit not found', 'NOT_FOUND')

    const pending = (await tx.execute<any>(sql`
      SELECT so.id, so.service_name, so.price_paisa, s.category
      FROM service_orders so
      JOIN services s ON s.id = so.service_id
      WHERE so.visit_id = ${visitId} AND so.chit_id IS NULL AND so.status <> 'cancelled'
      ORDER BY s.category, so.id
      FOR UPDATE OF so`)).rows

    if (pending.length === 0) {
      throw new ChitError('Everything ordered on this visit has already been printed', 'NOTHING_TO_BILL')
    }

    const byCategory = new Map<string, any[]>()
    for (const row of pending) {
      const list = byCategory.get(row.category) ?? []
      list.push(row)
      byCategory.set(row.category, list)
    }

    const made: any[] = []
    for (const [category, lines] of byCategory) {
      const total = lines.reduce((n, l) => n + Number(l.price_paisa), 0)
      const chitNo = await nextChitNo(tx)
      const chit = (await tx.execute<any>(sql`
        INSERT INTO chits (chit_no, visit_id, patient_id, category, total_paisa, created_by)
        VALUES (${chitNo}, ${visitId}, ${visit.patient_id}, ${category}::service_category,
                ${total}, ${createdBy})
        RETURNING *`)).rows[0]
      await tx.execute(sql`
        UPDATE service_orders SET chit_id = ${chit.id}
        WHERE id IN (${sql.join(lines.map((l) => sql`${l.id}`), sql`, `)})`)
      made.push(chit)
    }
    return made
  })
}

/** Everything needed to print, in one shape. */
export async function chitForPrint(chitId: number) {
  const chit = (await db.execute<any>(sql`
    SELECT c.*, p.mrn, p.name AS patient_name, p.phone, p.gender, p.age_years,
           v.visit_no, v.token_no, v.created_at,
           st.display_name AS doctor_name, d.specialisation
    FROM chits c
    JOIN patients p ON p.id = c.patient_id
    JOIN visits v   ON v.id = c.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st  ON st.id = d.staff_id
    WHERE c.id = ${chitId}`)).rows[0]
  if (!chit) throw new ChitError('Chit not found', 'NOT_FOUND')

  const lines = (await db.execute<any>(sql`
    SELECT so.id, so.service_name, so.price_paisa, so.status
    FROM service_orders so WHERE so.chit_id = ${chitId} ORDER BY so.id`)).rows

  return { chit, lines, categoryLabel: CATEGORY_LABEL[chit.category] ?? chit.category }
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
  if (category !== 'all') where = sql`${where} AND c.category = ${category}::service_category`
  if (from && to) where = sql`${where} AND c.created_at >= ${from}::date AND c.created_at < (${to}::date + interval '1 day')`
  if (q) {
    const like = `%${q}%`
    where = sql`${where} AND (c.chit_no ILIKE ${like} OR p.mrn ILIKE ${like}
                           OR p.name ILIKE ${like} OR p.phone ILIKE ${like}
                           OR v.token_no::text = ${q})`
  }
  const rows = (await db.execute<any>(sql`
    SELECT c.*, p.mrn, p.name AS patient_name, p.phone, v.token_no, v.visit_no,
           st.display_name AS doctor_name,
           (SELECT COUNT(*)::int FROM service_orders so WHERE so.chit_id = c.id) AS line_count
    FROM chits c
    JOIN patients p ON p.id = c.patient_id
    JOIN visits v   ON v.id = c.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st  ON st.id = d.staff_id
    WHERE ${where}
    ORDER BY c.created_at DESC LIMIT 300`)).rows
  return rows
}
