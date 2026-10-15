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

console.log('\n— receiving against a purchase order, over HTTP —')
{
  /*
   * THE WHOLE POINT OF THIS SECTION IS THAT IT GOES THROUGH THE ROUTE.
   *
   * Receiving against an order is supposed to link the delivery to it and
   * close it, and the service-level suite proved that it does. The route did
   * not: the zod schema on POST /pharmacy/purchases never declared
   * purchaseOrderId, and zod strips what it does not declare, so the client
   * sent it, the server dropped it, and every order stayed open forever
   * while the stock went in. Tested at the service and shipped broken in the
   * app, which is the gap this closes.
   *
   * The tax figures go the same way and for the same reason.
   */
  const auth = await q('/auth/login', { method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin-demo-1' }) })
  token = auth.body.token
  ok('an administrator signs in for this section', !!token)

  const sup = (await q('/pharmacy/suppliers')).body?.[0]
  /* The inventory list, which this suite has already proven works. */
  const prods = (await q('/pharmacy/inventory')).body ?? []
  const prod = Array.isArray(prods) ? prods.find((x) => x.id) : null
  ok('there is a supplier and a medicine to work with', !!sup && !!prod)

  if (sup && prod) {
    const packSize = Math.max(1, Number(prod.pack_size ?? 1))
    const po = await q('/pharma/orders', { method: 'POST', body: JSON.stringify({
      supplierId: sup.id, windowDays: 7,
      lines: [{ productId: prod.id, orderPacks: 7 }] }) })
    ok('an order is raised over HTTP', po.status === 201, `got ${po.status}`)
    ok('and it is stored in packs', Number(po.body?.items?.[0]?.order_packs) === 7,
      JSON.stringify(po.body?.items?.[0]?.order_packs))
    ok('with the unit equivalent beside it',
      Number(po.body?.items?.[0]?.order_units) === 7 * packSize,
      `${po.body?.items?.[0]?.order_units} vs ${7 * packSize}`)

    const stamp = Date.now().toString().slice(-7)
    const got = await q('/pharmacy/purchases', { method: 'POST', body: JSON.stringify({
      supplierId: sup.id,
      supplierInvoiceNo: 'TAX-' + stamp,
      invoiceDate: new Date().toISOString().slice(0, 10),
      purchaseOrderId: po.body.id,
      /* 10 packs at Rs 100 with 10% tax, then 5% on the invoice. */
      extraTaxBp: 500,
      lines: [{ productId: prod.id, batchNo: 'TX' + stamp,
        expiryDate: '2027-12-31', qty: 10, costPaisa: 10000, taxRateBp: 1000 }]
    }) })
    ok('the delivery is booked', got.status === 201, `got ${got.status}`)

    /* 10 x 100 = 1000 goods, +10% = 100 tax, +5% of 1100 = 55. */
    ok('the line tax is on the line value',
      Number(got.body?.purchase?.taxPaisa) === 10000,
      `${got.body?.purchase?.taxPaisa} paisa`)
    ok('the invoice tax is on goods plus line tax',
      Number(got.body?.purchase?.extraTaxPaisa) === 5500,
      `${got.body?.purchase?.extraTaxPaisa} paisa`)
    ok('and the total is all three added up',
      Number(got.body?.purchase?.totalPaisa) === 100000 + 10000 + 5500,
      `${got.body?.purchase?.totalPaisa} paisa`)

    /*
     * The assertion that was missing. One receive closes the order — that
     * was the decision — and over HTTP it never did.
     */
    const after = await q(`/pharma/orders/${po.body.id}`)
    ok('the order is closed by the delivery', after.body?.status === 'received',
      `status ${after.body?.status}`)
    ok('and the delivery points back at it',
      (await q('/pharma/orders')).body
        ?.find((o) => o.id === po.body.id)?.grn_no?.startsWith('GRN-'),
      'no GRN linked to the order')
  }
}

console.log('\n— discounts at the counter —')
{
  /*
   * Two settings, and the difference between them matters.
   *
   * The switch decides whether a bill can be reduced at all. The ceiling
   * decides how far, as a percentage of the WHOLE BILL — measured there
   * rather than per line, because three lines discounted ten per cent each
   * is ten per cent of the bill while one line at thirty is not, and a
   * per-line check would let a big discount be split across lines to get
   * past it.
   *
   * Zero means no ceiling, not "no discount". That is what the switch is
   * for, and conflating the two would make zero per cent mean two opposite
   * things.
   *
   * Enforced on the server, which is the only place it counts: the till is a
   * screen and the rule is a rule.
   */
  const auth = await q('/auth/login', { method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin-demo-1' }) })
  const adminTok = auth.body.token
  const asAdmin = (path, opts = {}) => q(path, {
    ...opts, headers: { authorization: 'Bearer ' + adminTok } })

  const phAuth = await q('/auth/login', { method: 'POST',
    body: JSON.stringify({ username: 'pharmacy', password: '1234' }) })
  token = phAuth.body.token

  const inv = (await q('/pharmacy/inventory')).body ?? []
  const p = inv.find((x) => x.in_stock > 20 && x.retail_paisa > 0)
  ok('there is something in stock to discount', !!p)

  if (p) {
    const gross = Number(p.retail_paisa) * 2
    const sell = (discountPaisa) => q('/pharmacy/sales', { method: 'POST',
      body: JSON.stringify({
        lines: [{ productId: p.id, qty: 2, soldAs: 'pack', discountPaisa }],
        payMethod: 'cash', paidPaisa: 0 }) })
    const set = (b) => asAdmin('/pharma/settings', {
      method: 'PUT', body: JSON.stringify(b) })

    await set({ discountEnabled: true, discountMaxPct: 0 })
    let r = await sell(Math.round(gross * 0.5))
    ok('with no ceiling a large discount goes through', r.status === 201,
      `${r.status} ${r.body?.code ?? ''}`)

    await set({ discountEnabled: true, discountMaxPct: 10 })
    r = await sell(Math.round(gross * 0.05))
    ok('under the ceiling is allowed', r.status === 201,
      `${r.status} ${r.body?.code ?? ''}`)
    r = await sell(Math.round(gross * 0.25))
    ok('over the ceiling is refused', r.body?.code === 'DISCOUNT_TOO_BIG',
      `${r.status} ${r.body?.code ?? ''}`)
    ok('and the refusal says the figure, the limit and the rupees',
      /25\.0%/.test(r.body?.error ?? '') && /10%/.test(r.body?.error ?? '')
      && /Rs/.test(r.body?.error ?? ''), String(r.body?.error ?? '').slice(0, 110))

    await set({ discountEnabled: false })
    r = await sell(Math.round(gross * 0.02))
    ok('switched off, even a small discount is refused',
      r.body?.code === 'DISCOUNT_OFF', `${r.status} ${r.body?.code ?? ''}`)
    r = await sell(0)
    ok('but a bill with no discount still sells', r.status === 201,
      `${r.status} ${r.body?.code ?? ''}`)

    /*
     * The per-person tick, which nothing had ever checked.
     *
     * `sale.discount` has been in the permission list since the pharmacy was
     * rebuilt and no code read it: the shop-wide switch and the ceiling
     * answered "how much" and nothing answered "by whom", so a cashier with
     * the tick deliberately removed could still knock money off a bill.
     */
    await set({ discountEnabled: true, discountMaxPct: 0 })

    const staff = (await asAdmin('/pharma/staff')).body ?? []
    const cashier = (staff ?? []).find((x) => x.username === 'pharmacy')
    ok('the cashier account is there to take the tick off', !!cashier,
      `${staff.length} staff`)

    if (cashier) {
      const held = (await asAdmin(`/pharma/permissions/${cashier.id}`)).body
      ok('a counter assistant may give a discount by default',
        (held.allowed ?? []).includes('sale.discount'),
        'the box would be hidden on a shop that has discounts switched on')

      /* Take it away and the SERVER must refuse, not just hide the box. */
      await asAdmin(`/pharma/permissions/${cashier.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          allowed: (held.allowed ?? []).filter((k) => k !== 'sale.discount')
        })
      })
      r = await sell(Math.round(gross * 0.05))
      ok('without the tick the discount is refused by the server',
        r.status === 403 && r.body?.code === 'NOT_ALLOWED',
        `${r.status} ${r.body?.code ?? ''}`)
      r = await sell(0)
      ok('and a bill with no discount on it still goes through',
        r.status === 201, `${r.status} ${r.body?.code ?? ''}`)

      /* Put it back, or every later run of this suite starts refused. */
      await asAdmin(`/pharma/permissions/${cashier.id}`, {
        method: 'PUT', body: JSON.stringify({ allowed: held.allowed ?? [] })
      })
      r = await sell(Math.round(gross * 0.05))
      ok('and it works again once the tick is back', r.status === 201,
        `${r.status} ${r.body?.code ?? ''}`)
    }

    /* A cashier who can raise their own ceiling has no ceiling. */
    r = await q('/pharma/settings', { method: 'PUT',
      body: JSON.stringify({ discountMaxPct: 100 }) })
    ok('a pharmacist cannot change the rules', r.status === 403, `got ${r.status}`)

    await set({ discountEnabled: true, discountMaxPct: 0 })
    const back = (await q('/pharma/settings')).body
    ok('the settings are left as they were found',
      back.discountEnabled === true && Number(back.discountMaxPct) === 0,
      JSON.stringify(back))
  }
}


/* ------------------------------ damage and expiry, through the routes ---- */

/**
 * The ROUTES, not the service underneath them.
 *
 * The service has its own suite and it passes. That is not the same thing:
 * last round a receive route silently dropped the purchase order id because
 * its schema never declared the field, the service worked perfectly, and the
 * suite tested the service. This is the screen's actual path - sign in, read
 * the shelf, post a write-off, read it back, fetch the slip.
 */
console.log('\n— damage and expiry, over the wire —')
{
  /* The pharmacist is not granted either tick by default, so they must be
   * refused before anything else is tested. */
  r = await q('/pharma/write-offs/shelf?q=')
  ok('the shelf can be read by anybody in the module',
    r.status === 200 && Array.isArray(r.body), `${r.status}`)

  const withStock = (r.body ?? []).find((x) => Number(x.qty_on_hand) > 2)
  ok('and it offers a batch with stock on it', !!withStock,
    `${(r.body ?? []).length} rows`)

  /*
   * Zero is a real window, so it must not be dropped as falsy on the way
   * through the query string. Everything it returns has to be expired.
   */
  r = await q('/pharma/write-offs/shelf?expiringWithinDays=0')
  /*
   * Everything in the zero-day window is out of date OR goes out today.
   *
   * This asserted `expired === true` on every row and real data broke it: the
   * window is `expiry_date <= CURRENT_DATE` and the flag is
   * `expiry_date < CURRENT_DATE`, so a batch dated today is in the list and
   * is not expired. That is correct behaviour — it is the batch most urgently
   * needing to come off the shelf — and the assertion was measuring
   * something nobody decided. What was genuinely wrong was the label on the
   * dropdown, which said "Already expired" over a list including stock still
   * technically in date.
   */
  const todayStr = new Date().toISOString().slice(0, 10)
  const stale = (r.body ?? []).filter((x) =>
    x.expired !== true && String(x.expiry_date).slice(0, 10) !== todayStr)
  ok('a zero-day window is honoured rather than read as "no window"',
    r.status === 200 && stale.length === 0,
    `${(r.body ?? []).length} rows, ${stale.length} neither expired nor expiring today`)
  ok('and it is strictly out of date or out of date today',
    (r.body ?? []).every((x) =>
      x.expired === true || String(x.expiry_date).slice(0, 10) === todayStr))

  const everything = (await q('/pharma/write-offs/shelf')).body ?? []
  ok('and it is narrower than no window at all',
    (r.body ?? []).length <= everything.length,
    `${(r.body ?? []).length} vs ${everything.length}`)

  if (withStock) {
    const body = JSON.stringify({
      kind: 'damage', note: 'route check',
      lines: [{ productId: Number(withStock.product_id),
                batchId: Number(withStock.batch_id), qty: 1,
                reason: 'dropped at the counter' }]
    })

    r = await q('/pharma/write-offs', { method: 'POST', body })
    ok('a pharmacist without the tick is refused by the SERVER, not just the rail',
      r.status === 403 && r.body.code === 'NOT_ALLOWED',
      `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)

    /* Now as the administrator, who holds everything. */
    const keep = token
    const admin = await q('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin-demo-1' })
    })
    token = admin.body.token

    const before = Number(withStock.qty_on_hand)
    r = await q('/pharma/write-offs', { method: 'POST', body })
    const made = r.body
    ok('an administrator can post one', r.status === 201 && made.id > 0,
      `${r.status} ${JSON.stringify(made).slice(0, 140)}`)
    ok('and it comes back with its tracking number',
      /^DMG-\d{6}-\d{2,}$/.test(made.write_off_no ?? ''), made.write_off_no)
    ok('the quantity and the value are on the response',
      Number(made.units) === 1
      && Number(made.value_paisa) === Number(withStock.cost_paisa),
      `${made.units} units, ${made.value_paisa} paisa, ` +
      `batch cost ${withStock.cost_paisa}`)

    /*
     * The REASON, checked through the route.
     *
     * It is the one field on this form that nothing else would notice going
     * missing: the quantity shows up as wrong stock, but a dropped reason
     * just leaves a blank column on a report somebody reads next year.
     */
    ok('and the reason survived the trip',
      (made.items ?? [])[0]?.reason === 'dropped at the counter',
      JSON.stringify((made.items ?? [])[0]?.reason))

    /* The shelf is one lighter. */
    const after = ((await q('/pharma/write-offs/shelf')).body ?? [])
      .find((x) => Number(x.batch_id) === Number(withStock.batch_id))
    ok('the batch lost exactly one unit',
      Number(after?.qty_on_hand ?? -1) === before - 1,
      `${before} then ${after?.qty_on_hand}`)

    r = await q(`/pharma/write-offs/${made.id}`)
    ok('reading it back brings its lines',
      r.status === 200 && (r.body.items ?? []).length === 1, `${r.status}`)

    r = await q('/pharma/write-offs?kind=damage&q=route check')
    ok('the register finds it by a word in the note',
      r.status === 200 && (r.body ?? []).some((x) => Number(x.id) === made.id),
      `${(r.body ?? []).length} rows`)

    r = await q('/pharma/write-offs?kind=expiry&q=route check')
    ok('and the expiry register does not show a damage report',
      !(r.body ?? []).some((x) => Number(x.id) === made.id))

    /* The slip, through a document ticket, exactly as the button does it. */
    const ticket = await q('/tickets', {
      method: 'POST',
      body: JSON.stringify({ path: `/pharma/write-offs/${made.id}/pdf` })
    })
    ok('a document ticket is issued for the slip',
      ticket.status === 200 && !!ticket.body.ticket,
      `${ticket.status} ${JSON.stringify(ticket.body).slice(0, 120)}`)

    if (ticket.body?.ticket) {
      const pdf = await fetch(
        `${B}/pharma/write-offs/${made.id}/pdf?ticket=` +
        encodeURIComponent(ticket.body.ticket))
      const buf = Buffer.from(await pdf.arrayBuffer())
      ok('and the slip downloads as a PDF',
        pdf.status === 200 && buf.subarray(0, 5).toString() === '%PDF-',
        `${pdf.status}, ${buf.length} bytes`)
      ok('named after the report rather than something generic',
        /DMG-\d{6}/.test(pdf.headers.get('content-disposition') ?? ''),
        pdf.headers.get('content-disposition') ?? '')
    }

    /* Over-asking is refused by the route too, with nothing moved. */
    r = await q('/pharma/write-offs', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'expiry',
        lines: [{ productId: Number(withStock.product_id),
                  batchId: Number(withStock.batch_id), qty: 99999 }]
      })
    })
    ok('more than the batch holds is refused over the wire',
      r.status === 400 && r.body.code === 'NOT_ENOUGH',
      `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)

    const still = ((await q('/pharma/write-offs/shelf')).body ?? [])
      .find((x) => Number(x.batch_id) === Number(withStock.batch_id))
    ok('and the batch is untouched by the refusal',
      Number(still?.qty_on_hand ?? -1) === before - 1,
      `${still?.qty_on_hand}`)

    token = keep
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
