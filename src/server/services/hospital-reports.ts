import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import type { Window } from './pharma-reports'

/**
 * Reports for the rest of the hospital.
 *
 * The pharmacy already had its own set; these are the same idea applied to
 * the laboratory, the x-ray room and the main counter, so that every module
 * answers the questions its own staff actually ask at the end of a day.
 *
 * Everything is derived from the transaction rows. Nothing reads a
 * pre-computed daily total, so a chit corrected on Tuesday shows up correctly
 * in Monday's figures rather than leaving two numbers that disagree.
 *
 * Money is only ever counted where it was taken. A test ordered by a doctor
 * and paid at the main counter belongs to the counter's takings and to the
 * lab's workload — the same event, counted once in each report, measuring two
 * different things. Adding them together would double the day.
 */

const between = (col: string, w: Window) =>
  sql`${sql.raw(col)} >= ${w.from}::date AND ${sql.raw(col)} < (${w.to}::date + interval '1 day')`

/** Lab and x-ray both live in service_orders; category tells them apart. */
const CATEGORY = {
  lab: sql`sv.category = 'lab'`,
  radiology: sql`sv.category = 'radiology'`,
  both: sql`sv.category IN ('lab', 'radiology', 'procedure')`
}

/* ------------------------------------------------------------ laboratory */

/** Every test done in the period, with what it earned and who ran it. */
export async function labRegister(w: Window, cat: keyof typeof CATEGORY) {
  const r = await db.execute<any>(sql`
    SELECT lo.report_no, lo.collected_at, lo.resulted_at,
           lo.collected_by, lo.resulted_by, lo.verified_by, lo.status,
           so.service_name, so.price_paisa, so.status AS pay_status,
           sv.category,
           p.mrn, p.name AS patient_name, p.age_years, p.gender,
           COALESCE(st.display_name, 'Walk-in') AS doctor_name,
           v.visit_type
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    JOIN patients p ON p.id = lo.patient_id
    JOIN visits v ON v.id = lo.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${CATEGORY[cat]} AND ${between('lo.created_at', w)}
    ORDER BY lo.created_at DESC LIMIT 800`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    collected_at: x.collected_at
      ? new Date(x.collected_at).toLocaleString('en-GB',
          { day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit' })
      : '',
    resulted_at: x.resulted_at
      ? new Date(x.resulted_at).toLocaleString('en-GB',
          { day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit' })
      : ''
  }))
}

/**
 * Grouped the several ways a lab is asked about.
 *
 * `by` replaces what would otherwise be six near-identical report screens.
 */
export async function labBy(w: Window, cat: keyof typeof CATEGORY, by:
  'day' | 'month' | 'test' | 'technician' | 'doctor' | 'status') {

  const dimension = {
    day:        sql`to_char(lo.created_at, 'YYYY-MM-DD')`,
    month:      sql`to_char(lo.created_at, 'YYYY-MM')`,
    test:       sql`so.service_name`,
    // Who did the work, not who was on shift.
    technician: sql`COALESCE(NULLIF(lo.resulted_by, ''), NULLIF(lo.collected_by, ''), 'Not recorded')`,
    doctor:     sql`COALESCE(st.display_name, 'Walk-in / no doctor')`,
    status:     sql`lo.status`
  }[by]

  const r = await db.execute<any>(sql`
    SELECT ${dimension} AS label,
           COUNT(*)::int AS tests,
           COUNT(DISTINCT lo.patient_id)::int AS patients,
           COALESCE(SUM(so.price_paisa), 0)::bigint AS revenue_paisa,
           COUNT(*) FILTER (WHERE lo.status = 'resulted')::int AS reported,
           COUNT(*) FILTER (WHERE lo.verified_at IS NOT NULL)::int AS verified,
           COALESCE(ROUND(AVG(
             EXTRACT(EPOCH FROM (lo.resulted_at - lo.collected_at)) / 60
           ) FILTER (WHERE lo.resulted_at IS NOT NULL AND lo.collected_at IS NOT NULL)), 0)::int
             AS avg_minutes
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    JOIN visits v ON v.id = lo.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${CATEGORY[cat]} AND ${between('lo.created_at', w)}
    GROUP BY 1
    ORDER BY ${by === 'day' || by === 'month' ? sql`1` : sql`revenue_paisa DESC`}
    LIMIT 400`)
  return r.rows
}

export async function labSummary(w: Window, cat: keyof typeof CATEGORY) {
  const r = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS tests,
           COUNT(DISTINCT lo.patient_id)::int AS patients,
           COALESCE(SUM(so.price_paisa), 0)::bigint AS revenue_paisa,
           COUNT(*) FILTER (WHERE lo.status = 'resulted')::int AS reported,
           COUNT(*) FILTER (WHERE lo.status <> 'resulted')::int AS pending,
           COUNT(*) FILTER (WHERE lo.verified_at IS NOT NULL)::int AS verified,
           COALESCE(ROUND(AVG(
             EXTRACT(EPOCH FROM (lo.resulted_at - lo.collected_at)) / 60
           ) FILTER (WHERE lo.resulted_at IS NOT NULL)), 0)::int AS avg_minutes
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    WHERE ${CATEGORY[cat]} AND ${between('lo.created_at', w)}`)
  return (r.rows as any[])[0]
}

/**
 * Ordered and paid for, but never done.
 *
 * The report a lab in-charge should read every morning: money taken for work
 * the hospital still owes. It is the one lab figure that is genuinely a
 * problem rather than a statistic.
 */
export async function labOutstanding(w: Window, cat: keyof typeof CATEGORY) {
  const r = await db.execute<any>(sql`
    SELECT so.service_name, so.price_paisa, so.ordered_at,
           p.mrn, p.name AS patient_name, p.phone,
           COALESCE(lo.status, 'not started') AS stage,
           COALESCE(st.display_name, 'Walk-in') AS doctor_name,
           EXTRACT(DAY FROM (now() - so.ordered_at))::int AS days_waiting
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    JOIN visits v ON v.id = so.visit_id
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN lab_orders lo ON lo.service_order_id = so.id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${CATEGORY[cat]}
      AND so.status IN ('paid', 'completed')
      AND COALESCE(lo.status, 'pending') <> 'resulted'
      AND ${between('so.ordered_at', w)}
    ORDER BY so.ordered_at LIMIT 400`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    ordered_at: new Date(x.ordered_at).toLocaleDateString('en-GB',
      { day: '2-digit', month: 'short', year: '2-digit' })
  }))
}

/** How long work sits between each stage. */
export async function labTurnaround(w: Window, cat: keyof typeof CATEGORY) {
  const r = await db.execute<any>(sql`
    SELECT so.service_name AS label,
           COUNT(*)::int AS tests,
           COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (lo.collected_at - so.ordered_at)) / 60)), 0)::int
             AS to_sample_mins,
           COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (lo.resulted_at - lo.collected_at)) / 60)), 0)::int
             AS to_result_mins,
           COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (lo.resulted_at - so.ordered_at)) / 60)), 0)::int
             AS total_mins
    FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    JOIN services sv ON sv.id = so.service_id
    WHERE ${CATEGORY[cat]} AND lo.resulted_at IS NOT NULL AND ${between('lo.created_at', w)}
    GROUP BY 1 ORDER BY total_mins DESC LIMIT 200`)
  return r.rows
}

/** Which values came back outside their range, and how often. */
export async function labAbnormal(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT lv.name AS label,
           COUNT(*)::int AS measured,
           COUNT(*) FILTER (WHERE lv.flag = 'high')::int AS high,
           COUNT(*) FILTER (WHERE lv.flag = 'low')::int AS low,
           CASE WHEN COUNT(*) > 0
             THEN ROUND(100.0 * COUNT(*) FILTER (WHERE lv.flag IN ('high','low')) / COUNT(*), 1)
             ELSE 0 END AS abnormal_pct
    FROM lab_values lv
    JOIN lab_orders lo ON lo.id = lv.lab_order_id
    WHERE lv.flag IS NOT NULL AND ${between('lo.resulted_at', w)}
    GROUP BY 1 HAVING COUNT(*) FILTER (WHERE lv.flag IN ('high','low')) > 0
    ORDER BY abnormal_pct DESC, measured DESC LIMIT 200`)
  return r.rows
}

/* ---------------------------------------------------------- main counter */

export async function counterSummary(w: Window) {
  const bills = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS bills,
           COALESCE(SUM(total_paisa), 0)::bigint AS taken_paisa,
           COUNT(*) FILTER (WHERE kind = 'consultation')::int AS consultations,
           COUNT(*) FILTER (WHERE kind = 'chit')::int AS chits,
           COALESCE(SUM(total_paisa) FILTER (WHERE pay_method = 'cash'), 0)::bigint AS cash_paisa
    FROM counter_bills WHERE ${between('created_at', w)}`)).rows[0]

  const reg = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS registrations,
           COUNT(*) FILTER (WHERE visit_type = 'direct')::int AS direct_visits,
           COUNT(*) FILTER (WHERE visit_type = 'emergency')::int AS emergency_visits
    FROM visits WHERE ${between('created_at', w)}`)).rows[0]

  const owed = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(total_paisa), 0)::bigint AS unpaid_paisa,
           COUNT(*)::int AS unpaid_chits
    FROM chits WHERE status = 'ordered' AND ${between('created_at', w)}`)).rows[0]

  return { ...bills, ...reg, ...owed }
}

/**
 * The day's takings, sliced.
 *
 * "By cashier" is the one a hospital owner opens first, because it is the
 * number they reconcile against what is physically in the drawer.
 */
export async function counterBy(w: Window, by:
  'day' | 'month' | 'hour' | 'cashier' | 'method' | 'kind' | 'department' | 'doctor') {

  const dimension = {
    day:        sql`to_char(cb.created_at, 'YYYY-MM-DD')`,
    month:      sql`to_char(cb.created_at, 'YYYY-MM')`,
    hour:       sql`to_char(cb.created_at, 'HH24') || ':00'`,
    cashier:    sql`COALESCE(NULLIF(cb.cashier_name, ''), 'Not recorded')`,
    method:     sql`cb.pay_method`,
    kind:       sql`cb.kind`,
    department: sql`COALESCE(ch.category::text, 'Consultation')`,
    doctor:     sql`COALESCE(st.display_name, 'No doctor')`
  }[by]

  const r = await db.execute<any>(sql`
    SELECT ${dimension} AS label,
           COUNT(*)::int AS bills,
           COALESCE(SUM(cb.total_paisa), 0)::bigint AS taken_paisa,
           COALESCE(AVG(cb.total_paisa), 0)::bigint AS average_paisa,
           COUNT(*) FILTER (WHERE cb.pay_method = 'cash')::int AS cash_bills
    FROM counter_bills cb
    LEFT JOIN chits ch ON ch.id = cb.chit_id
    LEFT JOIN visits v ON v.id = cb.visit_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${between('cb.created_at', w)}
    GROUP BY 1
    ORDER BY ${by === 'day' || by === 'month' || by === 'hour' ? sql`1` : sql`taken_paisa DESC`}
    LIMIT 400`)
  return r.rows
}

/** Bill by bill, the counter's day book. */
export async function counterRegister(w: Window, q: Record<string, string>) {
  let where = sql`${between('cb.created_at', w)}`
  if (q.cashier) where = sql`${where} AND cb.cashier_name = ${q.cashier}`
  if (q.method && q.method !== 'all') where = sql`${where} AND cb.pay_method = ${q.method}`

  const r = await db.execute<any>(sql`
    SELECT cb.bill_no, cb.created_at, cb.kind, cb.pay_method, cb.cashier_name,
           cb.total_paisa, cb.tendered_paisa, cb.change_paisa,
           p.mrn, p.name AS patient_name,
           COALESCE(st.display_name, '—') AS doctor_name
    FROM counter_bills cb
    LEFT JOIN visits v ON v.id = cb.visit_id
    LEFT JOIN chits ch ON ch.id = cb.chit_id
    LEFT JOIN patients p ON p.id = COALESCE(v.patient_id, ch.patient_id)
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${where} ORDER BY cb.created_at DESC LIMIT 600`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    created_at: new Date(x.created_at).toLocaleString('en-GB',
      { day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit' })
  }))
}

/** Who registered, and where they went. */
export async function patientRegister(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT p.mrn, p.name AS patient_name, p.age_years, p.gender, p.phone,
           v.visit_no, v.token_no, v.status, v.visit_type,
           v.consultation_fee_paisa, v.fee_paid,
           COALESCE(st.display_name, '—') AS doctor_name,
           v.created_at
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE ${between('v.created_at', w)}
    ORDER BY v.created_at DESC LIMIT 600`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    created_at: new Date(x.created_at).toLocaleString('en-GB',
      { day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit' })
  }))
}

/** Chits raised but never settled. Work ordered that nobody paid for. */
export async function unpaidChits(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT ch.chit_no, ch.category::text AS department, ch.total_paisa, ch.created_at,
           ch.created_by, p.mrn, p.name AS patient_name, p.phone,
           EXTRACT(DAY FROM (now() - ch.created_at))::int AS days_old
    FROM chits ch
    JOIN patients p ON p.id = ch.patient_id
    WHERE ch.status = 'ordered' AND ${between('ch.created_at', w)}
    ORDER BY ch.created_at LIMIT 400`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    created_at: new Date(x.created_at).toLocaleDateString('en-GB',
      { day: '2-digit', month: 'short', year: '2-digit' })
  }))
}

/** What each doctor earned, and from what. */
export async function doctorEarnings(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT st.display_name AS label,
           COUNT(*) FILTER (WHERE de.source = 'consultation')::int AS consultations,
           COUNT(*) FILTER (WHERE de.source = 'service')::int AS services,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE de.source = 'consultation'), 0)::bigint
             AS consultation_paisa,
           COALESCE(SUM(de.amount_paisa) FILTER (WHERE de.source = 'service'), 0)::bigint
             AS service_paisa,
           COALESCE(SUM(de.amount_paisa), 0)::bigint AS total_paisa
    FROM doctor_earnings de
    JOIN doctors d ON d.id = de.doctor_id
    JOIN staff st ON st.id = d.staff_id
    WHERE ${between('de.earned_at', w)}
    GROUP BY 1 ORDER BY total_paisa DESC LIMIT 200`)
  return r.rows
}

/* ------------------------------------------------- the whole hospital */

/**
 * Everything taken, everywhere, in one table.
 *
 * The only report that adds the tills together, and it does so by naming each
 * one rather than presenting a single figure — an owner wants to see that the
 * counter took 40,000 and the pharmacy 25,000, not that "the hospital" took
 * 65,000 with no way to check it.
 */
export async function hospitalIncome(w: Window) {
  const r = await db.execute<any>(sql`
    SELECT 'Main counter' AS label,
           COUNT(*)::int AS bills,
           COALESCE(SUM(total_paisa), 0)::bigint AS taken_paisa
    FROM counter_bills WHERE ${between('created_at', w)}

    UNION ALL

    SELECT 'Pharmacy', COUNT(*)::int, COALESCE(SUM(total_paisa), 0)::bigint
    FROM sales
    WHERE status <> 'voided' AND cancelled_at IS NULL AND ${between('sold_at', w)}

    UNION ALL

    SELECT 'Pharmacy returns', COUNT(*)::int, -COALESCE(SUM(total_paisa), 0)::bigint
    FROM sale_returns WHERE ${between('returned_at', w)}

    ORDER BY taken_paisa DESC`)
  return r.rows
}

/** A day of the hospital on one line each. */
export async function hospitalDaily(w: Window) {
  const r = await db.execute<any>(sql`
    WITH days AS (
      SELECT generate_series(${w.from}::date, ${w.to}::date, interval '1 day')::date AS d
    )
    SELECT to_char(days.d, 'YYYY-MM-DD') AS label,
           COALESCE((SELECT COUNT(*)::int FROM visits v
                     WHERE v.created_at::date = days.d), 0) AS patients,
           COALESCE((SELECT SUM(cb.total_paisa)::bigint FROM counter_bills cb
                     WHERE cb.created_at::date = days.d), 0) AS counter_paisa,
           COALESCE((SELECT SUM(sa.total_paisa)::bigint FROM sales sa
                     WHERE sa.sold_at::date = days.d
                       AND sa.status <> 'voided' AND sa.cancelled_at IS NULL), 0)
             AS pharmacy_paisa,
           COALESCE((SELECT COUNT(*)::int FROM lab_orders lo
                     WHERE lo.created_at::date = days.d), 0) AS lab_tests
    FROM days ORDER BY days.d`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    total_paisa: Number(x.counter_paisa) + Number(x.pharmacy_paisa)
  }))
}
