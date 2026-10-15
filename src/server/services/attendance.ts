import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { randomBytes } from 'node:crypto'

/**
 * Attendance.
 *
 * A punch is a fact. Arrived, left, late and absent are read off those facts
 * when somebody asks, never stored, so correcting a shift or a punch corrects
 * every day it touches rather than only the days recorded afterwards.
 */

export class AttendanceError extends Error {
  constructor(msg: string, public code:
    'NO_STAFF' | 'TOO_SOON' | 'EXEMPT' | 'NO_DEVICE' | 'NOT_FOUND') { super(msg) }
}

/** Two scans inside this window are one arrival, not an arrival and a leave. */
export const REPEAT_WINDOW_MINUTES = 5

const pad = (n: number) => String(n).padStart(2, '0')
const dateOf = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Which day a punch belongs to.
 *
 * Usually its own date. The exception is a shift that crosses midnight: a
 * nurse on 20:00 to 04:00 punches out at 03:50 on the following date, and
 * filing that under the following day would show her leaving a day she never
 * started and absent on the day she worked.
 *
 * The rule is the shift's own: if it ends before it starts, it crosses
 * midnight, and anything before the end time belongs to the day before.
 */
export function workDateFor(at: Date, shift?: {
  shift_start?: string | null; shift_end?: string | null
}): string {
  const start = shift?.shift_start
  const end = shift?.shift_end
  if (!start || !end) return dateOf(at)

  const [sh, sm] = String(start).split(':').map(Number)
  const [eh, em] = String(end).split(':').map(Number)
  const crossesMidnight = eh * 60 + em <= sh * 60 + sm
  if (!crossesMidnight) return dateOf(at)

  /*
   * An hour of slack past the end of the shift.
   *
   * Somebody who stays to finish a handover and leaves at 04:40 is still on
   * the night that started yesterday. Without the slack their leaving punch
   * would file under today and their shift would look as though it never
   * ended.
   */
  const minutes = at.getHours() * 60 + at.getMinutes()
  if (minutes <= eh * 60 + em + 60) {
    const prev = new Date(at)
    prev.setDate(prev.getDate() - 1)
    return dateOf(prev)
  }
  return dateOf(at)
}

/* ---------------------------------------------------------------- staff */

export async function staffForAttendance() {
  const r = await db.execute<any>(sql`
    SELECT id, display_name, username, role, shift_start, shift_end,
           attendance_required,
           (SELECT COUNT(*)::int FROM staff_fingerprints f WHERE f.staff_id = s.id)
             AS fingers
    FROM staff s
    WHERE is_active
    ORDER BY display_name`)
  return r.rows
}

/* -------------------------------------------------------------- devices */

export async function devices() {
  const r = await db.execute<any>(sql`
    SELECT id, name, location, kind, host, last_seen_at, is_active, created_at,
           -- The key is never sent back whole. Enough to tell two apart, not
           -- enough to use if the screen is read over somebody's shoulder.
           LEFT(api_key, 6) || '…' AS key_hint
    FROM attendance_devices ORDER BY name`)
  return r.rows
}

export async function saveDevice(input: {
  id?: number; name: string; location?: string | null; isActive?: boolean
  /**
   * Which kind of machine this is.
   *
   * 'reader'   a USB scanner on a PC. HMS holds the fingerprints and the
   *            agent on that PC does the matching, so enrolment happens on
   *            the HMS screen.
   * 'terminal' a standalone unit on the network. It holds its own
   *            fingerprints and does its own matching, so enrolment happens
   *            ON THE DEVICE and HMS only needs to know whose user id is
   *            whose.
   *
   * It changes nothing about how a punch is stored — both arrive at the same
   * route and become the same row. It is recorded so the screen can tell the
   * box on the wall from the scanner on the desk, and so the enrolment
   * screen can say that a terminal is not enrolled from here.
   */
  kind?: 'reader' | 'terminal'
  /** Where a terminal lives on the network. Documentation, not configuration. */
  host?: string | null
}) {
  if (!input.name.trim()) throw new AttendanceError('The device needs a name', 'NOT_FOUND')
  const kind = input.kind === 'terminal' ? 'terminal' : 'reader'

  if (input.id) {
    await db.execute(sql`
      UPDATE attendance_devices
      SET name = ${input.name.trim()}, location = ${input.location ?? null},
          kind = ${kind}, host = ${input.host?.trim() || null},
          is_active = ${input.isActive ?? true}
      WHERE id = ${input.id}`)
    return ((await db.execute<any>(sql`
      SELECT id, name, location, kind, host FROM attendance_devices
      WHERE id = ${input.id}`)).rows as any[])[0]
  }

  /*
   * The key is shown once, when the reader is created.
   *
   * It goes into the agent's configuration on the attendance PC and is not
   * needed again. Showing it on every visit to the screen would mean it is
   * readable by anybody who wanders past an unlocked admin session.
   */
  const apiKey = randomBytes(24).toString('hex')
  const row = ((await db.execute<any>(sql`
    INSERT INTO attendance_devices (name, location, api_key, kind, host)
    VALUES (${input.name.trim()}, ${input.location ?? null}, ${apiKey},
            ${kind}, ${input.host?.trim() || null})
    RETURNING id, name, location, kind, host`)).rows as any[])[0]
  return { ...row, api_key: apiKey }
}

export async function deviceByKey(apiKey: string) {
  const row = ((await db.execute<any>(sql`
    SELECT id, name FROM attendance_devices
    WHERE api_key = ${apiKey} AND is_active`)).rows as any[])[0]
  if (!row) throw new AttendanceError('Unknown reader', 'NO_DEVICE')
  await db.execute(sql`
    UPDATE attendance_devices SET last_seen_at = now() WHERE id = ${row.id}`)
  return row
}

/* --------------------------------------------------------------- punches */

export async function recordPunch(input: {
  staffId: number
  at?: Date | string
  source?: 'device' | 'manual'
  deviceId?: number | null
  note?: string | null
  raw?: string | null
  by?: string
}) {
  const at = input.at ? new Date(input.at) : new Date()

  const staff = ((await db.execute<any>(sql`
    SELECT id, display_name, shift_start, shift_end, attendance_required
    FROM staff WHERE id = ${input.staffId} AND is_active`)).rows as any[])[0]
  if (!staff) throw new AttendanceError('No such staff member', 'NO_STAFF')

  /*
   * An exempt person is refused, not silently recorded.
   *
   * If somebody marked as not needing attendance puts a finger on the reader,
   * either the exemption is wrong or the identification is. Recording it
   * quietly hides both.
   */
  if (!staff.attendance_required) {
    throw new AttendanceError(
      `${staff.display_name} is marked as not needing attendance.`, 'EXEMPT')
  }

  const workDate = workDateFor(at, staff)

  /*
   * A second scan within five minutes is the same arrival.
   *
   * People press twice when the first beep is quiet, and a reader by a door
   * catches somebody walking back for their bag. Treating those as a leave
   * would show a nurse working four minutes.
   */
  const recent = ((await db.execute<any>(sql`
    SELECT at FROM attendance_events
    WHERE staff_id = ${input.staffId}
      AND at > ${new Date(at.getTime() - REPEAT_WINDOW_MINUTES * 60_000).toISOString()}
      AND at <= ${at.toISOString()}
    ORDER BY at DESC LIMIT 1`)).rows as any[])[0]
  if (recent) {
    throw new AttendanceError(
      `${staff.display_name} already scanned a moment ago.`, 'TOO_SOON')
  }

  const r = await db.execute<any>(sql`
    INSERT INTO attendance_events
      (staff_id, at, source, device_id, work_date, note, added_by, raw)
    VALUES (${input.staffId}, ${at.toISOString()}, ${input.source ?? 'device'},
            ${input.deviceId ?? null}, ${workDate}, ${input.note ?? null},
            ${input.by ?? null}, ${input.raw ?? null})
    ON CONFLICT DO NOTHING
    RETURNING *`)

  const saved = (r.rows as any[])[0]
  if (!saved) {
    // The unique index caught a retry of a punch already stored.
    throw new AttendanceError(
      `That punch for ${staff.display_name} is already recorded.`, 'TOO_SOON')
  }

  /*
   * What the screen by the door has to say.
   *
   * The agent cannot work any of this out. Direction is not stored on a punch
   * — it is read from the order of the day's punches — so only the server
   * knows whether this was an arrival or a leaving, and only the server knows
   * the shift it is late against. Returning it here is what lets the screen
   * say "Checked in, 12 minutes late" instead of "Recorded".
   */
  const countToday = Number(((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n FROM attendance_events
    WHERE staff_id = ${input.staffId} AND work_date = ${workDate}`)).rows as any[])[0].n)

  return {
    ...saved,
    staff_name: staff.display_name,
    /*
     * The first punch of a day is the arrival; anything after it is the
     * current leaving time. Somebody who scans a third time has simply moved
     * their leaving time later, which is what "out" keeps meaning.
     */
    direction: countToday <= 1 ? 'in' : 'out',
    punch_no: countToday,
    late_minutes: lateMinutesFor(at, staff),
    shift_start: staff.shift_start,
    work_date: workDate
  }
}

/**
 * How late this arrival is, in minutes.
 *
 * Only against a shift: somebody with no shift set is present, never late,
 * and saying otherwise would scold people nobody expected at a given hour.
 */
export function lateMinutesFor(at: Date, staff: {
  shift_start?: string | null
}): number | null {
  if (!staff?.shift_start) return null
  const [h, m] = String(staff.shift_start).split(':').map(Number)
  const due = new Date(at)
  due.setHours(h, m, 0, 0)
  const diff = Math.round((at.getTime() - due.getTime()) / 60_000)
  return diff > 0 ? diff : 0
}

export async function deletePunch(id: number) {
  const r = await db.execute<any>(sql`
    DELETE FROM attendance_events WHERE id = ${id} RETURNING id`)
  if ((r.rows as any[]).length === 0) {
    throw new AttendanceError('No such punch', 'NOT_FOUND')
  }
  return { deleted: true }
}

/* ------------------------------------------------------- reading it back */

type DayRow = {
  staff_id: number
  display_name: string
  role: string
  shift_start: string | null
  shift_end: string | null
  attendance_required: boolean
  punches: { id: number; at: string; source: string; note: string | null }[]
}

/**
 * One day, every person.
 *
 * Direction is worked out here rather than stored: the first punch of a day
 * is the arrival and the last is the leaving. That is what the hospital asked
 * for, and it has one consequence worth knowing — somebody who scans on the
 * way out to lunch and again on the way back shows a shorter day than they
 * worked, because the middle two punches are not read as a break. The
 * punches are all kept, so if that becomes a problem it is answerable later
 * without re-collecting anything.
 */
export async function day(date: string) {
  const staff = (await db.execute<any>(sql`
    SELECT id, display_name, role, shift_start, shift_end, attendance_required
    FROM staff WHERE is_active ORDER BY display_name`)).rows as any[]

  const events = (await db.execute<any>(sql`
    SELECT id, staff_id, at, source, note, added_by
    FROM attendance_events WHERE work_date = ${date}
    ORDER BY at`)).rows as any[]

  const byStaff = new Map<number, any[]>()
  for (const e of events) {
    const list = byStaff.get(e.staff_id) ?? []
    list.push(e)
    byStaff.set(e.staff_id, list)
  }

  return staff.map((s): DayRow & {
    first: string | null; last: string | null
    minutes: number | null; late_minutes: number | null
    status: string
  } => {
    const punches = byStaff.get(s.id) ?? []
    const first = punches[0]?.at ?? null
    const last = punches.length > 1 ? punches[punches.length - 1].at : null

    const minutes = first && last
      ? Math.round((new Date(last).getTime() - new Date(first).getTime()) / 60_000)
      : null

    /*
     * Lateness only means something against a shift.
     *
     * Somebody with no shift set is not late, they are simply present. Saying
     * otherwise would fill the report with people nobody expected at a
     * particular hour.
     */
    let lateMinutes: number | null = null
    if (first && s.shift_start) {
      const at = new Date(first)
      const [sh, sm] = String(s.shift_start).split(':').map(Number)
      const due = new Date(at)
      due.setHours(sh, sm, 0, 0)
      const diff = Math.round((at.getTime() - due.getTime()) / 60_000)
      lateMinutes = diff > 0 ? diff : 0
    }

    const status = !s.attendance_required ? 'exempt'
      : punches.length === 0 ? 'absent'
      : last ? 'left' : 'in'

    return {
      staff_id: s.id, display_name: s.display_name, role: s.role,
      shift_start: s.shift_start, shift_end: s.shift_end,
      attendance_required: s.attendance_required,
      punches: punches.map((p) => ({
        id: p.id, at: p.at, source: p.source, note: p.note
      })),
      first, last, minutes, late_minutes: lateMinutes, status
    }
  })
}

/** Who is in the building right now: punched in today, no leaving punch yet. */
export async function onSite() {
  const today = dateOf(new Date())
  return (await day(today)).filter((r) => r.status === 'in')
}

/**
 * One person, one month.
 *
 * Built from the same reading as the day view, so a correction shows in both
 * and the two can never disagree.
 */
export async function monthFor(staffId: number, year: number, month: number) {
  const from = `${year}-${pad(month)}-01`
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`

  const staff = ((await db.execute<any>(sql`
    SELECT id, display_name, role, shift_start, shift_end, attendance_required
    FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) throw new AttendanceError('No such staff member', 'NO_STAFF')

  const events = (await db.execute<any>(sql`
    SELECT id, at, work_date, source, note
    FROM attendance_events
    WHERE staff_id = ${staffId} AND work_date >= ${from} AND work_date < ${to}
    ORDER BY at`)).rows as any[]

  const byDate = new Map<string, any[]>()
  for (const e of events) {
    const key = typeof e.work_date === 'string'
      ? e.work_date.slice(0, 10) : dateOf(new Date(e.work_date))
    const list = byDate.get(key) ?? []
    list.push(e)
    byDate.set(key, list)
  }

  const days: any[] = []
  const last = new Date(year, month, 0).getDate()
  for (let d = 1; d <= last; d++) {
    const date = `${year}-${pad(month)}-${pad(d)}`
    const punches = byDate.get(date) ?? []
    const first = punches[0]?.at ?? null
    const lastAt = punches.length > 1 ? punches[punches.length - 1].at : null
    days.push({
      date,
      punches,
      first,
      last: lastAt,
      minutes: first && lastAt
        ? Math.round((new Date(lastAt).getTime() - new Date(first).getTime()) / 60_000)
        : null,
      status: !staff.attendance_required ? 'exempt'
        : punches.length === 0 ? 'absent' : lastAt ? 'left' : 'in'
    })
  }

  const present = days.filter((d) => d.punches.length > 0).length
  return {
    staff,
    days,
    totals: {
      present,
      absent: staff.attendance_required ? days.length - present : 0,
      minutes: days.reduce((n, d) => n + (d.minutes ?? 0), 0)
    }
  }
}

/* ----------------------------------------------------------- enrolment */

export async function fingerprintsFor(staffId: number) {
  const r = await db.execute<any>(sql`
    SELECT id, finger_index, enrolled_by, created_at
    FROM staff_fingerprints WHERE staff_id = ${staffId} ORDER BY finger_index`)
  return r.rows
}

export async function saveFingerprint(input: {
  staffId: number; fingerIndex: number; template: string; by?: string
}) {
  const r = await db.execute<any>(sql`
    INSERT INTO staff_fingerprints (staff_id, finger_index, template, enrolled_by)
    VALUES (${input.staffId}, ${input.fingerIndex}, ${input.template}, ${input.by ?? null})
    ON CONFLICT (staff_id, finger_index)
    DO UPDATE SET template = EXCLUDED.template, enrolled_by = EXCLUDED.enrolled_by,
                  created_at = now()
    RETURNING id, finger_index`)
  return (r.rows as any[])[0]
}

export async function deleteFingerprint(id: number) {
  await db.execute(sql`DELETE FROM staff_fingerprints WHERE id = ${id}`)
  return { deleted: true }
}

/**
 * Every template, for the agent to load at startup.
 *
 * Matching happens on the attendance PC rather than here: it is faster, and
 * it keeps working when the LAN does not. The cost is that the templates
 * travel over the network, which is why the reader has a key.
 */
/**
 * Who the terminal's user ids belong to.
 *
 * A standalone terminal identifies the person itself and hands over a user
 * id of its own choosing. This is the only thing the agent needs from HMS in
 * terminal mode — no templates, because the device holds its own.
 *
 * `device_user_id` is sent as the mapping when it is set. When it is not,
 * the staff id is sent as the fallback, which makes a terminal enrolled
 * alongside HMS work with no mapping at all: user 7 on the device is staff
 * 7 here.
 *
 * Exempt and inactive staff are left out for the same reason they are left
 * out of the template list: a punch from them is refused at the other end,
 * and sending the mapping would only turn a clear refusal into a confusing
 * one.
 */
export async function rosterForAgent() {
  const r = await db.execute<any>(sql`
    SELECT s.id AS staff_id,
           COALESCE(NULLIF(s.device_user_id, ''), s.id::text) AS device_user_id,
           s.display_name,
           /* So the agent's log can say whether a mapping was set or guessed. */
           (s.device_user_id IS NOT NULL AND s.device_user_id <> '') AS mapped
    FROM staff s
    WHERE s.is_active AND s.attendance_required
    ORDER BY s.display_name`)
  return r.rows
}

export async function templatesForAgent() {
  const r = await db.execute<any>(sql`
    SELECT f.staff_id, f.finger_index, f.template, s.display_name
    FROM staff_fingerprints f
    JOIN staff s ON s.id = f.staff_id
    WHERE s.is_active AND s.attendance_required
    ORDER BY f.staff_id, f.finger_index`)
  return r.rows
}


/**
 * The last few scans, for the screen by the door.
 *
 * Polled rather than pushed, and read from the database rather than echoed by
 * the agent: the whole point of this screen is that it confirms what the
 * SERVER stored. A screen driven by the agent would happily say "recorded"
 * for a punch that never arrived.
 *
 * `since` lets the screen ask only for what it has not shown yet, so a quiet
 * corridor costs one empty reply every couple of seconds.
 */
export async function recentPunches(opts: { since?: number; limit?: number } = {}) {
  const rows = (await db.execute<any>(sql`
    SELECT e.id, e.at, e.source, e.work_date,
           s.display_name, s.role, s.shift_start,
           -- Which punch of that person's day this was, so the screen can say
           -- arrival or leaving without the caller working it out.
           (SELECT COUNT(*)::int FROM attendance_events x
            WHERE x.staff_id = e.staff_id AND x.work_date = e.work_date
              AND x.at <= e.at) AS punch_no
    FROM attendance_events e
    JOIN staff s ON s.id = e.staff_id
    /*
     * The last few, with no time window.
     *
     * It was the last twelve hours, which meant a nurse arriving for a night
     * shift saw an empty board — the morning's arrivals had aged out — and
     * made this behave differently depending on the hour it was asked.
     *
     * The window bought nothing: the screen only announces punches NEWER than
     * the one it started from, so an old scan can never be mistaken for a
     * fresh one. What is left is a short history strip, and a quiet reader
     * showing yesterday's last six is honest rather than misleading.
     */
    WHERE ${opts.since ? sql`e.id > ${opts.since}` : sql`true`}
    ORDER BY e.id DESC
    LIMIT ${opts.limit ?? 8}`)).rows as any[]

  return rows.map((r) => ({
    ...r,
    direction: Number(r.punch_no) <= 1 ? 'in' : 'out',
    late_minutes: lateMinutesFor(new Date(r.at), r)
  }))
}
