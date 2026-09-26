import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { sql, eq } from 'drizzle-orm'
import { db } from '../db/client'
import * as s from '../db/schema'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

/**
 * `main_counter` is the cash window; `receptionist` is the OPD desk.
 * The value name is kept for the OPD desk so existing staff rows stay valid.
 */
export type Role = 'admin' | 'main_counter' | 'receptionist' | 'ipd_counter' | 'store_keeper' | 'lab_tech' | 'radiology' | 'doctor' | 'pharmacist' | 'pharmacy_admin' | 'reports'

export type SessionUser = {
  id: number
  username: string
  displayName: string
  role: Role
  departmentId: number | null
  departmentName?: string | null
  /** Set only for doctors, so their screens can find their own queue. */
  doctorId?: number | null
}

/**
 * Unlike the standalone pharmacy till, this runs on a server that browsers
 * around the hospital connect to. Physical access to a ward PC is no longer
 * access to the data, so these credentials are a real boundary rather than
 * only an accountability record — and they guard diagnoses and prescriptions,
 * which is a different category of data from sales receipts.
 *
 * There is no default account. On first run the system has no staff and
 * demands that an admin be created.
 */
const SESSION_HOURS = 12

/**
 * Sessions live in the database, not in this process.
 *
 * They used to be a Map here, which meant a restart signed out everyone who
 * was logged in: in development on every file save, and in a hospital
 * whenever the service is restarted for an upgrade. A cashier halfway through
 * a bill got a blank screen and a 401 with nothing explaining it.
 *
 * The in-memory copy stays as a cache so the common case is not a query per
 * request; the database is the truth, and a cache miss falls back to it.
 */
const cache = new Map<string, { user: SessionUser; expires: number }>()

export async function hashPassword(pw: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${(await scryptAsync(pw, salt, 64)).toString('hex')}`
}

export async function verifyPassword(pw: string, stored: string) {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const want = Buffer.from(hashHex, 'hex')
  const got = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), want.length)
  // Constant-time: a plain === leaks how much of the hash matched via timing.
  return want.length === got.length && timingSafeEqual(want, got)
}

export class AuthError extends Error {
  constructor(
    msg: string,
    public code: 'BAD_CREDENTIALS' | 'WEAK_PASSWORD' | 'DUPLICATE' | 'SETUP_DONE' | 'LAST_ADMIN'
  ) { super(msg) }
}

export async function needsSetup(): Promise<boolean> {
  const r = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM staff WHERE is_active AND role = 'admin'`)
  return Number((r.rows as any[])[0].n) === 0
}

function validate(pw: string, role: Role) {
  // An admin password guards staff, prices and shares. A receptionist or
  // pharmacist types theirs dozens of times a shift on a shared machine, so a
  // shorter one is a deliberate trade: the risk there is a mis-attributed
  // record, not a remote attacker.
  const min = role === 'admin' ? 8 : 4
  if (pw.length < min) {
    throw new AuthError(`An ${role} password must be at least ${min} characters`, 'WEAK_PASSWORD')
  }
}

export async function createFirstAdmin(input: {
  username: string; displayName: string; password: string
}) {
  if (!(await needsSetup())) {
    throw new AuthError('This hospital already has an admin account', 'SETUP_DONE')
  }
  validate(input.password, 'admin')
  const [row] = await db.insert(s.staff).values({
    username: input.username.trim(),
    displayName: input.displayName.trim() || input.username.trim(),
    passwordHash: await hashPassword(input.password),
    role: 'admin'
  }).returning()
  return row
}

export async function login(username: string, password: string) {
  const r = await db.execute<any>(sql`
    SELECT st.*, d.name AS department_name, doc.id AS doctor_id
    FROM staff st
    LEFT JOIN departments d ON d.id = st.department_id
    LEFT JOIN doctors doc ON doc.staff_id = st.id AND doc.is_active
    WHERE lower(st.username) = lower(${username.trim()}) AND st.is_active`)
  const row = (r.rows as any[])[0]

  // Identical error and comparable timing whether the account is missing or
  // the password is wrong, so this cannot be used to discover usernames.
  const fail = new AuthError('Wrong username or password', 'BAD_CREDENTIALS')
  if (!row) { await scryptAsync(password, randomBytes(16), 64); throw fail }
  if (!(await verifyPassword(password, row.password_hash))) throw fail

  await db.execute(sql`UPDATE staff SET last_login_at = now() WHERE id = ${row.id}`)

  const user: SessionUser = {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    doctorId: row.doctor_id ? Number(row.doctor_id) : null
  }
  const token = randomBytes(32).toString('hex')
  const expires = Date.now() + SESSION_HOURS * 3600_000

  await db.execute(sql`
    INSERT INTO sessions (token, staff_id, expires_at)
    VALUES (${token}, ${user.id}, ${new Date(expires).toISOString()})`)
  cache.set(token, { user, expires })

  // Old rows are cleared on the way past rather than by a scheduled job.
  await db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`)

  return { token, user }
}

export async function logout(token: string) {
  cache.delete(token)
  await db.execute(sql`DELETE FROM sessions WHERE token = ${token}`)
}

/**
 * Who a token belongs to.
 *
 * Asynchronous now, because a cache miss reads the database. That is what
 * makes a session survive a restart: the first request after one misses the
 * empty cache, finds the row, and carries on.
 */
export async function sessionFor(token?: string): Promise<SessionUser | null> {
  if (!token) return null

  const hit = cache.get(token)
  if (hit) {
    if (hit.expires >= Date.now()) return hit.user
    cache.delete(token)
  }

  const row = ((await db.execute<any>(sql`
    SELECT s.expires_at, st.id, st.username, st.display_name, st.role, st.department_id,
           d.name AS department_name,
           (SELECT doc.id FROM doctors doc WHERE doc.staff_id = st.id) AS doctor_id
    FROM sessions s
    JOIN staff st ON st.id = s.staff_id AND st.is_active
    LEFT JOIN departments d ON d.id = st.department_id
    WHERE s.token = ${token} AND s.expires_at > now()`)).rows as any[])[0]
  if (!row) return null

  const user: SessionUser = {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    doctorId: row.doctor_id ? Number(row.doctor_id) : null
  }
  cache.set(token, { user, expires: new Date(row.expires_at).getTime() })
  return user
}

/**
 * The live session belonging to a staff id, if they have one.
 *
 * Used by download tickets: the ticket names who asked for the file, and this
 * turns that back into the same permissions they signed in with. Returns null
 * once they sign out, so a ticket cannot outlive the session it came from.
 */
export async function sessionForUser(staffId: number): Promise<SessionUser | null> {
  const row = ((await db.execute<any>(sql`
    SELECT token FROM sessions
    WHERE staff_id = ${staffId} AND expires_at > now()
    ORDER BY last_seen_at DESC LIMIT 1`)).rows as any[])[0]
  return row ? sessionFor(row.token) : null
}

/**
 * Sign somebody out everywhere.
 *
 * Used when an account is archived or its password is changed: a session that
 * outlives either of those is a person still working under credentials that
 * were deliberately taken away.
 */
async function dropSessionsFor(staffId: number) {
  for (const [token, sess] of cache) if (sess.user.id === staffId) cache.delete(token)
  await db.execute(sql`DELETE FROM sessions WHERE staff_id = ${staffId}`)
}

export async function listStaff() {
  const r = await db.execute<any>(sql`
    SELECT st.id, st.username, st.display_name, st.role, st.phone, st.is_active,
           st.last_login_at, d.name AS department_name, st.department_id,
           doc.id AS doctor_id, doc.specialisation, doc.room,
           doc.consultation_fee_paisa, doc.consultation_share_bp, doc.default_service_share_bp
    FROM staff st
    LEFT JOIN departments d ON d.id = st.department_id
    LEFT JOIN doctors doc ON doc.staff_id = st.id
    ORDER BY st.is_active DESC, st.role, st.display_name`)
  return r.rows
}

export async function createStaff(input: {
  username: string; displayName: string; password: string; role: Role
  departmentId?: number | null; phone?: string | null
  doctor?: {
    specialisation?: string | null; qualification?: string | null; room?: string | null
    consultationFeePaisa?: number; consultationShareBp?: number; defaultServiceShareBp?: number
  }
}) {
  validate(input.password, input.role)
  return db.transaction(async (tx) => {
    let row
    try {
      ;[row] = await tx.insert(s.staff).values({
        username: input.username.trim(),
        displayName: input.displayName.trim() || input.username.trim(),
        passwordHash: await hashPassword(input.password),
        role: input.role,
        departmentId: input.departmentId ?? null,
        phone: input.phone ?? null
      }).returning()
    } catch (e: any) {
      if (String(e?.message ?? '').includes('staff_username_uq')) {
        throw new AuthError(`The username "${input.username}" is already taken`, 'DUPLICATE')
      }
      throw e
    }

    // A doctor needs their clinical row created in the same transaction,
    // otherwise a half-made doctor cannot be rostered or paid.
    if (input.role === 'doctor') {
      await tx.insert(s.doctors).values({
        staffId: row.id,
        specialisation: input.doctor?.specialisation ?? null,
        qualification: input.doctor?.qualification ?? null,
        room: input.doctor?.room ?? null,
        consultationFeePaisa: input.doctor?.consultationFeePaisa ?? 0,
        consultationShareBp: input.doctor?.consultationShareBp ?? 10000,
        defaultServiceShareBp: input.doctor?.defaultServiceShareBp ?? 0
      })
    }
    return row
  })
}

export async function updateDoctor(doctorId: number, patch: {
  specialisation?: string | null; qualification?: string | null; room?: string | null
  consultationFeePaisa?: number; consultationShareBp?: number; defaultServiceShareBp?: number
  isActive?: boolean
}) {
  const [row] = await db.update(s.doctors).set(patch).where(eq(s.doctors.id, doctorId)).returning()
  return row
}

export async function setStaffPassword(staffId: number, password: string) {
  const [row] = await db.select().from(s.staff).where(eq(s.staff.id, staffId))
  if (!row) throw new AuthError('No such user', 'BAD_CREDENTIALS')
  validate(password, row.role as Role)
  await db.update(s.staff).set({ passwordHash: await hashPassword(password) })
    .where(eq(s.staff.id, staffId))
  // A password change ends any session opened with the old one.
  await dropSessionsFor(staffId)
}

/** Archive, never delete: visits and prescriptions reference staff. */
export async function archiveStaff(staffId: number) {
  const [row] = await db.select().from(s.staff).where(eq(s.staff.id, staffId))
  if (!row) throw new AuthError('No such user', 'BAD_CREDENTIALS')

  if (row.role === 'admin') {
    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM staff WHERE is_active AND role='admin' AND id <> ${staffId}`)
    if (Number((r.rows as any[])[0].n) === 0) {
      throw new AuthError('This is the only admin account. Create another one first.', 'LAST_ADMIN')
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(s.staff).set({ isActive: false }).where(eq(s.staff.id, staffId))
    await tx.update(s.doctors).set({ isActive: false }).where(eq(s.doctors.staffId, staffId))
  })
  await dropSessionsFor(staffId)
}

export async function restoreStaff(staffId: number) {
  await db.transaction(async (tx) => {
    await tx.update(s.staff).set({ isActive: true }).where(eq(s.staff.id, staffId))
    await tx.update(s.doctors).set({ isActive: true }).where(eq(s.doctors.staffId, staffId))
  })
}
