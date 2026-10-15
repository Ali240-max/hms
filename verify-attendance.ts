/**
 * Attendance.
 *
 * The rules under test are the three that decide every day's record: which
 * day a punch belongs to, when a second scan is the same arrival, and who is
 * expected at all.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  workDateFor, recordPunch, day, monthFor, onSite, saveDevice, devices,
  deviceByKey, saveFingerprint, fingerprintsFor, templatesForAgent,
  deletePunch, AttendanceError, REPEAT_WINDOW_MINUTES
} from './src/server/services/attendance'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}
const at = (iso: string) => new Date(iso)

console.log('\n— which day a punch belongs to —')
const dayShift = { shift_start: '09:00', shift_end: '17:00' }
const nightShift = { shift_start: '20:00', shift_end: '04:00' }

ok('a day shift files under its own date',
  workDateFor(at('2026-10-08T09:05:00'), dayShift) === '2026-10-08')
ok('and so does its evening',
  workDateFor(at('2026-10-08T17:10:00'), dayShift) === '2026-10-08')

/*
 * The one that matters. A nurse on 20:00 to 04:00 punches out after midnight.
 * Filed under the new date she would look as though she left a day she never
 * started, and absent on the day she worked.
 */
ok('a night shift starting at 20:00 files under that date',
  workDateFor(at('2026-10-08T20:02:00'), nightShift) === '2026-10-08')
ok('and its 03:50 leaving punch files under the night it began',
  workDateFor(at('2026-10-09T03:50:00'), nightShift) === '2026-10-08',
  workDateFor(at('2026-10-09T03:50:00'), nightShift))
/* An hour of slack: somebody finishing a handover is still on last night. */
ok('a handover running to 04:40 is still that night',
  workDateFor(at('2026-10-09T04:40:00'), nightShift) === '2026-10-08')
ok('but arriving at 08:00 is a new day',
  workDateFor(at('2026-10-09T08:00:00'), nightShift) === '2026-10-09')
ok('with no shift set, the punch is simply its own date',
  workDateFor(at('2026-10-09T02:00:00'), {}) === '2026-10-09')

console.log('\n— readers —')
const dev = await saveDevice({ name: `Staff entrance ${Date.now() % 10000}`,
  location: 'Main door' })
ok('a reader is given a key once', typeof dev.api_key === 'string' && dev.api_key.length > 20)
ok('and the key is not listed back whole',
  (await devices()).every((d: any) => !d.api_key && d.key_hint?.includes('…')))
ok('the agent is recognised by its key', (await deviceByKey(dev.api_key)).id === dev.id)
let refused = false
try { await deviceByKey('not-a-real-key') }
catch (e) { refused = e instanceof AttendanceError && e.code === 'NO_DEVICE' }
ok('and an unknown key is refused', refused)

console.log('\n— punching in and out —')
const stamp = Date.now().toString().slice(-6)
const who = ((await db.execute<any>(sql`
  INSERT INTO staff (username, display_name, password_hash, role,
                     shift_start, shift_end)
  VALUES (${'att' + stamp}, ${'Attendance Test ' + stamp}, 'x', 'receptionist',
          '09:00', '17:00')
  RETURNING id`)).rows as any[])[0]

const today = new Date()
const morning = new Date(today); morning.setHours(9, 12, 0, 0)
const evening = new Date(today); evening.setHours(17, 20, 0, 0)

await recordPunch({ staffId: who.id, at: morning, deviceId: dev.id })
ok('the arrival is recorded', (await day(
  `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${
    String(today.getDate()).padStart(2, '0')}`))
  .find((r: any) => r.staff_id === who.id)?.punches.length === 1)

/* People press twice when the first beep is quiet. */
refused = false
const soon = new Date(morning.getTime() + 2 * 60_000)
try { await recordPunch({ staffId: who.id, at: soon, deviceId: dev.id }) }
catch (e) { refused = e instanceof AttendanceError && e.code === 'TOO_SOON' }
ok(`a second scan within ${REPEAT_WINDOW_MINUTES} minutes is the same arrival`, refused)

/* A retry after a dropped connection must not become a second punch. */
refused = false
try { await recordPunch({ staffId: who.id, at: morning, deviceId: dev.id }) }
catch (e) { refused = e instanceof AttendanceError }
ok('and the identical punch posted twice is stored once', refused)

await recordPunch({ staffId: who.id, at: evening, deviceId: dev.id })

const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${
  String(today.getDate()).padStart(2, '0')}`
const row: any = (await day(todayKey)).find((r: any) => r.staff_id === who.id)
ok('the first punch is the arrival and the last is the leaving',
  new Date(row.first).getHours() === 9 && new Date(row.last).getHours() === 17)
ok('the time between them is counted', row.minutes === 488, String(row.minutes))
ok('arriving at 09:12 against a 09:00 shift is 12 minutes late',
  row.late_minutes === 12, String(row.late_minutes))
ok('and the day reads as left', row.status === 'left')

console.log('\n— who is expected —')
const exempt = ((await db.execute<any>(sql`
  INSERT INTO staff (username, display_name, password_hash, role, attendance_required)
  VALUES (${'ex' + stamp}, ${'Exempt Consultant ' + stamp}, 'x', 'doctor', false)
  RETURNING id`)).rows as any[])[0]

refused = false
try { await recordPunch({ staffId: exempt.id }) }
catch (e) { refused = e instanceof AttendanceError && e.code === 'EXEMPT' }
/*
 * Refused rather than quietly recorded: if an exempt person is on the reader,
 * either the exemption is wrong or the identification is, and both are worth
 * knowing.
 */
ok('an exempt person on the reader is refused, not recorded quietly', refused)
ok('and never shows as absent',
  (await day(todayKey)).find((r: any) => r.staff_id === exempt.id)?.status === 'exempt')

const missing = ((await db.execute<any>(sql`
  INSERT INTO staff (username, display_name, password_hash, role, shift_start, shift_end)
  VALUES (${'ab' + stamp}, ${'Absent One ' + stamp}, 'x', 'receptionist', '09:00','17:00')
  RETURNING id`)).rows as any[])[0]
ok('somebody expected who never scanned is absent',
  (await day(todayKey)).find((r: any) => r.staff_id === missing.id)?.status === 'absent')

console.log('\n— still in the building —')
const other = ((await db.execute<any>(sql`
  INSERT INTO staff (username, display_name, password_hash, role, shift_start, shift_end)
  VALUES (${'in' + stamp}, ${'Still Here ' + stamp}, 'x', 'lab_tech', '08:00','20:00')
  RETURNING id`)).rows as any[])[0]
const justNow = new Date(today); justNow.setHours(8, 30, 0, 0)
await recordPunch({ staffId: other.id, at: justNow, deviceId: dev.id })
ok('one punch and no second means still in', (await onSite())
  .some((r: any) => r.staff_id === other.id))
ok('and somebody who has left is not listed', !(await onSite())
  .some((r: any) => r.staff_id === who.id))

console.log('\n— a correction —')
const manual = await recordPunch({
  staffId: missing.id, at: new Date(new Date(today).setHours(9, 0, 0, 0)),
  source: 'manual', note: 'Reader would not read her thumb', by: 'Administrator'
})
ok('a punch can be added by hand', manual.source === 'manual')
ok('with the reason kept', manual.note?.includes('thumb'))
ok('and who added it', manual.added_by === 'Administrator')
ok('the day now shows her present',
  (await day(todayKey)).find((r: any) => r.staff_id === missing.id)?.status === 'in')

await deletePunch(manual.id)
ok('a wrong punch can be removed again',
  (await day(todayKey)).find((r: any) => r.staff_id === missing.id)?.status === 'absent')

console.log('\n— the month —')
const m = await monthFor(who.id, today.getFullYear(), today.getMonth() + 1)
ok('every day of the month is listed',
  m.days.length === new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate(),
  String(m.days.length))
ok('today counts as present', m.totals.present >= 1)
ok('and the minutes add up', m.totals.minutes >= 488)

console.log('\n— fingerprints —')
await saveFingerprint({ staffId: who.id, fingerIndex: 1, template: 'TEMPLATE-ONE',
  by: 'Administrator' })
await saveFingerprint({ staffId: who.id, fingerIndex: 2, template: 'TEMPLATE-TWO' })
ok('two fingers are kept, so one cut thumb is not a lockout',
  (await fingerprintsFor(who.id)).length === 2)
await saveFingerprint({ staffId: who.id, fingerIndex: 1, template: 'TEMPLATE-REDONE' })
ok('re-enrolling the same finger replaces it rather than adding a third',
  (await fingerprintsFor(who.id)).length === 2)

const forAgent = await templatesForAgent()
ok('the agent is given the templates', forAgent.some((t: any) => t.staff_id === who.id))
/* An exempt person's finger should never match at the door. */
await saveFingerprint({ staffId: exempt.id, fingerIndex: 1, template: 'EXEMPT-FINGER' })
ok('but never that of somebody exempt',
  !(await templatesForAgent()).some((t: any) => t.staff_id === exempt.id))

console.log('\n— what the screen by the door is told —')
{
  const { recentPunches, lateMinutesFor } = await import('./src/server/services/attendance')

  const stamp2 = Date.now().toString().slice(-6)
  const person = ((await db.execute<any>(sql`
    INSERT INTO staff (username, display_name, password_hash, role, shift_start, shift_end)
    VALUES (${'k' + stamp2}, ${'Muhammad Ali ' + stamp2}, 'x', 'receptionist',
            '08:40', '16:40')
    RETURNING id`)).rows as any[])[0]

  const d = new Date()
  const arrive = new Date(d); arrive.setHours(8, 53, 0, 0)
  const leave = new Date(d); leave.setHours(16, 45, 0, 0)

  /*
   * The agent cannot work any of this out. Direction is read from the order of
   * the day's punches and lateness from the shift, so both have to come back
   * from the server or the screen can only say "recorded".
   */
  const first: any = await recordPunch({ staffId: person.id, at: arrive, deviceId: dev.id })
  ok('the first punch of a day is an arrival', first.direction === 'in', first.direction)
  ok('it carries the name the screen shows',
    String(first.staff_name).startsWith('Muhammad Ali'))
  ok('08:53 against an 08:40 shift is 13 minutes late',
    first.late_minutes === 13, String(first.late_minutes))

  const second: any = await recordPunch({ staffId: person.id, at: leave, deviceId: dev.id })
  ok('the next punch is a leaving', second.direction === 'out', second.direction)
  /* Nobody is late for going home. */
  ok('lateness is only ever about arriving', lateMinutesFor(leave, { shift_start: null }) === null)

  const seen = await recentPunches({ limit: 5 })
  ok('the board lists the newest scan first',
    Number(seen[0].id) === Number(second.id), String(seen[0]?.id))
  ok('and labels it a leaving too', seen[0].direction === 'out')

  /*
   * The screen asks only for what it has not shown. A quiet corridor must
   * cost one empty reply, not the same six names re-announced every two
   * seconds.
   */
  ok('nothing new means nothing to show',
    (await recentPunches({ since: Number(second.id) })).length === 0)

  const third: any = await recordPunch({
    staffId: person.id, at: new Date(leave.getTime() + 20 * 60_000), deviceId: dev.id })
  const after = await recentPunches({ since: Number(second.id) })
  ok('a new scan arrives on the next poll',
    after.length === 1 && Number(after[0].id) === Number(third.id))
  /*
   * The hospital's rule: scans alternate. The third is a check-in again —
   * somebody coming back from lunch — and is not late for anything.
   */
  ok('a third scan is a check-in again', after[0].direction === 'in', after[0].direction)
  ok('and nobody is late coming back in', after[0].late_minutes == null,
    String(after[0].late_minutes))
}

/* ================================================== alternating scans */

const { directionOf, readDay, todayLocal } = await import('./src/server/services/attendance')

console.log('\n— the rule, on its own —')
ok('1st in, 2nd out, 3rd in, 4th out, 5th in',
  [1, 2, 3, 4, 5].map(directionOf).join(',') === 'in,out,in,out,in')
{
  const d = readDay([
    { at: '2026-03-10T09:00:00' }, { at: '2026-03-10T13:00:00' },
    { at: '2026-03-10T14:00:00' }, { at: '2026-03-10T17:30:00' }])
  ok('a lunch break is time away, not time worked', d.minutes === 4 * 60 + 210,
    String(d.minutes))
  ok('the day ends on a check-out, so it reads as left', d.state === 'left' && !!d.last)
  const back = readDay([
    { at: '2026-03-10T09:00:00' }, { at: '2026-03-10T13:00:00' },
    { at: '2026-03-10T14:00:00' }])
  ok('back from lunch reads as in, with no leaving time', back.state === 'in' && back.last === null)
  ok('and only the closed morning counts so far', back.minutes === 240, String(back.minutes))
  const sorted = readDay([{ at: '2026-03-10T17:00:00' }, { at: '2026-03-10T09:00:00' }])
  ok('direction comes from the time on the punch, not the order it arrived',
    sorted.punches[0].direction === 'in' && String(sorted.punches[0].at).includes('09:00'))
}
ok('today is the local date, not UTC', todayLocal() === (() => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
})())

async function person(label: string, extra = sql``) {
  const s = Date.now().toString().slice(-7) + Math.floor(Math.random() * 1000)
  return ((await db.execute<any>(sql`
    INSERT INTO staff (username, display_name, password_hash, role)
    VALUES (${label.toLowerCase().replace(/\W/g, '') + s}, ${label + ' ' + s}, 'x', 'ward')
    RETURNING id`)).rows as any[])[0].id as number
}
const iso = (s: string) => new Date(s)

console.log('\n— a whole day, scan by scan —')
{
  const id = await person('Alternating Nurse')
  const seq: string[] = []
  for (const t of ['08:58', '13:01', '13:47', '17:05', '19:30']) {
    const r: any = await recordPunch({ staffId: id, at: iso(`2026-03-11T${t}:00`) })
    seq.push(r.direction)
  }
  ok('five scans read in, out, in, out, in', seq.join(',') === 'in,out,in,out,in', seq.join(','))
  const d: any = (await day('2026-03-11')).find((r: any) => r.staff_id === id)
  ok('the day sheet labels each scan the same way',
    d.punches.map((p: any) => p.direction).join(',') === 'in,out,in,out,in')
  ok('and shows them in, because the last scan was a check-in', d.status === 'in')
}

console.log('\n— the next day starts again at check-in —')
{
  const id = await person('Next Day')
  await recordPunch({ staffId: id, at: iso('2026-03-12T09:00:00') })
  await recordPunch({ staffId: id, at: iso('2026-03-12T17:00:00') })
  const late: any = await recordPunch({ staffId: id, at: iso('2026-03-12T22:00:00') })
  ok('a third scan late at night is a check-in', late.direction === 'in')
  const morning: any = await recordPunch({ staffId: id, at: iso('2026-03-13T08:30:00') })
  ok('the first scan of the next calendar day is a check-in, not a check-out',
    morning.direction === 'in' && morning.punch_no === 1,
    `${morning.direction} #${morning.punch_no}`)

  /* A night shift belongs to the night it started, so its morning scan is the check-out. */
  const night = ((await db.execute<any>(sql`
    INSERT INTO staff (username, display_name, password_hash, role, shift_start, shift_end)
    VALUES (${'night' + Date.now()}, 'Night Nurse', 'x', 'ward', '20:00', '04:00')
    RETURNING id`)).rows as any[])[0].id
  await recordPunch({ staffId: night, at: iso('2026-03-12T19:55:00') })
  const out: any = await recordPunch({ staffId: night, at: iso('2026-03-13T03:58:00') })
  ok('a night shift’s 03:58 scan is that night’s check-out',
    out.direction === 'out' && out.work_date === '2026-03-12', `${out.direction} ${out.work_date}`)
}

console.log('\n— a refused scan does not move the sequence on —')
{
  const id = await person('Double Press')
  await recordPunch({ staffId: id, at: iso('2026-03-14T09:00:00') })
  let refusedTwice = false
  try { await recordPunch({ staffId: id, at: iso('2026-03-14T09:02:00') }) }
  catch (e) { refusedTwice = e instanceof AttendanceError && e.code === 'TOO_SOON' }
  ok('a second press two minutes later is refused', refusedTwice)

  /* A back-filled punch a minute BEFORE one already stored is the same press. */
  let refusedEarlier = false
  try { await recordPunch({ staffId: id, at: iso('2026-03-14T08:59:00') }) }
  catch (e) { refusedEarlier = e instanceof AttendanceError && e.code === 'TOO_SOON' }
  ok('so is one a minute before it, arriving late', refusedEarlier)

  const next: any = await recordPunch({ staffId: id, at: iso('2026-03-14T17:00:00') })
  ok('and the next real scan is still the check-out', next.direction === 'out' && next.punch_no === 2,
    `${next.direction} #${next.punch_no}`)
}

console.log('\n— punches arriving out of order —')
{
  const id = await person('Backfill')
  await recordPunch({ staffId: id, at: iso('2026-03-15T17:00:00') })
  const early: any = await recordPunch({ staffId: id, at: iso('2026-03-15T09:00:00') })
  ok('an earlier punch arriving second is still the day’s check-in',
    early.direction === 'in' && early.punch_no === 1, `${early.direction} #${early.punch_no}`)
  const d: any = (await day('2026-03-15')).find((r: any) => r.staff_id === id)
  ok('and the day reads 09:00 in, 17:00 out',
    d.punches.map((p: any) => p.direction).join(',') === 'in,out' && d.minutes === 480,
    `${d.punches.map((p: any) => p.direction)} ${d.minutes}`)
}

console.log('\n— scans arriving at the same moment —')
{
  /*
   * Without the per-person lock, near-simultaneous posts each passed the
   * repeat check before either had stored anything, and both landed.
   */
  const id = await person('Same Moment')
  const base = iso('2026-03-16T09:00:00').getTime()
  const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    recordPunch({ staffId: id, at: new Date(base + i * 10_000) })))
  const stored = burst.filter((r) => r.status === 'fulfilled').length
  const stillThere = Number(((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n FROM attendance_events WHERE staff_id = ${id}`)).rows as any[])[0].n)
  ok('eight presses inside a minute, sent at once, store exactly one', stored === 1 && stillThere === 1,
    `${stored} fulfilled, ${stillThere} stored`)

  /*
   * Separate scans sent together (a back-fill, say) are all kept, and the
   * day reads them in time order whichever order the lock let them in.
   */
  const id2 = await person('Busy Day')
  const t0 = iso('2026-03-17T08:00:00').getTime()
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    recordPunch({ staffId: id2, at: new Date(t0 + (5 - i) * 90 * 60_000) })))
  const d: any = (await day('2026-03-17')).find((r: any) => r.staff_id === id2)
  ok('six separate scans sent at once are all kept', d.punches.length === 6,
    String(d.punches.length))
  ok('and read in, out, in, out, in, out by their times, whoever won the race',
    d.punches.map((p: any) => p.direction).join(',') === 'in,out,in,out,in,out'
    && d.punches.every((p: any, i: number) =>
      i === 0 || new Date(p.at) > new Date(d.punches[i - 1].at)))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
