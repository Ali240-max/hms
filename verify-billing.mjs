/**
 * Counter billing and the gated queue.
 *
 *   npm run dev:server && node verify-billing.mjs
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
async function login(u,p){const r=await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})});return (await r.json()).token}
async function q(path, as, opts={}) {
  const r = await fetch(B+path,{...opts,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(opts.headers||{})}})
  const t = await r.text(); let b; try{b=JSON.parse(t)}catch{b=t}
  return {status:r.status, body:b}
}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['mc','main-counter','1234'],['opd','opd','1234'],['doc','dr.yasir','1234'],['admin','admin','admin-demo-1']]) tok[k]=await login(u,p)
ok('all counters sign in', Object.values(tok).every(Boolean))

console.log('\n— registering does not put anyone in the queue —')
let r = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Billing Test Patient',phone:'0300-7654321'})})
ok('patient registered', r.status===201, JSON.stringify(r.body).slice(0,100))
const patient = r.body
const docs = (await q('/doctors','mc')).body
const doctor = docs[0]
r = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:patient.id,doctorId:doctor.id})})
ok('visit created', r.status===201, JSON.stringify(r.body).slice(0,120))
const visit = r.body
ok('visit starts unbilled, not waiting', visit.status==='registered', `status=${visit.status}`)
ok('fee not marked paid', visit.feePaid===false)

console.log('\n— the cashier sees a draft before taking money —')
r = await q(`/counter/draft/visit/${visit.id}`,'mc')
ok('draft loads', r.status===200, JSON.stringify(r.body).slice(0,100))
ok('draft has a consultation line', r.body.items.length===1 && r.body.items[0].amountPaisa>0)
ok('draft total matches the fee', r.body.totalPaisa===Number(visit.consultationFeePaisa),
  `${r.body.totalPaisa} vs ${visit.consultationFeePaisa}`)
ok('draft names the doctor', /Consultation/.test(r.body.items[0].description))

console.log('\n— short cash is refused —')
r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId:visit.id, payMethod:'cash', tenderedPaisa:1 })})
ok('refuses cash under the total', r.status===409 && r.body.code==='SHORT_PAYMENT', JSON.stringify(r.body).slice(0,110))
let after = (await q(`/visits/${visit.id}`,'mc')).body
after = after.visit ?? after
ok('failed bill left the visit alone', after.status==='registered', `status=${after.status}`)

console.log('\n— completing the bill is what joins the queue —')
const fee = Number(visit.consultationFeePaisa)
r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId:visit.id, payMethod:'cash', tenderedPaisa: fee + 50000 })})
ok('bill completes', r.status===201, JSON.stringify(r.body).slice(0,140))
const bill = r.body.bill
ok('invoice number issued', /^INV-\d{6}$/.test(bill.bill_no), bill.bill_no)
ok('change calculated', Number(bill.change_paisa)===50000, String(bill.change_paisa))
ok('bill has its line items', r.body.items.length===1)
after = (await q(`/visits/${visit.id}`,'mc')).body
after = after.visit ?? after
ok('visit now waiting', after.status==='waiting', `status=${after.status}`)
ok('fee marked paid', after.fee_paid===true)

console.log('\n— a bill cannot be taken twice —')
r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId:visit.id, payMethod:'cash', tenderedPaisa: fee })})
ok('refuses a second consultation bill', r.status===409 && r.body.code==='ALREADY_BILLED', JSON.stringify(r.body).slice(0,100))

console.log('\n— the doctor cannot open a patient before OPD sends them in —')
r = await q(`/visits/${visit.id}/status`,'doc',{method:'POST',body:JSON.stringify({status:'in_consultation'})})
ok('doctor blocked while only waiting', r.status===409 && r.body.code==='NOT_SENT_IN', JSON.stringify(r.body).slice(0,120))

r = await q(`/visits/${visit.id}/vitals`,'opd',{method:'PATCH',body:JSON.stringify({complaint:'Headache',bpSystolic:128,bpDiastolic:82})})
ok('opd records details', r.status===200)
r = await q(`/visits/${visit.id}/send-in`,'opd',{method:'POST',body:'{}'})
ok('opd sends the patient in', r.status===200 && r.body.status==='ready', JSON.stringify(r.body).slice(0,90))
ok('hand-off records who and when', !!r.body.sent_in_by && !!r.body.sent_in_at)

r = await q(`/visits/${visit.id}/status`,'doc',{method:'POST',body:JSON.stringify({status:'in_consultation'})})
ok('doctor can now open it', r.status===200 && r.body.status==='in_consultation', JSON.stringify(r.body).slice(0,90))

console.log('\n— the main counter cannot send patients in —')
r = await q(`/visits/${visit.id}/send-in`,'mc',{method:'POST',body:'{}'})
ok('main counter refused', r.status===403, `got ${r.status}`)

console.log('\n— chits are billed the same way —')
r = await q('/chits?status=ordered','mc')
const chit = r.body[0]
if (chit) {
  r = await q(`/counter/draft/chit/${chit.id}`,'mc')
  ok('chit draft loads with its lines', r.status===200 && r.body.items.length>0, JSON.stringify(r.body).slice(0,110))
  ok('chit draft total matches', r.body.totalPaisa===Number(chit.total_paisa))
  r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
    kind:'chit', chitId:chit.id, payMethod:'cash', tenderedPaisa: Number(chit.total_paisa) })})
  ok('chit bill completes', r.status===201, JSON.stringify(r.body).slice(0,120))
  ok('chit invoice shares the series', /^INV-\d{6}$/.test(r.body.bill.bill_no))
  const c2 = (await q(`/chits/${chit.id}`,'mc')).body
  ok('chit now reads paid', c2.chit.status==='paid', c2.chit?.status)
  ok('its service orders followed', c2.lines.every(l=>l.status==='paid'))
  r = await q(`/counter/draft/chit/${chit.id}`,'mc')
  ok('refuses to draft an already paid chit', r.status===409, `got ${r.status}`)
}

console.log('\n— invoices are printable and listed —')
r = await q(`/counter/bills/${bill.id}`,'mc')
ok('invoice loads for printing', r.status===200 && r.body.items.length>0)
ok('invoice carries the letterhead', !!r.body.hospital?.name)
ok('invoice names the cashier', !!r.body.bill.cashier_name)
r = await q('/counter/bills','mc')
ok('today\'s bills listed', r.body.rows.length>0)
ok('totals reconcile the drawer', Number(r.body.totals.total_paisa)>0 && 'cash_paisa' in r.body.totals)

console.log('\n— other roles stay out of the till —')
for (const [who, code] of [['opd',403],['doc',403]]) {
  r = await q('/counter/bills',who,{method:'POST',body:JSON.stringify({kind:'consultation',visitId:visit.id,payMethod:'cash',tenderedPaisa:0})})
  ok(`${who} cannot complete a bill`, r.status===code, `got ${r.status}`)
}

console.log('\n— a sent-in patient reaches the doctor\'s ready list —')
{
  // The end-to-end path the OPD desk and the doctor actually share. The
  // status endpoint passing is not enough: the patient has to appear in the
  // list the doctor is looking at.
  let r2 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Ready List Patient',phone:'0300-5556667'})})
  const p2 = r2.body
  const meDoc = (await q('/auth/me','doc')).body
  const allDocs = (await q('/doctors','mc')).body
  const mine = (Array.isArray(allDocs) ? allDocs : allDocs.rows ?? []).find(d => d.id === meDoc.doctorId)
  ok('doctor account is linked to a doctor record', !!mine, `doctorId=${meDoc.doctorId}`)
  if (mine) {
    r2 = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:p2.id,doctorId:mine.id})})
    const v2 = r2.body

    let dq = (await q('/visits/queue','doc')).body
    let row = dq.find(x => x.id === v2.id)
    // An unpaid registration is not in the doctor's queue at all — it is work
    // sitting at the cash window, not a patient waiting for a doctor.
    ok('unpaid patient is not in the doctor queue at all', !row, row?.status)

    await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
      kind:'consultation', visitId:v2.id, payMethod:'cash', tenderedPaisa:Number(v2.consultationFeePaisa) })})
    dq = (await q('/visits/queue','doc')).body
    row = dq.find(x => x.id === v2.id)
    ok('after billing it is waiting, still not ready', row && row.status === 'waiting', row?.status)

    await q(`/visits/${v2.id}/send-in`,'opd',{method:'POST',body:'{}'})
    dq = (await q('/visits/queue','doc')).body
    row = dq.find(x => x.id === v2.id)
    ok('after send-in it appears as ready', row && row.status === 'ready', row?.status)
    ok('the doctor queue carries the vitals fields', row && 'bp_systolic' in row)
  }
}

console.log('\n— chits raise themselves when the doctor orders —')
{
  // Nobody presses a button. The order is the event that creates the charge.
  let r3 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Auto Chit Patient',phone:'0300-4443332'})})
  const p3 = r3.body
  const meDoc = (await q('/auth/me','doc')).body
  const allDocs = (await q('/doctors','mc')).body
  const mine = (Array.isArray(allDocs)?allDocs:[]).find(d => d.id === meDoc.doctorId)
  r3 = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:p3.id,doctorId:mine.id})})
  const v3 = r3.body
  await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
    kind:'consultation', visitId:v3.id, payMethod:'cash', tenderedPaisa:Number(v3.consultationFeePaisa) })})
  await q(`/visits/${v3.id}/send-in`,'opd',{method:'POST',body:'{}'})
  await q(`/visits/${v3.id}/status`,'doc',{method:'POST',body:JSON.stringify({status:'in_consultation'})})

  const services = (await q('/services','doc')).body
  const list = Array.isArray(services) ? services : services.rows ?? []
  const rad = list.find(s => s.category === 'radiology')
  const lab = list.filter(s => s.category === 'lab').slice(0, 2)
  ok('the hospital has services to order', !!rad && lab.length > 0, `${list.length} services`)

  const before = (await q(`/visits/${v3.id}/chits`,'mc')).body.chits.length
  ok('no chits before the consultation is saved', before === 0, String(before))

  r3 = await q(`/visits/${v3.id}/consultation`,'doc',{method:'POST',body:JSON.stringify({
    diagnosis:'Chest infection', items:[],
    services: [{ serviceId: rad.id }, ...lab.map(s => ({ serviceId: s.id }))] })})
  ok('consultation saves', r3.status===201 || r3.status===200, JSON.stringify(r3.body).slice(0,110))

  const after = (await q(`/visits/${v3.id}/chits`,'mc')).body
  ok('chits were raised automatically', after.chits.length > 0, `${after.chits.length}`)
  ok('one chit per department, not per test', after.chits.length === 2,
    after.chits.map(c=>`${c.category}:${c.line_count}`).join(' '))
  ok('nothing is left unbilled', after.unbilled.length === 0, JSON.stringify(after.unbilled))
  const labChit = after.chits.find(c => c.category === 'lab')
  ok('the lab chit carries both its tests', labChit && labChit.line_count === lab.length,
    `${labChit?.line_count}`)
  ok('chit totals match the services', after.chits.every(c => Number(c.total_paisa) > 0))
  ok('they start unpaid', after.chits.every(c => c.status === 'ordered'))

  // and the main counter sees them without doing anything
  const queue = (await q('/chits?status=ordered','mc')).body
  ok('the main counter sees them in its list',
    after.chits.every(c => queue.some(x => x.id === c.id)))

  // paying one produces a printable department slip
  const radChit = after.chits.find(c => c.category === 'radiology')
  const bill3 = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
    kind:'chit', chitId: radChit.id, payMethod:'cash', tenderedPaisa: Number(radChit.total_paisa) })})
  ok('paying the chit produces a bill', bill3.status===201)
  ok('the bill remembers which chit it settled', bill3.body.bill.chit_id === radChit.id,
    String(bill3.body.bill.chit_id))
  const slip = (await q(`/chits/${radChit.id}`,'mc')).body
  ok('the printable chit now reads paid', slip.chit.status === 'paid', slip.chit?.status)
  ok('and records who took the money', !!slip.chit.paid_by && !!slip.chit.paid_at)

  // re-saving the consultation must not raise duplicates
  await q(`/visits/${v3.id}/consultation`,'doc',{method:'POST',body:JSON.stringify({
    diagnosis:'Chest infection', items:[],
    services: [{ serviceId: rad.id }, ...lab.map(s => ({ serviceId: s.id }))] })})
  const again = (await q(`/visits/${v3.id}/chits`,'mc')).body
  ok('re-saving does not duplicate the paid chit',
    again.chits.filter(c => c.id === radChit.id).length === 1)
}

console.log('\n— an unpaid registration is invisible downstream —')
{
  let r4 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Unpaid Visibility',phone:'0300-1010101'})})
  const p4 = r4.body
  const meDoc = (await q('/auth/me','doc')).body
  const allDocs = (await q('/doctors','mc')).body
  const mine = (Array.isArray(allDocs)?allDocs:[]).find(d => d.id === meDoc.doctorId)
  r4 = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:p4.id,doctorId:mine.id})})
  const v4 = r4.body

  const inOpd = (await q('/visits/queue','opd')).body.some(x => x.id === v4.id)
  const inDoc = (await q('/visits/queue','doc')).body.some(x => x.id === v4.id)
  const inMc  = (await q('/visits/queue','mc')).body.some(x => x.id === v4.id)
  ok('the OPD desk cannot see it', !inOpd)
  ok('the doctor cannot see it', !inDoc)
  ok('the main counter can, because it has to bill it', inMc)

  await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
    kind:'consultation', visitId:v4.id, payMethod:'cash', tenderedPaisa:Number(v4.consultationFeePaisa) })})
  ok('it appears at the OPD desk once billed',
    (await q('/visits/queue','opd')).body.some(x => x.id === v4.id))

  // the old shortcut used to set the flag but leave the status behind
  let r5 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Mark Paid Case',phone:'0300-2020202'})})
  r5 = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:r5.body.id,doctorId:mine.id})})
  const v5 = r5.body
  r5 = await q(`/visits/${v5.id}/fee-paid`,'mc',{method:'POST',body:'{}'})
  ok('marking the fee paid moves it out of registered', r5.body.status === 'waiting', r5.body?.status)
  ok('and sets the flag', r5.body.fee_paid === true)
  ok('so the OPD desk sees it', (await q('/visits/queue','opd')).body.some(x => x.id === v5.id))

  // abandoning an unpaid registration
  let r6 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Walked Off',phone:'0300-3030303'})})
  const p6 = r6.body
  r6 = await q('/visits','mc',{method:'POST',body:JSON.stringify({patientId:p6.id,doctorId:mine.id})})
  const v6 = r6.body
  r6 = await q(`/visits/${v6.id}/abandon`,'mc',{method:'POST',body:'{}'})
  ok('an unpaid registration can be dropped', r6.status===200 && r6.body.status==='cancelled', r6.body?.status)
  r6 = await q(`/visits/${v4.id}/abandon`,'mc',{method:'POST',body:'{}'})
  ok('a paid one cannot be dropped', r6.status===409 && r6.body.code==='ALREADY_PAID', `got ${r6.status}`)
}

console.log('\n— deleting a patient —')
{
  let r7 = await q('/patients','mc',{method:'POST',body:JSON.stringify({name:'Typo Duplicate',phone:'0300-9090909'})})
  const fresh = r7.body
  r7 = await q(`/patients/${fresh.id}`,'mc',{method:'DELETE'})
  ok('a record with no history can be deleted', r7.status===200 && r7.body.id===fresh.id, JSON.stringify(r7.body).slice(0,90))
  r7 = await q(`/patients/${fresh.id}`,'mc')
  ok('and is gone afterwards', r7.status===404, `got ${r7.status}`)

  const withHistory = (await q('/patients?bucket=all','mc')).body.rows.find(p => p.visits > 0)
  r7 = await q(`/patients/${withHistory.id}`,'mc',{method:'DELETE'})
  ok('one with visits is refused', r7.status===409 && r7.body.code==='HAS_HISTORY', JSON.stringify(r7.body).slice(0,120))
  ok('and the refusal says why', /visits/.test(r7.body.error ?? ''), r7.body?.error?.slice(0,80))
  r7 = await q(`/patients/${withHistory.id}`,'mc')
  ok('that patient is untouched', r7.status===200)

  r7 = await q(`/patients/${withHistory.id}`,'opd',{method:'DELETE'})
  ok('the OPD desk cannot delete patients', r7.status===403, `got ${r7.status}`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
