/*
 * Everything the C# agent does over HTTP, done from Node.
 *
 * The SDK calls cannot be tested without the reader, but the protocol can:
 * every header, body and status code the agent depends on is exercised here
 * against the real server. If this passes, the only thing left untested is
 * the twenty lines that talk to the DLL.
 */
const B = (process.env.API_BASE || 'http://127.0.0.1:4000/api')
let pass = 0, fail = 0
const ok = (n, c, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

const st = await (await fetch(B + '/auth/status')).json()
if (st.needsSetup) {
  await fetch(B + '/auth/setup', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', displayName: 'Admin', password: 'admin-test-1' }) })
}

/*
 * Whichever administrator this database has.
 *
 * A seeded database carries admin/1234; one this suite set up itself carries
 * the password above. Trying both means the suite runs on either without
 * anybody remembering which.
 */
async function login(username, password) {
  const r = await fetch(B + '/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) })
  if (!r.ok) return null
  return (await r.json()).token
}
const tok = await login('admin', 'admin-test-1') ?? await login('admin', 'admin-demo-1')
if (!tok) {
  console.log('  FAIL could not sign in as admin — seed the database first')
  process.exit(1)
}
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok }

/* A reader, as the agent's agent.ini would carry it. */
const dev = await (await fetch(B + '/attendance/devices', { method: 'POST',
  headers: H, body: JSON.stringify({ name: 'Staff entrance', location: 'Main door' })
})).json()
ok('a reader hands back a key once', typeof dev.api_key === 'string' && dev.api_key.length > 20)
const KEY = { 'x-device-key': dev.api_key, 'content-type': 'application/json' }

/* Somebody to recognise. */
const stamp = Date.now().toString().slice(-6)
const staff = await (await fetch(B + '/staff', { method: 'POST', headers: H,
  body: JSON.stringify({ username: 'nurse' + stamp, displayName: 'Muhammad Ali',
    password: 'nurse-1234', role: 'receptionist',
    shiftStart: '08:40', shiftEnd: '16:40' }) })).json()
ok('a staff member can be created with a shift', !!staff.user?.id || !!staff.id)
const staffId = staff.user?.id ?? staff.id

/* --- what the agent does at startup ------------------------------------- */
console.log('\n— startup —')
const noKey = await fetch(B + '/attendance/agent/templates')
ok('templates are refused without the reader key', noKey.status === 401, String(noKey.status))

const badKey = await fetch(B + '/attendance/agent/templates',
  { headers: { 'x-device-key': 'not-a-key' } })
ok('and refused with a wrong one', badKey.status === 401, String(badKey.status))

let tmpl = await (await fetch(B + '/attendance/agent/templates', { headers: KEY })).json()
ok('templates come back as a list', Array.isArray(tmpl))

/* --- enrolment: the browser posts what the agent produced ---------------- */
console.log('\n— enrolment —')
const FAKE = Buffer.from('a-merged-template-from-DBMerge').toString('base64')
const saved = await fetch(B + '/attendance/fingerprints', { method: 'POST', headers: H,
  body: JSON.stringify({ staffId, fingerIndex: 1, template: FAKE }) })
ok('a template is stored against a staff member', saved.status === 201, String(saved.status))

const asAgent = await fetch(B + '/attendance/fingerprints', { method: 'POST', headers: KEY,
  body: JSON.stringify({ staffId, fingerIndex: 2, template: FAKE }) })
/*
 * The reader key must NOT be able to enrol. Deciding whose finger this is
 * belongs to an administrator; a key sitting in a text file on a PC by a door
 * should never be able to add a finger to somebody's record.
 */
ok('but the reader key cannot enrol anybody', asAgent.status === 401 || asAgent.status === 403,
  String(asAgent.status))

tmpl = await (await fetch(B + '/attendance/agent/templates', { headers: KEY })).json()
const mine = tmpl.find((t) => t.staff_id === staffId)
ok('the agent is then given that template', !!mine)
ok('with the finger index it was enrolled on', mine?.finger_index === 1)
ok('and the name, so a match can be logged', mine?.display_name === 'Muhammad Ali')
ok('the template round-trips unchanged', mine?.template === FAKE)

/* --- a punch ------------------------------------------------------------- */
console.log('\n— a punch —')
const at = new Date(); at.setHours(8, 53, 0, 0)
const iso = at.toISOString()

const r1 = await fetch(B + '/attendance/agent/punch', { method: 'POST', headers: KEY,
  body: JSON.stringify({ staffId, at: iso, raw: 'SLK20R fid=' + (staffId * 10 + 1) }) })
const b1 = await r1.json()
ok('the server takes it', r1.status === 201, String(r1.status))
ok('and says it is an arrival', b1.direction === 'in', String(b1.direction))
ok('with the name for the door screen', b1.staff_name === 'Muhammad Ali')
ok('and how late against the shift', b1.late_minutes === 13, String(b1.late_minutes))

/*
 * The agent retries anything it could not confirm. A repeat must not be an
 * error, or it would retry the same punch for ever.
 */
const r2 = await fetch(B + '/attendance/agent/punch', { method: 'POST', headers: KEY,
  body: JSON.stringify({ staffId, at: iso, raw: 'retry' }) })
const b2 = await r2.json()
ok('a retry of the same punch is accepted, not an error', r2.ok, String(r2.status))
ok('and marked as a duplicate', b2.duplicate === true)

/* The queue drops a punch the server refuses outright. */
const r3 = await fetch(B + '/attendance/agent/punch', { method: 'POST', headers: KEY,
  body: JSON.stringify({ staffId: 999999, at: iso, raw: 'ghost' }) })
ok('an unknown staff id is refused with a 4xx the agent can drop',
  r3.status >= 400 && r3.status < 500, String(r3.status))

/* --- the door screen sees it -------------------------------------------- */
console.log('\n— the door screen —')
const kiosk = await (await fetch(B + '/staff', { method: 'POST', headers: H,
  body: JSON.stringify({ username: 'door' + stamp, displayName: 'Door',
    password: 'door-1234', role: 'kiosk' }) })).json()
const ktok = (await (await fetch(B + '/auth/login', { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'door' + stamp, password: 'door-1234' }) })).json()).token
const seen = await (await fetch(B + '/attendance/recent',
  { headers: { authorization: 'Bearer ' + ktok } })).json()
ok('the punch reaches the board', seen.some((s) => s.display_name === 'Muhammad Ali'))
ok('labelled as an arrival', seen[0]?.direction === 'in')


/*
 * The door screen is denied by default, and this is where that is kept
 * honest: a route added next month must not quietly become readable by a
 * terminal in a corridor.
 */
console.log('\n— the door screen reaches nothing else —')
for (const [what, path] of [['patients', '/patients/search?q=a'],
  ['the staff list', '/staff'], ['the day sheet', '/attendance/day'],
  ['the bed board', '/ipd/beds']]) {
  const s = (await fetch(B + path,
    { headers: { authorization: 'Bearer ' + ktok } })).status
  ok('refused ' + what, s === 403, String(s))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
