import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Putting a member of staff onto the network terminal from HMS.
 *
 * HMS cannot speak to the terminal. The attendance agent can, and already
 * does every twenty seconds, so a request is written here as a job and the
 * agent carries it out on its next pass, over the connection it already
 * holds, and writes back what the DEVICE said. Nothing is reported as done
 * until the agent has read the user back off the device.
 *
 * WHAT THIS DOES NOT DO.
 *
 * It does not send fingerprints. The K50 matches with its own templates, and
 * whether a template taken on a USB reader is one the K50 will accept has not
 * been shown on this hardware. Writing one it cannot use would leave a person
 * who "has a finger" and is never recognised. So the identity goes across and
 * the finger is enrolled on the K50 itself, against the id already there.
 *
 * It never deletes or overwrites a user on the device. A device user whose id
 * HMS wanted is a CONFLICT, reported with the name the device holds, and left
 * exactly as it was.
 */

export class TerminalSyncError extends Error {
  constructor(msg: string, public code:
    'NO_STAFF' | 'EXEMPT' | 'NO_DEVICE' | 'CHOOSE_DEVICE' | 'BAD_ID' | 'ID_TAKEN'
    | 'MAPPING_DIFFERS' | 'NOT_FOUND' | 'NOT_PENDING') { super(msg) }
}

/**
 * What an id on the terminal may look like.
 *
 * Digits only, at most nine. The older 28-byte user record holds the id as a
 * 32-bit integer, so anything else cannot be stored there at all, and the
 * K50's own keypad only types digits. All zeros is refused: on the integer
 * layout it is the same as no id.
 */
export const DEVICE_ID = /^(?!0+$)[0-9]{1,9}$/

/** The name field on the device: 24 bytes of UTF-8 on current firmware. */
const NAME_BYTES = 24

/**
 * A name cut to fit the device, on a character boundary.
 *
 * Cut here rather than on the agent so the job records exactly what will be
 * written. Cutting bytes in the middle of a multi-byte letter would write
 * half a character, which the device shows as rubbish.
 */
export function fitName(name: string, bytes = NAME_BYTES): string {
  const clean = name.replace(/[\u0000-\u001f]/g, ' ').trim()
  let out = ''
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch, 'utf8') > bytes) break
    out += ch
  }
  return out.trim()
}

/** The terminals a job can be sent to. */
export async function terminals() {
  return (await db.execute<any>(sql`
    SELECT id, name, location, host, last_seen_at
    FROM attendance_devices
    WHERE kind = 'terminal' AND is_active
    ORDER BY name`)).rows as any[]
}

/**
 * Where somebody stands with the terminals: their id, the terminals there
 * are, and the latest job for each.
 */
export async function syncStatus(staffId: number) {
  const staff = ((await db.execute<any>(sql`
    SELECT id, display_name, device_user_id, attendance_required, is_active
    FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) throw new TerminalSyncError('No such staff member', 'NO_STAFF')

  const jobs = (await db.execute<any>(sql`
    SELECT DISTINCT ON (device_id)
           id, device_id, device_user_id, name, status, result_code, message,
           device_name, requested_by, attempts, created_at, claimed_at, finished_at
    FROM attendance_device_jobs
    WHERE staff_id = ${staffId}
    ORDER BY device_id, id DESC`)).rows as any[]

  return {
    staff: {
      id: staff.id,
      display_name: staff.display_name,
      device_user_id: staff.device_user_id,
      attendance_required: staff.attendance_required,
      /* What a sync would use if run now, so the screen can say it first. */
      proposed_id: staff.device_user_id || String(staff.id)
    },
    terminals: await terminals(),
    jobs
  }
}

/**
 * Ask for somebody to be put on a terminal.
 *
 * Safe to press twice: a job already waiting for this person on this device
 * is handed back rather than a second one queued.
 */
export async function requestSync(input: {
  staffId: number
  deviceId?: number | null
  /** Only for somebody with no terminal id yet. */
  deviceUserId?: string | null
  by?: string
}) {
  const staff = ((await db.execute<any>(sql`
    SELECT id, display_name, device_user_id, attendance_required, is_active
    FROM staff WHERE id = ${input.staffId}`)).rows as any[])[0]
  if (!staff || !staff.is_active) {
    throw new TerminalSyncError('No such active staff member', 'NO_STAFF')
  }
  /*
   * Somebody exempt from attendance has their punches refused at the server,
   * so putting them on the terminal would only produce scans that go nowhere.
   */
  if (!staff.attendance_required) {
    throw new TerminalSyncError(
      `${staff.display_name} is marked as not needing attendance. ` +
      'Change that first if they should use the terminal.', 'EXEMPT')
  }

  const device = await pickTerminal(input.deviceId)

  /*
   * WHICH ID.
   *
   * A terminal id already set against this person is the truth: somebody
   * decided it, and punches are already being read through it. A different
   * one asked for here is refused rather than quietly replacing it — that
   * change belongs in the staff form, where it is visible.
   *
   * With none set, the id asked for, or else the HMS staff id. The staff id is
   * the convention this system already uses for a terminal enrolled alongside
   * it, and a number nobody has to look up.
   */
  const mapped = (staff.device_user_id ?? '').trim() || null
  const asked = (input.deviceUserId ?? '').trim() || null
  if (mapped && asked && asked !== mapped) {
    throw new TerminalSyncError(
      `${staff.display_name} already has terminal id ${mapped}. ` +
      'Change it under Staff, Edit if it is wrong.', 'MAPPING_DIFFERS')
  }
  const id = mapped ?? asked ?? String(staff.id)

  if (!DEVICE_ID.test(id)) {
    throw new TerminalSyncError(
      `"${id}" cannot be used as a terminal id. Use digits only, up to nine.`, 'BAD_ID')
  }

  /* Somebody else in HMS already answers to that id. */
  const owner = ((await db.execute<any>(sql`
    SELECT id, display_name FROM staff
    WHERE device_user_id = ${id} AND id <> ${staff.id}`)).rows as any[])[0]
  if (owner) {
    throw new TerminalSyncError(
      `Terminal id ${id} already belongs to ${owner.display_name} in HMS.`, 'ID_TAKEN')
  }

  const name = fitName(staff.display_name || `Staff ${staff.id}`)

  /* Already waiting: hand that one back. */
  const open = await openJobFor(device.id, staff.id)
  if (open) return { job: open, existing: true }

  try {
    const job = ((await db.execute<any>(sql`
      INSERT INTO attendance_device_jobs
        (device_id, staff_id, kind, device_user_id, name, requested_by)
      VALUES (${device.id}, ${staff.id}, 'sync_user', ${id}, ${name}, ${input.by ?? null})
      RETURNING *`)).rows as any[])[0]
    return { job, existing: false }
  } catch (e: any) {
    const msg = String(e?.message ?? '')
    /* Two presses racing: the other one won, which is the same answer. */
    if (msg.includes('attendance_device_jobs_one_open_uq')) {
      const again = await openJobFor(device.id, staff.id)
      if (again) return { job: again, existing: true }
    }
    if (msg.includes('attendance_device_jobs_one_id_uq')) {
      throw new TerminalSyncError(
        `Terminal id ${id} is already being set up for somebody else on ` +
        `${device.name}. Wait for that to finish.`, 'ID_TAKEN')
    }
    throw e
  }
}

async function openJobFor(deviceId: number, staffId: number) {
  return ((await db.execute<any>(sql`
    SELECT * FROM attendance_device_jobs
    WHERE device_id = ${deviceId} AND staff_id = ${staffId}
      AND status IN ('pending', 'running')
    ORDER BY id DESC LIMIT 1`)).rows as any[])[0] ?? null
}

async function pickTerminal(deviceId?: number | null) {
  const list = await terminals()
  if (deviceId) {
    const d = list.find((t) => Number(t.id) === Number(deviceId))
    if (!d) throw new TerminalSyncError('That terminal is not active', 'NO_DEVICE')
    return d
  }
  if (list.length === 0) {
    throw new TerminalSyncError(
      'There is no terminal set up. Add one under Attendance, Readers, as ' +
      '"Terminal on the network".', 'NO_DEVICE')
  }
  if (list.length > 1) {
    throw new TerminalSyncError('Choose which terminal', 'CHOOSE_DEVICE')
  }
  return list[0]
}

/** Take back a request the agent has not started. */
export async function cancelJob(jobId: number) {
  const row = ((await db.execute<any>(sql`
    UPDATE attendance_device_jobs
    SET status = 'failed', result_code = 'CANCELLED',
        message = 'Cancelled before the agent picked it up.', finished_at = now()
    WHERE id = ${jobId} AND status = 'pending'
    RETURNING *`)).rows as any[])[0]
  if (row) return row
  const exists = ((await db.execute<any>(sql`
    SELECT status FROM attendance_device_jobs WHERE id = ${jobId}`)).rows as any[])[0]
  if (!exists) throw new TerminalSyncError('No such request', 'NOT_FOUND')
  throw new TerminalSyncError(
    'The agent has already started on this one. It will finish by itself.', 'NOT_PENDING')
}

/* ============================================================ the agent */

/**
 * How long the agent may hold a job before it is offered again.
 *
 * A job is claimed, then done over the network to the device, then reported.
 * If the agent dies in the middle, the job would otherwise sit as "running"
 * forever. Offering it again is safe because the agent reads the device
 * before it writes: a person it already created is found, not created twice.
 */
const STALE_MINUTES = 3
/** After this many tries a job is given up on, and says so. */
const MAX_ATTEMPTS = 3

/**
 * The jobs waiting for one device, claimed for its agent.
 *
 * `FOR UPDATE SKIP LOCKED` so two copies of an agent running by mistake
 * against one key never both take the same job.
 */
export async function claimJobs(deviceId: number, limit = 5) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE attendance_device_jobs
      SET status = 'failed', result_code = 'GAVE_UP', finished_at = now(),
          message = 'The agent took this ' || attempts || ' times without ' ||
                    'reporting back. Check the agent log on the terminal PC.'
      WHERE device_id = ${deviceId} AND status = 'running'
        AND claimed_at < now() - make_interval(mins => ${STALE_MINUTES})
        AND attempts >= ${MAX_ATTEMPTS}`)

    return (await tx.execute<any>(sql`
      UPDATE attendance_device_jobs j
      SET status = 'running', claimed_at = now(), attempts = j.attempts + 1
      FROM (
        SELECT id FROM attendance_device_jobs
        WHERE device_id = ${deviceId}
          AND (status = 'pending'
               OR (status = 'running'
                   AND claimed_at < now() - make_interval(mins => ${STALE_MINUTES})))
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) c
      WHERE j.id = c.id
      RETURNING j.id, j.kind, j.staff_id, j.device_user_id, j.name, j.attempts`)).rows
  })
}

export type JobOutcome = {
  id: number
  /*
   * CREATED          written, and read back off the device
   * ALREADY_PRESENT  the device already had a user with that id; not touched
   * DEVICE_FULL      no room for another user
   * DEVICE_ERROR     the device refused, or the connection broke mid-job
   * DEVICE_UNREACHABLE  the agent could not connect at all
   * VERIFY_FAILED    accepted, but not there when read back
   */
  code: 'CREATED' | 'ALREADY_PRESENT' | 'DEVICE_FULL' | 'DEVICE_ERROR'
    | 'DEVICE_UNREACHABLE' | 'VERIFY_FAILED'
  message?: string | null
  /** The name the device holds under that id, as read back. */
  deviceName?: string | null
  /** The name this job writes, as it fits the device's own record layout. */
  expectedName?: string | null
}

/**
 * What the agent found, turned into an answer for the screen.
 *
 * The one decision with any judgement in it is ALREADY_PRESENT. The device
 * has somebody under that id. Is it this person?
 *
 *   - If HMS already maps this person to that id, yes: somebody decided so.
 *   - If this is a RETRY and the device holds exactly the name this job
 *     writes, yes: the previous attempt wrote it and the report was lost.
 *   - Otherwise, not knowable. It is reported as a conflict, the device is
 *     left alone, and a person decides.
 *
 * A first attempt that finds a matching name is still a conflict. Two
 * different people called Ali exist, and the cost of guessing wrong is one
 * person's attendance filed under another's name, which nobody ever finds.
 */
export async function finishJob(deviceId: number, outcome: JobOutcome) {
  return db.transaction(async (tx) => {
    const job = ((await tx.execute<any>(sql`
      SELECT * FROM attendance_device_jobs
      WHERE id = ${outcome.id} AND device_id = ${deviceId}
      FOR UPDATE`)).rows as any[])[0]
    if (!job) throw new TerminalSyncError('No such job for this device', 'NOT_FOUND')

    /* Reported twice, which a retried post does. The first answer stands. */
    if (job.status === 'done' || job.status === 'failed') return job
    if (job.status !== 'running') {
      throw new TerminalSyncError('That job was never handed out', 'NOT_PENDING')
    }

    const staff = ((await tx.execute<any>(sql`
      SELECT id, display_name, device_user_id FROM staff
      WHERE id = ${job.staff_id} FOR UPDATE`)).rows as any[])[0]

    const devName = (outcome.deviceName ?? '').trim() || null
    const finish = async (status: 'done' | 'failed', code: string, message: string) =>
      ((await tx.execute<any>(sql`
        UPDATE attendance_device_jobs
        SET status = ${status}, result_code = ${code}, message = ${message.slice(0, 500)},
            device_name = ${devName}, finished_at = now()
        WHERE id = ${job.id}
        RETURNING *`)).rows as any[])[0]

    if (!staff) return finish('failed', 'NO_STAFF', 'The staff member no longer exists.')

    const mappedHere = (staff.device_user_id ?? '').trim() === job.device_user_id

    if (outcome.code === 'CREATED' || outcome.code === 'ALREADY_PRESENT') {
      const sameName = !!devName && !!outcome.expectedName
        && devName === outcome.expectedName.trim()
      const ours = outcome.code === 'CREATED' || mappedHere
        || (job.attempts > 1 && sameName)

      if (!ours) {
        return finish('failed', 'CONFLICT',
          `The terminal already has user ${job.device_user_id}` +
          (devName ? ` ("${devName}")` : '') + '. HMS did not change it. ' +
          `If that is ${staff.display_name}, set their terminal id to ` +
          `${job.device_user_id} under Staff, Edit, and press this again. ` +
          'If it is somebody else, choose a different id.')
      }

      /*
       * Remember the id, so punches from it are filed under this person.
       *
       * Only when they have none, or have this one. An id somebody changed
       * by hand while the job was running is theirs to keep.
       */
      if (!staff.device_user_id) {
        try {
          await tx.execute(sql`SAVEPOINT map_id`)
          await tx.execute(sql`
            UPDATE staff SET device_user_id = ${job.device_user_id} WHERE id = ${staff.id}`)
          await tx.execute(sql`RELEASE SAVEPOINT map_id`)
        } catch (e: any) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT map_id`)
          if (!String(e?.message ?? '').includes('staff_device_user_uq')) throw e
          return finish('failed', 'CONFLICT',
            `User ${job.device_user_id} is on the terminal, but another member ` +
            'of staff was given that terminal id in HMS meanwhile. Sort out ' +
            'which person it is under Staff, Edit.')
        }
      } else if (!mappedHere) {
        return finish('failed', 'CONFLICT',
          `${staff.display_name}'s terminal id was changed to ` +
          `${staff.device_user_id} while this was running. Press this again.`)
      }

      return finish('done', outcome.code,
        outcome.code === 'CREATED'
          ? `Created on the terminal as user ${job.device_user_id}.`
          : `Already on the terminal as user ${job.device_user_id}` +
            (devName ? ` ("${devName}")` : '') + '.')
    }

    return finish('failed', outcome.code,
      (outcome.message ?? '').trim() || 'The terminal did not accept it.')
  })
}
