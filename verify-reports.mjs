/**
 * Every report in the system: it runs, it prints, and only the right people
 * can open it.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',...(as?{authorization:'Bearer '+tok[as]}:{}),...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['rep','reports','1234'],['admin','admin','admin-demo-1'],
  ['lab','lab','1234'],['xray','xray','1234'],['mc','main-counter','1234'],
  ['ph','pharmacy','1234'],['opd','opd','1234']]) tok[k]=await login(u,p)

const today = new Date().toISOString().slice(0,10)
const from = new Date(Date.now()-30*86400000).toISOString().slice(0,10)
const W = `from=${from}&to=${today}`

console.log('\n— the catalogue —')
let r = await q('/reports','rep')
ok('the reports desk signs in and sees the catalogue', r.status===200 && r.body.length>0,
  `${r.body?.length}`)
const all = r.body
ok('it covers every module',
  new Set(all.map(x=>x.module)).size === 5,
  [...new Set(all.map(x=>x.module))].join(','))
ok('every report declares its columns', all.every(x=>Array.isArray(x.columns) && x.columns.length))

console.log('\n— each module sees its own —')
for (const [who, mod, role] of [['lab','laboratory','lab_tech'],['xray','radiology','radiology'],
  ['mc','counter','main_counter'],['ph','pharmacy','pharmacist']]) {
  const list = (await q('/reports',who)).body
  ok(`${role} sees only ${mod}`, list.length>0 && list.every(x=>x.module===mod),
    [...new Set(list.map(x=>x.module))].join(','))
}
ok('an administrator sees all of them', (await q('/reports','admin')).body.length === all.length)
ok('the OPD desk sees none', (await q('/reports','opd')).body.length === 0)

console.log('\n— scoping is enforced, not merely hidden —')
const pharmaOnly = all.find(x=>x.module==='pharmacy')
r = await q(`/reports/run/${pharmaOnly.id}?${W}`,'lab')
ok('the lab cannot run a pharmacy report', r.status===403, `got ${r.status}`)
r = await q(`/reports/print/${pharmaOnly.id}/pdf?${W}`,'lab')
ok('nor print one', r.status===403, `got ${r.status}`)
const labOnly = all.find(x=>x.module==='laboratory')
r = await q(`/reports/run/${labOnly.id}?${W}`,'ph')
ok('the pharmacy cannot run a lab report', r.status===403, `got ${r.status}`)
r = await q(`/reports/run/${labOnly.id}?${W}`,'lab')
ok('but the lab can', r.status===200, `got ${r.status}`)

console.log('\n— every report runs and prints —')
let ran=0, printed=0, broke=[]
for (const def of all) {
  const run = await q(`/reports/run/${def.id}?${W}`,'rep')
  if (run.status!==200 || !Array.isArray(run.body.rows)) { broke.push(`${def.id} run=${run.status}`); continue }
  ran++
  const res = await fetch(`${B}/reports/print/${def.id}/pdf?${W}`,
    { headers: { authorization: 'Bearer '+tok.rep } })
  const buf = Buffer.from(await res.arrayBuffer())
  if (res.status===200 && buf.slice(0,5).toString()==='%PDF-') printed++
  else broke.push(`${def.id} pdf=${res.status}`)
}
ok('all of them run', ran===all.length, `${ran}/${all.length}`)
ok('all of them print a real PDF', printed===all.length, `${printed}/${all.length}`)
ok('nothing broke', broke.length===0, broke.slice(0,4).join('; '))

console.log('\n— totals add up —')
const daily = (await q(`/reports/run/counter-daily?${W}`,'rep')).body
if (daily.rows.length) {
  const sum = daily.rows.reduce((n,x)=>n+Number(x.taken_paisa),0)
  ok('the footer total matches the rows', Number(daily.totals.taken_paisa)===sum,
    `${daily.totals.taken_paisa} vs ${sum}`)
} else ok('the footer total matches the rows', true, 'no rows in window')

console.log('\n— a ticket opens a report without a header —')
{
  const path = `/reports/print/${all[0].id}/pdf`
  const tk = await q('/tickets','rep',{method:'POST',body:JSON.stringify({ path })})
  ok('a ticket is issued', tk.status===200 && !!tk.body.ticket, JSON.stringify(tk.body).slice(0,70))
  const res = await fetch(`${B}${path}?${W}&ticket=${encodeURIComponent(tk.body.ticket)}`)
  ok('and it opens the PDF', res.status===200 &&
    (res.headers.get('content-type')||'').includes('application/pdf'), `got ${res.status}`)
}

console.log('\n— the reports desk can only read —')
for (const [path, body] of [
  ['/patients', { name: 'Should Not Work' }],
  ['/counter/bills', { kind:'consultation', visitId:1, payMethod:'cash', tenderedPaisa:0 }],
  ['/pharmacy/sales', { lines:[], payMethod:'cash', paidPaisa:0 }]
]) {
  r = await q(path,'rep',{method:'POST',body:JSON.stringify(body)})
  ok(`it cannot post to ${path}`, r.status===403, `got ${r.status}`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
