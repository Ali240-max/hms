import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * What a second administrator is allowed to change.
 *
 * A hospital ends up with more than one administrator account: the owner, the
 * manager, whoever sets up the staff list. They do not all need the same
 * powers, and the ones that matter most are the quiet ones — changing a price,
 * changing a doctor's share, clearing the system — because nothing about the
 * screen tells you afterwards that it happened.
 *
 * So this works the same way the pharmacy permissions do: a list of named
 * things, ticked per account, stored as overrides.
 *
 * Two rules keep it from locking everybody out:
 *
 *   1. The first administrator account — the one created when the system was
 *      installed — always holds everything and cannot be restricted, by
 *      anybody including itself. Without that, one careless save leaves a
 *      hospital with no way in to undo it.
 *   2. Only somebody holding `admin.access` can change anyone's permissions,
 *      and the root administrator always holds it.
 */

export type AdminPermission = {
  key: string
  group: string
  label: string
  blurb: string
  /** Denied by default for a new administrator, because of what it can do. */
  guarded?: boolean
}

export const ADMIN_PERMISSIONS: AdminPermission[] = [
  { key: 'admin.overview', group: 'Reading', label: 'Overview',
    blurb: 'The dashboard: patients today, fees taken, department activity.' },
  { key: 'admin.reports', group: 'Reading', label: 'Reports',
    blurb: 'Every report in the system, read only.' },

  { key: 'admin.staff.view', group: 'Staff', label: 'See the staff list',
    blurb: 'Who has an account and what role they hold.' },
  { key: 'admin.staff.edit', group: 'Staff', label: 'Add and edit staff',
    blurb: 'Create accounts, change roles, archive somebody.' },
  { key: 'admin.staff.password', group: 'Staff', label: 'Reset passwords',
    blurb: 'Set a new password for another member of staff.' },

  { key: 'admin.services.view', group: 'Services and prices', label: 'See services',
    blurb: 'The list of tests, scans and procedures.' },
  { key: 'admin.services.edit', group: 'Services and prices', label: 'Add and edit services',
    blurb: 'Names, categories, and whether a service is offered at all.' },
  { key: 'admin.services.price', group: 'Services and prices', label: 'Change prices',
    blurb: 'What the hospital charges. Every bill afterwards uses the new figure.',
    guarded: true },
  { key: 'admin.shares', group: 'Services and prices', label: 'Change doctor shares',
    blurb: 'What proportion of a fee a doctor keeps. This is somebody\'s pay.',
    guarded: true },

  { key: 'admin.departments', group: 'Setup', label: 'Departments',
    blurb: 'Add or rename a department.' },
  { key: 'admin.settings', group: 'Setup', label: 'Hospital details',
    blurb: 'Name, address, logo and the text printed on slips.' },
  { key: 'admin.modules', group: 'Setup', label: 'Modules in use',
    blurb: 'Switch a whole module on or off for the hospital.' },

  { key: 'admin.backup', group: 'Data', label: 'Backups',
    blurb: 'Run a backup and set where the second copy is kept.' },
  { key: 'admin.demo', group: 'Data', label: 'Load demo data',
    blurb: 'Fill an empty system with fictional patients for training.',
    guarded: true },
  { key: 'admin.wipe', group: 'Data', label: 'Clear all data',
    blurb: 'Delete every patient, visit, bill and result. Cannot be undone from inside.',
    guarded: true },

  { key: 'admin.access', group: 'Staff', label: 'Set what other administrators can do',
    blurb: 'This screen. Somebody holding it can grant themselves anything else.',
    guarded: true }
]

/** Everything except the guarded ones, which are granted deliberately. */
const DEFAULT_ALLOWED = ADMIN_PERMISSIONS.filter((p) => !p.guarded).map((p) => p.key)
const ALL_KEYS: string[] = ADMIN_PERMISSIONS.map((p) => p.key)

/**
 * The first administrator ever created.
 *
 * Identified by being the oldest active admin account rather than by a flag,
 * so there is nothing to get out of step and nothing to edit into a state
 * where no account holds everything.
 */
export async function rootAdminId(): Promise<number | null> {
  const row = ((await db.execute<any>(sql`
    SELECT id FROM staff WHERE role = 'admin' AND is_active
    ORDER BY created_at, id LIMIT 1`)).rows as any[])[0]
  return row ? Number(row.id) : null
}

export async function adminPermissionsFor(staffId: number) {
  const staff = ((await db.execute<any>(sql`
    SELECT id, role, display_name FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) return { allowed: [] as string[], isRoot: false, role: null }

  if (staff.role !== 'admin') {
    return { allowed: [] as string[], isRoot: false, role: staff.role }
  }

  const root = await rootAdminId()
  if (root === Number(staffId)) {
    return { allowed: ALL_KEYS, isRoot: true, role: 'admin' }
  }

  const overrides = (await db.execute<any>(sql`
    SELECT permission, allowed FROM staff_permissions WHERE staff_id = ${staffId}`)).rows as any[]

  const allowed = new Set(DEFAULT_ALLOWED)
  for (const o of overrides) {
    if (!ALL_KEYS.includes(o.permission)) continue
    if (o.allowed) allowed.add(o.permission)
    else allowed.delete(o.permission)
  }
  return { allowed: [...allowed], isRoot: false, role: 'admin' }
}

export async function saveAdminPermissions(staffId: number, allowed: string[]) {
  const root = await rootAdminId()
  if (root === Number(staffId)) {
    // Refused rather than silently ignored: somebody ticking boxes on this
    // account should be told why nothing happened.
    throw new Error('The first administrator account cannot be restricted')
  }

  const wanted = new Set(allowed.filter((k) => ALL_KEYS.includes(k)))
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM staff_permissions
      WHERE staff_id = ${staffId} AND permission = ANY(${sql.raw(
        `ARRAY[${ALL_KEYS.map((k) => `'${k}'`).join(',')}]::text[]`)})`)
    for (const key of ALL_KEYS) {
      const on = wanted.has(key)
      // Only the differences from the default are stored, so changing a
      // default later reaches every account that never overrode it.
      if (on === DEFAULT_ALLOWED.includes(key)) continue
      await tx.execute(sql`
        INSERT INTO staff_permissions (staff_id, permission, allowed)
        VALUES (${staffId}, ${key}, ${on})`)
    }
  })
  return adminPermissionsFor(staffId)
}

/** Every administrator account, for the access screen. */
export async function adminAccounts() {
  const rows = (await db.execute<any>(sql`
    SELECT id, username, display_name, created_at, last_login_at
    FROM staff WHERE role = 'admin' AND is_active
    ORDER BY created_at, id`)).rows as any[]
  const root = await rootAdminId()
  return rows.map((r) => ({ ...r, is_root: Number(r.id) === root }))
}

export async function hasAdminPermission(staffId: number, key: string) {
  const { allowed } = await adminPermissionsFor(staffId)
  return allowed.includes(key)
}
