import { sql, eq } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import * as s from '../db/schema'
import { documentNo } from './numbering'

/**
 * Patient identity.
 *
 * This is where systems like this actually fail, and the failure is a data
 * problem rather than a code one. The same person returns three months later,
 * gives their name slightly differently, has no CNIC on them, and shares a
 * name with dozens of others in the same town. Register on free text and you
 * have thousands of duplicates within a year and no usable history for anyone.
 *
 * So: a generated MRN is the identifier that goes on every document, phone is
 * the practical search anchor because people remember their own number, and
 * registration WARNS on likely duplicates instead of silently making another.
 * The warning is advisory — twins, shared family phones and genuine namesakes
 * all exist, so the receptionist decides, not the software.
 */

export class PatientError extends Error {
  constructor(msg: string, public code: 'NOT_FOUND' | 'NO_NAME' | 'HAS_HISTORY') { super(msg) }
}

/** MRN-000123. Short enough to read aloud, long enough to last. */
async function nextMrn(tx: any): Promise<string> {
  const n = await nextCounter(tx, 'mrn')
  return `MRN-${String(n).padStart(6, '0')}`
}

export type NewPatient = {
  name: string
  fatherName?: string | null
  phone?: string | null
  gender?: 'male' | 'female' | 'other' | null
  ageYears?: number | null
  dateOfBirth?: string | null
  cnic?: string | null
  address?: string | null
  bloodGroup?: string | null
  allergies?: string | null
}

/**
 * Anyone who might already be this person. Checked before creating, and shown
 * to the receptionist so they can pick the existing record instead.
 */
export async function findPossibleDuplicates(input: NewPatient) {
  const phone = (input.phone ?? '').replace(/\D/g, '')
  const name = input.name.trim()
  if (!phone && !name) return []

  const r = await db.execute<any>(sql`
    SELECT p.*,
           (SELECT COUNT(*)::int FROM visits v WHERE v.patient_id = p.id) AS visit_count,
           (SELECT MAX(v.created_at) FROM visits v WHERE v.patient_id = p.id) AS last_visit,
           CASE
             WHEN ${phone} <> '' AND regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') = ${phone}
               THEN 'same phone'
             WHEN ${input.cnic ?? ''} <> '' AND p.cnic = ${input.cnic ?? ''}
               THEN 'same CNIC'
             WHEN ${name} <> '' AND lower(p.name) = lower(${name}) THEN 'same name'
             ELSE 'similar name'
           END AS why
    FROM patients p
    WHERE (${phone} <> '' AND regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') = ${phone})
       OR (${input.cnic ?? ''} <> '' AND p.cnic = ${input.cnic ?? ''})
       /*
        * Matched as the name is being typed, not only when it is finished.
        *
        * An exact match found nothing until the last letter, by which point
        * the clerk had moved on to the phone field and stopped looking. Two
        * letters is enough to start showing candidates, which is the whole
        * point: the warning has to arrive before the record is created, not
        * after.
        */
       OR (length(${name}) >= 2 AND p.name ILIKE ${name + '%'})
       OR (length(${name}) >= 4 AND p.name ILIKE ${'%' + name + '%'})
    ORDER BY (regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') = ${phone}) DESC,
             (lower(p.name) = lower(${name})) DESC,
             (SELECT MAX(v.created_at) FROM visits v WHERE v.patient_id = p.id) DESC NULLS LAST,
             p.created_at DESC
    LIMIT 8`)
  return r.rows
}

export async function registerPatient(input: NewPatient, staffId?: number) {
  if (!input.name.trim()) throw new PatientError('The patient needs a name', 'NO_NAME')
  void staffId

  return db.transaction(async (tx) => {
    const mrn = await nextMrn(tx)
    const [row] = await tx.insert(s.patients).values({
      mrn,
      name: input.name.trim(),
      fatherName: input.fatherName?.trim() || null,
      phone: input.phone?.trim() || null,
      gender: input.gender ?? null,
      ageYears: input.ageYears ?? null,
      dateOfBirth: input.dateOfBirth || null,
      cnic: input.cnic?.trim() || null,
      address: input.address?.trim() || null,
      bloodGroup: input.bloodGroup?.trim() || null,
      allergies: input.allergies?.trim() || null
    }).returning()
    return row
  })
}

export async function updatePatient(id: number, patch: Partial<NewPatient>) {
  const [row] = await db.update(s.patients).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.fatherName !== undefined ? { fatherName: patch.fatherName?.trim() || null } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone?.trim() || null } : {}),
    ...(patch.gender !== undefined ? { gender: patch.gender ?? null } : {}),
    ...(patch.ageYears !== undefined ? { ageYears: patch.ageYears ?? null } : {}),
    ...(patch.cnic !== undefined ? { cnic: patch.cnic?.trim() || null } : {}),
    ...(patch.address !== undefined ? { address: patch.address?.trim() || null } : {}),
    ...(patch.bloodGroup !== undefined ? { bloodGroup: patch.bloodGroup?.trim() || null } : {}),
    ...(patch.allergies !== undefined ? { allergies: patch.allergies?.trim() || null } : {})
  }).where(eq(s.patients.id, id)).returning()
  if (!row) throw new PatientError('No such patient', 'NOT_FOUND')
  return row
}

/** Search by MRN, phone, name, father's name or CNIC in one box. */
export async function searchPatients(q: string) {
  const term = q.trim()
  if (term.length < 2) return []
  const digits = term.replace(/\D/g, '')

  const r = await db.execute<any>(sql`
    SELECT p.*,
           (SELECT COUNT(*)::int FROM visits v WHERE v.patient_id = p.id) AS visit_count,
           (SELECT MAX(v.created_at) FROM visits v WHERE v.patient_id = p.id) AS last_visit
    FROM patients p
    WHERE upper(p.mrn) = upper(${term})
       OR p.name ILIKE ${'%' + term + '%'}
       OR p.father_name ILIKE ${'%' + term + '%'}
       OR (${digits} <> '' AND regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') LIKE ${'%' + digits + '%'})
       OR (${digits} <> '' AND regexp_replace(COALESCE(p.cnic,''), '\\D', '', 'g') LIKE ${'%' + digits + '%'})
    ORDER BY (upper(p.mrn) = upper(${term})) DESC, p.created_at DESC
    LIMIT 25`)
  return r.rows
}

export async function getPatient(id: number) {
  const r = await db.execute<any>(sql`SELECT * FROM patients WHERE id = ${id}`)
  const row = (r.rows as any[])[0]
  if (!row) throw new PatientError('No such patient', 'NOT_FOUND')
  return row
}

/** Everything this patient has ever been seen for. */
export async function patientHistory(patientId: number) {
  const r = await db.execute<any>(sql`
    SELECT v.id, v.visit_no, v.token_no, v.status, v.complaint, v.created_at,
           st.display_name AS doctor_name, doc.specialisation,
           pr.id AS prescription_id, pr.diagnosis, pr.advice,
           (SELECT COUNT(*)::int FROM prescription_items pi WHERE pi.prescription_id = pr.id) AS medicine_count,
           (SELECT COUNT(*)::int FROM service_orders so WHERE so.visit_id = v.id) AS service_count
    FROM visits v
    JOIN doctors doc ON doc.id = v.doctor_id
    JOIN staff st ON st.id = doc.staff_id
    LEFT JOIN prescriptions pr ON pr.visit_id = v.id
    WHERE v.patient_id = ${patientId}
    ORDER BY v.created_at DESC LIMIT 50`)
  return r.rows
}

/* ================================================================ visits */

/**
 * Token numbers restart every day, because that is what a queue means to the
 * person holding the slip. The visit number stays globally unique for records.
 */
export async function createVisit(input: {
  patientId: number
  doctorId: number
  complaint?: string | null
  registeredBy?: number
  feePaid?: boolean
}) {
  return db.transaction(async (tx) => {
    const doc = await tx.execute<any>(sql`
      SELECT d.*, st.department_id FROM doctors d
      JOIN staff st ON st.id = d.staff_id WHERE d.id = ${input.doctorId}`)
    const doctor = (doc.rows as any[])[0]
    if (!doctor) throw new PatientError('No such doctor', 'NOT_FOUND')

    const today = new Date().toISOString().slice(0, 10)
    const tokenKey = `token:${today}`
    const tokenNo = await nextCounter(tx, tokenKey)
    /*
     * VIS-260918-V00042.
     *
     * The sequence resets daily like every other document. It used to run
     * from one global counter, which meant the visit number grew forever
     * while the date beside it already said which day it was — two things
     * carrying the same information, one of them unbounded.
     */
    const visitNo = await documentNo(tx, { prefix: 'VIS', letter: 'V' })

    const [row] = await tx.insert(s.visits).values({
      visitNo,
      tokenNo,
      patientId: input.patientId,
      doctorId: input.doctorId,
      departmentId: doctor.department_id ?? null,
      // Snapshot: this visit is charged at today's fee even if it changes later.
      consultationFeePaisa: Number(doctor.consultation_fee_paisa),
      feePaid: input.feePaid ?? false,
      /**
       * Registering does not put anyone in the queue. The cashier completing
       * the bill does. A patient standing at the window with an unpaid slip is
       * not waiting for a doctor yet, and showing them as such made the queue
       * lie about how many people were actually in it.
       */
      status: input.feePaid ? 'waiting' : 'registered',
      complaint: input.complaint?.trim() || null,
      registeredBy: input.registeredBy ?? null
    }).returning()
    return row
  })
}

/** The waiting room. Today only, because yesterday's queue is not a queue. */
/**
 * Today's queue.
 *
 * `includeUnpaid` decides whether registrations that have not been billed yet
 * are visible. Only the main counter passes true: an unpaid registration is
 * work sitting at its own window, not a patient in the queue. Everyone
 * downstream — the OPD desk, the doctors — sees the patient appear only once
 * the bill has been completed, which is the whole point of gating the queue on
 * payment. Enforced here rather than by filtering in each screen, so a new
 * screen cannot forget and start showing them.
 */
export async function todaysQueue(doctorId?: number, includeUnpaid = false) {
  const r = await db.execute<any>(sql`
    SELECT v.*, p.mrn, p.name AS patient_name, p.phone, p.gender, p.age_years,
           st.display_name AS doctor_name, doc.room,
           EXISTS (SELECT 1 FROM prescriptions pr WHERE pr.visit_id = v.id) AS has_prescription
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors doc ON doc.id = v.doctor_id
    JOIN staff st ON st.id = doc.staff_id
    WHERE v.created_at >= date_trunc('day', now())
      AND v.status <> 'cancelled'
      ${includeUnpaid ? sql`` : sql`AND v.status <> 'registered'`}
      ${doctorId ? sql`AND v.doctor_id = ${doctorId}` : sql``}
    ORDER BY
      CASE v.status
        WHEN 'in_consultation' THEN 0 WHEN 'ready' THEN 1
        WHEN 'waiting' THEN 2 WHEN 'registered' THEN 3 ELSE 4 END,
      v.token_no`)
  return r.rows
}

export async function setVisitStatus(
  visitId: number,
  status: 'registered' | 'waiting' | 'ready' | 'in_consultation' | 'completed' | 'cancelled',
  by?: string
) {
  const stamps = status === 'in_consultation' ? sql`, seen_at = COALESCE(seen_at, now())`
    : status === 'completed' ? sql`, closed_at = now()`
    // The OPD desk handing the patient over is the event a doctor waits on,
    // so it is stamped with who did it and when.
    : status === 'ready' ? sql`, sent_in_at = now(), sent_in_by = ${by ?? null}`
    : sql``
  const r = await db.execute<any>(sql`
    UPDATE visits SET status = ${status}${stamps} WHERE id = ${visitId} RETURNING *`)
  return (r.rows as any[])[0]
}

/**
 * Mark a consultation fee paid without going through the till.
 *
 * Kept for correcting records, not for taking money — the counter screens send
 * people to the billing tab instead. It moves the visit into the queue as well
 * as setting the flag: previously it set only the flag, which left a visit
 * sitting at `registered` with `fee_paid` true, invisible to the OPD desk and
 * impossible to bill again because the draft refused an already-paid fee.
 */
export async function markFeePaid(visitId: number) {
  const r = await db.execute<any>(sql`
    UPDATE visits
    SET fee_paid = true,
        status = CASE WHEN status = 'registered' THEN 'waiting'::visit_status ELSE status END
    WHERE id = ${visitId}
    RETURNING *`)
  return (r.rows as any[])[0]
}

/**
 * Abandon a registration that was never paid for.
 *
 * Someone changes their mind at the window, or the receptionist picks the
 * wrong doctor. Without this the visit sits at `registered` forever, holding a
 * token number and cluttering the till.
 */
export async function abandonVisit(visitId: number) {
  const r = await db.execute<any>(sql`
    UPDATE visits SET status = 'cancelled', closed_at = now()
    WHERE id = ${visitId} AND status = 'registered' AND NOT fee_paid
    RETURNING *`)
  return (r.rows as any[])[0] ?? null
}

/**
 * Delete a patient record.
 *
 * Only when nothing hangs off it. The real need is the duplicate created two
 * minutes ago by a receptionist who mistyped a name, and that record has no
 * history behind it. Once a patient has been seen, billed or prescribed for,
 * the record is part of the hospital's account of what it did, and deleting it
 * would silently remove rows from the day's takings and a doctor's earnings.
 *
 * So this counts first and refuses with the reason rather than cascading. If a
 * real patient needs to disappear from the working list, that is a different
 * job from deletion and should stay a different job.
 */
export async function deletePatient(patientId: number) {
  const counts = (await db.execute<any>(sql`
    SELECT (SELECT COUNT(*)::int FROM visits WHERE patient_id = ${patientId}) AS visits,
           (SELECT COUNT(*)::int FROM chits WHERE patient_id = ${patientId}) AS chits,
           (SELECT COUNT(*)::int FROM counter_bills WHERE patient_id = ${patientId}) AS bills,
           (SELECT COUNT(*)::int FROM sales WHERE patient_id = ${patientId}) AS sales`)).rows[0]

  const blocking = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .map(([k, n]) => `${n} ${k}`)

  if (blocking.length > 0) {
    throw new PatientError(
      `This patient has ${blocking.join(', ')} on record, so it cannot be deleted. ` +
      `Correct the details instead.`,
      'HAS_HISTORY'
    )
  }

  const r = await db.execute<any>(sql`
    DELETE FROM patients WHERE id = ${patientId} RETURNING id, mrn, name`)
  const row = (r.rows as any[])[0]
  if (!row) throw new PatientError('Patient not found', 'NOT_FOUND')
  return row
}

export async function getVisit(visitId: number) {
  const r = await db.execute<any>(sql`
    SELECT v.*, p.mrn, p.name AS patient_name, p.phone, p.gender, p.age_years,
           p.allergies, p.blood_group,
           st.display_name AS doctor_name, doc.specialisation, doc.room
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors doc ON doc.id = v.doctor_id
    JOIN staff st ON st.id = doc.staff_id
    WHERE v.id = ${visitId}`)
  const row = (r.rows as any[])[0]
  if (!row) throw new PatientError('No such visit', 'NOT_FOUND')
  return row
}
