import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { paidAtSale } from './credit-bills'
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
           cb.subtotal_paisa,
           /*
            * Blank rather than 0.00 on a bill with no discount, so the
            * column can be read down for the ones that had one. A column of
            * zeroes reads as real figures and hides the row that matters.
            */
           NULLIF(cb.discount_paisa, 0) AS discount_paisa,
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
export async function doctorEarnings(w: Window, q?: Record<string, string>) {
  const only = Number(q?.doctor) || 0
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
      ${only ? sql`AND d.id = ${only}` : sql``}
    GROUP BY 1 ORDER BY total_paisa DESC LIMIT 200`)
  return r.rows
}

/**
 * The doctors a hospital has, for the dropdown on the earnings reports.
 *
 * Everyone who has ever earned, not just the active list: a report for last
 * March has to be able to name a doctor who left in June, or the figures are
 * there and nobody can select them.
 */
export async function doctorChoices() {
  const r = await db.execute<any>(sql`
    SELECT d.id::text AS value, st.display_name AS label
    FROM doctors d JOIN staff st ON st.id = d.staff_id
    ORDER BY st.display_name`)
  return r.rows as { value: string; label: string }[]
}

/**
 * The cashiers who have actually taken money in, for the register's filter.
 *
 * Read off the BILLS, not off the staff list. The counter register matches on
 * `cashier_name`, which is the name copied onto the bill at the time — so a
 * cashier who has since left, or whose display name has been corrected
 * since, still has to appear or their bills become unreachable. Offering the
 * current staff list instead would show names that match nothing and hide
 * names that do.
 *
 * Distinct over the whole table rather than the window on screen: a filter
 * whose options change as you move the dates is a filter that forgets what
 * you picked.
 */
export async function cashierChoices() {
  const r = await db.execute<any>(sql`
    SELECT DISTINCT cashier_name AS value, cashier_name AS label
    FROM counter_bills
    WHERE cashier_name IS NOT NULL AND cashier_name <> ''
    ORDER BY cashier_name`)
  return r.rows as { value: string; label: string }[]
}

/**
 * How a bill was paid.
 *
 * A fixed list, because these are the values the column is allowed to hold
 * and a hospital that has never taken a card payment should still be able to
 * ask for them — a list read from the data would offer only what has already
 * happened, so the one method somebody is checking for would be the one
 * missing from the dropdown.
 *
 * Labelled rather than printed raw: "easypaisa" is the value in the column
 * and "EasyPaisa" is the name of the thing.
 */
export async function payMethodChoices() {
  return [
    { value: 'cash', label: 'Cash' },
    { value: 'card', label: 'Card' },
    { value: 'easypaisa', label: 'EasyPaisa' },
    { value: 'jazzcash', label: 'JazzCash' },
    { value: 'credit', label: 'Credit' }
  ]
}

/**
 * Every line behind a doctor's total.
 *
 * The summary answers "what did Dr Yasir earn"; this answers the question
 * that always follows, which is "from whom, and for what". One row per
 * earning: the patient, what was done, what it was billed at, the share
 * agreed, and what that came to.
 *
 * THE SHARE IS THE ONE THAT WAS AGREED AT THE TIME, read off the earning
 * rather than off the doctor's current percentage. A hospital that renegotiates
 * a doctor's cut in July must not find that June's statements have quietly
 * changed.
 *
 * Grouped by doctor when no particular one is chosen, so a bundle of
 * statements can be printed in one go on the first of the month.
 */
export async function doctorEarningDetail(w: Window, q?: Record<string, string>) {
  const only = Number(q?.doctor) || 0
  const r = await db.execute<any>(sql`
    SELECT st.display_name AS doctor,
           to_char(de.earned_at, 'DD Mon YY HH24:MI') AS when,
           p.name AS patient_name,
           p.mrn,
           CASE de.source WHEN 'consultation' THEN 'Consultation' ELSE 'Test or procedure' END
             AS kind,
           de.description,
           de.gross_paisa,
           (de.share_bp / 100.0) AS share_pct,
           de.amount_paisa
    FROM doctor_earnings de
    JOIN doctors d ON d.id = de.doctor_id
    JOIN staff st ON st.id = d.staff_id
    LEFT JOIN visits v ON v.id = de.visit_id
    LEFT JOIN patients p ON p.id = v.patient_id
    WHERE ${between('de.earned_at', w)}
      ${only ? sql`AND d.id = ${only}` : sql``}
    ORDER BY st.display_name, de.earned_at DESC, de.id DESC
    LIMIT 5000`)

  return (r.rows as any[]).map((x) => ({
    ...x,
    /* A visit that has been cleared leaves the earning with no patient on
     * it. Saying so beats an empty cell somebody reads as a bug. */
    patient_name: x.patient_name ?? '(patient removed)',
    mrn: x.mrn ?? '',
    share_pct: Number(x.share_pct).toFixed(1)
  }))
}

/** The figures above a doctor's statement. */
export async function doctorEarningSummary(w: Window, q?: Record<string, string>) {
  const only = Number(q?.doctor) || 0
  const r = ((await db.execute<any>(sql`
    SELECT COUNT(DISTINCT de.doctor_id)::int AS doctors,
           COUNT(DISTINCT v.patient_id)::int  AS patients,
           COALESCE(SUM(de.gross_paisa), 0)::bigint  AS billed,
           COALESCE(SUM(de.amount_paisa), 0)::bigint AS earned
    FROM doctor_earnings de
    LEFT JOIN visits v ON v.id = de.visit_id
    WHERE ${between('de.earned_at', w)}
      ${only ? sql`AND de.doctor_id = ${only}` : sql``}`)).rows as any[])[0]

  const money = (p: any) => (Number(p) / 100).toLocaleString('en-PK',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const billed = Number(r.billed), earned = Number(r.earned)

  return {
    notes: [
      `Patients seen         ${r.patients}`,
      `Billed to patients    Rs ${money(billed)}`,
      `Doctor's share        Rs ${money(earned)}`,
      `Kept by the hospital  Rs ${money(billed - earned)}`
    ]
  }
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

    /*
     * Money taken, so only bills paid at the counter. A credit bill brings
     * in nothing the day it is written and a bill to a department brings in
     * nothing at all; what a credit customer pays later is its own line, on
     * the day it was received, so it is counted once.
     */
    SELECT 'Pharmacy', COUNT(*)::int, COALESCE(SUM(total_paisa), 0)::bigint
    FROM sales sa
    WHERE status <> 'voided' AND cancelled_at IS NULL AND ${between('sold_at', w)}
      AND ${paidAtSale('sa')}

    UNION ALL

    SELECT 'Pharmacy credit received', COUNT(*)::int, COALESCE(SUM(amount_paisa), 0)::bigint
    FROM sale_payments WHERE ${between('received_at', w)}

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
                       AND sa.status <> 'voided' AND sa.cancelled_at IS NULL
                       AND ${paidAtSale('sa')}), 0)
           + COALESCE((SELECT SUM(sp.amount_paisa)::bigint FROM sale_payments sp
                     WHERE sp.received_at::date = days.d), 0)
             AS pharmacy_paisa,
           COALESCE((SELECT COUNT(*)::int FROM lab_orders lo
                     WHERE lo.created_at::date = days.d), 0) AS lab_tests
    FROM days ORDER BY days.d`)
  return (r.rows as any[]).map((x) => ({
    ...x,
    total_paisa: Number(x.counter_paisa) + Number(x.pharmacy_paisa)
  }))
}

/* ------------------------------------------------------ goods received */

/**
 * Every delivery, item by item, grouped under its own invoice.
 *
 * Not one row per delivery. The report a store keeper checks against the
 * paper invoice has to show what actually arrived — each medicine, its pack,
 * its rate, the quantity and any bonus — then that invoice's total, then the
 * next invoice, and a grand total at the end. A single summary line per
 * delivery is useless for the job it is used for, which is finding the line
 * where the supplier and the system disagree.
 *
 * The renderer groups on `group_key`, so the rows arrive flat and come out
 * blocked by invoice with a subtotal under each.
 */
export async function goodsReceivedDetail(w: Window, q: Record<string, string>) {
  let where = sql`${between('p.invoice_date', w)}`
  if (q.supplier) where = sql`${where} AND p.supplier_id = ${Number(q.supplier)}`
  if (q.grnFrom) where = sql`${where} AND p.grn_no >= ${q.grnFrom}`
  if (q.grnTo) where = sql`${where} AND p.grn_no <= ${q.grnTo}`

  const r = await db.execute<any>(sql`
    SELECT
      -- What each block is headed with.
      s.name || '   ·   GRN ' || COALESCE(p.grn_no, '—') ||
        '   ·   Invoice ' || COALESCE(p.supplier_invoice_no, '—') ||
        '   ·   ' || to_char(p.invoice_date, 'DD/MM/YYYY') AS group_key,
      pr.name AS product_name,
      COALESCE(pr.pack_label, '1x' || pr.pack_size::text) AS packing,
      b.batch_no,
      COALESCE(b.expiry_date::text, '') AS expiry,
      pi.unit_cost_paisa AS rate_paisa,
      pi.qty, COALESCE(pi.bonus_qty, 0) AS bonus,
      (pi.qty * pi.unit_cost_paisa)::bigint AS line_total_paisa
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN batches b ON b.id = pi.batch_id
    JOIN products pr ON pr.id = b.product_id
    WHERE ${where}
    ORDER BY p.invoice_date, p.id, pr.name
    LIMIT 2000`)
  return r.rows
}

/** One line per delivery, for when the detail is not what is wanted. */
export async function goodsReceivedSummary(w: Window, q: Record<string, string>) {
  let where = sql`${between('p.invoice_date', w)}`
  if (q.supplier) where = sql`${where} AND p.supplier_id = ${Number(q.supplier)}`
  if (q.grnFrom) where = sql`${where} AND p.grn_no >= ${q.grnFrom}`
  if (q.grnTo) where = sql`${where} AND p.grn_no <= ${q.grnTo}`

  const r = await db.execute<any>(sql`
    SELECT COALESCE(p.grn_no, '—') AS grn_no,
           to_char(p.invoice_date, 'DD/MM/YYYY') AS received_on,
           s.name AS supplier_name,
           COALESCE(p.supplier_invoice_no, '—') AS supplier_invoice_no,
           (SELECT COUNT(*)::int FROM purchase_items pi WHERE pi.purchase_id = p.id) AS lines,
           COALESCE((SELECT SUM(pi.qty)::int FROM purchase_items pi
                     WHERE pi.purchase_id = p.id), 0) AS packs,
           COALESCE((SELECT SUM(pi.bonus_qty)::int FROM purchase_items pi
                     WHERE pi.purchase_id = p.id), 0) AS bonus,
           p.total_paisa, p.discount_paisa, p.received_by,
           /*
            * When it was actually keyed in, as against the invoice date.
            *
            * These are routinely different: a delivery dated Tuesday gets
            * booked on Thursday. The invoice date is the supplier's claim and
            * the only one the report showed; this is ours, and it is the one
            * that matters when somebody asks who entered a figure and when.
            */
           to_char(p.created_at, 'DD/MM/YY HH24:MI') AS booked_at,
           COALESCE(po.order_no, '-') AS order_no
    FROM purchases p
    JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN purchase_orders po ON po.id = p.purchase_order_id
    WHERE ${where}
    ORDER BY p.invoice_date DESC, p.id DESC LIMIT 600`)
  return r.rows
}

/* ------------------------------------------- departments, at a glance */

/**
 * One line per department: how many patients, and how much was taken.
 *
 * The question a hospital owner asks first, and the one the old system could
 * only answer by adding up three separate printouts. Patients are counted
 * distinctly, so a patient who had a consultation and two tests in the same
 * department counts once — otherwise the busiest department is simply the one
 * that orders the most tests.
 */
export async function salesByDepartment(w: Window) {
  const r = await db.execute<any>(sql`
    WITH work AS (
      /* Consultations sit on the visit; tests and scans sit on the order. */
      SELECT d.name                          AS department,
             v.patient_id,
             cb.total_paisa,
             cb.discount_paisa
      FROM counter_bills cb
      JOIN visits v       ON v.id = cb.visit_id
      LEFT JOIN departments d ON d.id = v.department_id
      /*
       * A counter bill has no status. The row is written when the money is
       * taken, so its existence is the payment — there is no unpaid one to
       * filter out.
       */
      WHERE ${between('cb.created_at', w)}

      UNION ALL

      -- sv.category is an enum, so it is cast to text before a default can
      -- be supplied: COALESCE on the enum itself is rejected outright.
      -- The service's own department when one is set, otherwise its broad
      -- category. The fallback is what lets this report work on a hospital
      -- that has not filled the new field in yet.
      SELECT COALESCE(sd.name, sc.name, INITCAP(sv.category::text), 'Other') AS department,
             ch.patient_id,
             ch.total_paisa,
             0 AS discount_paisa
      FROM chits ch
      JOIN service_orders so ON so.chit_id = ch.id
      JOIN services sv       ON sv.id = so.service_id
      -- Grouped the way Patients by Department and the token queue are:
      -- the category's department when mapped, otherwise the service's.
      LEFT JOIN service_categories sc ON sc.id = sv.category_id
      LEFT JOIN departments sd ON sd.id = COALESCE(sc.department_id, sv.department_id)
      WHERE ${between('ch.created_at', w)}
        AND ch.status = 'paid'
    )
    SELECT COALESCE(department, 'Unassigned')        AS department,
           COUNT(DISTINCT patient_id)::int           AS patients,
           COALESCE(SUM(total_paisa), 0)::bigint     AS received_paisa
    FROM work
    GROUP BY 1
    ORDER BY received_paisa DESC, department`)
  return r.rows
}

/**
 * Every patient seen, grouped by department.
 *
 * One row per piece of work rather than per patient, because that is what a
 * head of department checks against: the name, who saw them, what was done
 * and what was taken for it. The table breaks by department, which is what
 * `groupBy` on the report definition does with it.
 */
export async function patientsByDepartment(w: Window, q: Record<string, string> = {}) {
  /*
   * One department, by its id, when the screen's filter names one. Matched
   * on the same department each row is grouped under — the visit's for a
   * consultation, the service's (through its category's mapping) for a test
   * — never on the name, so a renamed department still filters correctly.
   * Empty means every department, which is the report as it always was.
   */
  const deptId = Number(q.department ?? 0)
  const onlyVisit = deptId > 0 ? sql`AND v.department_id = ${deptId}` : sql``
  const onlyService = deptId > 0
    ? sql`AND COALESCE(sc.department_id, sv.department_id) = ${deptId}` : sql``

  const r = await db.execute<any>(sql`
    SELECT COALESCE(d.name, 'Unassigned')            AS department,
           COALESCE(st.display_name, '—')            AS doctor_name,
           p.name                                    AS patient_name,
           'Consultation'                            AS procedure_name,
           p.mrn,
           cb.total_paisa                            AS received_paisa,
           cb.discount_paisa,
           cb.created_at
    FROM counter_bills cb
    JOIN visits v        ON v.id = cb.visit_id
    JOIN patients p      ON p.id = v.patient_id
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN doctors doc   ON doc.id = v.doctor_id
    LEFT JOIN staff st      ON st.id = doc.staff_id
    WHERE ${between('cb.created_at', w)}
      ${onlyVisit}

    UNION ALL

    /*
     * Tests and scans name the test in the procedure column, as asked: on a
     * laboratory sheet "Consultation" against every line would tell a
     * pathologist nothing.
     */
    SELECT COALESCE(sd.name, sc.name, INITCAP(sv.category::text), 'Other') AS department,
           COALESCE(st.display_name, '—')            AS doctor_name,
           p.name                                    AS patient_name,
           so.service_name                           AS procedure_name,
           p.mrn,
           so.price_paisa                            AS received_paisa,
           0                                         AS discount_paisa,
           ch.created_at
    FROM service_orders so
    JOIN chits ch        ON ch.id = so.chit_id
    JOIN patients p      ON p.id = ch.patient_id
    JOIN services sv     ON sv.id = so.service_id
    -- The category's department when it is mapped to one, as the token
    -- queue uses; otherwise the service's own.
    LEFT JOIN service_categories sc ON sc.id = sv.category_id
    LEFT JOIN departments sd ON sd.id = COALESCE(sc.department_id, sv.department_id)
    LEFT JOIN visits v   ON v.id = ch.visit_id
    LEFT JOIN doctors doc ON doc.id = v.doctor_id
    LEFT JOIN staff st    ON st.id = doc.staff_id
    WHERE ${between('ch.created_at', w)}
      AND ch.status = 'paid'
      ${onlyService}

    ORDER BY 1, created_at`)

  // Numbered within each department, so a printed sheet can be read out.
  let dept = ''
  let n = 0
  return (r.rows as any[]).map((row) => {
    if (row.department !== dept) { dept = row.department; n = 0 }
    return { ...row, no: ++n }
  })
}
