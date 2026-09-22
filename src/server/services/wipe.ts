import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { runBackup } from './backup'
import { verifyPassword } from './auth'

/**
 * Clearing the system to start again.
 *
 * This is the most destructive thing the software can do, so it is built to be
 * hard to do by accident and impossible to do casually:
 *
 *   1. only an administrator may ask
 *   2. they must re-enter their own password, in a screen they are already
 *      signed in to, because walking away from an unlocked machine is how this
 *      would otherwise happen
 *   3. they must type the hospital's own name exactly, which cannot be guessed
 *      by clicking through dialogs
 *   4. a full backup is taken first, automatically, and the wipe is abandoned
 *      if that backup fails
 *
 * Staff accounts, services, departments, doctors, the medicine catalogue and
 * the hospital's settings all survive. Those are the configuration somebody
 * spent a week entering; the point of starting clean is to drop the *trading*
 * — the patients, visits, bills, prescriptions, results and stock movements
 * from a demo or a trial period — not to make them set the system up twice.
 */

export class WipeError extends Error {
  constructor(msg: string, public code:
    'WRONG_PASSWORD' | 'WRONG_NAME' | 'BACKUP_FAILED' | 'NOT_ALLOWED') { super(msg) }
}

/**
 * Wiped in this order so foreign keys never block a delete.
 *
 * Children before parents. Anything not on this list is configuration and is
 * deliberately left alone.
 */
const TRADING_TABLES = [
  // laboratory
  'lab_values', 'lab_orders',
  // pharmacy selling
  'sale_return_items', 'sale_returns', 'sale_items', 'sales',
  // pharmacy buying and stock
  'purchase_return_items', 'purchase_returns', 'purchase_items', 'purchases',
  'stock_ledger', 'batches',
  // hospital stores
  'supply_movements', 'supply_batches',
  // money
  'ledger_entries', 'payments', 'price_history',
  'counter_bill_items', 'counter_bills',
  'doctor_earnings',
  // clinical
  'prescription_items', 'prescriptions', 'service_orders', 'chits',
  'visits', 'patients'
]

/** What would go, and what would stay. Shown before anyone confirms. */
export async function wipePreview() {
  const counts: { table: string; rows: number }[] = []
  for (const t of TRADING_TABLES) {
    try {
      const r = await db.execute<any>(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`))
      const n = Number((r.rows as any[])[0]?.n ?? 0)
      if (n > 0) counts.push({ table: t, rows: n })
    } catch { /* a table from a migration this database has not run yet */ }
  }

  const kept: { table: string; rows: number }[] = []
  for (const t of ['staff', 'doctors', 'services', 'departments', 'products',
                   'suppliers', 'salts', 'manufacturers', 'settings']) {
    try {
      const r = await db.execute<any>(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`))
      kept.push({ table: t, rows: Number((r.rows as any[])[0]?.n ?? 0) })
    } catch { /* not in this database */ }
  }

  return {
    willDelete: counts,
    totalRows: counts.reduce((n, c) => n + c.rows, 0),
    willKeep: kept
  }
}

export async function wipeTradingData(input: {
  staffId: number
  password: string
  hospitalName: string
  typedName: string
}) {
  /* --------------------------------------------------- the three locks */

  const row = ((await db.execute<any>(sql`
    SELECT password_hash FROM staff WHERE id = ${input.staffId} AND is_active`))
    .rows as any[])[0]
  if (!row || !(await verifyPassword(input.password, row.password_hash))) {
    throw new WipeError('That password is not right', 'WRONG_PASSWORD')
  }

  const typed = input.typedName.trim().toLowerCase()
  const real = (input.hospitalName ?? '').trim().toLowerCase()
  if (!real || typed !== real) {
    throw new WipeError(
      'Type the hospital name exactly as it appears in Settings', 'WRONG_NAME')
  }

  /* ------------------------------------- a backup, or nothing happens */

  let backup
  try {
    backup = await runBackup('manual')
  } catch (e: any) {
    throw new WipeError(
      `The backup failed, so nothing was deleted: ${e?.message ?? e}`, 'BACKUP_FAILED')
  }

  /* ------------------------------------------------------- the wipe */

  const deleted: Record<string, number> = {}
  await db.transaction(async (tx) => {
    for (const t of TRADING_TABLES) {
      try {
        const r = await tx.execute<any>(sql.raw(`DELETE FROM ${t}`))
        deleted[t] = (r as any).rowCount ?? 0
      } catch { /* table not present in this database */ }
    }

    /*
     * Counters go back to zero too.
     *
     * Leaving them would mean the first invoice after a clean start is
     * number 4,312, which makes an empty system look like it has been
     * trading for a year. MRNs reset with everything else because the
     * patients they identified are gone.
     */
    await tx.execute(sql`DELETE FROM counters`)
  })

  return { backup: backup.file, deleted, at: new Date().toISOString() }
}
