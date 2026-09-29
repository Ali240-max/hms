import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { REPORTS } from './report-catalogue'

/**
 * Which reports each login may open.
 *
 * Reports were gated by role: the laboratory saw laboratory reports, the
 * counter saw counter reports, and nobody else saw anything. That is right
 * most of the time and wrong often enough to matter — an owner wants the
 * cashier to see the day's takings but not the doctors' shares, and a matron
 * wants the patient registers without the purchase ledger.
 *
 * So the role only decides the starting point. From there an administrator
 * ticks reports on and off per account, and what they tick is what that
 * person sees in their own Reports tab.
 *
 * Stored as overrides against the role default rather than as a full list, so
 * a report added in a later version appears for the roles it belongs to
 * without anybody having to go and tick it for every account.
 */

/** The reports a role sees when nobody has changed anything. */
const ROLE_MODULES: Record<string, string[]> = {
  admin: ['pharmacy', 'laboratory', 'radiology', 'counter', 'hospital'],
  reports: ['pharmacy', 'laboratory', 'radiology', 'counter', 'hospital'],
  pharmacist: ['pharmacy'],
  pharmacy_admin: ['pharmacy'],
  store_keeper: ['pharmacy'],
  lab_tech: ['laboratory'],
  radiology: ['radiology'],
  main_counter: ['counter'],
  receptionist: ['counter'],
  ipd_counter: ['counter'],
  doctor: []
}

export function defaultReportIds(role: string): string[] {
  const modules = ROLE_MODULES[role] ?? []
  return REPORTS.filter((r) => modules.includes(r.module)).map((r) => r.id)
}

/** Every report, grouped, for the access screen. */
export function reportCatalogue() {
  const groups = new Map<string, { id: string; title: string; blurb: string }[]>()
  for (const r of REPORTS) {
    if (!groups.has(r.group)) groups.set(r.group, [])
    groups.get(r.group)!.push({ id: r.id, title: r.title, blurb: r.blurb })
  }
  return [...groups.entries()].map(([group, reports]) => ({ group, reports }))
}

const key = (id: string) => `report.see.${id}`

/**
 * What one account may see.
 *
 * The role default, then whatever has been ticked or unticked against it.
 * An unknown id in the overrides is ignored, so removing a report from a
 * later version cannot leave a dead permission behind.
 */
export async function reportsFor(staffId: number): Promise<string[]> {
  const staff = ((await db.execute<any>(sql`
    SELECT role FROM staff WHERE id = ${staffId} AND is_active`)).rows as any[])[0]
  if (!staff) return []

  const allowed = new Set(defaultReportIds(staff.role))

  const overrides = (await db.execute<any>(sql`
    SELECT permission, allowed FROM staff_permissions
    WHERE staff_id = ${staffId} AND permission LIKE 'report.see.%'`)).rows as any[]

  const known = new Set(REPORTS.map((r) => r.id))
  for (const o of overrides) {
    const id = String(o.permission).replace('report.see.', '')
    if (!known.has(id)) continue
    if (o.allowed) allowed.add(id)
    else allowed.delete(id)
  }
  return [...allowed]
}

export async function saveReportsFor(staffId: number, ids: string[]) {
  const staff = ((await db.execute<any>(sql`
    SELECT role FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) throw new Error('No such user')

  const wanted = new Set(ids.filter((id) => REPORTS.some((r) => r.id === id)))
  const defaults = new Set(defaultReportIds(staff.role))

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM staff_permissions
      WHERE staff_id = ${staffId} AND permission LIKE 'report.see.%'`)

    for (const r of REPORTS) {
      const on = wanted.has(r.id)
      // Only differences from the role default are stored, so a new report
      // reaches the accounts it should without anyone editing them.
      if (on === defaults.has(r.id)) continue
      await tx.execute(sql`
        INSERT INTO staff_permissions (staff_id, permission, allowed)
        VALUES (${staffId}, ${key(r.id)}, ${on})`)
    }
  })

  return reportsFor(staffId)
}

/** Every account an administrator can grant reports to. */
export async function reportAccounts() {
  const rows = (await db.execute<any>(sql`
    SELECT id, username, display_name, role
    FROM staff WHERE is_active
    ORDER BY role, display_name`)).rows as any[]
  return rows.map((r) => ({ ...r, default_count: defaultReportIds(r.role).length }))
}
