import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Pharmacy bills issued to hospital departments, for the reports.
 *
 * Grouped on `sales.department_id` — the department the bill was issued to —
 * and never on the text of the customer name. A department renamed under
 * Administration keeps all its bills under the new name, and two departments
 * that happen to share a word do not swallow each other's.
 */

type Window = { from: string; to: string }

const fmt = (t: any) => new Date(t).toLocaleString('en-GB', {
  day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

function filters(w: Window, q: Record<string, string>) {
  let where = sql`sa.department_id IS NOT NULL AND sa.status <> 'voided' AND sa.cancelled_at IS NULL
                  AND sa.sold_at >= ${w.from}::date AND sa.sold_at < (${w.to}::date + interval '1 day')`
  const dept = Number(q.department ?? 0)
  if (dept > 0) where = sql`${where} AND sa.department_id = ${dept}`
  const search = (q.q ?? '').trim()
  if (search) where = sql`${where} AND sa.invoice_no ILIKE ${'%' + search + '%'}`
  return where
}

/**
 * One row per medicine line, grouped by department and then by bill, so the
 * printed copy reads department → each bill with its lines and total →
 * the department's total → the next department, with a grand total last.
 */
export async function departmentBillLines(w: Window, q: Record<string, string>) {
  const rows = (await db.execute<any>(sql`
    SELECT d.name AS department_name, d.id AS department_id,
           sa.id AS sale_id, sa.invoice_no, sa.sold_at, sa.total_paisa AS bill_total_paisa,
           sa.cashier, sa.customer_name,
           si.product_name, si.batch_no, si.display_qty AS qty, si.sold_as,
           si.unit_price_paisa, si.line_total_paisa
    FROM sales sa
    JOIN departments d ON d.id = sa.department_id
    JOIN sale_items si ON si.sale_id = sa.id
    WHERE ${filters(w, q)}
    ORDER BY d.name, sa.sold_at, sa.id, si.id
    LIMIT 5000`)).rows as any[]
  return rows.map((r) => ({
    ...r,
    sold_at: fmt(r.sold_at),
    /*
     * The bill heading inside each department: number, time, who issued it
     * and that it is charged to the department rather than paid.
     */
    bill_block: `${r.invoice_no}   ·   ${fmt(r.sold_at)}   ·   ${r.cashier ?? '—'}` +
      `   ·   Charged to department`,
    status: 'Charged to department'
  }))
}

/** One row per bill, for a shorter register. */
export async function departmentBillRegister(w: Window, q: Record<string, string>) {
  const rows = (await db.execute<any>(sql`
    SELECT d.name AS department_name, sa.invoice_no, sa.sold_at, sa.total_paisa,
           sa.cashier, sa.customer_name,
           (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = sa.id) AS lines
    FROM sales sa JOIN departments d ON d.id = sa.department_id
    WHERE ${filters(w, q)}
    ORDER BY d.name, sa.sold_at, sa.id
    LIMIT 2000`)).rows as any[]
  return rows.map((r) => ({ ...r, sold_at: fmt(r.sold_at), status: 'Charged to department' }))
}

export async function departmentBillStats(w: Window, q: Record<string, string>) {
  const r = ((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS dept_bills,
           COALESCE(SUM(sa.total_paisa), 0)::bigint AS dept_paisa,
           COUNT(DISTINCT sa.department_id)::int AS departments
    FROM sales sa WHERE ${filters(w, q)}`)).rows as any[])[0]
  const per = (await db.execute<any>(sql`
    SELECT d.name, COUNT(*)::int AS bills, SUM(sa.total_paisa)::bigint AS paisa
    FROM sales sa JOIN departments d ON d.id = sa.department_id
    WHERE ${filters(w, q)} GROUP BY d.name ORDER BY d.name`)).rows as any[]
  return {
    ...r,
    // Printed under the grand total on the PDF.
    notes: per.map((p) =>
      `${p.name}: ${p.bills} bill${p.bills === 1 ? '' : 's'}, Rs ${(Number(p.paisa) / 100).toFixed(2)}`)
  }
}

export async function departmentChoices() {
  const r = await db.execute<any>(sql`
    SELECT id, name FROM departments WHERE is_active ORDER BY name`)
  return (r.rows as any[]).map((d) => ({ value: String(d.id), label: d.name }))
}
