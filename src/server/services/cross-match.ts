import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { nextCounter } from '../db/client'

/**
 * Cross match reports.
 *
 * Before a transfusion the laboratory checks that one particular bag of blood
 * is safe for one particular patient. The report names both sides, records the
 * donor's screening, and ends with a plain statement of whether the match is
 * compatible.
 *
 * The defaults below are what a laboratory writes on nearly every one of
 * these, which is the point: a technologist should be changing the two or
 * three answers that differ, not typing NEGATIVE five times.
 */

export const SCREENING_ANSWERS = ['NEGATIVE', 'POSITIVE', 'NOT DONE'] as const
export const PHASE_ANSWERS = ['COMPATIBLE', 'INCOMPATIBLE'] as const
export const BLOOD_GROUPS = ['O', 'A', 'B', 'AB'] as const
export const RH = ['POSITIVE', 'NEGATIVE'] as const

export type CrossMatchInput = {
  patientId: number
  visitId?: number | null
  patientGroup?: string | null
  patientRh?: string | null
  donorName: string
  donorAge?: number | null
  donorSex?: string | null
  donorGroup?: string | null
  donorRh?: string | null
  donorHb?: string | null
  bloodBagNo?: string | null
  hbsag?: string | null
  antiHcv?: string | null
  hiv?: string | null
  vdrl?: string | null
  mp?: string | null
  directPhase?: string | null
  albuminPhase?: string | null
  conclusion?: string | null
  notes?: string | null
  /** When the blood was drawn. Defaults to now if the laboratory does not say. */
  sampleTakenAt?: string | null
  /**
   * The lab order this answers, where it was booked as a test.
   *
   * Marked reported by the same call that writes the report. Two steps — the
   * report, then the test — is two chances to do one and not the other, and a
   * cross match left on the bench with its report already printed is the
   * worse half of that.
   */
  labOrderId?: number | null
}

export class CrossMatchError extends Error {
  constructor(msg: string, public code: 'NO_DONOR' | 'NOT_FOUND') { super(msg) }
}

/**
 * The line at the foot of the report.
 *
 * Worked out from the two phases rather than typed, because it is the one
 * sentence a ward reads and a technologist typing "COMPATIBLE" under two
 * incompatible phases is a transfusion reaction. It can still be overridden,
 * for the cases where a consultant wants different wording.
 */
export function conclusionFor(direct?: string | null, albumin?: string | null) {
  const both = [direct, albumin].map((v) => String(v ?? '').toUpperCase())
  if (both.some((v) => v === 'INCOMPATIBLE')) {
    return 'CROSS MATCH IS NOT COMPATIBLE WITH PATIENT BLOOD GROUP'
  }
  if (both.every((v) => v === 'COMPATIBLE')) {
    return 'CROSS MATCH IS COMPATIBLE WITH PATIENT BLOOD GROUP'
  }
  return ''
}

export async function createCrossMatch(input: CrossMatchInput, by?: string) {
  if (!input.donorName?.trim()) {
    throw new CrossMatchError('The donor needs a name', 'NO_DONOR')
  }

  return db.transaction(async (tx) => {
    const n = await nextCounter(tx, 'crossmatch')
    const reportNo = `XM-${String(n).padStart(6, '0')}`

    const conclusion = input.conclusion?.trim()
      || conclusionFor(input.directPhase, input.albuminPhase)

    const r = await tx.execute<any>(sql`
      INSERT INTO cross_matches (
        report_no, patient_id, visit_id, patient_group, patient_rh,
        donor_name, donor_age, donor_sex, donor_group, donor_rh, donor_hb,
        blood_bag_no, hbsag, anti_hcv, hiv, vdrl, mp,
        direct_phase, albumin_phase, conclusion, notes, sample_taken_at, created_by)
      VALUES (
        ${reportNo}, ${input.patientId}, ${input.visitId ?? null},
        ${input.patientGroup ?? null}, ${input.patientRh ?? null},
        ${input.donorName.trim()}, ${input.donorAge ?? null}, ${input.donorSex ?? null},
        ${input.donorGroup ?? null}, ${input.donorRh ?? null}, ${input.donorHb ?? null},
        ${input.bloodBagNo ?? null},
        ${input.hbsag ?? 'NEGATIVE'}, ${input.antiHcv ?? 'NEGATIVE'},
        ${input.hiv ?? 'NEGATIVE'}, ${input.vdrl ?? 'NEGATIVE'}, ${input.mp ?? 'NEGATIVE'},
        ${input.directPhase ?? 'COMPATIBLE'}, ${input.albuminPhase ?? 'COMPATIBLE'},
        ${conclusion}, ${input.notes ?? null},
        ${input.sampleTakenAt ?? null}, ${by ?? null})
      RETURNING *`)

    if (input.labOrderId) {
      await tx.execute(sql`
        UPDATE lab_orders
        SET status = 'resulted', resulted_at = now(), resulted_by = ${by ?? null}
        WHERE id = ${input.labOrderId}`)
    }

    return (r.rows as any[])[0]
  })
}

export async function crossMatch(id: number) {
  const row = ((await db.execute<any>(sql`
    SELECT cm.*, p.name AS patient_name, p.mrn, p.age_years, p.gender, p.phone,
           v.visit_no,
           st.display_name AS doctor_name
    FROM cross_matches cm
    JOIN patients p ON p.id = cm.patient_id
    LEFT JOIN visits v ON v.id = cm.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE cm.id = ${id}`)).rows as any[])[0]
  if (!row) throw new CrossMatchError('No such report', 'NOT_FOUND')
  return row
}

/**
 * Cross matches, written and still to be written.
 *
 * This tab is the only place they appear now, so it has to show the ones
 * still on the bench as well as the ones finished. A booked cross match with
 * no report yet is a lab order with no row here, so the two are brought
 * together: the report where there is one, the booking where there is not.
 */
export async function crossMatches(opts: {
  q?: string; status?: string; limit?: number
} = {}) {
  const like = `%${opts.q ?? ''}%`
  const status = opts.status ?? 'all'

  const r = await db.execute<any>(sql`
    SELECT cm.id, cm.report_no, cm.donor_name, cm.blood_bag_no, cm.conclusion,
           cm.created_at, cm.created_by, 'reported' AS stage,
           NULL::int AS lab_order_id, NULL::int AS visit_id,
           NULL::int AS service_order_id,
           p.name AS patient_name, p.mrn, p.id AS patient_id
    FROM cross_matches cm
    JOIN patients p ON p.id = cm.patient_id
    WHERE ${status === 'pending' ? sql`false` : sql`true`}
      AND ${opts.q ? sql`(p.name ILIKE ${like} OR p.mrn ILIKE ${like}
              OR cm.report_no ILIKE ${like} OR cm.donor_name ILIKE ${like}
              OR cm.blood_bag_no ILIKE ${like})` : sql`true`}

    UNION ALL

    /*
     * Booked but not yet written. The sample may not even have been taken,
     * which is exactly what the ward is ringing to ask about.
     */
    SELECT NULL::int AS id, lo.report_no, NULL AS donor_name, NULL AS blood_bag_no,
           NULL AS conclusion, lo.created_at, NULL AS created_by,
           CASE WHEN lo.collected_at IS NULL THEN 'awaiting_sample' ELSE 'on_the_bench' END
             AS stage,
           lo.id AS lab_order_id, lo.visit_id, so.id AS service_order_id,
           p.name AS patient_name, p.mrn, p.id AS patient_id
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    JOIN patients p ON p.id = lo.patient_id
    -- By code or by name, so a hand-made "Cross Match" service is picked up
    -- here rather than being stranded with no screen that can finish it.
    WHERE (sv.code = 'XMATCH' OR sv.name ~* 'cross[[:space:]]*match')
      AND lo.status <> 'resulted'
      AND ${status === 'reported' ? sql`false` : sql`true`}
      AND ${opts.q ? sql`(p.name ILIKE ${like} OR p.mrn ILIKE ${like}
              OR lo.report_no ILIKE ${like})` : sql`true`}

    ORDER BY created_at DESC
    LIMIT ${opts.limit ?? 100}`)
  return r.rows
}
