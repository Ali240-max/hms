/**
 * Hospital stores: receive, issue FEFO, write off, count.
 *
 *   npm run dev:server && node verify-supplies.mjs
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+tok[as],...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['st','stores','1234'],['admin','admin','admin-demo-1'],['ph','pharmacy','1234'],['opd','opd','1234']]) tok[k]=await login(u,p)
ok('the store keeper can sign in', !!tok.st)

console.log('\n— an item and its stock —')
let r = await q('/supplies/items','st',{method:'POST',body:JSON.stringify({
  name:'Verify Cannula 22G', category:'consumable', unitLabel:'piece',
  reorderLevel:50, tracksExpiry:true, storageNote:'Shelf C' })})
ok('item created', r.status===201, JSON.stringify(r.body).slice(0,100))
const item = r.body
r = await q(`/supplies/items?q=${encodeURIComponent('Verify Cannula')}`,'st')
ok('it appears in the list', r.body.length===1 && r.body[0].on_hand===0, JSON.stringify(r.body[0]?.on_hand))

console.log('\n— receiving —')
const soon = new Date(Date.now()+30*86400000).toISOString().slice(0,10)
const later = new Date(Date.now()+400*86400000).toISOString().slice(0,10)
r = await q('/supplies/receive','st',{method:'POST',body:JSON.stringify({
  invoiceNo:'SUP-1',
  lines:[{ itemId:item.id, batchNo:'LATER', expiryDate:later, qty:100, costPaisa:3000 },
         { itemId:item.id, batchNo:'SOON',  expiryDate:soon,  qty:40,  costPaisa:3000 }] })})
ok('two batches received', r.status===201 && r.body.length===2, JSON.stringify(r.body).slice(0,90))
r = await q(`/supplies/items?q=${encodeURIComponent('Verify Cannula')}`,'st')
ok('stock is the sum of both', r.body[0].on_hand===140, String(r.body[0].on_hand))
ok('value is counted', Number(r.body[0].value_paisa)===140*3000, String(r.body[0].value_paisa))
ok('nearest expiry is the soonest', r.body[0].nearest_expiry===soon, r.body[0].nearest_expiry)

console.log('\n— issuing takes the nearest expiry first —')
r = await q('/supplies/issue','st',{method:'POST',body:JSON.stringify({
  itemId:item.id, qty:10, issuedTo:'Staff nurse', reason:'Trolley restock' })})
ok('issue succeeds', r.status===201, JSON.stringify(r.body).slice(0,110))
ok('it came from the SOON batch', r.body.taken[0].batchNo==='SOON', r.body.taken[0]?.batchNo)

r = await q('/supplies/issue','st',{method:'POST',body:JSON.stringify({ itemId:item.id, qty:40 })})
ok('an issue spanning two batches works', r.status===201 && r.body.taken.length===2,
  JSON.stringify(r.body.taken?.map(t=>`${t.batchNo}:${t.qty}`)))
ok('it finishes SOON before touching LATER',
  r.body.taken[0].batchNo==='SOON' && r.body.taken[0].qty===30 && r.body.taken[1].batchNo==='LATER',
  JSON.stringify(r.body.taken))

r = await q(`/supplies/items?q=${encodeURIComponent('Verify Cannula')}`,'st')
ok('stock fell by 50', r.body[0].on_hand===90, String(r.body[0].on_hand))

console.log('\n— it will not go negative —')
r = await q('/supplies/issue','st',{method:'POST',body:JSON.stringify({ itemId:item.id, qty:9999 })})
ok('over-issue refused', r.status===409 && r.body.code==='NO_STOCK', JSON.stringify(r.body).slice(0,110))
ok('the refusal says how many there are', /90/.test(r.body.error ?? ''), r.body?.error?.slice(0,70))
r = await q(`/supplies/items?q=${encodeURIComponent('Verify Cannula')}`,'st')
ok('the failed issue changed nothing', r.body[0].on_hand===90, String(r.body[0].on_hand))
r = await q('/supplies/issue','st',{method:'POST',body:JSON.stringify({ itemId:item.id, qty:0 })})
ok('zero quantity refused', r.status===400 || r.status===409, `got ${r.status}`)

console.log('\n— writing off and counting —')
r = await q('/supplies/waste','st',{method:'POST',body:JSON.stringify({
  itemId:item.id, qty:5, reason:'Packet torn' })})
ok('write-off works', r.status===201)
r = await q('/supplies/adjust','st',{method:'POST',body:JSON.stringify({
  itemId:item.id, countedQty:80, reason:'Monthly count' })})
ok('a count that disagrees is recorded', r.status===201 && r.body.diff===-5,
  JSON.stringify(r.body))
r = await q(`/supplies/items?q=${encodeURIComponent('Verify Cannula')}`,'st')
ok('stock now matches the count', r.body[0].on_hand===80, String(r.body[0].on_hand))
r = await q('/supplies/adjust','st',{method:'POST',body:JSON.stringify({
  itemId:item.id, countedQty:80, reason:'Again' })})
ok('a count that agrees changes nothing', r.body.diff===0, JSON.stringify(r.body))

console.log('\n— the ledger explains the stock —')
r = await q(`/supplies/movements?item=${item.id}`,'st')
const kinds = r.body.map(m=>m.kind)
ok('every kind of movement is recorded',
  ['receive','issue','waste','adjust'].every(k=>kinds.includes(k)), kinds.join(','))
const net = r.body.reduce((n,m)=>n+Number(m.qty),0)
ok('the movements add up to the stock on hand', net===80, String(net))
ok('the count carries its reason',
  r.body.some(m=>m.kind==='adjust' && /Monthly count/.test(m.reason ?? '')))
ok('issues record who took them',
  r.body.some(m=>m.kind==='issue' && m.issued_to==='Staff nurse'))

console.log('\n— archiving —')
r = await q(`/supplies/items/${item.id}/archive`,'st',{method:'POST'})
ok('refuses while stock remains', r.status===409 && r.body.code==='IN_USE', JSON.stringify(r.body).slice(0,100))
await q('/supplies/waste','st',{method:'POST',body:JSON.stringify({ itemId:item.id, qty:80, reason:'Clearing for test' })})
r = await q(`/supplies/items/${item.id}/archive`,'st',{method:'POST'})
ok('archives once empty', r.status===200 && r.body.is_active===false, JSON.stringify(r.body).slice(0,80))

console.log('\n— reports —')
r = await q('/supplies/reports?days=30','st')
ok('reports load', r.status===200 && Array.isArray(r.body.byDepartment))
ok('consumption is grouped by department', r.body.byDepartment.length>0, `${r.body.byDepartment?.length}`)
ok('most-used items listed', r.body.topConsumed.length>0)
ok('expiring batches listed', Array.isArray(r.body.expiring))
r = await q('/supplies/summary','st')
ok('summary counts low stock', 'low_count' in r.body && 'total_value_paisa' in r.body,
  JSON.stringify(r.body).slice(0,110))

console.log('\n— days of cover —')
r = await q('/supplies/items','st')
const withBurn = r.body.filter(i=>Number(i.per_day)>0)
ok('cover is worked out from real usage', withBurn.length>0, `${withBurn.length} items`)
ok('cover is a sane number', withBurn.every(i=>i.days_left===null || i.days_left>=0))

console.log('\n— only the store changes stock —')
for (const who of ['ph','opd']) {
  r = await q('/supplies/issue',who,{method:'POST',body:JSON.stringify({ itemId:item.id, qty:1 })})
  ok(`${who} cannot issue stock`, r.status===403, `got ${r.status}`)
}
r = await q('/supplies/items','ph')
ok('but anyone can see what is on the shelf', r.status===200 && Array.isArray(r.body))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
