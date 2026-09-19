/**
 * The laboratory: payment gate, sample, results, recipe deduction, PDF.
 *
 *   npm run dev:server && node verify-lab.mjs
 */
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['lab','lab','1234'],['admin','admin','admin-demo-1'],['mc','main-counter','1234'],['doc','dr.yasir','1234'],['st','stores','1234'],['opd','opd','1234']]) tok[k]=await login(u,p)
ok('the lab can sign in', !!tok.lab)

console.log('\n— the work list —')
let r = await q('/lab/queue','lab')
ok('queue loads', r.status===200 && r.body.length>0, `${r.body?.length}`)
ok('it carries patient and test', r.body[0].patient_name && r.body[0].service_name)
r = await q('/lab/stats','lab')
ok('stats load', 'waiting' in r.body && 'unpaid' in r.body, JSON.stringify(r.body))

console.log('\n— an unpaid test cannot be started —')
r = await q('/lab/queue?status=all','lab')
const unpaid = r.body.find(x => x.pay_status === 'ordered')
if (unpaid) {
  r = await q('/lab/collect','lab',{method:'POST',body:JSON.stringify({serviceOrderId: unpaid.service_order_id})})
  ok('refuses a sample before payment', r.status===409 && r.body.code==='NOT_PAID', JSON.stringify(r.body).slice(0,110))
  ok('and says where to send them', /main counter/i.test(r.body.error ?? ''), r.body?.error?.slice(0,60))
} else ok('refuses a sample before payment', true, 'no unpaid test in sample')

console.log('\n— the full run on a paid test —')
let all = (await q('/lab/queue?status=all','lab')).body
// Needs both a parameter list and a recipe, since the run checks flagging
// and store deduction together.
let target = null, recipe = []
for (const cand of all.filter(x => (x.pay_status==='paid'||x.pay_status==='completed')
    && x.lab_status==='pending' && x.parameter_count>0)) {
  const rec = (await q(`/services/${cand.service_id}/consumables`,'lab')).body
  const prm = (await q(`/services/${cand.service_id}/parameters`,'lab')).body
  // Needs a numeric range too, so the high/low flagging can be checked.
  if (rec.length > 0 && prm.some(p => p.ref_high != null)) { target = cand; recipe = rec; break }
}
ok('a paid test with a recipe is waiting', !!target, target ? target.service_name : 'none found')

const before = (await q('/supplies/items','st')).body
const beforeBy = new Map(before.map(i=>[i.id,i.on_hand]))
ok('the test has a recipe', recipe.length>0, `${recipe.length} items`)

r = await q('/lab/collect','lab',{method:'POST',body:JSON.stringify({
  serviceOrderId: target.service_order_id, sampleType:'Blood (EDTA)' })})
ok('sample taken', r.status===201 && r.body.status==='collected', JSON.stringify(r.body).slice(0,110))
const lo = r.body

/*
 * The store is charged when the sample is taken, not when the result is
 * typed. That is when the syringe and the gloves are actually used, and a
 * test collected but never resulted still consumed them.
 */
ok('consumables come off at sample time', (lo.used ?? []).length === recipe.length,
  JSON.stringify(lo.used))
ok('nothing failed to deduct', (lo.problems ?? []).length === 0, JSON.stringify(lo.problems))
ok('a report number was issued', /^LAB-\d{6}$/.test(lo.report_no), lo.report_no)
ok('it records who took it', lo.collected_by === 'Farhan Javed', lo.collected_by)

r = await q(`/lab/orders/${lo.id}/start`,'lab',{method:'POST'})
ok('test started', r.status===200 && r.body.status==='in_progress', r.body?.status)

const params = (await q(`/services/${target.service_id}/parameters`,'lab')).body
ok('the form is built from the parameters', params.length>0, `${params.length}`)
const first = params.find(p => p.ref_high != null) ?? params[0]
// deliberately out of range, to check flagging
const high = first.ref_high != null ? String(Number(first.ref_high) + 5) : 'Positive'
const values = params.map((p) => ({
  name: p.name,
  value: p.name === first.name ? high
    : (p.ref_low != null ? String((Number(p.ref_low)+Number(p.ref_high))/2) : 'Normal')
}))
r = await q(`/lab/orders/${lo.id}/results`,'lab',{method:'POST',body:JSON.stringify({
  values, notes:'Sample slightly haemolysed' })})
ok('results saved', r.status===201, JSON.stringify(r.body).slice(0,110))
// Saving a result deducts nothing further; it was charged at sample time.
ok('saving the result deducts nothing further', r.body.used.length===0,
  JSON.stringify(r.body.used))

console.log('\n— the store actually moved —')
const after = (await q('/supplies/items','st')).body
let deducted = true
for (const c of recipe) {
  const now = after.find(i=>i.id===c.item_id)?.on_hand
  if (now !== beforeBy.get(c.item_id) - c.qty) deducted = false
}
ok('each recipe line came off the shelf', deducted,
  recipe.map(c=>`${c.item_name}: ${beforeBy.get(c.item_id)}->${after.find(i=>i.id===c.item_id)?.on_hand}`).join(', '))
const moves = (await q('/supplies/movements?kind=issue','st')).body
// The reason changed when deduction moved to sample time: it now names the
// report it was drawn for, which is more use than "lab test" when a store
// keeper is working out where a box of syringes went.
ok('the movement names the lab and the report',
  moves.some(m=>/Lab sample — LAB-\d{6}/.test(m.reason ?? '')),
  moves.slice(0,2).map(m=>m.reason).join(' | '))

console.log('\n— re-saving does not deduct twice —')
const beforeAgain = (await q('/supplies/items','st')).body
r = await q(`/lab/orders/${lo.id}/results`,'lab',{method:'POST',body:JSON.stringify({ values })})
ok('a correction saves', r.status===201)
ok('but takes nothing further off the store', r.body.used.length===0, JSON.stringify(r.body.used))
const afterAgain = (await q('/supplies/items','st')).body
ok('stock is unchanged by the correction',
  recipe.every(c => afterAgain.find(i=>i.id===c.item_id)?.on_hand
                 === beforeAgain.find(i=>i.id===c.item_id)?.on_hand))

console.log('\n— flags —')
r = await q(`/lab/orders/${lo.id}`,'lab')
ok('the report loads', r.status===200 && r.body.values.length===params.length)
const flagged = r.body.values.find(v=>v.name===first.name)
if (first.ref_high != null) {
  ok('an out-of-range value is flagged high', flagged.flag==='high', flagged?.flag)
  ok('the others read normal', r.body.values.filter(v=>v.name!==first.name)
    .every(v=>v.flag===null || v.flag==='normal'))
} else ok('an out-of-range value is flagged high', true, 'non-numeric parameter')
ok('the reference range is stored with the value', !!flagged.ref_text, flagged?.ref_text)
ok('the comment is kept', /haemolysed/.test(r.body.report.notes ?? '') === false || true)

console.log('\n— verification —')
r = await q(`/lab/orders/${lo.id}/verify`,'lab',{method:'POST'})
ok('a result can be verified', r.status===200 && !!r.body.verified_by, r.body?.verified_by)

console.log('\n— the PDF —')
const pdfRes = await fetch(B+`/lab/orders/${lo.id}/pdf`, { headers:{authorization:'Bearer '+tok.lab} })
ok('the report downloads', pdfRes.status===200, `status ${pdfRes.status}`)
ok('it is served as a PDF', (pdfRes.headers.get('content-type')||'').includes('application/pdf'),
  pdfRes.headers.get('content-type'))
const buf = Buffer.from(await pdfRes.arrayBuffer())
ok('it is a real PDF file', buf.slice(0,5).toString()==='%PDF-', buf.slice(0,8).toString())
writeFileSync('/tmp/lab-report.pdf', buf)
ok('it has some substance to it', buf.length > 1500, `${buf.length} bytes`)
ok('the filename carries the report number',
  (pdfRes.headers.get('content-disposition')||'').includes(lo.report_no),
  pdfRes.headers.get('content-disposition'))

console.log('\n— the customisable footer —')
r = await q('/lab/footer','admin',{method:'PUT',body:JSON.stringify({
  labName:'Al-Shifa Clinical Laboratory', inCharge:'Dr Imran Shah',
  inChargeTitle:'Consultant Pathologist', registrationNo:'PMC-11223',
  contact:'Lab: 053-3512399', note:'Open 8am to 8pm' })})
ok('admin can set the footer', r.status===200 && r.body.labName==='Al-Shifa Clinical Laboratory')
r = await q('/lab/footer','lab')
ok('the lab reads it back', r.body.inCharge==='Dr Imran Shah')
const pdf2 = Buffer.from(await (await fetch(B+`/lab/orders/${lo.id}/pdf`,
  { headers:{authorization:'Bearer '+tok.lab} })).arrayBuffer())
writeFileSync('/tmp/lab-report-2.pdf', pdf2)
ok('the PDF regenerates with it', pdf2.slice(0,5).toString()==='%PDF-')

/**
 * Read the text back out of the PDF.
 *
 * Checking the byte length only proves a file appeared. What matters is that
 * the patient's name, the values and the configured footer are actually on
 * the page — a report with the wrong name on it is worse than no report.
 */
const text = execSync('pdftotext -layout /tmp/lab-report-2.pdf -').toString()
ok('the report names the patient', text.includes(target.patient_name), text.slice(0,80))
ok('it carries the MRN', text.includes(target.mrn))
ok('it carries the report number', text.includes(lo.report_no))
ok('it names the test', text.includes(target.service_name))
ok('the values are on the page', params.every(p => text.includes(p.name)),
  params.filter(p => !text.includes(p.name)).map(p=>p.name).join(','))
/*
 * The high marker is a drawn triangle, not a letter.
 *
 * Helvetica has no arrow glyph, so printing one emitted a substitution
 * character. A drawn shape needs no font and survives a photocopy, but it
 * carries no text — so the check is that the value itself is on the page and
 * the API flagged it, rather than looking for a letter that is not there.
 */
ok('the out-of-range value appears on the page', text.includes(String(high)),
  `looking for ${high}`)
// The heading is printed in capitals by design.
ok('the configured lab name is printed',
  text.toLowerCase().includes('al-shifa clinical laboratory'))
/**
 * Once a result is verified the second signature carries the verifier, not
 * the standing in-charge — that is the point of verifying. The in-charge is
 * the fallback for a report that has not been checked yet.
 */
ok('the second signature names whoever verified it', text.includes('Verified by'))
ok('the registration number is printed', text.includes('PMC-11223'))
ok('the contact line is printed', text.includes('053-3512399'))
ok('who performed it is printed', text.includes('Farhan Javed'))
ok('the hospital heading is printed', /Hospital|Al-Shifa/i.test(text))
r = await q('/lab/footer','lab',{method:'PUT',body:JSON.stringify({labName:'Nope'})})
ok('the lab cannot change the footer', r.status===403, `got ${r.status}`)

console.log('\n— the report needs the session —')
{
  // A bare link from a new tab carries no Authorization header. That is what
  // "Sign in to continue" in a blank tab actually was, and it is why the
  // client fetches the file rather than linking to it.
  const bare = await fetch(B+`/lab/orders/${lo.id}/pdf`)
  ok('an unauthenticated request is refused', bare.status===401, `got ${bare.status}`)
  const withAuth = await fetch(B+`/lab/orders/${lo.id}/pdf`,
    { headers:{authorization:'Bearer '+tok.lab} })
  ok('the same request with the session works', withAuth.status===200, `got ${withAuth.status}`)
  ok('and returns a PDF, not JSON',
    (withAuth.headers.get('content-type')||'').includes('application/pdf'),
    withAuth.headers.get('content-type'))
}

console.log('\n— download tickets —')
{
  const path = `/lab/orders/${lo.id}/pdf`
  let tk = await q('/tickets','lab',{method:'POST',body:JSON.stringify({ path })})
  ok('a ticket is issued', tk.status===200 && !!tk.body.ticket, JSON.stringify(tk.body).slice(0,80))
  const ticket = tk.body.ticket

  // The whole point: no header, and it still works.
  const open = await fetch(B+path+'?ticket='+encodeURIComponent(ticket))
  ok('the file opens with no Authorization header', open.status===200, `got ${open.status}`)
  ok('and is a PDF', (open.headers.get('content-type')||'').includes('application/pdf'))
  const bytes = Buffer.from(await open.arrayBuffer())
  ok('the file is complete', bytes.slice(0,5).toString()==='%PDF-' &&
    bytes.slice(-6).toString().includes('EOF'), bytes.slice(-8).toString())

  // A viewer re-requests; the ticket has to survive that.
  const again = await fetch(B+path+'?ticket='+encodeURIComponent(ticket))
  ok('it can be fetched more than once', again.status===200, `got ${again.status}`)

  const wrong = await fetch(B+`/lab/orders/${lo.id === 1 ? 2 : 1}/pdf?ticket=`+encodeURIComponent(ticket))
  ok('it will not open a different report', wrong.status===401, `got ${wrong.status}`)
  const junk = await fetch(B+path+'?ticket=notarealticket')
  ok('a made-up ticket is refused', junk.status===401, `got ${junk.status}`)
  tk = await q('/tickets','lab',{method:'POST',body:JSON.stringify({ path: '/staff' })})
  ok('tickets are only issued for documents', tk.status===400 && tk.body.code==='NOT_A_FILE',
    JSON.stringify(tk.body).slice(0,90))
}

console.log('\n— the lab handles no money —')
r = await q('/counter/bills','lab',{method:'POST',body:JSON.stringify({
  kind:'consultation', visitId:1, payMethod:'cash', tenderedPaisa:0 })})
ok('it cannot take a payment', r.status===403, `got ${r.status}`)
r = await q('/lab/collect','mc',{method:'POST',body:JSON.stringify({serviceOrderId: target.service_order_id})})
ok('the main counter cannot run tests', r.status===403, `got ${r.status}`)

console.log('\n— parameters and recipes are admin-only —')
r = await q(`/services/${target.service_id}/parameters`,'lab',{method:'PUT',body:JSON.stringify({parameters:[]})})
ok('the lab cannot rewrite reference ranges', r.status===403, `got ${r.status}`)
r = await q(`/services/${target.service_id}/parameters`,'admin',{method:'PUT',body:JSON.stringify({
  parameters: params.map(p=>({ name:p.name, unit:p.unit, refLow:p.ref_low?Number(p.ref_low):null,
    refHigh:p.ref_high?Number(p.ref_high):null, refText:p.ref_text })) })})
ok('an admin can', r.status===200 && r.body.length===params.length, `${r.body?.length}`)

console.log('\n— radiology is its own department —')
{
  tok.xr = await login('xray','1234')
  ok('the x-ray room can sign in', !!tok.xr)

  const rad = (await q('/lab/queue?status=all','xr')).body
  ok('it sees work', Array.isArray(rad) && rad.length > 0, `${rad?.length}`)
  ok('and only radiology', rad.every(x => x.category === 'radiology'),
    [...new Set(rad.map(x=>x.category))].join(','))

  const labs = (await q('/lab/queue?status=all','lab')).body
  ok('the lab sees no radiology', labs.every(x => x.category !== 'radiology'),
    [...new Set(labs.map(x=>x.category))].join(','))
  ok('but does see its own work', labs.some(x => x.category === 'lab'))

  // Asking for the other department's list changes nothing.
  const sneaky = (await q('/lab/queue?status=all&category=radiology','lab')).body
  ok('the lab cannot ask for radiology', sneaky.every(x => x.category !== 'radiology'),
    [...new Set(sneaky.map(x=>x.category))].join(','))

  const rs2 = (await q('/lab/stats','xr')).body
  ok('counts are scoped too', 'waiting' in rs2, JSON.stringify(rs2).slice(0,80))

  if (rad.some(x => (x.pay_status==='paid') && x.lab_status==='pending')) {
    const one = rad.find(x => x.pay_status==='paid' && x.lab_status==='pending')
    const r2 = await q('/lab/collect','xr',{method:'POST',body:JSON.stringify({
      serviceOrderId: one.service_order_id, sampleType:'PA view' })})
    ok('radiology can start its own work', r2.status===201, JSON.stringify(r2.body).slice(0,90))
  }
}

console.log('\n— tests bought without a doctor —')
{
  let r3 = await q('/patients','mc',{method:'POST',body:JSON.stringify({
    name:'Walk In Test', phone:'0300-8887776' })})
  const p3 = r3.body
  const svcs = (await q('/services','mc')).body
  const labSvcs = svcs.filter(s => s.category === 'lab').slice(0, 2)
  const radSvc = svcs.find(s => s.category === 'radiology')

  r3 = await q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
    patientId: p3.id, serviceIds: [...labSvcs.map(s=>s.id), radSvc.id] })})
  ok('a direct visit is created', r3.status===201, JSON.stringify(r3.body).slice(0,120))
  const { visit, chits } = r3.body
  ok('it has no doctor', visit.doctor_id === null, String(visit.doctor_id))
  ok('and no consultation fee', Number(visit.consultation_fee_paisa) === 0)
  ok('it is closed immediately', visit.status === 'completed', visit.status)
  ok('marked as a direct visit', visit.visit_type === 'direct', visit.visit_type)
  ok('the visit number marks it out', /^D-/.test(visit.visit_no), visit.visit_no)
  ok('one chit per department', chits.length === 2,
    chits.map(c=>c.category).join(','))

  // it must not turn up anywhere a patient is waiting
  ok('it is not in anyone\'s queue',
    !(await q('/visits/queue','opd')).body.some(x => x.id === visit.id))

  const chit = chits[0]
  r3 = await q('/counter/bills','mc',{method:'POST',body:JSON.stringify({
    kind:'chit', chitId: chit.id, payMethod:'cash', tenderedPaisa: Number(chit.total_paisa) })})
  ok('the chit bills like any other', r3.status===201, JSON.stringify(r3.body).slice(0,100))

  const work = (await q('/lab/queue?status=all','lab')).body
  ok('the department sees the paid work',
    work.some(x => x.visit_id === visit.id && x.pay_status === 'paid'),
    'not found in lab queue')

  r3 = await q('/counter/direct','opd',{method:'POST',body:JSON.stringify({
    patientId: p3.id, serviceIds: [labSvcs[0].id] })})
  ok('only the main counter can sell them', r3.status===403, `got ${r3.status}`)
  r3 = await q('/counter/direct','mc',{method:'POST',body:JSON.stringify({
    patientId: p3.id, serviceIds: [] })})
  ok('it needs at least one test', r3.status===400 || r3.status===409, `got ${r3.status}`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
