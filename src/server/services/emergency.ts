import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'

/**
 * Emergency intake.
 *
 * The order of events is the opposite of OPD, and that is the whole reason
 * this exists as its own path rather than a flag on the normal one:
 *
 *   OPD        register -> pay -> queue -> vitals -> doctor
 *   Emergency  arrive -> treated -> billed afterwards
 *
 * Nobody sends a bleeding patient to a cash window first. So an emergency
 * visit is created by the emergency desk and is immediately live — it does not
 * wait for a bill, and it does not sit behind the payment gate that holds OPD
 * registrations back. What the main counter sees instead is an amount owed,
 * which it collects when someone from the family reaches the window.
 *
 * Medicines used at the bedside work the same way: the desk records what was
 * given, and the pharmacy collects for it afterwards.
 */

export class EmergencyError extends Error {
  constructor(msg: string, public code: 'NOT_FOUND' | 'NO_DOCTOR' | 'CLOSED') { super(msg) }
}

export const TRIAGE = ['critical', 'urgent', 'standard'] as const
export type Triage = typeof TRIAGE[number]

/** Sickest first, then longest waiting. Arrival order alone is not triage. */
const TRIAGE_RANK = sql`CASE v.triage
  WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END`

export async function createEmergencyVisit(input: {
  patientId: number
  doctorId: number
  triage?: string
  arrivalNote?: string | null
  broughtBy?: string | null
  /** Staff id, which is what the column stores; the name goes on sent_in_by. */
  registeredById: number
  registeredBy: string
}) {
  return db.transaction(async (tx) => {
    const doctor = (await tx.execute<any>(sql`
      SELECT d.id, d.consultation_fee_paisa, st.department_id
      FROM doctors d JOIN staff st ON st.id = d.staff_id
      WHERE d.id = ${input.doctorId} AND d.is_active`)).rows[0]
    if (!doctor) throw new EmergencyError('That duty doctor is not available', 'NO_DOCTOR')

    const today = new Date().toISOString().slice(0, 10)
    const tokenNo = await nextCounter(tx, `token:emergency:${today}`)
    /*
     * VIS-260918-E00042.
     *
     * The sequence resets daily like every other document. It used to run
     * from one global counter, which meant the visit number grew forever
     * while the date beside it already said which day it was — two things
     * carrying the same information, one of them unbounded.
     */
    const visitNo = await documentNo(tx, { prefix: 'VIS', letter: 'E' })

    /**
     * Starts at 'ready', not 'registered'.
     *
     * The patient is already in front of a doctor. Holding them at
     * 'registered' until a bill was completed would be the OPD rule applied
     * where it does actual harm.
     */
    const visit = (await tx.execute<any>(sql`
      INSERT INTO visits
        (visit_no, token_no, patient_id, doctor_id, department_id, consultation_fee_paisa,
         fee_paid, status, visit_type, triage, arrival_note, brought_by, registered_by,
         sent_in_at, sent_in_by)
      VALUES (${visitNo}, ${tokenNo}, ${input.patientId}, ${input.doctorId},
              ${doctor.department_id ?? null}, ${Number(doctor.consultation_fee_paisa)},
              false, 'ready', 'emergency', ${input.triage ?? 'standard'},
              ${input.arrivalNote ?? null}, ${input.broughtBy ?? null}, ${input.registeredById},
              now(), ${input.registeredBy})
      RETURNING *`)).rows[0]

    return visit
  })
}

/** The emergency floor right now. */
export async function emergencyQueue(opts: { includeClosed?: boolean } = {}) {
  const r = await db.execute<any>(sql`
    SELECT v.*, p.mrn, p.name AS patient_name, p.phone, p.age_years, p.gender,
           p.allergies, p.blood_group,
           st.display_name AS doctor_name,
           (SELECT COUNT(*)::int FROM prescription_items pi
            JOIN prescriptions pr ON pr.id = pi.prescription_id
            WHERE pr.visit_id = v.id) AS med_count,
           (SELECT COUNT(*)::int FROM prescription_items pi
            JOIN prescriptions pr ON pr.id = pi.prescription_id
            WHERE pr.visit_id = v.id AND pi.status = 'pending') AS med_pending,
           (SELECT COALESCE(SUM(c.total_paisa), 0)::bigint FROM chits c
            WHERE c.visit_id = v.id AND c.status = 'ordered') AS chits_due_paisa
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors d ON d.id = v.doctor_id
    JOIN staff st ON st.id = d.staff_id
    WHERE v.visit_type = 'emergency'
      AND v.status <> 'cancelled'
      ${opts.includeClosed ? sql`` : sql`AND v.status <> 'completed'`}
      AND v.created_at >= now() - interval '48 hours'
    ORDER BY ${TRIAGE_RANK}, v.created_at`)
  return r.rows
}

/**
 * Record medicines given at the bedside.
 *
 * Stored as an ordinary prescription so the pharmacy needs nothing new: the
 * same queue, the same "fill at the counter" button, the same settlement when
 * the sale completes. The only difference is who wrote it.
 *
 * Appends rather than replaces. Emergency treatment happens in bursts — two
 * ampoules now, a drip twenty minutes later — and each burst is added to the
 * same running list rather than overwriting the last one.
 */
export async function addEmergencyMedicines(input: {
  visitId: number
  items: { productId?: number | null; drugName: string; dose?: string | null
           qtyPrescribed?: number; instructions?: string | null }[]
  addedBy: string
}) {
  return db.transaction(async (tx) => {
    const visit = (await tx.execute<any>(sql`
      SELECT v.id, v.doctor_id, v.status, v.visit_type FROM visits v WHERE v.id = ${input.visitId}`)).rows[0]
    if (!visit) throw new EmergencyError('Visit not found', 'NOT_FOUND')
    if (visit.status === 'completed' || visit.status === 'cancelled') {
      throw new EmergencyError('This emergency visit has been closed', 'CLOSED')
    }

    let pres = (await tx.execute<any>(sql`
      SELECT * FROM prescriptions WHERE visit_id = ${input.visitId}`)).rows[0]
    if (!pres) {
      pres = (await tx.execute<any>(sql`
        INSERT INTO prescriptions (visit_id, doctor_id, diagnosis)
        VALUES (${input.visitId}, ${visit.doctor_id}, 'Emergency treatment')
        RETURNING *`)).rows[0]
    }

    for (const it of input.items) {
      await tx.execute(sql`
        INSERT INTO prescription_items
          (prescription_id, product_id, drug_name, dose, frequency, qty_prescribed, instructions)
        VALUES (${pres.id}, ${it.productId ?? null}, ${it.drugName.trim()},
                ${it.dose ?? null}, 'STAT', ${Math.max(1, it.qtyPrescribed ?? 1)},
                ${it.instructions ?? `Given in emergency by ${input.addedBy}`})`)
    }

    const items = (await tx.execute<any>(sql`
      SELECT * FROM prescription_items WHERE prescription_id = ${pres.id} ORDER BY id`)).rows
    return { prescriptionId: pres.id, items }
  })
}

/** What this emergency visit still owes, across all three tills. */
export async function emergencyDues(visitId: number) {
  const r = await db.execute<any>(sql`
    SELECT v.consultation_fee_paisa, v.fee_paid,
           (SELECT COALESCE(SUM(c.total_paisa), 0)::bigint FROM chits c
            WHERE c.visit_id = v.id AND c.status = 'ordered') AS chits_paisa,
           (SELECT COUNT(*)::int FROM prescription_items pi
            JOIN prescriptions pr ON pr.id = pi.prescription_id
            WHERE pr.visit_id = v.id AND pi.status = 'pending') AS meds_pending
    FROM visits v WHERE v.id = ${visitId}`)
  const row = (r.rows as any[])[0]
  if (!row) throw new EmergencyError('Visit not found', 'NOT_FOUND')
  return {
    consultationPaisa: row.fee_paid ? 0 : Number(row.consultation_fee_paisa),
    chitsPaisa: Number(row.chits_paisa),
    medsPending: Number(row.meds_pending),
    feePaid: row.fee_paid
  }
}

/** Close the visit once the patient is discharged or moved to a ward. */
export async function closeEmergencyVisit(visitId: number, by: string, outcome?: string) {
  const r = await db.execute<any>(sql`
    UPDATE visits
    SET status = 'completed', closed_at = now(),
        arrival_note = COALESCE(arrival_note, '') ||
          CASE WHEN ${outcome ?? null}::text IS NULL THEN ''
               ELSE E'\n' || ${'Outcome: ' + (outcome ?? '') + ' (' + by + ')'} END
    WHERE id = ${visitId} AND visit_type = 'emergency'
    RETURNING *`)
  const row = (r.rows as any[])[0]
  if (!row) throw new EmergencyError('Visit not found', 'NOT_FOUND')
  return row
}
