/**
 * Credit bills, department bills, the expired badge and the lab's booked time.
 *
 * An HTTP suite like verify-billing: it signs in with the demo accounts and
 * CREATES BILLS through the API, so it assumes a seeded test database and a
 * running server. It also reads the database directly (DATABASE_URL) to check
 * the server's figures against the rows, so point both at the same throwaway
 * database — never a real one.
 *
 * What is held to account here:
 *
 *   1. A credit bill takes nothing at the counter, whatever the till sends,
 *      and is not counted as collected on the day it is made.
 *   2. Taking the money: needs payment.receive; a part payment leaves the bill
 *      part paid; the same confirmation sent twice is refused; more than is
 *      owed is refused; and the bill's money is counted as collected exactly
 *      once, on the day it arrives.
 *   3. A department bill uses a real department, takes the stock off once
 *      even when the request is sent twice, and is never counted as
 *      collected.
 *   4. The expired badge counts batches past expiry that still hold stock.
 *   5. A lab test's booked time is its counter bill's created_at.
 */
import pg from 'pg'
import { existsSync, readFileSync } from 'node:fs'

const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
/* A real environment variable wins over .env, the same rule as the server. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  if (!existsSync('.env')) return undefined
  const line = readFileSync('.env', 'utf8').split(/\r?\n/)
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l))
  return line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
}
const db = new pg.Pool({ connectionString: databaseUrl() })

let pass = 0, fail = 0
const ok = (n, c, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}
const one = async (q, p = []) => (await db.query(q, p)).rows[0]

async function login(u, p) {
  const r = await fetch(B + '/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
  return (await r.json()).token
}
function as(token) {
  return async (path, body, method) => {
    const r = await fetch(B + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
}
const key = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const admin = as(await login('admin', 'admin-demo-1'))
const counter = as(await login('pharmacy', '1234'))

/* A medicine with enough stock that is in date. */
const stock = await one(`
  SELECT p.id, p.name, p.pack_size, SUM(b.qty_on_hand)::int AS on_hand
  FROM products p JOIN batches b ON b.product_id = p.id
  WHERE p.is_active AND b.qty_on_hand > 0 AND b.expiry_date > CURRENT_DATE + 1
    AND p.schedule <> 'controlled'
  GROUP BY p.id HAVING SUM(b.qty_on_hand) >= 30 ORDER BY p.id LIMIT 1`)
ok('a medicine in stock to test with', !!stock)
const line = { productId: stock.id, qty: 2, soldAs: 'unit' }
const sellable = async () => Number((await one(`
  SELECT COALESCE(SUM(qty_on_hand),0)::int AS n FROM batches
  WHERE product_id = $1 AND qty_on_hand > 0 AND expiry_date > CURRENT_DATE`, [stock.id])).n)

/* ------------------------------------------------------- credit bill */
console.log('\n— a credit bill takes nothing at the counter —')

const totalsBefore = (await admin('/pharmacy/sales?mode=today')).body.totals
/* Sent the way the old till sent it: the full total as "paid". */
const sold = await counter('/pharmacy/sales', {
  lines: [{ ...line, soldAs: 'unit', qty: 3 }], payMethod: 'credit', paidPaisa: 999999,
  customerName: 'Verify Credit Customer', requestKey: key()
})
ok('credit sale accepted', sold.status === 201, JSON.stringify(sold.body))
const sale = sold.body.sale
ok('nothing recorded as paid on a credit bill', Number(sale.paidPaisa) === 0, sale.paidPaisa)
const row = await one(`SELECT sale_kind, pay_method FROM sales WHERE id = $1`, [sale.id])
ok('marked as a credit bill', row.sale_kind === 'credit' && row.pay_method === 'credit')

const totalsAfter = (await admin('/pharmacy/sales?mode=today')).body.totals
ok('not counted as collected when billed',
  Number(totalsAfter.collected_paisa) === Number(totalsBefore.collected_paisa),
  `${totalsBefore.collected_paisa} -> ${totalsAfter.collected_paisa}`)
ok('counted as billed on credit',
  Number(totalsAfter.credit_paisa) - Number(totalsBefore.credit_paisa) === Number(sale.totalPaisa))

const listed = (await counter('/pharmacy/credit-bills?status=open&q=' + sale.invoiceNo)).body
const mine = listed.rows.find((r) => r.id === sale.id)
ok('on the Credit Bills tab as outstanding',
  mine && mine.credit_status === 'outstanding' && Number(mine.outstanding_paisa) === Number(sale.totalPaisa))

/* ------------------------------------------------------ taking money */
console.log('\n— receiving payment —')
const total = Number(sale.totalPaisa)
const half = Math.floor(total / 2)

const refused = await counter(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: half, expectedOutstandingPaisa: total })
ok('a counter assistant without payment.receive is refused', refused.status === 403, refused.status)

const p1 = await admin(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: half, expectedOutstandingPaisa: total, method: 'cash' })
ok('part payment recorded', p1.status === 201 && p1.body.status === 'partial', JSON.stringify(p1.body))
ok('balance left is the rest', p1.body.outstandingPaisa === total - half)

const again = await admin(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: half, expectedOutstandingPaisa: total, method: 'cash' })
ok('the same confirmation sent twice is refused', again.status === 409 && again.body.code === 'STALE',
  JSON.stringify(again.body))

const tooMuch = await admin(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: total, expectedOutstandingPaisa: total - half })
ok('more than is owed is refused', tooMuch.status === 409 && tooMuch.body.code === 'TOO_MUCH')

const p2 = await admin(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: total - half, expectedOutstandingPaisa: total - half, method: 'easypaisa' })
ok('the rest settles it', p2.status === 201 && p2.body.status === 'settled', JSON.stringify(p2.body))

const p3 = await admin(`/pharmacy/credit-bills/${sale.id}/receive`,
  { amountPaisa: 1, expectedOutstandingPaisa: 0 })
ok('a settled bill takes nothing more', p3.status === 409 && p3.body.code === 'ALREADY_SETTLED')

const pays = (await db.query(`SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY id`, [sale.id])).rows
ok('exactly two payment rows', pays.length === 2, pays.length)
ok('who received it is the signed-in admin',
  pays.every((p) => p.received_by_staff_id && p.received_by), JSON.stringify(pays.map((p) => p.received_by)))

const totalsPaid = (await admin('/pharmacy/sales?mode=today')).body.totals
ok('collected rises by the bill total exactly once',
  Number(totalsPaid.collected_paisa) - Number(totalsAfter.collected_paisa) === total,
  `${totalsAfter.collected_paisa} -> ${totalsPaid.collected_paisa} (bill ${total})`)

const report = (await admin(`/reports/run/credit-bills?q=${sale.invoiceNo}`)).body
const rr = report.rows?.find((r) => r.id === sale.id)
ok('credit report shows it settled with who received it',
  rr && rr.credit_status === 'settled' && rr.last_received_by && Number(rr.outstanding_paisa) === 0,
  JSON.stringify(rr))

/* -------------------------------------------------- department bills */
console.log('\n— interdepartmental billing —')
const depts = (await counter('/pharmacy/departments')).body
const dbDepts = await one(`SELECT COUNT(*)::int AS n FROM departments WHERE is_active`)
ok('department cards are the hospital\'s own departments', depts.length === dbDepts.n,
  `${depts.length} vs ${dbDepts.n}`)
const dept = depts.find((d) => /emerg/i.test(d.name)) ?? depts[0]

const deptsBefore = await one(`SELECT md5(string_agg(id||name||code||is_active, ',' ORDER BY id)) h FROM departments`)
const shelfBefore = await sellable()
const k = key()
const d1 = await counter('/pharmacy/department-sales',
  { departmentId: dept.id, requestKey: k, lines: [line], receivedBy: 'Verify' })
const d2 = await counter('/pharmacy/department-sales',
  { departmentId: dept.id, requestKey: k, lines: [line], receivedBy: 'Verify' })
ok('department bill made', d1.status === 201, JSON.stringify(d1.body))
ok('sent twice, the same bill comes back', d2.body?.sale?.id === d1.body?.sale?.id && d2.body.duplicate === true)
const shelfAfter = await sellable()
ok('stock taken off once', shelfBefore - shelfAfter === 2, `${shelfBefore} -> ${shelfAfter}`)
const drow = await one(`SELECT department_id, sale_kind, paid_paisa FROM sales WHERE id = $1`, [d1.body.sale.id])
ok('linked to the department by its id', drow.department_id === dept.id && drow.sale_kind === 'department')
ok('nothing taken at the counter', Number(drow.paid_paisa) === 0)
const deptsAfter = await one(`SELECT md5(string_agg(id||name||code||is_active, ',' ORDER BY id)) h FROM departments`)
ok('departments untouched', deptsBefore.h === deptsAfter.h)

const credit = (await counter('/pharmacy/credit-bills?status=all&q=' + d1.body.sale.invoiceNo)).body
ok('not listed as a credit bill', !credit.rows.some((r) => r.id === d1.body.sale.id))

const bad = await counter('/pharmacy/department-sales',
  { departmentId: 999999, requestKey: key(), lines: [line] })
ok('an unknown department is refused', bad.status === 404, bad.status)
const huge = await counter('/pharmacy/department-sales',
  { departmentId: dept.id, requestKey: key(), lines: [{ ...line, qty: 99999 }] })
ok('more than the shelf holds is refused', huge.status === 409, `${huge.status} ${JSON.stringify(huge.body)}`)
ok('a refused bill takes no stock', (await sellable()) === shelfAfter)

const dr = (await admin(`/reports/run/department-bills?department=${dept.id}&q=${d1.body.sale.invoiceNo}`)).body
ok('department report lists the bill under its department',
  dr.rows?.length > 0 && dr.rows.every((r) => r.department_name === dept.name && r.invoice_no === d1.body.sale.invoiceNo),
  JSON.stringify(dr.rows?.[0]))
ok('report carries its grouping', dr.groupBy === 'department_name' && dr.subGroupBy === 'bill_block')

/* ----------------------------------------------------------- expiry */
console.log('\n— the expired badge —')
const badge = (await counter('/pharmacy/expired-count')).body
const truth = await one(`
  SELECT COUNT(*)::int AS batches, COUNT(DISTINCT product_id)::int AS medicines
  FROM batches WHERE qty_on_hand > 0 AND expiry_date < CURRENT_DATE`)
ok('counts expired batches still holding stock', badge.batches === truth.batches,
  `${badge.batches} vs ${truth.batches}`)

/* ------------------------------------------------------- booked time */
console.log('\n— lab booked time —')
const q = (await as(await login('lab', '1234'))('/lab/queue?status=all')).body
const withBooked = q.filter((r) => r.booked_at)
ok('lab rows carry a booked time', withBooked.length > 0, `${withBooked.length} of ${q.length}`)
let right = 0
for (const r of withBooked.slice(0, 40)) {
  const b = await one(`
    SELECT MIN(cb.created_at) AS at FROM counter_bill_items cbi JOIN counter_bills cb ON cb.id = cbi.bill_id
    WHERE cbi.ref_type = 'service_order' AND cbi.ref_id = $1`, [r.service_order_id])
  const c = b?.at ? null : await one(`
    SELECT MIN(cb.created_at) AS at FROM counter_bills cb JOIN service_orders so ON so.chit_id = cb.chit_id
    WHERE so.id = $1`, [r.service_order_id])
  const at = b?.at ?? c?.at
  if (at && new Date(at).getTime() === new Date(r.booked_at).getTime()) right++
}
ok('booked time is the counter bill\'s created_at', right === Math.min(40, withBooked.length),
  `${right} of ${Math.min(40, withBooked.length)}`)
const unbilled = await one(`
  SELECT so.id FROM service_orders so JOIN services sv ON sv.id = so.service_id
  WHERE sv.category IN ('lab','radiology') AND so.status <> 'cancelled'
    AND NOT EXISTS (SELECT 1 FROM counter_bill_items cbi WHERE cbi.ref_type='service_order' AND cbi.ref_id=so.id)
    AND NOT EXISTS (SELECT 1 FROM counter_bills cb WHERE so.chit_id IS NOT NULL AND cb.chit_id = so.chit_id)
  LIMIT 1`)
if (unbilled) {
  const r = q.find((x) => x.service_order_id === unbilled.id)
  ok('a test with no bill has no booked time', !r || r.booked_at == null)
}

await db.end()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
