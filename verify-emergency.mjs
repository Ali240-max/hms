/**
 * Emergency intake: treated first, billed afterwards.
 *
 *   npm run dev:server && node verify-emergency.mjs
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['er','emergency','1234'],['mc','main-counter','1234'],['ph','pharmacy','1234'],['opd','opd','1234'],['doc','dr.yasir','1234']]) tok[k]=await login(u,p)
ok('the emergency desk can sign in', !!tok.er)

console.log('\n— an arrival is live immediately —')
let r = await q('/patients','er',{method:'POST',body:JSON.stringify({name:'Accident Case', ageYears:34, gender:'male'})})
ok('the desk can register an arrival', r.status===201, JSON.stringify(r.body).slice(0,90))
const pt = r.body
const docs = (await q('/doctors','er')).body
const duty = docs[0]
r = await q('/ipd/visits','er',{method:'POST',body:JSON.stringify({
  patientId: pt.id, doctorId: duty.id, triage:'critical',
  arrivalNote:'Road accident, head injury', broughtBy:'Rescue 1122' })})
ok('emergency visit created', r.status===201, JSON.stringify(r.body).slice(0,140))
const v = r.body
ok('it is live, not held at registered', v.status==='ready', v.status)
ok('marked as an emergency visit', v.visit_type==='emergency', v.visit_type)
ok('the fee is unpaid but recorded', v.fee_paid===false && Number(v.consultation_fee_paisa)>0)
ok('triage is kept', v.triage==='critical')
ok('the visit number marks it out as emergency',
  /^VIS-\d{6}-E\d{5}$/.test(v.visit_no), v.visit_no)

console.log('\n— it does NOT wait behind the payment gate —')
ok('the doctor can see it straight away',
  (await q('/visits/queue','doc')).body.some(x=>x.id===v.id) ||
  (await q('/visits/queue?doctor='+duty.id,'mc')).body.some(x=>x.id===v.id))
const floor = (await q('/ipd/queue','er')).body
ok('it is on the emergency floor list', floor.some(x=>x.id===v.id))
ok('critical sorts to the top', floor[0].triage==='critical', floor[0]?.triage)

console.log('\n— the main counter collects the fee afterwards —')
ok('the main counter sees it', (await q('/visits/queue','mc')).body.some(x=>x.id===v.id))
r = await q(`/counter/draft/visit/${v.id}`,'mc')
ok('it can be billed like any consultation', r.status===200 && r.body.totalPaisa>0)
r = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId:v.id, payMethod:'cash', tenderedPaisa:Number(v.consultation_fee_paisa) })})
ok('the fee can be taken later', r.status===201, JSON.stringify(r.body).slice(0,110))
r = await q(`/visits/${v.id}`,'mc')
const after = r.body.visit ?? r.body
ok('paying does not knock it back into the OPD queue', after.status !== 'waiting', after.status)

console.log('\n— bedside medicines reach the pharmacy —')
// Needs at least one whole pack: a product with 37 loose units of a
// 100-pack cannot be sold by the pack, which is correct behaviour.
const meds = (await q('/pharmacy/inventory','ph')).body
  .filter(p => p.in_stock >= (p.pack_size || 1)).slice(0,2)
ok('there is stock to give', meds.length>0)
r = await q(`/ipd/visits/${v.id}/medicines`,'er',{method:'POST',body:JSON.stringify({
  items:[{ productId: meds[0].id, drugName: meds[0].name, dose:'1 amp IV', qtyPrescribed:2 },
         { productId: null, drugName:'Normal saline 1L', qtyPrescribed:1 }] })})
ok('the desk records what was used', r.status===201, JSON.stringify(r.body).slice(0,110))
ok('both lines saved', r.body.items.length===2, String(r.body.items?.length))

const queue = (await q('/pharmacy/prescriptions','ph')).body
const mine = queue.find(x=>x.visit_id===v.id)
ok('the pharmacy sees it in its own queue', !!mine, `${queue.length} in queue`)
ok('flagged as emergency', mine && mine.visit_type==='emergency', mine?.visit_type)
ok('emergency work sorts first', queue[0].visit_type==='emergency', queue[0]?.visit_type)

console.log('\n— appending, not replacing —')
r = await q(`/ipd/visits/${v.id}/medicines`,'er',{method:'POST',body:JSON.stringify({
  items:[{ productId: meds[1]?.id ?? null, drugName: meds[1]?.name ?? 'Diclofenac', qtyPrescribed:1 }] })})
ok('a second burst is added to the same list', r.body.items.length===3, String(r.body.items?.length))

console.log('\n— the pharmacy takes the money —')
r = await q('/pharmacy/sales','ph',{method:'POST',body:JSON.stringify({
  lines:[{ productId: meds[0].id, qty: 2,
           soldAs: meds[0].allow_loose ? 'unit' : 'pack' }], payMethod:'cash', paidPaisa: 10000000,
  visitId: v.id, patientId: pt.id })})
ok('the sale completes', r.status===201, JSON.stringify(r.body).slice(0,110))
const pres = (await q(`/visits/${v.id}/prescription`,'ph')).body
const dispensed = pres.items.find(i=>i.product_id===meds[0].id)
ok('that line is marked collected', dispensed && dispensed.status==='dispensed', dispensed?.status)
const saline = pres.items.find(i=>!i.product_id)
ok('the item pharmacy does not stock stays pending', saline && saline.status==='pending', saline?.status)

console.log('\n— what is still owed —')
r = await q(`/ipd/visits/${v.id}/dues`,'er')
ok('dues are reported', r.status===200 && 'medsPending' in r.body, JSON.stringify(r.body).slice(0,110))
ok('the consultation now reads settled', r.body.consultationPaisa===0 && r.body.feePaid===true)
ok('outstanding medicines are counted', r.body.medsPending>0, String(r.body.medsPending))

console.log('\n— closing the visit —')
r = await q(`/ipd/visits/${v.id}/close`,'er',{method:'POST',body:JSON.stringify({outcome:'Admitted to ward'})})
ok('the desk can close it', r.status===200 && r.body.status==='completed', r.body?.status)
ok('the outcome is recorded', /Admitted to ward/.test(r.body.arrival_note ?? ''), r.body?.arrival_note?.slice(0,60))
ok('it leaves the floor list', !(await q('/ipd/queue','er')).body.some(x=>x.id===v.id))
ok('but is still reachable with all=1', (await q('/ipd/queue?all=1','er')).body.some(x=>x.id===v.id))
r = await q(`/ipd/visits/${v.id}/medicines`,'er',{method:'POST',body:JSON.stringify({
  items:[{ drugName:'Too late', qtyPrescribed:1 }] })})
ok('a closed visit takes no more medicines', r.status===409 && r.body.code==='CLOSED', `got ${r.status}`)

console.log('\n— the desk handles no money —')
for (const [path, body] of [['/counter/bills', {kind:'consultation',visitId:v.id,payMethod:'cash',tenderedPaisa:0}]]) {
  r = await q(path,'er',{method:'POST',body:JSON.stringify(body)})
  ok('the emergency desk cannot complete a bill', r.status===403, `got ${r.status}`)
}
r = await q('/ipd/visits','opd',{method:'POST',body:JSON.stringify({patientId:pt.id,doctorId:duty.id})})
ok('the OPD desk cannot admit to emergency', r.status===403, `got ${r.status}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
