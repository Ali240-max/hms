/**
 * Service categories, department token queues, the department report filter,
 * the pharmacy bill tabs and restoring a backup.
 *
 * An HTTP suite like verify-billing: it signs in with the demo accounts and
 * CREATES CATEGORIES, SERVICES, VISITS AND BILLS through the API, so it
 * assumes a seeded TEST database and a running server. It reads the database
 * directly (DATABASE_URL) as well, so point both at the same throwaway
 * database — never a real one.
 *
 * The restore section REPLACES THE WHOLE DATABASE with a backup taken a
 * moment earlier, so it only runs with VERIFY_RESTORE=1.
 *
 *   1. Categories: the four built in ones exist; a new one maps to a real
 *      department; names are unique ignoring case; only an administrator may
 *      add one; one in use cannot be deleted.
 *   2. A service filed under a mapped category takes its department, whatever
 *      the form sends, and its kind follows the category.
 *   3. Tokens: each department counts from its own sequence. The worked
 *      example from the request (doctor, lab, lab, radiology, doctor, lab) and
 *      a brand-new department starting at 1; twelve walk-in tests billed at
 *      once never share a token.
 *   4. Patients by Department, filtered to one department, shows only it.
 *   5. Pharmacy bills: regular, credit and interdepartmental are a partition.
 *   6. Restore (VERIFY_RESTORE=1): damaged and foreign files are refused,
 *      a wrong password is refused, and a real restore brings the data back,
 *      keeps a backup of what was there and signs everybody out.
 */
import pg from 'pg'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'

const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  if (!existsSync('.env')) return undefined
  const line = readFileSync('.env', 'utf8').split(/\r?\n/)
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l))
  return line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
}
const db = new pg.Pool({ connectionString: databaseUrl() })

let pass = 0, fail = 0
const ok = (n, c, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : '')))
}
async function login(u, p) {
  const r = await fetch(B + '/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
  return (await r.json()).token
}
async function call(tok, method, path, body, raw) {
  const r = await fetch(B + path, {
    method,
    headers: raw ? { authorization: 'Bearer ' + tok, 'content-type': 'application/octet-stream' }
      : { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  })
  let j = null
  try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, body: j }
}
const one = async (q, p = []) => (await db.query(q, p)).rows[0]

const admin = await login('admin', 'admin-demo-1')
const mc = await login('main-counter', '1234')
ok('admin and the main counter sign in', !!admin && !!mc)

/* ------------------------------------------------------------ categories */
console.log('\n— categories —')
const cats = (await call(admin, 'GET', '/service-categories?all=1')).body
ok('the four built-in categories exist',
  ['lab', 'radiology', 'procedure', 'other'].every((k) => cats.some((c) => c.is_builtin && c.kind === k)), cats)
const labCat = cats.find((c) => c.is_builtin && c.kind === 'lab')
const radCat = cats.find((c) => c.is_builtin && c.kind === 'radiology')
ok('the laboratory category is mapped to the Laboratory department',
  labCat?.department_name === 'Laboratory', labCat)
const uncategorised = await one('SELECT COUNT(*)::int AS n FROM services WHERE category_id IS NULL')
ok('every existing service was filed under a category', uncategorised.n === 0, uncategorised)

const dental = await one(`SELECT id FROM departments WHERE upper(code) = 'DENT'`)
const stamp = Date.now().toString(36).slice(-5)
const catName = `Dental procedures ${stamp}`
const made = await call(admin, 'POST', '/service-categories',
  { name: catName, departmentId: dental.id, kind: 'procedure' })
ok('a category mapped to Dental is created', made.status === 201 && made.body.department_id === dental.id, made)
const dup = await call(admin, 'POST', '/service-categories',
  { name: '  ' + catName.toUpperCase() + ' ', departmentId: null })
ok('the same name in other case is refused', dup.status === 409 && dup.body.code === 'DUPLICATE', dup)
const byCounter = await call(mc, 'POST', '/service-categories', { name: 'Nope ' + stamp, departmentId: null })
ok('the main counter cannot add a category', byCounter.status === 403, byCounter)
const badDept = await call(admin, 'POST', '/service-categories', { name: 'Ghost ' + stamp, departmentId: 999999 })
ok('a department that does not exist is refused', badDept.status === 409, badDept)
const listed = (await call(mc, 'GET', '/service-categories')).body
ok('the counter reads the categories, the new one included', listed.some((c) => c.id === made.body.id))

/* -------------------------------------------------------------- services */
console.log('\n— services —')
const other = await one(`SELECT id FROM departments WHERE upper(code) = 'CARD'`)
const svc = await call(admin, 'POST', '/services', {
  name: `Scaling ${stamp}`, categoryId: made.body.id, pricePaisa: 150000, defaultShareBp: 0,
  departmentId: other.id, requiresDoctor: false
})
const svcRow = await one('SELECT * FROM services WHERE id = $1', [svc.body?.id])
ok('a service is created under the new category', svc.status === 201 && svcRow?.category_id === made.body.id, svc)
ok('its department is the category\'s, not the one the form sent', svcRow?.department_id === dental.id, svcRow)
ok('its kind follows the category', svcRow?.category === 'procedure', svcRow)
const del = await call(admin, 'DELETE', `/service-categories/${made.body.id}`)
ok('a category with services cannot be deleted', del.status === 409 && del.body.code === 'IN_USE', del)
const builtinDel = await call(admin, 'DELETE', `/service-categories/${labCat.id}`)
ok('a built-in category cannot be deleted', builtinDel.status === 409, builtinDel)
const services = (await call(mc, 'GET', '/services')).body
ok('the counter sees the new service with its category name',
  services.some((s) => s.id === svcRow.id && s.category_name === catName))

/* ---------------------------------------------------------------- tokens */
console.log('\n— tokens —')
const patient = (await call(mc, 'POST', '/patients',
  { name: `Queue Test ${stamp}`, phone: '0300' + String(Date.now()).slice(-7) })).body
const labSvc = services.find((s) => s.category_id === labCat.id && s.code !== 'XMATCH')
const radSvc = services.find((s) => s.category_id === radCat.id)
const doctor = await one(`
  SELECT d.id, st.department_id FROM doctors d JOIN staff st ON st.id = d.staff_id
  WHERE d.is_active AND st.department_id IS NOT NULL ORDER BY d.id LIMIT 1`)
ok('there is a lab test, an x-ray and a doctor with a department to test with',
  !!labSvc && !!radSvc && !!doctor && !!patient?.id)

const direct = async (serviceId) => {
  const r = await call(mc, 'POST', '/counter/direct', { patientId: patient.id, serviceIds: [serviceId] })
  return { visit: r.body?.visit, chit: r.body?.chits?.[0], status: r.status }
}
// The visit route returns the Drizzle row, so the token is `tokenNo` there.
const visit = async () => {
  const v = (await call(mc, 'POST', '/visits',
    { patientId: patient.id, doctorId: doctor.id, feePaid: false })).body
  return { ...v, token_no: v?.tokenNo ?? v?.token_no }
}

const d1 = await visit()
const l1 = await direct(labSvc.id)
const l2 = await direct(labSvc.id)
const r1 = await direct(radSvc.id)
const d2 = await visit()
const l3 = await direct(labSvc.id)
ok('doctor tokens follow on from each other, untouched by the lab in between',
  Number.isInteger(d1.token_no) && d2.token_no === d1.token_no + 1, [d1.token_no, d2.token_no])
const docQueue = await one(`SELECT value FROM counters WHERE key LIKE 'token:%:dept:' || $1`,
  [doctor.department_id])
ok("the doctor's token comes from their department's queue", docQueue?.value === d2.token_no, docQueue)
ok('lab tokens follow on from each other, untouched by the doctor and the x-ray',
  l2.chit.token_no === l1.chit.token_no + 1 && l3.chit.token_no === l2.chit.token_no + 1,
  [l1.chit?.token_no, l2.chit?.token_no, l3.chit?.token_no])
ok('the lab chit is stamped with the Laboratory department', l1.chit.department_id === labCat.department_id)
ok('a walk-in visit carries its chit\'s token', l1.visit.token_no === l1.chit.token_no)
ok('radiology counts on its own', r1.chit.department_id === radCat.department_id
  && r1.chit.token_no !== undefined, r1.chit)

const t1 = await direct(svcRow.id)
const t2 = await direct(svcRow.id)
const dentalUsedBefore = await one(`
  SELECT COUNT(*)::int AS n FROM chits WHERE department_id = $1 AND created_at::date = CURRENT_DATE
    AND id NOT IN ($2, $3)`, [dental.id, t1.chit.id, t2.chit.id])
const dentalDoctorVisits = await one(`
  SELECT COUNT(*)::int AS n FROM visits WHERE department_id = $1 AND created_at::date = CURRENT_DATE`,
  [dental.id])
if (dentalUsedBefore.n === 0 && dentalDoctorVisits.n === 0) {
  ok('the new Dental queue starts at 1', t1.chit.token_no === 1, t1.chit)
}
ok('and goes on to 2', t2.chit.token_no === t1.chit.token_no + 1, [t1.chit.token_no, t2.chit.token_no])

const before = (await direct(labSvc.id)).chit.token_no
const many = await Promise.all(Array.from({ length: 12 }, () => direct(labSvc.id)))
const tokens = many.map((m) => m.chit?.token_no).sort((a, b) => a - b)
ok('twelve lab tests billed at once all succeed', many.every((m) => m.status === 201), many.map((m) => m.status))
ok('and get twelve different tokens, one after another',
  new Set(tokens).size === 12 && tokens[0] === before + 1 && tokens[11] === before + 12, tokens)

const printed = (await call(mc, 'GET', `/chits/${t1.chit.id}`)).body
  ?? (await call(mc, 'GET', `/chits/${t1.chit.id}/print`)).body
if (printed?.chit) {
  ok('the printed chit says where to go', printed.categoryLabel === 'Dental', printed.categoryLabel)
}

/* ------------------------------------------------- patients by department */
console.log('\n— Patients by Department —')
// Paid, so the report counts them.
for (const c of [l1.chit, t1.chit]) {
  await call(mc, 'POST', '/counter/bills', { kind: 'chit', chitId: c.id, payMethod: 'cash', tenderedPaisa: 10000000 })
}
const all = (await call(admin, 'GET', '/reports/run/dept-patients')).body
const onlyDental = (await call(admin, 'GET', `/reports/run/dept-patients?department=${dental.id}`)).body
const onlyLab = (await call(admin, 'GET', `/reports/run/dept-patients?department=${labCat.department_id}`)).body
ok('all departments includes Dental and the laboratory',
  all.rows.some((r) => r.department === 'Dental') && all.rows.some((r) => r.department === 'Laboratory'))
ok('Dental alone has only Dental rows', onlyDental.rows.length > 0
  && onlyDental.rows.every((r) => r.department === 'Dental'), onlyDental.rows.slice(0, 3))
ok('the laboratory alone has only laboratory rows', onlyLab.rows.length > 0
  && onlyLab.rows.every((r) => r.department === 'Laboratory'))
ok('the filtered totals are the filtered rows', onlyDental.totals.received_paisa
  === onlyDental.rows.reduce((n, r) => n + Number(r.received_paisa), 0))
const catalogue = (await call(admin, 'GET', '/reports')).body
const def = (Array.isArray(catalogue) ? catalogue : catalogue?.reports ?? [])
  .find((r) => r.id === 'dept-patients')
ok('the report offers a department filter defaulting to All Departments',
  def?.filters?.[0]?.key === 'department' && def.filters[0].allLabel === 'All Departments'
  && def.filters[0].options.some((o) => o.value === String(dental.id)), def?.filters)

/* -------------------------------------------------------- pharmacy bills */
console.log('\n— pharmacy bills —')
const sales = async (kind) =>
  (await call(admin, 'GET', `/pharmacy/sales?mode=all&kind=${kind}`)).body.rows.map((r) => r.id)
const [everything, regular, credit, dept] =
  await Promise.all(['all', 'regular', 'credit', 'department'].map(sales))
ok('there are bills of all three kinds to test with', regular.length && credit.length && dept.length,
  [regular.length, credit.length, dept.length])
const overlap = regular.filter((id) => credit.includes(id) || dept.includes(id))
  .concat(credit.filter((id) => dept.includes(id)))
ok('no bill is under two tabs', overlap.length === 0, overlap.slice(0, 5))
if (everything.length < 500) {
  ok('the three tabs together are every bill',
    regular.length + credit.length + dept.length === everything.length,
    [regular.length, credit.length, dept.length, everything.length])
}
const deptRows = await db.query(
  `SELECT COUNT(*)::int AS n FROM sales WHERE id = ANY($1) AND department_id IS NULL AND sale_kind <> 'department'`,
  [dept])
ok('every interdepartmental bill has a department', deptRows.rows[0].n === 0)

/* ---------------------------------------------------------------- restore */
if (process.env.VERIFY_RESTORE !== '1') {
  console.log('\n— restore: skipped (set VERIFY_RESTORE=1; it replaces the whole database) —')
} else {
  console.log('\n— restore —')
  const lab = await login('lab', '1234')
  const refused = await call(lab, 'POST', '/admin/restore/inspect', { file: 'hms-x.ndjson.gz' })
  ok('a lab account cannot restore', refused.status === 403, refused)

  const backup = (await call(admin, 'POST', '/admin/backups')).body
  ok('a backup is taken', !!backup?.file, backup)
  const name = backup.file.split(/[\\/]/).pop()
  const inspected = await call(admin, 'POST', '/admin/restore/inspect', { file: name })
  ok('the backup checks out', inspected.status === 200 && inspected.body.completenessChecked
    && inspected.body.admins > 0, inspected)
  ok('its creation time is reported', !!inspected.body.takenAt)
  const traversal = await call(admin, 'POST', '/admin/restore/inspect', { file: '..\\..\\.env' })
  ok('a path outside the backups folder is refused', traversal.status === 404, traversal)

  const bytes = readFileSync(backup.file)
  const cut = await call(admin, 'POST', '/admin/restore/upload', undefined, bytes.subarray(0, bytes.length - 200))
  ok('a truncated backup is refused', cut.status === 409 && cut.body.code === 'INVALID_FILE', cut)
  const junk = await call(admin, 'POST', '/admin/restore/upload', undefined, Buffer.from('not a backup at all'))
  ok('a file that is not a backup is refused', junk.status === 409 && junk.body.code === 'INVALID_FILE', junk)
  const foreign = await call(admin, 'POST', '/admin/restore/upload', undefined,
    gzipSync(JSON.stringify({ hello: 'world' }) + '\n'))
  ok('somebody else\'s gzip is refused', foreign.status === 409 && foreign.body.code === 'INVALID_FILE', foreign)

  const lines = gunzipSync(bytes).toString('utf8').trim().split('\n')
  const newer = [...lines]
  const at = newer.findIndex((l) => l.startsWith('{"_table":"patients"'))
  const row = JSON.parse(newer[at]); row.row.from_the_future = 1; newer[at] = JSON.stringify(row)
  const incompatible = await call(admin, 'POST', '/admin/restore/upload', undefined, gzipSync(newer.join('\n')))
  ok('a backup with a column this version lacks is refused', incompatible.status === 409
    && incompatible.body.code === 'INCOMPATIBLE', incompatible)
  const injected = [...lines]
  const meta = JSON.parse(injected[0]); meta.tables.push('patients; DROP TABLE staff'); injected[0] = JSON.stringify(meta)
  const inj = await call(admin, 'POST', '/admin/restore/upload', undefined, gzipSync(injected.join('\n')))
  ok('a table name that is not a table is refused', inj.status === 409 && inj.body.code === 'INVALID_FILE', inj)
  const short = lines.filter((l, i) => i !== at)
  const missing = await call(admin, 'POST', '/admin/restore/upload', undefined, gzipSync(short.join('\n')))
  ok('a backup with a row missing is refused against its closing counts', missing.status === 409
    && missing.body.code === 'INVALID_FILE', missing)

  const good = await call(admin, 'POST', '/admin/restore/upload', undefined, bytes)
  ok('the real backup uploads and checks out', good.status === 201 && !!good.body.upload, good)

  // Something made after the backup, which the restore must take away.
  const marker = (await call(mc, 'POST', '/patients', { name: `After Backup ${stamp}` })).body
  const counts = await one('SELECT (SELECT COUNT(*) FROM patients)::int AS p, (SELECT COUNT(*) FROM sales)::int AS s')

  const wrong = await call(admin, 'POST', '/admin/restore',
    { upload: good.body.upload, password: 'nope', confirm: 'RESTORE' })
  ok('a wrong password is refused', wrong.status === 409 && wrong.body.code === 'WRONG_PASSWORD', wrong)
  const unconfirmed = await call(admin, 'POST', '/admin/restore',
    { upload: good.body.upload, password: 'admin-demo-1', confirm: 'yes' })
  ok('it is refused without RESTORE typed', unconfirmed.status === 409 && unconfirmed.body.code === 'NOT_CONFIRMED')
  const still = await one('SELECT COUNT(*)::int AS n FROM patients WHERE id = $1', [marker.id])
  ok('nothing was changed by the refused attempts', still.n === 1)

  const t0 = Date.now()
  const done = await call(admin, 'POST', '/admin/restore',
    { upload: good.body.upload, password: 'admin-demo-1', confirm: 'RESTORE' })
  ok('the restore completes', done.status === 200 && done.body.rows > 0, done)
  console.log(`       (${((Date.now() - t0) / 1000).toFixed(1)} s, ${done.body?.rows} rows)`)
  const gone = await one('SELECT COUNT(*)::int AS n FROM patients WHERE id = $1', [marker.id])
  ok('the patient made after the backup is gone', gone.n === 0)
  const after = await one('SELECT (SELECT COUNT(*) FROM patients)::int AS p, (SELECT COUNT(*) FROM sales)::int AS s')
  ok('everything else is as it was', after.p === counts.p - 1 && after.s === counts.s, [counts, after])
  ok('a backup of the data before the restore exists', !!done.body.safetyBackup
    && existsSync(done.body.safetyBackup), done.body.safetyBackup)
  const signedOut = await call(admin, 'GET', '/admin/backups')
  ok('everybody is signed out', signedOut.status === 401, signedOut.status)
  const again = await login('admin', 'admin-demo-1')
  ok('and can sign in again', !!again)
  const fresh = (await call(again, 'POST', '/patients', { name: `After Restore ${stamp}` })).body
  ok('a new patient after the restore does not collide with restored ids',
    !!fresh?.id && fresh.id > Number((await one('SELECT MAX(id)::int AS m FROM patients WHERE id <> $1', [fresh.id])).m))
  const fk = await one(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND condeferrable`)
  ok('every foreign key is back to how it was', fk.n === 0, fk)
  const dir = backup.file.slice(0, backup.file.length - name.length)
  const leftovers = existsSync(join(dir, 'restore-uploads'))
    ? readdirSync(join(dir, 'restore-uploads')).filter((f) => f.startsWith('working-')) : []
  ok('no working copy is left behind', leftovers.length === 0, leftovers)
}

await db.end()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
