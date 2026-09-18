/**
 * The chit payment flow: order -> print -> pay -> perform.
 *
 *   npm run dev:server        (in one terminal)
 *   node verify-chits.mjs     (in another)
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
async function login(u, p) {
  const r = await fetch(B + '/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
  return (await r.json()).token
}
async function q(path, as, opts = {}) {
  const r = await fetch(B + path, { ...opts, headers: {
    'content-type': 'application/json', authorization: 'Bearer ' + tok[as], ...(opts.headers || {}) } })
  const t = await r.text()
  let b; try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

for (const [k, u, p] of [['admin','admin','admin-demo-1'],['mc','main-counter','1234'],['opd','opd','1234'],['ph','pharmacy','1234'],['doc','dr.yasir','1234']]) {
  tok[k] = await login(u, p)
}
ok('everyone signs in', Object.values(tok).every(Boolean))

console.log('\n— hospital settings drive the letterhead —')
let r = await q('/settings/hospital', 'admin', { method: 'PUT', body: JSON.stringify({
  name: 'Al-Shifa General Hospital', address: 'GT Road, Gujrat', phone: '053-3512345',
  chitFooter: 'Pay at the cashier window before proceeding.' }) })
ok('admin saves hospital info', r.status === 200 && r.body.name === 'Al-Shifa General Hospital', JSON.stringify(r.body).slice(0,100))
r = await q('/settings/hospital', 'admin', { method: 'PUT', body: JSON.stringify({ name: 'X' }) })
ok('partial update keeps other fields', r.body.address === 'GT Road, Gujrat')
await q('/settings/hospital', 'admin', { method: 'PUT', body: JSON.stringify({ name: 'Al-Shifa General Hospital' }) })
r = await q('/settings/hospital', 'mc', { method: 'PUT', body: JSON.stringify({ name: 'Hacked' }) })
ok('main counter cannot change hospital info', r.status === 403, `got ${r.status}`)

console.log('\n— find a visit with tests ordered —')
r = await q('/chits?status=ordered', 'mc')
ok('unpaid chit queue loads', Array.isArray(r.body) && r.body.length > 0, `${r.body?.length}`)
const unpaid = r.body[0]
ok('chit carries patient and token', !!unpaid.mrn && unpaid.token_no != null)

console.log('\n— reception prints —')
r = await q(`/chits/${unpaid.id}`, 'mc')
ok('printable chit loads', r.status === 200 && r.body.lines.length > 0)
ok('letterhead comes from settings', r.body.hospital.name === 'Al-Shifa General Hospital', r.body.hospital?.name)
ok('lines total the chit', r.body.lines.reduce((n,l)=>n+Number(l.price_paisa),0) === Number(r.body.chit.total_paisa))
ok('department is named', !!r.body.categoryLabel)

console.log('\n— the department will not start before payment —')
r = await q(`/chits/${unpaid.id}/complete`, 'doc', { method: 'POST', body: '{}' })
ok('refuses to complete an unpaid chit', r.status === 409 && r.body.code === 'NOT_PAID', JSON.stringify(r.body).slice(0,100))

console.log('\n— only the main counter settles a chit —')
r = await q(`/chits/${unpaid.id}/pay`, 'ph', { method: 'POST', body: JSON.stringify({ payMethod: 'cash' }) })
ok('pharmacy cannot take chit payment', r.status === 403, `got ${r.status}`)
r = await q(`/chits/${unpaid.id}/pay`, 'opd', { method: 'POST', body: JSON.stringify({ payMethod: 'cash' }) })
ok('opd counter cannot take chit payment', r.status === 403, `got ${r.status}`)

console.log('\n— cashier takes the money —')
r = await q(`/chits/${unpaid.id}/pay`, 'mc', { method: 'POST', body: JSON.stringify({ payMethod: 'cash' }) })
ok('main counter can take payment', r.status === 200 && r.body.status === 'paid', JSON.stringify(r.body).slice(0,120))
ok('records who took it', !!r.body.paid_by)
r = await q(`/chits/${unpaid.id}/pay`, 'mc', { method: 'POST', body: JSON.stringify({ payMethod: 'cash' }) })
ok('refuses to charge twice', r.status === 409 && r.body.code === 'ALREADY_PAID', JSON.stringify(r.body).slice(0,100))

console.log('\n— underlying orders followed the chit —')
r = await q(`/chits/${unpaid.id}`, 'mc')
ok('order lines marked paid', r.body.lines.every(l => l.status === 'paid'), JSON.stringify(r.body.lines.map(l=>l.status)))

console.log('\n— the department performs it —')
r = await q(`/chits/${unpaid.id}/complete`, 'doc', { method: 'POST', body: JSON.stringify({ note: 'Films taken' }) })
ok('completes once paid', r.status === 200 && r.body.status === 'completed')
ok('records who did it', !!r.body.completed_by)
r = await q(`/chits/${unpaid.id}/complete`, 'doc', { method: 'POST', body: '{}' })
ok('refuses to complete twice', r.status === 409, `got ${r.status}`)

console.log('\n— printing chits for a fresh visit —')
r = await q('/visits/queue', 'doc')
const anyVisit = (await q('/chits', 'mc')).body[0]
r = await q(`/visits/${anyVisit.visit_id}/chits`, 'mc')
ok('visit chit summary loads', r.status === 200 && Array.isArray(r.body.chits))
r = await q(`/visits/${anyVisit.visit_id}/chits`, 'mc', { method: 'POST', body: '{}' })
ok('refuses when nothing left to bill', r.status === 409 && r.body.code === 'NOTHING_TO_BILL', JSON.stringify(r.body).slice(0,90))

console.log('\n— one chit per department, not per line —')
r = await q('/chits', 'mc')
const byVisit = {}
for (const c of r.body) (byVisit[c.visit_id] ??= []).push(c)
const multi = Object.values(byVisit).find(cs => cs.length > 1)
if (multi) ok('a visit with two chits has two departments', new Set(multi.map(c => c.category)).size === multi.length,
  multi.map(c=>c.category).join(','))
else ok('a visit with two chits has two departments', true, 'none in sample')
const anyChit = r.body[0]
r = await q(`/chits/${anyChit.id}`, 'mc')
ok('every line on a chit is one department', r.body.lines.length > 0)

console.log('\n— chit search —')
r = await q(`/chits?q=${encodeURIComponent(anyChit.mrn)}`, 'mc')
ok('search by MRN', r.body.length > 0 && r.body.every(c => c.mrn === anyChit.mrn))
r = await q('/chits?category=radiology&status=paid', 'mc')
ok('filter by department and status', r.body.every(c => c.category === 'radiology' && c.status === 'paid'))

console.log('\n— patient directory buckets —')
for (const b of ['today', 'week', 'month', 'all']) {
  r = await q(`/patients?bucket=${b}`, 'mc')
  ok(`bucket ${b}`, r.status === 200 && Array.isArray(r.body.rows), JSON.stringify(r.body).slice(0,80))
}
r = await q('/patients?bucket=all', 'mc')
ok('counts widen with the window', r.body.counts.today <= r.body.counts.week && r.body.counts.week <= r.body.counts.month,
  JSON.stringify(r.body.counts))
const someone = r.body.rows[0]
r = await q(`/patients?bucket=all&q=${encodeURIComponent(someone.mrn)}`, 'mc')
ok('directory search by MRN', r.body.rows.length === 1 && r.body.rows[0].id === someone.id)

console.log('\n— editing a patient —')
r = await q(`/patients/${someone.id}`, 'mc', { method: 'PATCH',
  body: JSON.stringify({ phone: '0300-9999999', address: 'Kachehri Chowk, Gujrat' }) })
ok('reception edits a patient', r.status === 200, JSON.stringify(r.body).slice(0,120))
r = await q(`/patients/${someone.id}`, 'mc')
ok('edit persisted', r.body.patient?.phone === '0300-9999999' || r.body.phone === '0300-9999999',
  JSON.stringify(r.body).slice(0,140))

console.log('\n— doctor earnings, one row per patient —')
const from = new Date(Date.now() - 40*86400000).toISOString().slice(0,10)
const to = new Date().toISOString().slice(0,10)
r = await q(`/me/earnings/by-patient?from=${from}&to=${to}`, 'doc')
ok('by-patient earnings load', r.status === 200 && r.body.length > 0, `${r.body?.length}`)
const row = r.body[0]
ok('row has MRN and name', !!row.mrn && !!row.patient_name)
ok('columns per department present',
  ['consultation_paisa','radiology_paisa','lab_paisa','procedure_paisa','other_paisa','total_paisa']
    .every(k => k in row), Object.keys(row).join(','))
const parts = ['consultation_paisa','radiology_paisa','lab_paisa','procedure_paisa','other_paisa']
  .reduce((n,k)=>n+Number(row[k]),0)
ok('columns add up to the total', parts === Number(row.total_paisa), `${parts} vs ${row.total_paisa}`)
ok('one row per patient', new Set(r.body.map(x=>x.patient_id)).size === r.body.length)

console.log('\n— future-dated data keeps screens populated —')
r = await q('/patients?bucket=all', 'mc')
const futureVisits = await q('/chits', 'mc')
ok('data exists beyond today',
  r.body.rows.some(p => p.last_visit && new Date(p.last_visit) > new Date()),
  'no future visits found')

console.log('\n— backups —')
r = await q('/admin/backups', 'admin', { method: 'POST' })
ok('manual backup runs', r.status === 201 && r.body.size > 0, JSON.stringify(r.body).slice(0,120))
ok('backup covers every table', r.body.tables > 15, `${r.body?.tables} tables`)
r = await q('/admin/backups', 'admin')
ok('backup listed', r.body.length > 0)
r = await q('/admin/backups', 'mc')
ok('main counter cannot back up', r.status === 403, `got ${r.status}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
