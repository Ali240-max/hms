import { sql, eq } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'
import * as s from '../db/schema'

export class ClinicalError extends Error {
  constructor(msg: string, public code: 'NOT_FOUND' | 'NO_ITEMS' | 'CLOSED' | 'NO_PRICE') { super(msg) }
}

/* ========================================================= prescriptions */

export type PrescribedItem = {
  /** Null for anything not in the pharmacy catalogue. Deliberately allowed. */
  productId?: number | null
  drugName: string
  dose?: string | null
  frequency?: string | null
  durationDays?: number | null
  qtyPrescribed: number
  instructions?: string | null
}

export type OrderedService = {
  serviceId: number
  note?: string | null
}

/**
 * Saves the whole consultation: diagnosis, medicines, tests, and whatever the
 * doctor earns from it.
 *
 * Everything lands in one transaction. A prescription saved without its
 * service orders would send a patient to the lab with nothing to pay against,
 * and an earning written without its order would pay a doctor for work that is
 * not recorded anywhere.
 */
export async function saveConsultation(input: {
  visitId: number
  doctorId: number
  diagnosis?: string | null
  advice?: string | null
  followUpDate?: string | null
  items: PrescribedItem[]
  services: OrderedService[]
}) {
  return db.transaction(async (tx) => {
    const v = await tx.execute<any>(sql`SELECT * FROM visits WHERE id = ${input.visitId}`)
    const visit = (v.rows as any[])[0]
    if (!visit) throw new ClinicalError('No such visit', 'NOT_FOUND')
    if (visit.status === 'cancelled') {
      throw new ClinicalError('This visit was cancelled', 'CLOSED')
    }

    // Re-saving replaces the prescription rather than stacking a second one.
    // A doctor correcting a typo must not leave the pharmacy with two lists.
    const existing = await tx.execute<any>(sql`
      SELECT id FROM prescriptions WHERE visit_id = ${input.visitId}`)
    const prev = (existing.rows as any[])[0]

    let prescriptionId: number
    if (prev) {
      prescriptionId = Number(prev.id)
      await tx.execute(sql`
        UPDATE prescriptions SET diagnosis = ${input.diagnosis ?? null},
               advice = ${input.advice ?? null},
               follow_up_date = ${input.followUpDate || null}::date
        WHERE id = ${prescriptionId}`)
      // Only lines nothing has been dispensed against can be replaced; once
      // the pharmacy has handed medicine over, that line is a record of fact.
      await tx.execute(sql`
        DELETE FROM prescription_items
        WHERE prescription_id = ${prescriptionId} AND qty_dispensed = 0`)
    } else {
      const [row] = await tx.insert(s.prescriptions).values({
        visitId: input.visitId,
        doctorId: input.doctorId,
        diagnosis: input.diagnosis ?? null,
        advice: input.advice ?? null,
        followUpDate: input.followUpDate || null
      }).returning()
      prescriptionId = row.id
    }

    for (const it of input.items) {
      if (!it.drugName.trim()) continue
      await tx.insert(s.prescriptionItems).values({
        prescriptionId,
        productId: it.productId ?? null,
        drugName: it.drugName.trim(),
        dose: it.dose ?? null,
        frequency: it.frequency ?? null,
        durationDays: it.durationDays ?? null,
        qtyPrescribed: Math.max(1, it.qtyPrescribed),
        instructions: it.instructions ?? null
      })
    }

    /* ----------------------------------------------------------- services */
    for (const so of input.services) {
      const svcRes = await tx.execute<any>(sql`
        SELECT sv.*, COALESCE(dss.share_bp, sv.default_share_bp, 0) AS effective_share_bp
        FROM services sv
        LEFT JOIN doctor_service_shares dss
          ON dss.service_id = sv.id AND dss.doctor_id = ${input.doctorId}
        WHERE sv.id = ${so.serviceId}`)
      const svc = (svcRes.rows as any[])[0]
      if (!svc) continue
      // Same rule as the counter: an unpriced test is refused rather than
      // quietly ordered at zero.
      if (Number(svc.price_paisa) <= 0) {
        throw new ClinicalError(
          `No price set for ${svc.name}. An administrator sets it under Administration, Services.`,
          'NO_PRICE')
      }

      // Price and share are both snapshotted. Changing either next month must
      // never rewrite what a doctor already earned.
      const price = Number(svc.price_paisa)
      const shareBp = Number(svc.effective_share_bp)
      const share = Math.round((price * shareBp) / 10000)

      const [order] = await tx.insert(s.serviceOrders).values({
        visitId: input.visitId,
        serviceId: svc.id,
        doctorId: input.doctorId,
        serviceName: svc.name,
        pricePaisa: price,
        shareBp,
        sharePaisa: share,
        note: so.note ?? null
      }).returning()

      if (share > 0) {
        await tx.execute(sql`
          INSERT INTO doctor_earnings
            (doctor_id, visit_id, source, ref_table, ref_id, description, gross_paisa, share_bp, amount_paisa)
          VALUES (${input.doctorId}, ${input.visitId}, 'service', 'service_orders', ${order.id},
                  ${svc.name}, ${price}, ${shareBp}, ${share})
          ON CONFLICT (source, ref_table, ref_id) DO NOTHING`)
      }
    }

    /* ------------------------------------------------------- consultation */
    // Written once per visit. The unique index on (source, ref_table, ref_id)
    // is what stops a doctor being paid twice for re-saving a consultation.
    const docRow = await tx.execute<any>(sql`
      SELECT consultation_share_bp FROM doctors WHERE id = ${input.doctorId}`)
    const shareBp = Number((docRow.rows as any[])[0]?.consultation_share_bp ?? 0)
    const fee = Number(visit.consultation_fee_paisa)
    const amount = Math.round((fee * shareBp) / 10000)
    if (amount > 0) {
      await tx.execute(sql`
        INSERT INTO doctor_earnings
          (doctor_id, visit_id, source, ref_table, ref_id, description, gross_paisa, share_bp, amount_paisa)
        VALUES (${input.doctorId}, ${input.visitId}, 'consultation', 'visits', ${input.visitId},
                'Consultation', ${fee}, ${shareBp}, ${amount})
        ON CONFLICT (source, ref_table, ref_id) DO NOTHING`)
    }

    await tx.execute(sql`
      UPDATE visits SET status = 'completed', closed_at = now(),
             seen_at = COALESCE(seen_at, now())
      WHERE id = ${input.visitId}`)

    /* --------------------------------------------------------------- chits */
    /**
     * Chits are raised here, by the act of ordering, not by anyone pressing a
     * button later.
     *
     * The doctor ordering an x-ray is the event that creates the charge, so
     * the charge should exist from that moment. Waiting for a clerk to
     * generate it meant a patient could reach the counter before the chit
     * did, and it made the chit list a record of what someone had remembered
     * to create rather than of what had actually been ordered.
     *
     * One chit per department, not per line: the patient pays once at the
     * window for everything the lab is doing, and carries one slip to the lab.
     * Grouping by department is what decides how many slips they end up with.
     */
    const unbilled = (await tx.execute<any>(sql`
      SELECT so.id, sv.category
      FROM service_orders so
      JOIN services sv ON sv.id = so.service_id
      WHERE so.visit_id = ${input.visitId} AND so.chit_id IS NULL AND so.status <> 'cancelled'
      ORDER BY sv.category, so.id
      FOR UPDATE OF so`)).rows as any[]

    const byCategory = new Map<string, number[]>()
    for (const row of unbilled) {
      const list = byCategory.get(row.category) ?? []
      list.push(row.id)
      byCategory.set(row.category, list)
    }

    for (const [category, ids] of byCategory) {
      const n = await nextCounter(tx, 'chit')
      const chitNo = await documentNo(tx, { prefix: 'CHIT', letter: 'T' })
      const chit = (await tx.execute<any>(sql`
        INSERT INTO chits (chit_no, visit_id, patient_id, category, total_paisa, created_by)
        SELECT ${chitNo}, ${input.visitId}, v.patient_id, ${category}::service_category,
               (SELECT COALESCE(SUM(price_paisa), 0) FROM service_orders
                WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})),
               ${'Ordered during consultation'}
        FROM visits v WHERE v.id = ${input.visitId}
        RETURNING *`)).rows[0]
      await tx.execute(sql`
        UPDATE service_orders SET chit_id = ${chit.id}
        WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    }

    return {
      prescriptionId, items: input.items.length, services: input.services.length,
      chits: byCategory.size
    }
  })
}

export async function getPrescription(visitId: number) {
  const head = await db.execute<any>(sql`
    SELECT pr.*, v.visit_no, v.token_no, v.complaint, v.created_at AS visit_at,
           p.id AS patient_id, p.mrn, p.name AS patient_name, p.phone, p.gender,
           p.age_years, p.allergies,
           st.display_name AS doctor_name, doc.specialisation, doc.qualification
    FROM prescriptions pr
    JOIN visits v ON v.id = pr.visit_id
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors doc ON doc.id = pr.doctor_id
    JOIN staff st ON st.id = doc.staff_id
    WHERE pr.visit_id = ${visitId}`)
  const prescription = (head.rows as any[])[0]
  if (!prescription) return null

  const items = await db.execute<any>(sql`
    SELECT pi.*,
           pr.name AS catalogue_name, pr.unit_label, pr.sub_unit_label, pr.pack_size,
           COALESCE(st.qty, 0)::int AS in_stock
    FROM prescription_items pi
    LEFT JOIN products pr ON pr.id = pi.product_id
    LEFT JOIN LATERAL (
      SELECT SUM(b.qty_on_hand) AS qty FROM batches b
      WHERE b.product_id = pi.product_id AND b.qty_on_hand > 0 AND b.expiry_date > CURRENT_DATE
    ) st ON true
    WHERE pi.prescription_id = ${prescription.id} ORDER BY pi.id`)

  const services = await db.execute<any>(sql`
    SELECT so.* FROM service_orders so WHERE so.visit_id = ${visitId} ORDER BY so.id`)

  return { prescription, items: items.rows, services: services.rows }
}

/** Prescriptions waiting at the pharmacy counter. */
export async function pendingPrescriptions(q?: string) {
  const term = (q ?? '').trim()
  const digits = term.replace(/\D/g, '')
  return (await db.execute<any>(sql`
    SELECT v.id AS visit_id, v.visit_no, v.token_no, v.created_at, v.visit_type,
           p.mrn, p.name AS patient_name, p.phone,
           st.display_name AS doctor_name,
           pr.id AS prescription_id, pr.diagnosis,
           COUNT(pi.id)::int AS total_items,
           COUNT(pi.id) FILTER (WHERE pi.status = 'pending')::int AS pending_items,
           BOOL_OR(sa.id IS NOT NULL) AS has_sale
    FROM prescriptions pr
    JOIN visits v ON v.id = pr.visit_id
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors doc ON doc.id = pr.doctor_id
    JOIN staff st ON st.id = doc.staff_id
    JOIN prescription_items pi ON pi.prescription_id = pr.id
    LEFT JOIN sales sa ON sa.visit_id = v.id AND sa.status <> 'voided'
    WHERE (${term} = ''
        OR upper(p.mrn) = upper(${term})
        OR p.name ILIKE ${'%' + term + '%'}
        OR v.visit_no ILIKE ${'%' + term + '%'}
        OR (${digits} <> '' AND regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') LIKE ${'%' + digits + '%'}))
      ${term ? sql`` : sql`AND v.created_at >= date_trunc('day', now()) - interval '2 days'`}
    GROUP BY v.id, v.visit_no, v.token_no, v.created_at, v.visit_type, p.mrn, p.name, p.phone,
             st.display_name, pr.id, pr.diagnosis
    HAVING COUNT(pi.id) FILTER (WHERE pi.status = 'pending') > 0 OR ${term} <> ''
    ORDER BY (v.visit_type = 'emergency') DESC, v.created_at DESC LIMIT 50`)).rows
}

/* =============================================================== earnings */

/**
 * What a doctor has earned, and from what.
 *
 * Read from the ledger rather than recomputed from prices, so the figure a
 * doctor is paid against can be reconstructed line by line months later and
 * does not move when someone edits a price.
 */
export async function doctorEarnings(doctorId: number, from: string, to: string) {
  const totals = await db.execute<any>(sql`
    SELECT COALESCE(SUM(amount_paisa), 0)::bigint AS total_paisa,
           COALESCE(SUM(amount_paisa) FILTER (WHERE source = 'consultation'), 0)::bigint AS consultation_paisa,
           COALESCE(SUM(amount_paisa) FILTER (WHERE source = 'service'), 0)::bigint AS service_paisa,
           COUNT(*) FILTER (WHERE source = 'consultation')::int AS consultations,
           COUNT(*) FILTER (WHERE source = 'service')::int AS services,
           COALESCE(SUM(gross_paisa), 0)::bigint AS gross_paisa
    FROM doctor_earnings
    WHERE doctor_id = ${doctorId}
      AND earned_at >= ${from}::date AND earned_at < (${to}::date + interval '1 day')`)

  const lines = await db.execute<any>(sql`
    SELECT de.*, p.name AS patient_name, p.mrn, v.visit_no
    FROM doctor_earnings de
    LEFT JOIN visits v ON v.id = de.visit_id
    LEFT JOIN patients p ON p.id = v.patient_id
    WHERE de.doctor_id = ${doctorId}
      AND de.earned_at >= ${from}::date AND de.earned_at < (${to}::date + interval '1 day')
    ORDER BY de.earned_at DESC LIMIT 500`)

  const daily = await db.execute<any>(sql`
    SELECT g.d::date AS day,
           COALESCE(e.amount, 0)::bigint AS amount_paisa,
           COALESCE(e.n, 0)::int AS entries
    FROM generate_series(${from}::date, ${to}::date, '1 day') g(d)
    LEFT JOIN (
      SELECT date_trunc('day', earned_at)::date AS d,
             SUM(amount_paisa) AS amount, COUNT(*) AS n
      FROM doctor_earnings WHERE doctor_id = ${doctorId} GROUP BY 1
    ) e ON e.d = g.d
    ORDER BY g.d`)

  const byPatient = await earningsByPatient(doctorId, from, to)

  return { totals: (totals.rows as any[])[0], lines: lines.rows, daily: daily.rows, byPatient }
}

/**
 * The same earnings, one row per patient instead of one per transaction.
 *
 * A doctor checking their day wants to see "Hina Tariq, 500 consultation,
 * 1200 x-ray, 1700 total", not four separate ledger lines they have to add up
 * themselves. The ledger stays as it is underneath; this is a view over it.
 *
 * Columns are pivoted by department, so the shape stays fixed no matter which
 * services a hospital happens to have configured.
 */
export async function earningsByPatient(doctorId: number, from: string, to: string) {
  const r = await db.execute<any>(sql`
    SELECT p.id AS patient_id, p.mrn, p.name AS patient_name, p.phone,
           MIN(de.earned_at) AS first_at,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE de.source = 'consultation'), 0)::bigint
             AS consultation_paisa,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE s.category = 'radiology'), 0)::bigint
             AS radiology_paisa,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE s.category = 'lab'), 0)::bigint
             AS lab_paisa,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE s.category = 'procedure'), 0)::bigint
             AS procedure_paisa,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE s.category = 'other'), 0)::bigint
             AS other_paisa,
           COALESCE(SUM(de.amount_paisa), 0)::bigint AS total_paisa,
           COALESCE(SUM(de.gross_paisa), 0)::bigint  AS billed_paisa,
           COUNT(DISTINCT de.visit_id)::int          AS visits
    FROM doctor_earnings de
    JOIN visits v   ON v.id = de.visit_id
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN service_orders so ON so.id = de.ref_id AND de.ref_table = 'service_orders'
    LEFT JOIN services s        ON s.id = so.service_id
    WHERE de.doctor_id = ${doctorId}
      AND de.earned_at >= ${from}::date AND de.earned_at < (${to}::date + interval '1 day')
    GROUP BY p.id, p.mrn, p.name, p.phone
    ORDER BY MIN(de.earned_at) DESC
    LIMIT 500`)
  return r.rows
}

/** Admin view: every doctor's earnings over a period, highest first. */
export async function allDoctorEarnings(from: string, to: string) {
  return (await db.execute<any>(sql`
    SELECT d.id AS doctor_id, st.display_name AS doctor_name, doc_dept.name AS department,
           COALESCE(SUM(de.amount_paisa), 0)::bigint AS earned_paisa,
           COALESCE(SUM(de.gross_paisa), 0)::bigint  AS generated_paisa,
           COUNT(de.id) FILTER (WHERE de.source = 'consultation')::int AS consultations,
           COUNT(de.id) FILTER (WHERE de.source = 'service')::int AS services
    FROM doctors d
    JOIN staff st ON st.id = d.staff_id
    LEFT JOIN departments doc_dept ON doc_dept.id = st.department_id
    LEFT JOIN doctor_earnings de ON de.doctor_id = d.id
      AND de.earned_at >= ${from}::date AND de.earned_at < (${to}::date + interval '1 day')
    WHERE d.is_active
    GROUP BY d.id, st.display_name, doc_dept.name
    ORDER BY earned_paisa DESC`)).rows
}

/* =============================================================== services */

/**
 * The services list.
 *
 * Everyone except the administrator's own screen sees only what can actually
 * be ordered: active, and priced. The catalogue ships unpriced, and a test in
 * the doctor's picker that is refused the moment it is chosen is a trap — the
 * doctor learns to distrust the list. Until a price is set it simply is not
 * offered.
 *
 * The administrator's screen passes `all`, and sees everything, unpriced
 * tests included, because that is where the price gets set.
 */
export async function listServices(includeInactive = false) {
  return (await db.execute<any>(sql`
    SELECT sv.*, COUNT(so.id)::int AS times_ordered
    FROM services sv
    LEFT JOIN service_orders so ON so.service_id = sv.id
    WHERE ${includeInactive ? sql`true` : sql`sv.is_active AND sv.price_paisa > 0`}
    GROUP BY sv.id ORDER BY sv.category, sv.name`)).rows
}

export async function upsertService(input: {
  id?: number; code?: string | null; name: string
  category: 'lab' | 'radiology' | 'procedure' | 'other'
  pricePaisa: number; defaultShareBp: number; isActive?: boolean
}) {
  if (input.id) {
    const [row] = await db.update(s.services).set({
      code: input.code ?? null, name: input.name.trim(), category: input.category,
      pricePaisa: input.pricePaisa, defaultShareBp: input.defaultShareBp,
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {})
    }).where(eq(s.services.id, input.id)).returning()
    return row
  }
  const [row] = await db.insert(s.services).values({
    code: input.code ?? null, name: input.name.trim(), category: input.category,
    pricePaisa: input.pricePaisa, defaultShareBp: input.defaultShareBp
  }).returning()
  return row
}
