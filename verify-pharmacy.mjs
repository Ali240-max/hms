/**
 * Pharmacy module checks, over a real socket against a running server.
 *
 *   npm run dev:server        (in one terminal)
 *   node verify-pharmacy.mjs  (in another)
 *
 * Needs demo data loaded. Creates a test product and supplier as it goes.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
let token = ''
async function q(path, opts = {}) {
  const r = await fetch(B + path, {
    ...opts, headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {})
    }
  })
  const t = await r.text()
  let b; try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('\n— pharmacist signs in —')
let r = await q('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'pharmacy', password: '1234' }) })
token = r.body.token
ok('login', r.status === 200 && r.body.user.role === 'pharmacist', JSON.stringify(r.body).slice(0,120))

console.log('\n— catalogue and stock —')
r = await q('/pharmacy/inventory')
const inv = r.body
ok('inventory lists medicines', Array.isArray(inv) && inv.length > 0, `${inv?.length}`)
ok('stock quantities present', inv.some(p => p.in_stock > 0))
r = await q('/pharmacy/inventory/summary')
ok('summary has stock value', Number(r.body.total_value_paisa) > 0, JSON.stringify(r.body))
r = await q('/pharmacy/inventory/filters')
ok('company + supplier filters', r.body.manufacturers.length > 0 && r.body.suppliers.length > 0)
r = await q('/pharmacy/inventory?filter=low')
ok('low-stock filter runs', r.status === 200)
r = await q('/pharmacy/inventory?filter=expiring')
ok('expiring filter runs', r.status === 200)

console.log('\n— register a medicine —')
r = await q('/pharmacy/products', { method: 'POST', body: JSON.stringify({
  name: 'Verify Syrup 120ml', manufacturer: 'Test Labs', unitLabel: 'bottle',
  subUnitLabel: 'ml', packSize: 1, schedule: 'otc', reorderLevel: 5 }) })
ok('creates a product', r.status === 201, JSON.stringify(r.body).slice(0,120))
const newProduct = r.body.id

console.log('\n— suppliers —')
r = await q('/pharmacy/suppliers', { method: 'POST', body: JSON.stringify({ name: 'Verify Distributors', phone: '0300 1111111' }) })
ok('creates a supplier', r.status === 201)
const supplierId = r.body.id
r = await q('/pharmacy/suppliers')
ok('supplier appears in list', r.body.some(s => s.id === supplierId))

console.log('\n— receive stock against that supplier —')
const exp = new Date(Date.now() + 400*86400000).toISOString().slice(0,10)
r = await q('/pharmacy/purchases', { method: 'POST', body: JSON.stringify({
  supplierId, supplierInvoiceNo: 'VER-001', invoiceDate: new Date().toISOString().slice(0,10),
  lines: [{ productId: newProduct, batchNo: 'VB1', expiryDate: exp, qty: 20, bonusQty: 2,
            costPaisa: 15000, pricePaisa: 20000 }] }) })
ok('goods receipt saves', r.status === 201, JSON.stringify(r.body).slice(0,150))
r = await q(`/pharmacy/products/${newProduct}/batches`)
ok('bonus packs reached the shelf', r.body[0]?.qtyOnHand === 22, `qty=${r.body[0]?.qtyOnHand}`)

console.log('\n— archive is blocked while stock remains —')
r = await q(`/pharmacy/products/${newProduct}/archive`, { method: 'POST' })
ok('refuses to archive stocked item', r.status === 409, `got ${r.status}`)

console.log('\n— sell it —')
r = await q('/pharmacy/sales', { method: 'POST', body: JSON.stringify({
  lines: [{ productId: newProduct, qty: 2 }], payMethod: 'cash', paidPaisa: 40000 }) })
ok('sale completes', r.status === 201, JSON.stringify(r.body).slice(0,150))
const saleTotal = r.body.sale?.totalPaisa
ok('total is 2 × 200.00', saleTotal === 40000, `got ${saleTotal}`)
r = await q(`/pharmacy/products/${newProduct}/batches`)
ok('stock fell by 2', r.body[0]?.qtyOnHand === 20, `qty=${r.body[0]?.qtyOnHand}`)

console.log('\n— overselling is refused —')
r = await q('/pharmacy/sales', { method: 'POST', body: JSON.stringify({
  lines: [{ productId: newProduct, qty: 9999 }], payMethod: 'cash', paidPaisa: 100000000 }) })
ok('refuses to oversell', r.status === 409, `got ${r.status}`)

console.log('\n— bills —')
r = await q('/pharmacy/sales?mode=today')
ok('today\'s bills listed', r.body.rows.length > 0)
ok('totals returned', Number(r.body.totals.revenue_paisa) > 0)
r = await q('/pharmacy/sales?mode=all&sort=highest')
ok('sort by highest works', r.status === 200 && r.body.rows.length > 0)
r = await q('/pharmacy/sales/cashiers')
ok('cashier list works', Array.isArray(r.body))

console.log('\n— reports —')
r = await q('/pharmacy/reports/expiring?days=365')
ok('expiry report runs', Array.isArray(r.body))
r = await q('/pharmacy/reports/low-stock')
ok('reorder report runs', Array.isArray(r.body))
r = await q('/pharmacy/dashboard?days=30')
ok('dashboard runs', r.status === 200 && r.body.trend?.length > 0, JSON.stringify(r.body).slice(0,120))
r = await q('/pharmacy/dashboard?days=1')
ok('today tab returns cash-up', r.body.cashUp != null)

console.log('\n— prescriptions —')
r = await q('/pharmacy/prescriptions')
const queue = r.body
ok('pending prescriptions listed', Array.isArray(queue) && queue.length > 0, `${queue?.length}`)
const first = queue[0]
r = await q(`/visits/${first.visit_id}/prescription`)
const detail = r.body
ok('prescription detail loads', r.status === 200 && detail.items?.length > 0)
const linked = detail.items.find(i => i.product_id)
ok('at least one item links to a shelf product', !!linked)

if (linked) {
  console.log('\n— fill it at the counter —')
  const before = linked.qty_dispensed
  /*
   * A prescription is written in units, but not everything can be split — a
   * bottle of syrup is one thing whatever the prescription says. So the sale
   * unit follows what the medicine allows rather than being assumed.
   */
  const inv = (await q('/pharmacy/inventory')).body
  const linkedProduct = inv.find(p => p.id === linked.product_id)
  const soldAs = linkedProduct?.allow_loose ? 'unit' : 'pack'
  r = await q('/pharmacy/sales', { method: 'POST', body: JSON.stringify({
    lines: [{ productId: linked.product_id, qty: linked.qty_prescribed, soldAs }],
    payMethod: 'cash', paidPaisa: 100000000,
    visitId: first.visit_id, patientId: detail.prescription.patient_id }) })
  ok('prescription sale completes', r.status === 201, JSON.stringify(r.body).slice(0,150))
  r = await q(`/visits/${first.visit_id}/prescription`)
  const after = r.body.items.find(i => i.id === linked.id)
  ok('item marked dispensed', after.status === 'dispensed', `status=${after.status} qty=${after.qty_dispensed}/${after.qty_prescribed}`)
  ok('dispensed count rose', after.qty_dispensed > before)
  const other = r.body.items.find(i => i.id !== linked.id && !i.product_id)
  if (other) ok('unmatched free-text item stays pending', other.status === 'pending', `status=${other.status}`)
  r = await q(`/pharmacy/sales?mode=today`)
  const withPatient = r.body.rows.find(s => s.patient_name)
  ok('sale carries the patient', !!withPatient, 'no patient-linked sale found')
}

console.log('\n— the OPD counter cannot reach the pharmacy —')
token = ''
r = await q('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'opd', password: '1234' }) })
token = r.body.token
r = await q('/pharmacy/inventory')
ok('opd counter blocked', r.status === 403, `got ${r.status}`)
r = await q('/pharmacy/sales', { method: 'POST', body: JSON.stringify({ lines: [{ productId: newProduct, qty: 1 }] }) })
ok('opd counter cannot sell', r.status === 403, `got ${r.status}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
