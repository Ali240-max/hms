/**
 * Screen smoke test: every data path the client mounts on load.
 *
 * Compiling is not the same as working — this catches a screen that type-checks
 * but asks the server for something that is not there.
 *
 *   npm run dev:server && node verify-screens.mjs
 *
 * Needs demo data loaded (npm run seed) on a database the OPD suite has not
 * reset, since that one wipes and creates its own users.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const today = new Date().toISOString().slice(0, 10)
const tok = {}
async function login(u,p){const r=await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})});return (await r.json()).token}
async function g(path, as){const r=await fetch(B+path,{headers:{authorization:'Bearer '+tok[as]}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
for(const [k,u,p] of [['admin','admin','admin-demo-1'],['mc','main-counter','1234'],['opd','opd','1234'],['doc','dr.yasir','1234'],['ph','pharmacy','1234']]) tok[k]=await login(u,p)
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}

console.log('\n— every screen loads its data —')
for (const [name, path, as] of [
  ['main counter desk', '/visits/queue', 'mc'],
  ['main counter stats', '/stats/today', 'mc'],
  ['opd counter queue', '/visits/queue', 'opd'],
  ['patient directory', '/patients?bucket=week', 'mc'],
  ['chit counter', '/chits?status=ordered', 'mc'],
  ['doctor queue', '/visits/queue', 'doc'],
  /*
   * The admin overview is built from two endpoints, not one. There has never
   * been an /admin/overview route — this line was checking a URL that was
   * never written, which is worse than not checking at all: it reported a
   * failure every run and told nobody anything true about the screen.
   */
  ['admin overview — today', '/stats/today', 'admin'],
  ['admin overview — earnings', `/earnings/all?from=${today}&to=${today}`, 'admin'],
  ['hospital settings', '/settings/hospital', 'admin'],
  ['backups', '/admin/backups', 'admin'],
  ['pharmacy inventory', '/pharmacy/inventory', 'ph'],
  ['pharmacy dashboard', '/pharmacy/dashboard?days=30', 'ph'],
  ['prescription queue', '/pharmacy/prescriptions', 'ph']
]) {
  const r = await g(path, as)
  ok(name, r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0,90)}`)
}

console.log('\n— doctor earnings screen shape —')
const from = new Date(Date.now()-30*86400000).toISOString().slice(0,10)
const to = new Date().toISOString().slice(0,10)
let r = await g(`/earnings/me?from=${from}&to=${to}`,'doc')
ok('earnings endpoint returns byPatient', Array.isArray(r.body.byPatient), Object.keys(r.body).join(','))
ok('byPatient rows carry every column',
  r.body.byPatient.length===0 || ['mrn','patient_name','consultation_paisa','radiology_paisa','lab_paisa','procedure_paisa','other_paisa','total_paisa'].every(k=>k in r.body.byPatient[0]))

console.log('\n— prescriptions still store a readable frequency —')
r = await g('/pharmacy/prescriptions','ph')
if (r.body.length) {
  const d = await g(`/visits/${r.body[0].visit_id}/prescription`,'doc')
  const freqs = d.body.items.map(i=>i.frequency).filter(Boolean)
  ok('frequency saved as standard shorthand',
    freqs.every(f=>['OD','BD','TDS','QID','SOS','STAT','Weekly'].includes(f)), freqs.join(','))
} else ok('frequency saved as standard shorthand', true, 'no pending prescriptions')

console.log('\n— future data keeps tomorrow populated —')
r = await g('/patients?bucket=all','mc')
const future = r.body.rows.filter(p=>p.last_visit && new Date(p.last_visit) > new Date())
ok('visits exist beyond today', future.length > 0, `${future.length} future`)
const far = r.body.rows.filter(p=>p.last_visit && new Date(p.last_visit) > new Date(Date.now()+30*86400000))
ok('and beyond a month out', far.length > 0, `${far.length}`)

console.log('\n— chit lifecycle is represented in demo data —')
r = await g('/chits?status=all','mc')
const st = new Set(r.body.map(c=>c.status))
ok('unpaid chits present', st.has('ordered'))
ok('paid chits present', st.has('paid'))
ok('completed chits present', st.has('completed'))



/* Appended: the counter split, reception overview, and print data. */
console.log('\n— the two tills stay separate —')
r = await g('/reception/overview?hours=24','mc')
ok('reception overview loads', r.status===200 && r.body.kpi, JSON.stringify(r.body).slice(0,90))
ok('reports consultation fees', 'collected_paisa' in r.body.kpi)
ok('hourly series covers the window', r.body.hourly.length >= 20, `${r.body.hourly?.length} hours`)
ok('chits shown separately from the drawer', 'unpaid_paisa' in r.body.chits)
ok('new vs returning split present', 'new_patients' in r.body.kpi && 'returning_patients' in r.body.kpi)

let paid = await g('/chits?status=ordered','ph')
if (paid.body.length) {
  const id = paid.body[0].id
  const bad = await fetch(B+`/chits/${id}/pay`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok['opd']},body:'{}'})
  ok('opd counter is refused at the API', bad.status===403, `got ${bad.status}`)
  const good = await fetch(B+`/chits/${id}/pay`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok['mc']},body:'{}'})
  ok('main counter is allowed', good.status===200, `got ${good.status}`)
}

console.log('\n— printable slips have what the paper needs —')
r = await g('/chits?status=all','ph')
const c0 = await g(`/chits/${r.body[0].id}`,'ph')
ok('chit slip carries letterhead', !!c0.body.hospital?.name)
ok('chit slip carries lines and total',
  c0.body.lines.length>0 && Number(c0.body.chit.total_paisa)>0)
r = await g('/pharmacy/sales?mode=all','ph')
if (r.body.rows.length) {
  const s = await g(`/pharmacy/sales/${r.body.rows[0].id}`,'ph')
  ok('bill receipt loads its items', s.status===200 && s.body.items.length>0)
  ok('receipt items carry batch for returns',
    s.body.items.every(i => 'batch_no' in i), Object.keys(s.body.items[0]||{}).join(','))
}

console.log('\n— pharmacy can see and search the chit queue —')
r = await g('/chits?status=ordered','ph')
ok('pharmacy sees unpaid chits', r.status===200 && Array.isArray(r.body))
if (r.body.length) {
  const s = await g(`/chits?q=${encodeURIComponent(r.body[0].mrn)}`,'ph')
  ok('pharmacy can search chits by MRN', s.body.length>0)
}
r = await g('/pharmacy/prescriptions?q=zzzzzz','ph')
ok('prescription search filters', Array.isArray(r.body) && r.body.length===0, `${r.body?.length}`)

console.log('\n— the OPD counter can do its job and nothing more —')
let vq = await g('/visits/queue','opd')
ok('opd sees the queue', vq.status===200 && Array.isArray(vq.body))
const waiting = vq.body.find(v => v.status==='waiting')
if (waiting) {
  let w = await fetch(B+`/visits/${waiting.id}/vitals`,{method:'PATCH',
    headers:{'content-type':'application/json',authorization:'Bearer '+tok['opd']},
    body: JSON.stringify({ complaint:'Chest tightness', bpSystolic:168, bpDiastolic:104, pulseBpm:92, temperatureF:99.2 })})
  ok('opd records vitals', w.status===200, `got ${w.status}`)
  const after = (await g('/visits/queue','opd')).body.find(v=>v.id===waiting.id)
  ok('vitals come back on the queue', after.bp_systolic===168 && after.complaint==='Chest tightness',
    JSON.stringify({bp:after.bp_systolic,c:after.complaint}))
  ok('vitals record who took them', !!after.vitals_by && !!after.vitals_at)
  const reg = await fetch(B+'/patients',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+tok['opd']},
    body: JSON.stringify({name:'Should Not Work'})})
  ok('opd cannot register patients', reg.status===403, `got ${reg.status}`)
  const fee = await fetch(B+`/visits/${waiting.id}/fee-paid`,{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+tok['opd']},body:'{}'})
  ok('opd cannot take the consultation fee', fee.status===403, `got ${fee.status}`)
  const bad = await fetch(B+'/visits/'+waiting.id+'/vitals',{method:'PATCH',
    headers:{'content-type':'application/json',authorization:'Bearer '+tok['opd']},
    body: JSON.stringify({ bpSystolic: 900 })})
  ok('impossible readings are rejected', bad.status===400 || bad.status===422, `got ${bad.status}`)
}
const mcReg = await fetch(B+'/patients',{method:'POST',
  headers:{'content-type':'application/json',authorization:'Bearer '+tok['mc']},
  body: JSON.stringify({name:'Counter Test Patient', phone:'0300-1234567'})})
ok('main counter can register', mcReg.status===201, `got ${mcReg.status}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
