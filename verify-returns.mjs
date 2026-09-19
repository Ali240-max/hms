/**
 * Returns: against the invoice, restock or write off, refund what was charged.
 *
 *   npm run dev:server && node verify-returns.mjs
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['ph','pharmacy','1234'],['opd','opd','1234']]) tok[k]=await login(u,p)

console.log('\n— make a sale to return —')
const inv = (await q('/pharmacy/inventory','ph')).body.filter(p=>p.in_stock >= (p.pack_size||1)*3)
ok('there is stock to sell', inv.length>0, `${inv.length} products`)
const prod = inv[0]
const soldAs = prod.allow_loose ? 'unit' : 'pack'
let r = await q('/pharmacy/sales','ph',{method:'POST',body:JSON.stringify({
  lines:[{ productId: prod.id, qty: 3, soldAs }], payMethod:'cash', paidPaisa: 100000000,
  customerName:'Return Test' })})
ok('sale completes', r.status===201, JSON.stringify(r.body).slice(0,100))
const sale = r.body.sale ?? r.body
const beforeStock = (await q('/pharmacy/inventory','ph')).body.find(p=>p.id===prod.id).in_stock

console.log('\n— find it by invoice number —')
r = await q(`/pharma/returns/lookup?invoice=${encodeURIComponent(sale.invoiceNo ?? sale.invoice_no)}`,'ph')
ok('the invoice is found', r.status===200, JSON.stringify(r.body).slice(0,90))
const look = r.body
ok('its lines come back', look.items.length>0)
/*
 * A sale of three may arrive as two lines.
 *
 * FEFO takes the nearest expiry first, so three units can come off two
 * batches and land as 2 + 1. That is correct — a return has to go back to the
 * batch it came from, or the expiry on the shelf would be wrong — so the test
 * works from the biggest line rather than assuming the sale is one row. The
 * earlier version passed only because the stock happened to sit in one batch.
 */
const line = look.items.slice().sort((a,b) => b.returnable - a.returnable)[0]
const SOLD = Number(line.display_qty)
ok('a line is returnable in full', line.returnable === SOLD,
  `${line.returnable} of ${SOLD}`)
ok('the sale covers three units across its lines',
  look.items.reduce((n,i)=>n+Number(i.display_qty),0) === 3,
  look.items.map(i=>i.display_qty).join('+'))
ok('the refund rate is what was charged',
  Number(line.unit_refund_paisa)*SOLD === Number(line.line_total_paisa),
  `${line.unit_refund_paisa} x${SOLD} vs ${line.line_total_paisa}`)

r = await q('/pharma/returns/lookup?invoice=NOPE-999','ph')
ok('an unknown invoice is refused', r.status===404, `got ${r.status}`)

console.log('\n— return two, sealed —')
// Return all but one of that line, so something is left to test the rest with.
const FIRST = Math.max(1, SOLD - 1)
r = await q('/pharma/returns','ph',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: FIRST, restock: true }],
  reason:'Patient did not need it' })})
ok('the return is accepted', r.status===201, JSON.stringify(r.body).slice(0,110))
const ret = r.body
ok('it gets a return number', /^SR-\d{6}$/.test(ret.return_no), ret.return_no)
ok('the refund matches what those units cost',
  Number(ret.total_paisa) === Number(line.unit_refund_paisa)*FIRST,
  `${ret.total_paisa} vs ${Number(line.unit_refund_paisa)*FIRST}`)
ok('cash sale refunds from the drawer', ret.refund_to==='cash', ret.refund_to)

const afterStock = (await q('/pharmacy/inventory','ph')).body.find(p=>p.id===prod.id).in_stock
const units = soldAs === 'pack' ? FIRST * prod.pack_size : FIRST
ok('sealed stock goes back on the shelf', afterStock === beforeStock + units,
  `${beforeStock} -> ${afterStock}, expected +${units}`)

console.log('\n— what is left —')
r = await q(`/pharma/returns/lookup?invoice=${encodeURIComponent(sale.invoiceNo ?? sale.invoice_no)}`,'ph')
const after = r.body.items.find(i => i.id === line.id)
ok('what is left on that line is what was not returned',
  after.returnable === SOLD - FIRST, `${after.returnable} left of ${SOLD}`)
ok('the returned quantity is recorded', Number(after.already_returned)===FIRST,
  String(after.already_returned))

console.log('\n— it will not over-return —')
r = await q('/pharma/returns','ph',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: SOLD + 5, restock: true }] })})
ok('returning more than was sold is refused', r.status===409 && r.body.code==='TOO_MANY',
  JSON.stringify(r.body).slice(0,110))
ok('the refusal says how many are left',
  new RegExp(`Only ${SOLD - FIRST} `).test(r.body.error ?? ''), r.body?.error?.slice(0,70))

console.log('\n— damaged goods are refunded but not restocked —')
const before2 = (await q('/pharmacy/inventory','ph')).body.find(p=>p.id===prod.id).in_stock
r = await q('/pharma/returns','ph',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: SOLD - FIRST, restock: false }],
  reason:'Strip torn' })})
ok('a damaged return is accepted', r.status===201)
ok('the customer still gets their money', Number(r.body.total_paisa)>0, String(r.body?.total_paisa))
const after2 = (await q('/pharmacy/inventory','ph')).body.find(p=>p.id===prod.id).in_stock
ok('but it does NOT go back on the shelf', after2 === before2, `${before2} -> ${after2}`)

console.log('\n— nothing left to return —')
r = await q(`/pharma/returns/lookup?invoice=${encodeURIComponent(sale.invoiceNo ?? sale.invoice_no)}`,'ph')
ok('the line is fully returned', r.body.items[0].returnable===0, String(r.body.items[0].returnable))
r = await q('/pharma/returns','ph',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: 1, restock: true }] })})
ok('a further return is refused', r.status===409, `got ${r.status}`)
r = await q('/pharma/returns','ph',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: 0, restock: true }] })})
ok('an empty return is refused', r.status===409 && r.body.code==='NOTHING', `got ${r.status}`)

console.log('\n— the day book —')
r = await q('/pharma/returns','ph')
ok('returns are listed', r.status===200 && r.body.length>0, `${r.body?.length}`)
ok('each carries its invoice', r.body[0].invoice_no != null)
ok('write-offs are counted separately', r.body.some(x=>Number(x.written_off)>0))

console.log('\n— report PDFs open with a ticket —')
{
  // The bug this covers: the client used to send the whole URL, query string
  // included, as the ticket path, and the server refused it as "not a
  // downloadable document". A ticket is bound to the document, not the filters.
  const path = '/pharma/reports/print/sales-daily/pdf'
  const tk = await q('/tickets','ph',{method:'POST',body:JSON.stringify({ path })})
  ok('a ticket is issued for the bare path', tk.status===200 && !!tk.body.ticket,
    JSON.stringify(tk.body).slice(0,80))
  const today = new Date().toISOString().slice(0,10)
  const res = await fetch(
    `${B}${path}?from=${today}&to=${today}&ticket=${encodeURIComponent(tk.body.ticket)}`)
  ok('the report opens with filters attached and no auth header', res.status===200,
    `got ${res.status}`)
  ok('and it is a PDF', (res.headers.get('content-type')||'').includes('application/pdf'),
    res.headers.get('content-type'))
  const withQuery = await q('/tickets','ph',{method:'POST',body:JSON.stringify({
    path: path + '?from=' + today })})
  ok('a path carrying a query is still refused', withQuery.status===400,
    `got ${withQuery.status}`)
}

console.log('\n— only the pharmacy —')
r = await q('/pharma/returns','opd',{method:'POST',body:JSON.stringify({
  saleId: sale.id, lines:[{ saleItemId: line.id, qty: 1, restock: true }] })})
ok('the OPD desk cannot take returns', r.status===403, `got ${r.status}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
