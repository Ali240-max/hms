/**
 * Document numbers: dated, daily, and never colliding.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['mc','main-counter','1234'],['lab','lab','1234'],['ph','pharmacy','1234'],['doc','dr.yasir','1234']]) tok[k]=await login(u,p)

const d = new Date()
const DAY = String(d.getFullYear()).slice(2) +
  String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0')
console.log(`\n— today's segment is ${DAY} —`)

console.log('\n— a visit —')
let r = await q('/patients','mc',{method:'POST',body:JSON.stringify({ name:'Numbering Test', phone:'0300-9998887' })})
const pt = r.body
const docs = (await q('/doctors','mc')).body
r = await q('/visits','mc',{method:'POST',body:JSON.stringify({ patientId: pt.id, doctorId: docs[0].id })})
const visit = r.body
const visitNo = visit.visitNo ?? visit.visit_no
ok('a visit is numbered VIS-<date>-V<seq>',
  new RegExp(`^VIS-${DAY}-V\\d{5}$`).test(visitNo), visitNo)

console.log('\n— a counter bill —')
const draft = (await q(`/counter/draft/visit/${visit.id}`,'mc')).body
r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId: visit.id, payMethod:'cash',
  tenderedPaisa: Number(draft.totalPaisa) })})
ok('a consultation bill is INV-<date>-C<seq>',
  new RegExp(`^INV-${DAY}-C\\d{5}$`).test(r.body.bill?.bill_no ?? r.body.bill_no ?? ''),
  r.body.bill?.bill_no ?? r.body.bill_no)

console.log('\n— a chit —')
const svcs = (await q('/services','mc')).body.filter(s=>s.category==='lab').slice(0,1)
r = await q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
  patientId: pt.id, serviceIds: svcs.map(s=>s.id) })})
const direct = r.body
ok('a walk-in visit is VIS-<date>-D<seq>',
  new RegExp(`^VIS-${DAY}-D\\d{5}$`).test(direct.visit.visit_no), direct.visit.visit_no)
ok('a chit is CHIT-<date>-T<seq>',
  new RegExp(`^CHIT-${DAY}-T\\d{5}$`).test(direct.chits[0].chit_no), direct.chits[0].chit_no)

r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'chit', chitId: direct.chits[0].id, payMethod:'cash',
  tenderedPaisa: Number(direct.chits[0].total_paisa) })})
ok('a chit bill is INV-<date>-D<seq>',
  new RegExp(`^INV-${DAY}-D\\d{5}$`).test(r.body.bill?.bill_no ?? r.body.bill_no ?? ''),
  r.body.bill?.bill_no ?? r.body.bill_no)

console.log('\n— a lab report —')
const work = (await q('/lab/queue?status=all','lab')).body
  .filter(x=>x.visit_id===direct.visit.id && x.lab_status==='pending')
if (work.length) {
  r = await q('/lab/collect','lab',{method:'POST',body:JSON.stringify({ serviceOrderId: work[0].service_order_id })})
  ok('a lab report is LAB-<date>-L<seq>',
    new RegExp(`^LAB-${DAY}-L\\d{5}$`).test(r.body.report_no), r.body.report_no)
} else ok('a lab report is LAB-<date>-L<seq>', false, 'no paid lab work created')

console.log('\n— a pharmacy sale —')
const inv = (await q('/pharmacy/inventory','ph')).body.filter(p=>p.in_stock >= (p.pack_size||1))
r = await q('/pharmacy/sales','ph',{method:'POST',body:JSON.stringify({
  lines:[{ productId: inv[0].id, qty:1, soldAs: inv[0].allow_loose ? 'unit' : 'pack' }],
  payMethod:'cash', paidPaisa: 100000000, customerName:'Numbering' })})
const sale = r.body.sale ?? r.body
ok('a sale is PH-<date>-S<seq>',
  new RegExp(`^PH-${DAY}-S\\d{5}$`).test(sale.invoiceNo ?? sale.invoice_no ?? ''),
  sale.invoiceNo ?? sale.invoice_no)

console.log('\n— the sequence runs per day, not forever —')
{
  // Two documents of the same kind, issued back to back.
  const a = await q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
    patientId: pt.id, serviceIds: svcs.map(s=>s.id) })})
  const b = await q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
    patientId: pt.id, serviceIds: svcs.map(s=>s.id) })})
  const na = Number(a.body.chits[0].chit_no.split('-').pop().replace('T',''))
  const nb = Number(b.body.chits[0].chit_no.split('-').pop().replace('T',''))
  ok('consecutive documents increment by one', nb === na + 1, `${na} then ${nb}`)
  ok('both carry the date for today',
    a.body.chits[0].chit_no.includes(DAY) && b.body.chits[0].chit_no.includes(DAY))
  ok('the sequence is five digits, so 99,999 a day',
  /\d{5}$/.test(b.body.chits[0].chit_no), b.body.chits[0].chit_no)
}

console.log('\n— two tills at once cannot collide —')
{
  const made = await Promise.all(Array.from({ length: 8 }, () =>
    q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
      patientId: pt.id, serviceIds: svcs.map(s=>s.id) })})))
  const nos = made.map(x => x.body.chits?.[0]?.chit_no).filter(Boolean)
  ok('eight simultaneous chits all succeeded', nos.length === 8, `${nos.length}/8`)
  ok('and every number is different', new Set(nos).size === nos.length,
    nos.length - new Set(nos).size + ' duplicates')
}

console.log('\n— an MRN is deliberately not dated —')
ok('a patient keeps a plain lifelong number', /^MRN-\d{6}$/.test(pt.mrn), pt.mrn)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
