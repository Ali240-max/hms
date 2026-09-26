/**
 * What a second administrator may change.
 *
 * The powers that matter are the quiet ones: a price, a doctor's share,
 * clearing the system. None of them leaves a mark on screen afterwards, so an
 * unticked box has to be a refusal at the server and not a hidden button.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login = async (u, p) => (await (await fetch(B + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p })
})).json()).token
const q = async (path, as, o = {}) => {
  const r = await fetch(B + path, {
    ...o,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok[as], ...(o.headers || {}) }
  })
  const t = await r.text(); let b
  try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

tok.root = await login('admin', 'admin-demo-1')

console.log('\n— the catalogue —')
let r = await q('/admin/permissions', 'root')
ok('there is a list of named powers', r.status === 200 && r.body.length >= 12, `${r.body?.length}`)
const guarded = r.body.filter((p) => p.guarded).map((p) => p.key)
ok('the dangerous ones are marked as granted deliberately',
  ['admin.wipe', 'admin.services.price', 'admin.shares', 'admin.access']
    .every((k) => guarded.includes(k)), guarded.join(','))

console.log('\n— the first administrator cannot be cut down —')
r = await q('/admin/permissions/me', 'root')
ok('it holds everything', r.body.isRoot === true && r.body.allowed.length >= 12,
  `${r.body?.allowed?.length}`)
const accounts = (await q('/admin/accounts', 'root')).body
const root = accounts.find((a) => a.is_root)
ok('exactly one account is the root one', accounts.filter((a) => a.is_root).length === 1)
r = await q(`/admin/permissions/${root.id}`, 'root', {
  method: 'PUT', body: JSON.stringify({ allowed: [] })
})
ok('restricting it is refused', r.status === 409, `got ${r.status}`)
r = await q('/admin/permissions/me', 'root')
ok('and it still holds everything', r.body.allowed.length >= 12)

console.log('\n— a second administrator —')
const uname = 'subadmin' + Date.now().toString().slice(-5)
const sub = (await q('/staff', 'root', {
  method: 'POST',
  body: JSON.stringify({ username: uname, displayName: 'Sub Admin', password: 'sub-admin-1', role: 'admin' })
})).body
ok('can be created', !!sub.id, JSON.stringify(sub).slice(0, 80))

r = await q(`/admin/permissions/${sub.id}`, 'root')
const defaults = r.body.allowed
ok('starts without the guarded powers',
  guarded.every((k) => !defaults.includes(k)), defaults.filter((k) => guarded.includes(k)).join(','))
ok('but with the ordinary ones', defaults.includes('admin.overview') && defaults.includes('admin.staff.view'))

tok.sub = await login(uname, 'sub-admin-1')

console.log('\n— what it is refused, at the server —')
for (const [path, method, key] of [
  ['/admin/wipe-preview', 'GET', 'admin.wipe'],
  ['/modules', 'PUT', 'admin.modules'],
  ['/settings/hospital', 'PUT', 'admin.settings'],
  ['/admin/accounts', 'GET', 'admin.access']
]) {
  // Guarded from the start, except modules and settings which are defaults —
  // so cut those two down first and check both directions.
  const shouldPass = defaults.includes(key)
  r = await q(path, 'sub', { method, body: method === 'GET' ? undefined : JSON.stringify({}) })
  ok(`${method} ${path} ${shouldPass ? 'allowed by default' : 'refused'}`,
    shouldPass ? r.status !== 403 : r.status === 403, `got ${r.status}`)
}

console.log('\n— taking a power away bites immediately —')
await q(`/admin/permissions/${sub.id}`, 'root', {
  method: 'PUT', body: JSON.stringify({ allowed: ['admin.overview', 'admin.reports'] })
})
for (const [path, method] of [['/modules', 'PUT'], ['/settings/hospital', 'PUT'],
  ['/staff', 'POST'], ['/admin/backups', 'GET'], ['/departments', 'POST']]) {
  r = await q(path, 'sub', { method, body: method === 'GET' ? undefined : JSON.stringify({}) })
  ok(`${method} ${path} is now refused`, r.status === 403, `got ${r.status}`)
}
ok('what it kept still works', (await q('/stats/today', 'sub')).status === 200)
ok('and reports still work', (await q('/reports', 'sub')).status === 200)

console.log('\n— giving one back —')
await q(`/admin/permissions/${sub.id}`, 'root', {
  method: 'PUT', body: JSON.stringify({ allowed: ['admin.overview', 'admin.reports', 'admin.departments'] })
})
const stamp = Date.now().toString().slice(-4)
r = await q('/departments', 'sub', {
  method: 'POST', body: JSON.stringify({ name: 'Perm Test ' + stamp, code: 'PT' + stamp })
})
ok('the department it was granted now saves', r.status === 201 || r.status === 200, `got ${r.status}`)
r = await q('/modules', 'sub', { method: 'PUT', body: JSON.stringify({}) })
ok('and the one it was not is still refused', r.status === 403, `got ${r.status}`)

console.log('\n— it cannot grant itself anything —')
r = await q(`/admin/permissions/${sub.id}`, 'sub', {
  method: 'PUT', body: JSON.stringify({ allowed: ['admin.wipe'] })
})
ok('editing its own permissions is refused', r.status === 403, `got ${r.status}`)
r = await q('/admin/permissions/me', 'sub')
ok('and it did not gain the power', !r.body.allowed.includes('admin.wipe'),
  r.body.allowed?.join(','))

console.log('\n— a non-administrator holds none of this —')
tok.mc = await login('main-counter', '1234')
ok('the counter cannot read the catalogue',
  (await q('/admin/permissions', 'mc')).status === 403)
ok('nor the accounts', (await q('/admin/accounts', 'mc')).status === 403)

await q(`/staff/${sub.id}/archive`, 'root', { method: 'POST' })

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
