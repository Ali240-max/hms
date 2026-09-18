/**
 * Module toggles: hide what a hospital is not using, delete nothing.
 *
 *   npm run dev:server && node verify-modules.mjs
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',...(as?{authorization:'Bearer '+tok[as]}:{}),...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['admin','admin','admin-demo-1'],['doc','dr.yasir','1234'],['mc','main-counter','1234']]) tok[k]=await login(u,p)

console.log('\n— everything is on to begin with —')
let r = await q('/modules', null)
ok('readable without signing in', r.status===200, `got ${r.status}`)
ok('the sign-in screen needs this before anyone has a session',
  typeof r.body.doctor === 'boolean', JSON.stringify(r.body).slice(0,90))
ok('all seven modules reported', Object.keys(r.body).length===7, Object.keys(r.body).join(','))
ok('default is everything on', Object.values(r.body).every(v=>v===true))

console.log('\n— switching the doctor terminal off —')
r = await q('/modules','admin',{method:'PUT',body:JSON.stringify({ doctor:false })})
ok('admin can switch it off', r.status===200 && r.body.doctor===false, JSON.stringify(r.body).slice(0,80))
ok('it leaves the others alone', r.body.laboratory===true && r.body.radiology===true)
r = await q('/modules', null)
ok('and it persists', r.body.doctor===false)

console.log('\n— off hides, it does not block —')
/*
 * The important property. A hospital that switches the doctor terminal on in
 * March must find its January data exactly where it left it, so turning a
 * module off must never refuse an API call or hide a row. If it did, the
 * toggle would be a migration and switching back would lose work.
 */
r = await q('/visits/queue','doc')
ok('a doctor can still sign in and see their queue', r.status===200 && Array.isArray(r.body),
  `got ${r.status}`)
r = await q('/doctors','mc')
ok('doctors are still listed for the counter', r.status===200 && r.body.length>0,
  `${r.body?.length}`)
const visits = (await q('/visits/queue','mc')).body
ok('existing visits are untouched', Array.isArray(visits))

console.log('\n— only an admin decides —')
for (const who of ['doc','mc']) {
  r = await q('/modules',who,{method:'PUT',body:JSON.stringify({ doctor:true })})
  ok(`${who} cannot change modules`, r.status===403, `got ${r.status}`)
}

console.log('\n— switching it back —')
r = await q('/modules','admin',{method:'PUT',body:JSON.stringify({ doctor:true })})
ok('it comes back on', r.body.doctor===true)
r = await q('/modules','admin',{method:'PUT',body:JSON.stringify({
  pharmacy:false, emergency:false, stores:false })})
ok('several can be set at once',
  r.body.pharmacy===false && r.body.emergency===false && r.body.stores===false,
  JSON.stringify(r.body))
ok('and the rest stay on', r.body.doctor===true && r.body.laboratory===true)
r = await q('/modules','admin',{method:'PUT',body:JSON.stringify({ nonsense:true })})
ok('an unknown module is ignored rather than stored',
  !('nonsense' in r.body), Object.keys(r.body).join(','))

// leave the demo as we found it
await q('/modules','admin',{method:'PUT',body:JSON.stringify({
  doctor:true, opdCounter:true, pharmacy:true, laboratory:true,
  radiology:true, emergency:true, stores:true })})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
