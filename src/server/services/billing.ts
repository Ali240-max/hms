import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'

/**
 * Billing at the main counter window.
 *
 * Two things are paid for here and both go through the same till: the
 * consultation fee when a patient registers, and the chits for tests and scans
 * when they come back after seeing the doctor. Giving them one bill shape
 * means one invoice series, one print format and one number to reconcile the
 * drawer against at close.
 *
 * The important rule is that completing the bill is what moves the patient
 * forward. Registering does not put anyone in the queue; paying does. Before
 * this, a visit appeared in the queue the moment the details were typed, and
 * whether the fee had been collected was a separate flag nobody looked at.
 */

export class BillError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'ALREADY_BILLED' | 'SHORT_PAYMENT' | 'NOTHING_TO_BILL') {
    super(msg)
  }
}

/**
 * INV-260618-C00123.
 *
 * The letter says what was paid for: C a consultation fee, D a department
 * chit. The date resets the sequence daily, so the number never has to be
 * wide enough to hold years of trading.
 */
async function nextBillNo(tx: any, kind: 'consultation' | 'chit'): Promise<string> {
  return documentNo(tx, { prefix: 'INV', letter: kind === 'chit' ? 'D' : 'C' })
}

/**
 * What the cashier should see on screen before taking money.
 *
 * Returned as line items rather than a single total so the patient can be
 * shown what they are paying for, which is most of what an argument at the
 * window is about.
 */
export async function draftForVisit(visitId: number) {
  const visit = (await db.execute<any>(sql`
    SELECT v.*, p.mrn, p.name AS patient_name, p.phone, p.age_years, p.gender,
           st.display_name AS doctor_name, d.specialisation, dep.name AS department
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    LEFT JOIN departments dep ON dep.id = st.department_id
    WHERE v.id = ${visitId}`)).rows[0]
  if (!visit) throw new BillError('Visit not found', 'NOT_FOUND')
  if (visit.fee_paid) throw new BillError('This consultation has already been billed', 'ALREADY_BILLED')

  return {
    kind: 'consultation' as const,
    visit,
    items: [{
      description: `Consultation — ${visit.doctor_name ?? 'Doctor'}${
        visit.specialisation ? ` (${visit.specialisation})` : ''}`,
      refType: 'visit',
      refId: visit.id,
      amountPaisa: Number(visit.consultation_fee_paisa)
    }],
    totalPaisa: Number(visit.consultation_fee_paisa)
  }
}

export async function draftForChit(chitId: number) {
  const chit = (await db.execute<any>(sql`
    SELECT c.*, p.mrn, p.name AS patient_name, p.phone, p.age_years, p.gender,
           v.token_no, v.visit_no, st.display_name AS doctor_name
    FROM chits c
    JOIN patients p ON p.id = c.patient_id
    JOIN visits v ON v.id = c.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE c.id = ${chitId}`)).rows[0]
  if (!chit) throw new BillError('Chit not found', 'NOT_FOUND')
  if (chit.status !== 'ordered') {
    throw new BillError(`This chit is already marked ${chit.status}`, 'ALREADY_BILLED')
  }

  const lines = (await db.execute<any>(sql`
    SELECT id, service_name, price_paisa FROM service_orders
    WHERE chit_id = ${chitId} ORDER BY id`)).rows

  return {
    kind: 'chit' as const,
    chit,
    visit: { id: chit.visit_id, token_no: chit.token_no, visit_no: chit.visit_no,
             patient_id: chit.patient_id, mrn: chit.mrn, patient_name: chit.patient_name,
             phone: chit.phone, age_years: chit.age_years, gender: chit.gender,
             doctor_name: chit.doctor_name },
    items: lines.map((l: any) => ({
      description: l.service_name, refType: 'service_order', refId: l.id,
      amountPaisa: Number(l.price_paisa)
    })),
    totalPaisa: Number(chit.total_paisa)
  }
}

/**
 * Complete a bill and move the patient on.
 *
 * Everything is one transaction: the invoice, the fee or chit being marked
 * paid, and the visit joining the queue. A bill that printed but left the
 * patient out of the queue, or a patient in the queue with no invoice behind
 * them, are both worse than the whole thing failing and being redone.
 */
export async function completeBill(input: {
  kind: 'consultation' | 'chit'
  visitId?: number
  chitId?: number
  payMethod: string
  tenderedPaisa: number
  discountPaisa?: number
  cashierStaffId: number
  cashierName: string
}) {
  const draft = input.kind === 'consultation'
    ? await draftForVisit(input.visitId!)
    : await draftForChit(input.chitId!)

  const discount = Math.max(0, input.discountPaisa ?? 0)
  const total = Math.max(0, draft.totalPaisa - discount)

  /**
   * Cash must cover the bill. Card and wallet payments settle for the exact
   * amount, so only cash can be short — and a short cash bill means the drawer
   * will not reconcile tonight with nobody able to say why.
   */
  if (input.payMethod === 'cash' && input.tenderedPaisa < total) {
    throw new BillError(
      `Cash received is less than the bill: Rs ${(total / 100).toFixed(2)} due`, 'SHORT_PAYMENT')
  }

  const tendered = input.payMethod === 'cash' ? input.tenderedPaisa : total
  const change = Math.max(0, tendered - total)

  return db.transaction(async (tx) => {
    const billNo = await nextBillNo(tx, input.kind)
    const bill = (await tx.execute<any>(sql`
      INSERT INTO counter_bills
        (bill_no, kind, visit_id, patient_id, chit_id, subtotal_paisa, discount_paisa,
         total_paisa, tendered_paisa, change_paisa, pay_method, cashier_staff_id, cashier_name)
      VALUES (${billNo}, ${input.kind}, ${draft.visit.id}, ${draft.visit.patient_id},
              ${input.kind === 'chit' ? input.chitId! : null},
              ${draft.totalPaisa}, ${discount}, ${total}, ${tendered}, ${change},
              ${input.payMethod}::pay_method, ${input.cashierStaffId}, ${input.cashierName})
      RETURNING *`)).rows[0]

    for (const it of draft.items) {
      await tx.execute(sql`
        INSERT INTO counter_bill_items (bill_id, description, ref_type, ref_id, amount_paisa)
        VALUES (${bill.id}, ${it.description}, ${it.refType}, ${it.refId}, ${it.amountPaisa})`)
    }

    if (input.kind === 'consultation') {
      // Paying is what puts the patient in the queue, not registering.
      await tx.execute(sql`
        UPDATE visits SET fee_paid = true, status = 'waiting'
        WHERE id = ${draft.visit.id} AND status = 'registered'`)
      await tx.execute(sql`UPDATE visits SET fee_paid = true WHERE id = ${draft.visit.id}`)
    } else {
      await tx.execute(sql`
        UPDATE chits SET status = 'paid', paid_at = now(), paid_by = ${input.cashierName},
                         pay_method = ${input.payMethod}::pay_method
        WHERE id = ${input.chitId!} AND status = 'ordered'`)
      await tx.execute(sql`
        UPDATE service_orders SET status = 'paid'
        WHERE chit_id = ${input.chitId!} AND status = 'ordered'`)
    }

    const items = (await tx.execute<any>(sql`
      SELECT * FROM counter_bill_items WHERE bill_id = ${bill.id} ORDER BY id`)).rows
    return { bill, items }
  })
}

/**
 * A test bought without seeing a doctor.
 *
 * People walk in with a form from another hospital, or want a sugar test
 * before Ramadan, or their employer wants a blood group. Making them sit
 * through a consultation to buy one test is how a hospital loses that trade to
 * the lab across the road.
 *
 * It still creates a visit and a chit, because everything downstream — the
 * lab work list, the report, the doctor's earnings, the day's takings —
 * already knows how to read those. What it does not create is a consultation
 * fee, and the visit closes as soon as the bill is paid: nobody is waiting to
 * be seen.
 */
export async function directServiceVisit(input: {
  patientId: number
  serviceIds: number[]
  by: string
  byId: number
}) {
  if (input.serviceIds.length === 0) {
    throw new BillError('Pick at least one test', 'NOTHING_TO_BILL')
  }
  return db.transaction(async (tx) => {
    const services = (await tx.execute<any>(sql`
      SELECT * FROM services
      WHERE id IN (${sql.join(input.serviceIds.map((i) => sql`${i}`), sql`, `)})
        AND is_active`)).rows as any[]
    if (services.length === 0) throw new BillError('Those tests are not available', 'NOT_FOUND')

    const today = new Date().toISOString().slice(0, 10)
    const tokenNo = await nextCounter(tx, `token:direct:${today}`)
    /*
     * VIS-260918-D00042.
     *
     * The sequence resets daily like every other document. It used to run
     * from one global counter, which meant the visit number grew forever
     * while the date beside it already said which day it was — two things
     * carrying the same information, one of them unbounded.
     */
    const visitNo = await documentNo(tx, { prefix: 'VIS', letter: 'D' })

    /**
     * No doctor and no fee. `doctor_id` is nullable only for this case, so
     * the earnings tables simply never see these rows — which is correct,
     * since no doctor referred them and none should be paid a share.
     */
    const visit = (await tx.execute<any>(sql`
      INSERT INTO visits
        (visit_no, token_no, patient_id, doctor_id, consultation_fee_paisa,
         fee_paid, status, visit_type, registered_by, complaint)
      VALUES (${visitNo}, ${tokenNo}, ${input.patientId}, NULL, 0,
              true, 'completed', 'direct', ${input.byId}, 'Walk-in test, no consultation')
      RETURNING *`)).rows[0]

    for (const sv of services) {
      await tx.execute(sql`
        INSERT INTO service_orders
          (visit_id, service_id, service_name, price_paisa, share_bp, status)
        VALUES (${visit.id}, ${sv.id}, ${sv.name}, ${sv.price_paisa}, 0, 'ordered')`)
    }

    // Grouped by department, the same as any other chit.
    const byCategory = new Map<string, any[]>()
    for (const sv of services) {
      const list = byCategory.get(sv.category) ?? []
      list.push(sv)
      byCategory.set(sv.category, list)
    }

    const chits: any[] = []
    for (const [category, list] of byCategory) {
      const n = await nextCounter(tx, 'chit')
      const chitNo = await documentNo(tx, { prefix: 'CHIT', letter: 'T' })
      const total = list.reduce((sum, sv) => sum + Number(sv.price_paisa), 0)
      const chit = (await tx.execute<any>(sql`
        INSERT INTO chits (chit_no, visit_id, patient_id, category, total_paisa, created_by)
        VALUES (${chitNo}, ${visit.id}, ${input.patientId}, ${category}::service_category,
                ${total}, ${input.by})
        RETURNING *`)).rows[0]
      await tx.execute(sql`
        UPDATE service_orders SET chit_id = ${chit.id}
        WHERE visit_id = ${visit.id} AND service_id IN (
          ${sql.join(list.map((sv) => sql`${sv.id}`), sql`, `)})`)
      chits.push(chit)
    }

    return { visit, chits }
  })
}

/** Everything a printed invoice needs, in one shape. */
export async function billForPrint(billId: number) {
  const bill = (await db.execute<any>(sql`
    SELECT b.*, p.mrn, p.name AS patient_name, p.phone, p.age_years, p.gender,
           v.token_no, v.visit_no, st.display_name AS doctor_name
    FROM counter_bills b
    LEFT JOIN patients p ON p.id = b.patient_id
    LEFT JOIN visits v   ON v.id = b.visit_id
    LEFT JOIN doctors d  ON d.id = v.doctor_id
    LEFT JOIN staff st   ON st.id = d.staff_id
    WHERE b.id = ${billId}`)).rows[0]
  if (!bill) throw new BillError('Bill not found', 'NOT_FOUND')
  const items = (await db.execute<any>(sql`
    SELECT * FROM counter_bill_items WHERE bill_id = ${billId} ORDER BY id`)).rows
  return { bill, items }
}

export async function listBills(opts: { q?: string; from?: string; to?: string; kind?: string }) {
  const { q = '', from, to, kind = 'all' } = opts
  let where = sql`true`
  if (kind !== 'all') where = sql`${where} AND b.kind = ${kind}`
  if (from && to) {
    where = sql`${where} AND b.created_at >= ${from}::date AND b.created_at < (${to}::date + interval '1 day')`
  } else {
    where = sql`${where} AND b.created_at >= date_trunc('day', now())`
  }
  if (q) {
    const like = `%${q}%`
    where = sql`${where} AND (b.bill_no ILIKE ${like} OR p.mrn ILIKE ${like}
                          OR p.name ILIKE ${like} OR p.phone ILIKE ${like})`
  }
  const rows = (await db.execute<any>(sql`
    SELECT b.*, p.mrn, p.name AS patient_name, v.token_no
    FROM counter_bills b
    LEFT JOIN patients p ON p.id = b.patient_id
    LEFT JOIN visits v ON v.id = b.visit_id
    WHERE ${where} ORDER BY b.created_at DESC LIMIT 300`)).rows
  const totals = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS bill_count,
           COALESCE(SUM(b.total_paisa), 0)::bigint AS total_paisa,
           COALESCE(SUM(b.total_paisa) FILTER (WHERE b.pay_method = 'cash'), 0)::bigint AS cash_paisa
    FROM counter_bills b
    LEFT JOIN patients p ON p.id = b.patient_id
    WHERE ${where}`)).rows[0]
  return { rows, totals }
}
