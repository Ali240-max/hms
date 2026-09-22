/**
 * Clearing the system: every lock holds, a backup is taken, configuration survives.
 *
 * Runs against a scratch database. It deletes everything on purpose.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
tok.admin = await login('admin','admin-demo-1')
tok.mc = await login('main-counter','1234')

const hospital = (await q('/settings/hospital','admin')).body
console.log(`\n— hospital is "${hospital.name}" —`)

console.log('\n— the preview says what goes and what stays —')
let r = await q('/admin/wipe-preview','admin')
ok('a preview is offered', r.status===200 && Array.isArray(r.body.willDelete))
ok('it counts what would go', r.body.totalRows > 0, String(r.body.totalRows))
ok('and lists what would stay', r.body.willKeep.some(k=>k.table==='staff' && k.rows>0))
const before = r.body.totalRows
const staffBefore = r.body.willKeep.find(k=>k.table==='staff').rows
const servicesBefore = r.body.willKeep.find(k=>k.table==='services').rows

console.log('\n— every lock holds —')
r = await q('/admin/wipe','mc',{method:'POST',body:JSON.stringify({
  password:'admin-demo-1', typedName: hospital.name })})
ok('only an administrator may ask', r.status===403, `got ${r.status}`)

r = await q('/admin/wipe','admin',{method:'POST',body:JSON.stringify({
  password:'wrong-password', typedName: hospital.name })})
ok('a wrong password is refused', r.status===409 && r.body.code==='WRONG_PASSWORD',
  JSON.stringify(r.body).slice(0,90))

r = await q('/admin/wipe','admin',{method:'POST',body:JSON.stringify({
  password:'admin-demo-1', typedName:'Some Other Hospital' })})
ok('a wrong hospital name is refused', r.status===409 && r.body.code==='WRONG_NAME',
  JSON.stringify(r.body).slice(0,90))

r = await q('/admin/wipe-preview','admin')
ok('and none of that deleted anything', r.body.totalRows === before,
  `${before} then ${r.body.totalRows}`)

console.log('\n— the real thing —')
r = await q('/admin/wipe','admin',{method:'POST',body:JSON.stringify({
  password:'admin-demo-1', typedName: hospital.name })})
ok('it runs with the right password and name', r.status===200, JSON.stringify(r.body).slice(0,110))
ok('a backup file was written first', typeof r.body.backup === 'string' && r.body.backup.endsWith('.gz'),
  r.body?.backup)
ok('it reports what it deleted', Object.keys(r.body.deleted ?? {}).length > 0)

console.log('\n— what survived —')
r = await q('/admin/wipe-preview','admin')
ok('no trading data is left', r.body.totalRows === 0, String(r.body.totalRows))
ok('staff accounts survived',
  r.body.willKeep.find(k=>k.table==='staff').rows === staffBefore,
  `${staffBefore} -> ${r.body.willKeep.find(k=>k.table==='staff').rows}`)
ok('services survived',
  r.body.willKeep.find(k=>k.table==='services').rows === servicesBefore)
ok('the medicine list survived',
  (r.body.willKeep.find(k=>k.table==='products')?.rows ?? 0) > 0)

ok('the administrator can still sign in', !!(await login('admin','admin-demo-1')))
ok('the counter can still sign in', !!(await login('main-counter','1234')))

console.log('\n— numbering starts again —')
{
  const pt = (await q('/patients','mc',{method:'POST',body:JSON.stringify({ name:'After Wipe' })})).body
  ok('the first patient is MRN-000001', pt.mrn === 'MRN-000001', pt.mrn)
  const docs = (await q('/doctors','mc')).body
  const v = (await q('/visits','mc',{method:'POST',body:JSON.stringify({
    patientId: pt.id, doctorId: docs[0].id })})).body
  ok('the first visit ends in 00001',
    /00001$/.test(v.visitNo ?? v.visit_no ?? ''), v.visitNo ?? v.visit_no)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
