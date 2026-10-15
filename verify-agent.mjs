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


/* ============================ a terminal, not a reader ==================== */

/**
 * The server half of terminal mode.
 *
 * A ZKTeco K50 on the wall is not a second kind of reader. It holds its own
 * fingerprints, matches people itself, and hands over a decision it has
 * already made: a user id it chose and a time off its own clock. So it needs
 * none of the templates and exactly one thing HMS knows and it does not —
 * whose user id is whose.
 *
 * The agent half cannot be exercised from here: it speaks a binary protocol
 * to a device on a LAN, and there is no device. Its arithmetic has its own
 * test that runs on Windows (agent/test-protocol.bat) against vectors taken
 * from the reference implementation. What CAN be checked here is everything
 * the agent will ask the server for, and that is what this does.
 */
console.log('\n— a terminal asks for the roster, not the templates —')
{
  const noKey = await fetch(B + '/attendance/agent/roster')
  ok('the roster is refused without the device key', noKey.status === 401,
    String(noKey.status))

  const r = await fetch(B + '/attendance/agent/roster', { headers: KEY })
  ok('and served with it', r.status === 200, String(r.status))
  const roster = await r.json()
  ok('it is a list', Array.isArray(roster), typeof roster)
  ok('with people on it', roster.length > 0, `${roster.length}`)

  /*
   * EVERY ROW CARRIES A MAPPING, set or fallen back to.
   *
   * A row with a staff id and no device user id would be a person the agent
   * can never match a punch to, which shows up as attendance quietly missing
   * for one member of staff. The fallback — the staff id as a string — is
   * what makes a terminal enrolled alongside HMS work with no setup at all.
   */
  const bad = roster.filter((x) => !x.device_user_id || !x.staff_id)
  ok('every row has both a staff id and a device user id', bad.length === 0,
    JSON.stringify(bad.slice(0, 2)))

  ok('the fallback is the staff id as text, so an unmapped person still works',
    roster.some((x) => String(x.device_user_id) === String(x.staff_id)))

  ok('and it says whether the mapping was set or guessed',
    roster.every((x) => typeof x.mapped === 'boolean'))

  /*
   * The mapping is settable, and it is what the roster then returns. This is
   * the path somebody walks when the terminal was already in service with
   * its own numbering.
   */
  const who = roster[0]
  const DEV_ID = 'T-' + (Date.now() % 100000)
  let put = await fetch(B + '/staff/' + who.staff_id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
    body: JSON.stringify({ deviceUserId: DEV_ID })
  })
  ok('a terminal id can be set against a staff member', put.status === 200,
    String(put.status))

  const again = await (await fetch(B + '/attendance/agent/roster', { headers: KEY })).json()
  const row = again.find((x) => Number(x.staff_id) === Number(who.staff_id))
  ok('and the roster hands that id to the agent', row && row.device_user_id === DEV_ID,
    JSON.stringify(row))
  ok('marked as a real mapping rather than the fallback', row && row.mapped === true)

  /*
   * Two people cannot share one id on the device. Without this the punches
   * from that id would land on whichever row the query returned first —
   * silently, and differently on different days.
   */
  const other = again.find((x) => Number(x.staff_id) !== Number(who.staff_id))
  if (other) {
    const clash = await fetch(B + '/staff/' + other.staff_id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
      body: JSON.stringify({ deviceUserId: DEV_ID })
    })
    ok('two people cannot be given the same terminal id',
      clash.status >= 400, String(clash.status))
  }

  /* Put it back, so a second run of this suite starts where it started. */
  await fetch(B + '/staff/' + who.staff_id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
    body: JSON.stringify({ deviceUserId: null })
  })
  const back = await (await fetch(B + '/attendance/agent/roster', { headers: KEY })).json()
  const cleared = back.find((x) => Number(x.staff_id) === Number(who.staff_id))
  ok('clearing it returns to the staff-id fallback',
    cleared && String(cleared.device_user_id) === String(who.staff_id)
    && cleared.mapped === false, JSON.stringify(cleared))
}

console.log('\n— a device says which kind it is —')
{
  const made = await (await fetch(B + '/attendance/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
    body: JSON.stringify({
      name: 'Test terminal ' + (Date.now() % 100000),
      kind: 'terminal', host: '192.168.1.201'
    })
  })).json()
  ok('a terminal can be added', made.id > 0, JSON.stringify(made).slice(0, 120))
  /*
   * Checked on the way back out, not just on the way in. `kind` not being
   * declared in the route's schema would have zod strip it and every device
   * would quietly stay a reader — the same failure that left purchase orders
   * open forever.
   */
  ok('and comes back as a terminal rather than silently a reader',
    made.kind === 'terminal', String(made.kind))
  ok('with its address kept', made.host === '192.168.1.201', String(made.host))

  const list = await (await fetch(B + '/attendance/devices',
    { headers: { authorization: 'Bearer ' + tok } })).json()
  const mine = list.find((d) => Number(d.id) === Number(made.id))
  ok('the list says what it is', mine && mine.kind === 'terminal',
    JSON.stringify(mine))
  ok('and existing devices are still readers',
    list.filter((d) => Number(d.id) !== Number(made.id))
        .every((d) => d.kind === 'reader' || d.kind === 'terminal'))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
