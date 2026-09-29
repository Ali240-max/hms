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
        direct_phase, albumin_phase, conclusion, notes, created_by)
      VALUES (
        ${reportNo}, ${input.patientId}, ${input.visitId ?? null},
        ${input.patientGroup ?? null}, ${input.patientRh ?? null},
        ${input.donorName.trim()}, ${input.donorAge ?? null}, ${input.donorSex ?? null},
        ${input.donorGroup ?? null}, ${input.donorRh ?? null}, ${input.donorHb ?? null},
        ${input.bloodBagNo ?? null},
        ${input.hbsag ?? 'NEGATIVE'}, ${input.antiHcv ?? 'NEGATIVE'},
        ${input.hiv ?? 'NEGATIVE'}, ${input.vdrl ?? 'NEGATIVE'}, ${input.mp ?? 'NEGATIVE'},
        ${input.directPhase ?? 'COMPATIBLE'}, ${input.albuminPhase ?? 'COMPATIBLE'},
        ${conclusion}, ${input.notes ?? null}, ${by ?? null})
      RETURNING *`)
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

export async function crossMatches(opts: { q?: string; limit?: number } = {}) {
  const like = `%${opts.q ?? ''}%`
  const r = await db.execute<any>(sql`
    SELECT cm.id, cm.report_no, cm.donor_name, cm.blood_bag_no, cm.conclusion,
           cm.created_at, cm.created_by,
           p.name AS patient_name, p.mrn
    FROM cross_matches cm
    JOIN patients p ON p.id = cm.patient_id
    WHERE ${opts.q ? sql`(p.name ILIKE ${like} OR p.mrn ILIKE ${like}
              OR cm.report_no ILIKE ${like} OR cm.donor_name ILIKE ${like}
              OR cm.blood_bag_no ILIKE ${like})` : sql`true`}
    ORDER BY cm.created_at DESC
    LIMIT ${opts.limit ?? 100}`)
  return r.rows
}
