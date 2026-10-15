/**
 * Creating staff on the network terminal, the HMS half.
 *
 * Everything between the button and the agent: which id a person gets, what
 * is refused before anything is queued, how a job is handed out and taken
 * back, and what each answer from the device does to the person's terminal
 * id. The device half is agent/AgentTest.cs, against a fake terminal.
 *
 * Neither proves a real K50 accepts the user. That needs the K50.
 *
 * Writes to whatever DATABASE_URL points at. Run it against a test database.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import { saveDevice, rosterForAgent } from './src/server/services/attendance'
import {
  requestSync, claimJobs, finishJob, cancelJob, syncStatus, fitName,
  TerminalSyncError, DEVICE_ID
} from './src/server/services/terminal-sync'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}
async function refused(fn: () => Promise<any>, code: string) {
  try { await fn(); return 'not refused' }
  catch (e: any) { return e instanceof TerminalSyncError && e.code === code ? true : String(e.code ?? e.message) }
}

const stamp = Date.now().toString().slice(-6)
let n = 0
async function staff(name: string, extra: { mapped?: string; exempt?: boolean; inactive?: boolean } = {}) {
  n++
  return ((await db.execute<any>(sql`
    INSERT INTO staff (username, display_name, password_hash, role,
                       device_user_id, attendance_required, is_active)
    VALUES (${'ts' + stamp + n}, ${name}, 'x', 'ward', ${extra.mapped ?? null},
            ${!extra.exempt}, ${!extra.inactive})
    RETURNING id, display_name`)).rows as any[])[0]
}
const mappingOf = async (id: number) => ((await db.execute<any>(sql`
  SELECT device_user_id FROM staff WHERE id = ${id}`)).rows as any[])[0].device_user_id

/* Two terminals, so every call names its device. */
const term = await saveDevice({ name: 'Test K50 ' + stamp, kind: 'terminal', host: '192.168.1.201' })
const other = await saveDevice({ name: 'Other K50 ' + stamp, kind: 'terminal' })
const reader = await saveDevice({ name: 'USB reader ' + stamp, kind: 'reader' })
const D = Number(term.id)

console.log('\n— which id a person gets —')
const a = await staff('Nadia Aslam')
const r1 = await requestSync({ staffId: a.id, deviceId: D, by: 'Admin' })
ok('somebody with no terminal id gets their HMS staff id',
  r1.job.device_user_id === String(a.id) && r1.job.status === 'pending',
  `${r1.job.device_user_id} ${r1.job.status}`)
ok('and the name the device will hold', r1.job.name === 'Nadia Aslam')

const again = await requestSync({ staffId: a.id, deviceId: D, by: 'Admin' })
ok('pressing it twice hands back the same job instead of queueing a second',
  again.existing === true && again.job.id === r1.job.id)

const b = await staff('Hina Butt', { mapped: '5' + stamp.slice(-4) })
const rb = await requestSync({ staffId: b.id, deviceId: D })
ok('somebody with a terminal id keeps it', rb.job.device_user_id === '5' + stamp.slice(-4))

const c = await staff('Asked For')
const asked = '8' + stamp.slice(-5)
const rc = await requestSync({ staffId: c.id, deviceId: D, deviceUserId: asked })
ok('an id asked for is used when they have none', rc.job.device_user_id === asked)

console.log('\n— refused before anything is queued —')
ok('a different id for somebody who already has one is refused',
  await refused(() => requestSync({ staffId: b.id, deviceId: D, deviceUserId: '42' }),
    'MAPPING_DIFFERS') === true)
const x = await staff('Another')
ok('an id another member of staff already has is refused',
  await refused(() => requestSync({ staffId: x.id, deviceId: D, deviceUserId: '5' + stamp.slice(-4) }),
    'ID_TAKEN') === true)
ok('an id already queued for somebody else on that device is refused',
  await refused(() => requestSync({ staffId: x.id, deviceId: D, deviceUserId: asked }),
    'ID_TAKEN') === true)
for (const bad of ['E-17', '1234567890', '000', '12 3']) {
  const y = await staff('Bad Id ' + bad)
  ok(`"${bad}" is not an id a terminal can hold`,
    await refused(() => requestSync({ staffId: y.id, deviceId: D, deviceUserId: bad }), 'BAD_ID') === true)
}
ok('somebody exempt from attendance is not put on the terminal',
  await refused(async () => requestSync({ staffId: (await staff('Exempt', { exempt: true })).id, deviceId: D }),
    'EXEMPT') === true)
ok('nor somebody archived',
  await refused(async () => requestSync({ staffId: (await staff('Gone', { inactive: true })).id, deviceId: D }),
    'NO_STAFF') === true)
ok('a USB reader is not a terminal',
  await refused(() => requestSync({ staffId: x.id, deviceId: Number(reader.id) }), 'NO_DEVICE') === true)
ok('with two terminals, the screen has to say which',
  await refused(() => requestSync({ staffId: x.id }), 'CHOOSE_DEVICE') === true)

console.log('\n— the agent takes the work —')
const claimed = await claimJobs(D)
ok('the agent is handed the waiting jobs', claimed.length === 3, String(claimed.length))
ok('marked as its own', (await db.execute<any>(sql`
  SELECT COUNT(*)::int AS n FROM attendance_device_jobs
  WHERE device_id = ${D} AND status = 'running'`)).rows[0].n === 3)
ok('and not handed out again while it has them', (await claimJobs(D)).length === 0)
ok('another device’s agent is never given them', (await claimJobs(Number(other.id))).length === 0)

/* Two agents asking at once (a copy started by mistake) get one job, once. */
const twin = await staff('Twin Agent Test')
await requestSync({ staffId: twin.id, deviceId: D })
const [g1, g2] = await Promise.all([claimJobs(D), claimJobs(D)])
ok('two agents asking at the same moment never both take a job', g1.length + g2.length === 1,
  `${g1.length} + ${g2.length}`)
const twinJob = [...g1, ...g2][0]

console.log('\n— what the device said —')
const ja = claimed.find((j: any) => Number(j.staff_id) === Number(a.id))
const done = await finishJob(D, { id: ja.id, code: 'CREATED', deviceName: 'Nadia Aslam', expectedName: 'Nadia Aslam' })
ok('created and read back: done', done.status === 'done' && done.result_code === 'CREATED')
ok('and their terminal id is now set, so punches from it are filed under them',
  await mappingOf(a.id) === String(a.id))
const roster = await rosterForAgent()
ok('the agent’s roster now carries it as a real mapping',
  roster.some((r: any) => Number(r.staff_id) === Number(a.id) && r.device_user_id === String(a.id) && r.mapped === true))
const twice = await finishJob(D, { id: ja.id, code: 'DEVICE_ERROR', message: 'late duplicate' })
ok('a result reported twice keeps the first answer', twice.status === 'done')

const jb = claimed.find((j: any) => Number(j.staff_id) === Number(b.id))
const present = await finishJob(D, { id: jb.id, code: 'ALREADY_PRESENT', deviceName: 'HINA', expectedName: 'Hina Butt' })
ok('already on the device under the id HMS already maps them to: done',
  present.status === 'done' && present.result_code === 'ALREADY_PRESENT')

/*
 * THE CASE THAT MATTERS. The device already has somebody under the id this
 * person was about to get — enrolled in ZKBio years ago, nothing to do with
 * HMS. They must not be claimed.
 */
const jc = claimed.find((j: any) => Number(j.staff_id) === Number(c.id))
const clash = await finishJob(D, { id: jc.id, code: 'ALREADY_PRESENT', deviceName: 'Yasir', expectedName: 'Asked For' })
ok('an unrelated device user under that id is a conflict, not a match',
  clash.status === 'failed' && clash.result_code === 'CONFLICT')
ok('which names who the device has there', String(clash.message).includes('Yasir'))
ok('and leaves the person without a terminal id', (await mappingOf(c.id)) === null)

/* Even the same name is not taken on trust the first time: two people share names. */
const same = await staff('Muhammad Ali')
await requestSync({ staffId: same.id, deviceId: D })
const js = (await claimJobs(D))[0]
const guessed = await finishJob(D, { id: js.id, code: 'ALREADY_PRESENT', deviceName: 'Muhammad Ali', expectedName: 'Muhammad Ali' })
ok('a matching name on a FIRST attempt is still a conflict, not a guess',
  guessed.status === 'failed' && guessed.result_code === 'CONFLICT' && (await mappingOf(same.id)) === null)

console.log('\n— an agent that died halfway —')
/*
 * Written to the device, then the report was lost. The job comes back after
 * a few minutes; the agent finds the user it made; that is a success, not a
 * conflict — but only on a retry, and only with exactly the name it writes.
 */
const lost = await staff('Lost Report')
await requestSync({ staffId: lost.id, deviceId: D })
const first = (await claimJobs(D))[0]
await db.execute(sql`UPDATE attendance_device_jobs SET claimed_at = now() - interval '10 minutes' WHERE id = ${first.id}`)
const retry = (await claimJobs(D)).find((j: any) => j.id === first.id)
ok('a job held too long is offered again', !!retry && retry.attempts === 2, JSON.stringify(retry))
const healed = await finishJob(D, { id: first.id, code: 'ALREADY_PRESENT', deviceName: 'Lost Report', expectedName: 'Lost Report' })
ok('and the user the first attempt made is recognised as its own',
  healed.status === 'done' && (await mappingOf(lost.id)) === String(lost.id))

/* Offered and lost too many times: given up, and said so. */
const stuck = await staff('Stuck')
await requestSync({ staffId: stuck.id, deviceId: D })
await db.execute(sql`
  UPDATE attendance_device_jobs SET status = 'running', attempts = 3,
         claimed_at = now() - interval '10 minutes'
  WHERE staff_id = ${stuck.id}`)
await claimJobs(D)
const gaveUp = ((await db.execute<any>(sql`
  SELECT status, result_code FROM attendance_device_jobs WHERE staff_id = ${stuck.id}`)).rows as any[])[0]
ok('after three tries it is given up with a reason', gaveUp.status === 'failed' && gaveUp.result_code === 'GAVE_UP',
  JSON.stringify(gaveUp))

console.log('\n— failures change nothing —')
const unreachable = await finishJob(D, { id: twinJob.id, code: 'DEVICE_UNREACHABLE', message: 'Could not reach the terminal at 192.168.1.201: timed out' })
ok('a device that could not be reached is reported as such', unreachable.status === 'failed'
  && String(unreachable.message).includes('timed out'))
ok('and the person is not given a terminal id', (await mappingOf(twin.id)) === null)

/* Somebody else was given the id in HMS while the agent was creating it. */
const racer = await staff('Racer')
const taker = await staff('Taker')
const raceId = '9' + stamp.slice(-5)
await requestSync({ staffId: racer.id, deviceId: D, deviceUserId: raceId })
const jr = (await claimJobs(D))[0]
await db.execute(sql`UPDATE staff SET device_user_id = ${raceId} WHERE id = ${taker.id}`)
const raced = await finishJob(D, { id: jr.id, code: 'CREATED', deviceName: 'Racer', expectedName: 'Racer' })
ok('an id taken in HMS meanwhile is a conflict, not two people on one id',
  raced.status === 'failed' && raced.result_code === 'CONFLICT' && (await mappingOf(racer.id)) === null)

ok('a result for a job belonging to another device is refused',
  await refused(() => finishJob(Number(other.id), { id: jr.id, code: 'CREATED' }), 'NOT_FOUND') === true)

console.log('\n— taking a request back —')
const canc = await staff('Cancelled')
const rq = await requestSync({ staffId: canc.id, deviceId: D })
const cancelled = await cancelJob(rq.job.id)
ok('a request the agent has not started can be cancelled',
  cancelled.status === 'failed' && cancelled.result_code === 'CANCELLED')
const rq2 = await requestSync({ staffId: canc.id, deviceId: D })
await claimJobs(D)
ok('one it has started cannot', await refused(() => cancelJob(rq2.job.id), 'NOT_PENDING') === true)

console.log('\n— what the screen reads —')
const st = await syncStatus(a.id)
ok('the status shows the terminals and the latest job per terminal',
  st.terminals.some((t: any) => Number(t.id) === D)
  && st.jobs.some((j: any) => Number(j.device_id) === D && j.status === 'done'))
ok('and the id a sync would use', st.staff.proposed_id === String(a.id))

console.log('\n— a guess never shadows a real mapping —')
/*
 * Staff P has no terminal id; somebody else has been created on the terminal
 * AS P's staff id. The roster must not also offer P as the guess for it.
 */
const p = await staff('Shadowed')
const q = await staff('Owner')
await db.execute(sql`UPDATE staff SET device_user_id = ${String(p.id)} WHERE id = ${q.id}`)
const r2 = await rosterForAgent()
const forId = r2.filter((r: any) => r.device_user_id === String(p.id))
ok('only the real mapping is offered for that id',
  forId.length === 1 && Number(forId[0].staff_id) === Number(q.id) && forId[0].mapped === true,
  JSON.stringify(forId))

console.log('\n— names and ids —')
ok('a long name is cut to the 24 bytes the device holds',
  Buffer.byteLength(fitName('Dr Muhammad Abdullah Khan Niazi'), 'utf8') <= 24)
const urdu = fitName('محمد علی خان نیازی صاحب')
ok('an Urdu name is cut on a letter, never through one',
  Buffer.byteLength(urdu, 'utf8') <= 24 && !urdu.includes('�') && 'محمد علی خان نیازی صاحب'.startsWith(urdu))
ok('the id rule matches the agent’s', DEVICE_ID.test('15') && !DEVICE_ID.test('E-17') && !DEVICE_ID.test('0'))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
