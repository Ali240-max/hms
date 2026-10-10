import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'

/**
 * Inpatients.
 *
 * An admission is a visit that does not end the same day: a bed, a doctor's
 * rounds, whatever is ordered from the bedside, and one running account the
 * family settles at the end.
 */

export class IpdError extends Error {
  constructor(msg: string, public code:
    'NO_BED' | 'BED_TAKEN' | 'NOT_FOUND' | 'ALREADY_ADMITTED' | 'UNPAID' | 'CLOSED') {
    super(msg)
  }
}

/* --------------------------------------------------------- the night rule */

/**
 * How many nights a stay is charged for.
 *
 * A bed is charged per night, so what is counted is the number of times the
 * date changed while the patient held the bed, not the number of hours.
 * Admitted 11pm Monday and discharged 9am Tuesday is ONE night, which is
 * right: the bed was held through one night and could not be given away.
 *
 * A stay that starts and ends on the same day counts as one, not zero. The
 * bed was still held for that day and the hospital still lost the use of it;
 * charging nothing for a day case is a rule nobody running a ward would
 * recognise.
 *
 * Counted on calendar dates in local time rather than on 24-hour blocks,
 * because that is what a ward clerk counts on their fingers, and a bill
 * nobody can check by hand is a bill that gets argued about.
 */
export function nightsBetween(from: Date | string, to: Date | string | null): number {
  const start = startOfDay(new Date(from))
  const end = startOfDay(to ? new Date(to) : new Date())
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  return Math.max(1, days)
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Every date the patient is charged for, so each night is posted once. */
export function nightsIn(from: Date | string, to: Date | string | null): string[] {
  const start = startOfDay(new Date(from))
  const nights = nightsBetween(from, to)
  const out: string[] = []
  for (let i = 0; i < nights; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
      `${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}

/* ---------------------------------------------------------------- wards */

export async function wards(opts: { all?: boolean } = {}) {
  const r = await db.execute<any>(sql`
    SELECT w.*,
           COUNT(b.id) FILTER (WHERE b.is_active)::int                        AS bed_count,
           COUNT(b.id) FILTER (WHERE b.is_active AND b.status = 'free')::int  AS free_count,
           COUNT(b.id) FILTER (WHERE b.is_active AND b.status = 'occupied')::int
                                                                             AS occupied_count
    FROM wards w
    LEFT JOIN beds b ON b.ward_id = w.id
    WHERE ${opts.all ? sql`true` : sql`w.is_active`}
    GROUP BY w.id
    ORDER BY w.display_order, w.name`)
  return r.rows
}

/**
 * Create or update a ward, and optionally fill it with beds.
 *
 * `bedCount` on a new ward creates that many numbered beds in one go, because
 * a twenty-bed general ward is twenty identical beds and nobody wants to add
 * them one at a time. On an existing ward it tops up to that number rather
 * than recreating: beds that are occupied must not be deleted because somebody
 * typed a smaller number.
 */
export async function saveWard(input: {
  id?: number
  name: string
  kind?: string
  floor?: string | null
  chargePaisa: number
  bedCount?: number
  bedPrefix?: string | null
  isActive?: boolean
}) {
  if (!input.name.trim()) throw new IpdError('The ward needs a name', 'NOT_FOUND')

  return db.transaction(async (tx) => {
    let wardId = input.id

    if (wardId) {
      await tx.execute(sql`
        UPDATE wards SET
          name = ${input.name.trim()}, kind = ${input.kind ?? 'general'},
          floor = ${input.floor ?? null}, charge_paisa = ${input.chargePaisa},
          is_active = ${input.isActive ?? true}
        WHERE id = ${wardId}`)
    } else {
      const row = ((await tx.execute<any>(sql`
        INSERT INTO wards (name, kind, floor, charge_paisa)
        VALUES (${input.name.trim()}, ${input.kind ?? 'general'},
                ${input.floor ?? null}, ${input.chargePaisa})
        RETURNING id`)).rows as any[])[0]
      wardId = Number(row.id)
    }

    if (input.bedCount && input.bedCount > 0) {
      const have = Number(((await tx.execute<any>(sql`
        SELECT COUNT(*)::int AS n FROM beds WHERE ward_id = ${wardId}`)).rows as any[])[0].n)

      const prefix = (input.bedPrefix ?? '').trim()
      for (let i = have + 1; i <= input.bedCount; i++) {
        await tx.execute(sql`
          INSERT INTO beds (ward_id, name, display_order)
          VALUES (${wardId}, ${prefix ? `${prefix}-${i}` : String(i)}, ${i})
          ON CONFLICT DO NOTHING`)
      }
    }

    return ((await tx.execute<any>(sql`
      SELECT * FROM wards WHERE id = ${wardId}`)).rows as any[])[0]
  })
}

export async function deleteWard(id: number) {
  const used = ((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n FROM bed_stays bs
    JOIN beds b ON b.id = bs.bed_id WHERE b.ward_id = ${id}`)).rows as any[])[0]
  if (Number(used.n) > 0) {
    throw new IpdError(
      `${used.n} stay(s) have been recorded in this ward, so deleting it would leave ` +
      'those bills pointing at nothing. Switch it off instead.', 'CLOSED')
  }
  await db.execute(sql`DELETE FROM wards WHERE id = ${id}`)
  return { deleted: true }
}

/* ----------------------------------------------------------------- beds */

/** The whole hospital at a glance, which is the question asked all day. */
export async function bedBoard() {
  const r = await db.execute<any>(sql`
    SELECT b.id, b.name, b.status, b.note, b.is_active,
           COALESCE(b.charge_paisa, w.charge_paisa) AS charge_paisa,
           b.charge_paisa IS NOT NULL               AS own_price,
           w.id AS ward_id, w.name AS ward_name, w.kind AS ward_kind, w.floor,
           a.id AS admission_id, a.admission_no, a.admitted_at,
           p.name AS patient_name, p.mrn, p.age_years, p.gender,
           st.display_name AS doctor_name
    FROM beds b
    JOIN wards w ON w.id = b.ward_id
    LEFT JOIN bed_stays bs ON bs.bed_id = b.id AND bs.to_at IS NULL
    LEFT JOIN admissions a ON a.id = bs.admission_id AND a.status = 'open'
    LEFT JOIN patients p ON p.id = a.patient_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE b.is_active AND w.is_active
    ORDER BY w.display_order, w.name, b.display_order, b.name`)
  return r.rows
}

export async function saveBed(input: {
  id?: number
  wardId: number
  name: string
  chargePaisa?: number | null
  status?: string
  note?: string | null
  isActive?: boolean
}) {
  if (input.id) {
    await db.execute(sql`
      UPDATE beds SET
        name = ${input.name.trim()},
        charge_paisa = ${input.chargePaisa ?? null},
        status = COALESCE(${input.status ?? null}, status),
        note = ${input.note ?? null},
        is_active = ${input.isActive ?? true}
      WHERE id = ${input.id}`)
    return ((await db.execute<any>(sql`
      SELECT * FROM beds WHERE id = ${input.id}`)).rows as any[])[0]
  }

  const row = ((await db.execute<any>(sql`
    INSERT INTO beds (ward_id, name, charge_paisa, note)
    VALUES (${input.wardId}, ${input.name.trim()}, ${input.chargePaisa ?? null},
            ${input.note ?? null})
    RETURNING *`)).rows as any[])[0]
  return row
}

export async function deleteBed(id: number) {
  const used = ((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n FROM bed_stays WHERE bed_id = ${id}`)).rows as any[])[0]
  if (Number(used.n) > 0) {
    throw new IpdError(
      `This bed has been slept in ${used.n} time(s). Switch it off instead, ` +
      'so the stays recorded against it still make sense.', 'CLOSED')
  }
  await db.execute(sql`DELETE FROM beds WHERE id = ${id}`)
  return { deleted: true }
}

/** Taking a bed out of use, or putting it back. */
export async function setBedStatus(id: number, status: string, note?: string | null) {
  const bed = ((await db.execute<any>(sql`
    SELECT status FROM beds WHERE id = ${id}`)).rows as any[])[0]
  if (!bed) throw new IpdError('No such bed', 'NOT_FOUND')
  if (bed.status === 'occupied' && status !== 'occupied') {
    throw new IpdError(
      'Somebody is in this bed. Discharge or transfer them first.', 'BED_TAKEN')
  }
  await db.execute(sql`
    UPDATE beds SET status = ${status}, note = ${note ?? null} WHERE id = ${id}`)
  return { ok: true }
}

/* ----------------------------------------------------------- admission */

export async function admit(input: {
  patientId: number
  bedId: number
  visitId?: number | null
  doctorId?: number | null
  departmentId?: number | null
  admissionType?: string
  diagnosis?: string | null
  attendantName?: string | null
  attendantPhone?: string | null
  attendantRelation?: string | null
  advancePaisa?: number | null
  by?: string
}) {
  return db.transaction(async (tx) => {
    const open = ((await tx.execute<any>(sql`
      SELECT admission_no FROM admissions
      WHERE patient_id = ${input.patientId} AND status = 'open'`)).rows as any[])[0]
    if (open) {
      throw new IpdError(
        `This patient is already admitted under ${open.admission_no}. ` +
        'Discharge that admission first, or transfer them to another bed.',
        'ALREADY_ADMITTED')
    }

    /*
     * The bed is taken under a lock.
     *
     * Two clerks admitting two patients into the last free bed at the same
     * moment is not hypothetical on a busy morning, and the loser should be
     * told so rather than finding out when the ward rings.
     */
    const bed = ((await tx.execute<any>(sql`
      SELECT b.id, b.status, COALESCE(b.charge_paisa, w.charge_paisa) AS charge_paisa
      FROM beds b JOIN wards w ON w.id = b.ward_id
      WHERE b.id = ${input.bedId} AND b.is_active
      FOR UPDATE OF b`)).rows as any[])[0]
    if (!bed) throw new IpdError('No such bed', 'NO_BED')
    if (bed.status !== 'free') {
      throw new IpdError('That bed is not free any more. Pick another.', 'BED_TAKEN')
    }

    const n = await nextCounter(tx, 'admission')
    const admissionNo = `ADM-${String(n).padStart(6, '0')}`

    const adm = ((await tx.execute<any>(sql`
      INSERT INTO admissions (
        admission_no, patient_id, visit_id, doctor_id, department_id,
        admission_type, diagnosis, attendant_name, attendant_phone,
        attendant_relation, admitted_by)
      VALUES (${admissionNo}, ${input.patientId}, ${input.visitId ?? null},
              ${input.doctorId ?? null}, ${input.departmentId ?? null},
              ${input.admissionType ?? 'planned'}, ${input.diagnosis ?? null},
              ${input.attendantName ?? null}, ${input.attendantPhone ?? null},
              ${input.attendantRelation ?? null}, ${input.by ?? null})
      RETURNING *`)).rows as any[])[0]

    await tx.execute(sql`
      INSERT INTO bed_stays (admission_id, bed_id, charge_paisa, moved_by)
      VALUES (${adm.id}, ${bed.id}, ${bed.charge_paisa}, ${input.by ?? null})`)
    await tx.execute(sql`UPDATE beds SET status = 'occupied' WHERE id = ${bed.id}`)

    if (input.advancePaisa && input.advancePaisa > 0) {
      await tx.execute(sql`
        INSERT INTO admission_payments (admission_id, kind, amount_paisa, taken_by)
        VALUES (${adm.id}, 'advance', ${input.advancePaisa}, ${input.by ?? null})`)
    }

    return adm
  })
}

/**
 * Move a patient to another bed.
 *
 * The old stay is closed and a new one opened, each with its own rate, so a
 * move from the general ward to a private room on day three bills two nights
 * at one price and the rest at another.
 */
export async function transfer(input: {
  admissionId: number
  bedId: number
  reason?: string | null
  by?: string
}) {
  return db.transaction(async (tx) => {
    const adm = ((await tx.execute<any>(sql`
      SELECT id, status FROM admissions WHERE id = ${input.admissionId}`)).rows as any[])[0]
    if (!adm) throw new IpdError('No such admission', 'NOT_FOUND')
    if (adm.status !== 'open') {
      throw new IpdError('That admission is closed.', 'CLOSED')
    }

    const bed = ((await tx.execute<any>(sql`
      SELECT b.id, b.status, COALESCE(b.charge_paisa, w.charge_paisa) AS charge_paisa
      FROM beds b JOIN wards w ON w.id = b.ward_id
      WHERE b.id = ${input.bedId} AND b.is_active
      FOR UPDATE OF b`)).rows as any[])[0]
    if (!bed) throw new IpdError('No such bed', 'NO_BED')
    if (bed.status !== 'free') {
      throw new IpdError('That bed is not free.', 'BED_TAKEN')
    }

    const current = ((await tx.execute<any>(sql`
      SELECT id, bed_id FROM bed_stays
      WHERE admission_id = ${input.admissionId} AND to_at IS NULL`)).rows as any[])[0]
    if (current) {
      await tx.execute(sql`UPDATE bed_stays SET to_at = now() WHERE id = ${current.id}`)
      /*
       * The bed just left goes to cleaning, not straight to free.
       *
       * Somebody has to strip it, and a board that shows it free the instant a
       * patient moves sends the next admission into an unmade bed.
       */
      await tx.execute(sql`
        UPDATE beds SET status = 'cleaning' WHERE id = ${current.bed_id}`)
    }

    await tx.execute(sql`
      INSERT INTO bed_stays (admission_id, bed_id, charge_paisa, reason, moved_by)
      VALUES (${input.admissionId}, ${bed.id}, ${bed.charge_paisa},
              ${input.reason ?? null}, ${input.by ?? null})`)
    await tx.execute(sql`UPDATE beds SET status = 'occupied' WHERE id = ${bed.id}`)

    return { ok: true }
  })
}

/* ------------------------------------------------------- bed charges */

/**
 * Post the bed nights an admission has run up so far.
 *
 * Idempotent on purpose: it can be run on every page load, on a timer, and
 * again at discharge, and a night already posted is left alone. That is what
 * the unique index on (admission, date) where kind = 'bed' is for. The
 * alternative, a nightly job that must run exactly once, fails quietly on the
 * night the server was rebooted and nobody notices until the bill is short.
 */
export async function postBedNights(admissionId: number) {
  const stays = (await db.execute<any>(sql`
    SELECT bs.*, b.name AS bed_name, w.name AS ward_name
    FROM bed_stays bs
    JOIN beds b ON b.id = bs.bed_id
    JOIN wards w ON w.id = b.ward_id
    WHERE bs.admission_id = ${admissionId}
    ORDER BY bs.from_at`)).rows as any[]

  let added = 0
  for (const stay of stays) {
    for (const date of nightsIn(stay.from_at, stay.to_at)) {
      const r = await db.execute<any>(sql`
        INSERT INTO admission_charges
          (admission_id, kind, description, qty, unit_paisa, total_paisa,
           source_table, source_id, charged_for)
        VALUES (${admissionId}, 'bed',
                ${`${stay.ward_name} · ${stay.bed_name}`}, 1,
                ${stay.charge_paisa}, ${stay.charge_paisa},
                'bed_stays', ${stay.id}, ${date})
        ON CONFLICT DO NOTHING
        RETURNING id`)
      if ((r.rows as any[]).length) added++
    }
  }
  return { added }
}

/* ----------------------------------------------------- the running bill */

export async function account(admissionId: number) {
  await postBedNights(admissionId)

  const adm = ((await db.execute<any>(sql`
    SELECT a.*, p.name AS patient_name, p.mrn, p.age_years, p.gender, p.phone,
           st.display_name AS doctor_name, d.name AS department_name,
           b.name AS bed_name, w.name AS ward_name
    FROM admissions a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN doctors doc ON doc.id = a.doctor_id
    LEFT JOIN staff st ON st.id = doc.staff_id
    LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN bed_stays bs ON bs.admission_id = a.id AND bs.to_at IS NULL
    LEFT JOIN beds b ON b.id = bs.bed_id
    LEFT JOIN wards w ON w.id = b.ward_id
    WHERE a.id = ${admissionId}`)).rows as any[])[0]
  if (!adm) throw new IpdError('No such admission', 'NOT_FOUND')

  const charges = (await db.execute<any>(sql`
    SELECT * FROM admission_charges WHERE admission_id = ${admissionId}
    ORDER BY created_at, id`)).rows as any[]

  const payments = (await db.execute<any>(sql`
    SELECT * FROM admission_payments WHERE admission_id = ${admissionId}
    ORDER BY created_at, id`)).rows as any[]

  const billed = charges.reduce((n, c) => n + Number(c.total_paisa), 0)

  /*
   * A discount reduces what is owed; it is not money that arrived. Keeping
   * the two apart is what lets the day's takings reconcile against the till.
   */
  const paid = payments
    .filter((p) => p.kind === 'advance' || p.kind === 'payment')
    .reduce((n, p) => n + Number(p.amount_paisa), 0)
  const refunded = payments
    .filter((p) => p.kind === 'refund')
    .reduce((n, p) => n + Number(p.amount_paisa), 0)
  const relieved = payments
    .filter((p) => p.kind === 'discount' || p.kind === 'waived')
    .reduce((n, p) => n + Number(p.amount_paisa), 0)

  return {
    admission: adm,
    charges,
    payments,
    totals: {
      billed_paisa: billed,
      paid_paisa: paid - refunded,
      relieved_paisa: relieved,
      balance_paisa: billed - relieved - (paid - refunded),
      /*
       * Money owed back to the family.
       *
       * An advance is taken on the way in, before anybody knows what the stay
       * will cost, so a short stay routinely ends with the hospital holding
       * more than it billed. Nothing said so, and an unremarked credit is
       * money quietly kept: the family asks weeks later and nobody can say
       * what happened.
       */
      refund_due_paisa: Math.max(0, (paid - refunded) - (billed - relieved)),
      nights: nightsBetween(adm.admitted_at, adm.discharged_at)
    }
  }
}

export async function addCharge(input: {
  admissionId: number
  kind: string
  description: string
  qty?: number
  unitPaisa: number
  sourceTable?: string | null
  sourceId?: number | null
  by?: string
}) {
  const qty = input.qty ?? 1
  const row = ((await db.execute<any>(sql`
    INSERT INTO admission_charges
      (admission_id, kind, description, qty, unit_paisa, total_paisa,
       source_table, source_id, added_by)
    VALUES (${input.admissionId}, ${input.kind}, ${input.description.trim()},
            ${qty}, ${input.unitPaisa}, ${Math.round(qty * input.unitPaisa)},
            ${input.sourceTable ?? null}, ${input.sourceId ?? null}, ${input.by ?? null})
    RETURNING *`)).rows as any[])[0]
  return row
}

export async function takePayment(input: {
  admissionId: number
  kind?: string
  amountPaisa: number
  method?: string | null
  note?: string | null
  approvedBy?: string | null
  by?: string
}) {
  const row = ((await db.execute<any>(sql`
    INSERT INTO admission_payments
      (admission_id, kind, amount_paisa, method, note, approved_by, taken_by)
    VALUES (${input.admissionId}, ${input.kind ?? 'payment'}, ${input.amountPaisa},
            ${input.method ?? null}, ${input.note ?? null},
            ${input.approvedBy ?? null}, ${input.by ?? null})
    RETURNING *`)).rows as any[])[0]
  return row
}

/* ----------------------------------------------------------- discharge */

export async function discharge(input: {
  admissionId: number
  outcome?: string
  outcomeNote?: string | null
  finalDiagnosis?: string | null
  /** Let a balance stand. Needs a name against it. */
  allowBalance?: boolean
  by?: string
}) {
  const acct = await account(input.admissionId)
  if (acct.admission.status !== 'open') {
    throw new IpdError('That admission is already closed.', 'CLOSED')
  }

  /*
   * A balance stops a discharge unless somebody overrides it deliberately.
   *
   * Not because the hospital should hold patients, but because the bed frees
   * the moment this runs and the account is never looked at again. The
   * override exists for the cases that matter: a death, a transfer out, a
   * waived bill. It is the counter's decision, recorded, not the software's.
   */
  /*
   * A credit is reported, not blocked.
   *
   * The ward still needs the bed and the family still needs to leave, so the
   * refund is handed back at the window rather than held up here. What
   * matters is that the discharge says the number out loud instead of closing
   * the account over it.
   */
  if (acct.totals.refund_due_paisa > 0) {
    await takePayment({
      admissionId: input.admissionId, kind: 'refund',
      amountPaisa: acct.totals.refund_due_paisa,
      note: 'Unused advance returned at discharge',
      by: input.by
    })
  }

  if (acct.totals.balance_paisa > 0 && !input.allowBalance) {
    throw new IpdError(
      `Rs ${(acct.totals.balance_paisa / 100).toFixed(2)} is still outstanding. ` +
      'Take the payment, or discharge with the balance left standing.', 'UNPAID')
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE admissions SET
        status = 'discharged', discharged_at = now(),
        outcome = ${input.outcome ?? 'discharged'},
        outcome_note = ${input.outcomeNote ?? null},
        final_diagnosis = ${input.finalDiagnosis ?? null},
        discharged_by = ${input.by ?? null}
      WHERE id = ${input.admissionId}`)

    const stay = ((await tx.execute<any>(sql`
      SELECT id, bed_id FROM bed_stays
      WHERE admission_id = ${input.admissionId} AND to_at IS NULL`)).rows as any[])[0]
    if (stay) {
      await tx.execute(sql`UPDATE bed_stays SET to_at = now() WHERE id = ${stay.id}`)
      // Cleaning, not free. Somebody has to strip the bed first.
      await tx.execute(sql`UPDATE beds SET status = 'cleaning' WHERE id = ${stay.bed_id}`)
    }

    return { ok: true }
  })
}

/* ------------------------------------------------------------- listing */

export async function admissions(opts: {
  status?: string; q?: string; limit?: number
} = {}) {
  const like = `%${opts.q ?? ''}%`
  const r = await db.execute<any>(sql`
    SELECT a.id, a.admission_no, a.admitted_at, a.discharged_at, a.status,
           a.outcome, a.admission_type, a.diagnosis,
           p.name AS patient_name, p.mrn, p.age_years, p.gender, p.phone,
           st.display_name AS doctor_name,
           b.name AS bed_name, w.name AS ward_name,
           COALESCE((SELECT SUM(total_paisa) FROM admission_charges c
                     WHERE c.admission_id = a.id), 0)::bigint AS billed_paisa,
           COALESCE((SELECT SUM(amount_paisa) FROM admission_payments pm
                     WHERE pm.admission_id = a.id
                       AND pm.kind IN ('advance', 'payment')), 0)::bigint AS paid_paisa
    FROM admissions a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN doctors doc ON doc.id = a.doctor_id
    LEFT JOIN staff st ON st.id = doc.staff_id
    LEFT JOIN bed_stays bs ON bs.admission_id = a.id AND bs.to_at IS NULL
    LEFT JOIN beds b ON b.id = bs.bed_id
    LEFT JOIN wards w ON w.id = b.ward_id
    WHERE ${opts.status && opts.status !== 'all'
      ? sql`a.status = ${opts.status}` : sql`true`}
      AND ${opts.q
        ? sql`(p.name ILIKE ${like} OR p.mrn ILIKE ${like}
               OR a.admission_no ILIKE ${like} OR p.phone ILIKE ${like})`
        : sql`true`}
    ORDER BY a.admitted_at DESC
    LIMIT ${opts.limit ?? 100}`)
  return r.rows
}
