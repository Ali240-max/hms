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
  /*
   * Inpatients. These were missing, which would have left admissions and bed
   * stays pointing at patients that no longer exist, and every bed on the
   * board still showing somebody in it.
   */
  'admission_charges', 'admission_payments', 'bed_stays', 'admissions',
  /*
   * Cross match reports point at patients, and this list did not name them.
   * Deleting a patient one referred to was refused by the foreign key, which
   * aborted the whole clearing and produced "current transaction is aborted,
   * commands ignored until end of transaction block" for everything after it.
   */
  'cross_matches',
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
/**
 * What each table is, in words.
 *
 * The confirmation screen listed raw table names, and "lab_values" reads to a
 * laboratory like the reference ranges they spent a week typing in rather
 * than the results. Somebody about to clear a hospital's data should not have
 * to guess which is which.
 */
const LABEL: Record<string, string> = {
  patients: 'Patients',
  visits: 'Visits',
  chits: 'Chits',
  service_orders: 'Tests and scans ordered',
  counter_bills: 'Counter bills',
  counter_bill_items: 'Lines on counter bills',
  payments: 'Payments',
  ledger_entries: 'Ledger entries',
  doctor_earnings: "Doctors' shares earned",
  prescriptions: 'Prescriptions',
  prescription_items: 'Lines on prescriptions',
  lab_orders: 'Lab and radiology reports',
  lab_values: 'Results typed onto those reports (NOT the reference ranges)',
  sales: 'Pharmacy sales',
  sale_items: 'Lines on pharmacy sales',
  sale_returns: 'Pharmacy returns',
  sale_return_items: 'Lines on pharmacy returns',
  purchases: 'Purchases',
  purchase_items: 'Lines on purchases',
  purchase_returns: 'Purchase returns',
  purchase_return_items: 'Lines on purchase returns',
  batches: 'Stock batches',
  stock_ledger: 'Stock movements',
  supply_batches: 'Store batches',
  supply_movements: 'Store movements',
  price_history: 'Price changes',
  admissions: 'Admissions',
  bed_stays: 'Bed stays',
  admission_charges: 'Charges on admissions',
  admission_payments: 'Payments on admissions'
}

const KEPT_LABEL: Record<string, string> = {
  staff: 'Staff and logins',
  doctors: 'Doctors',
  services: 'Tests, scans and procedures',
  service_parameters: 'Test setups: what each test reports and its normal values',
  service_interpretations: 'Interpretation bands',
  lab_signatories: 'Who signs lab reports',
  departments: 'Departments',
  wards: 'Wards',
  beds: 'Beds',
  products: 'Pharmacy products',
  suppliers: 'Suppliers',
  salts: 'Salts',
  manufacturers: 'Manufacturers',
  settings: 'Every setting, including the logo'
}

export async function wipePreview() {
  const counts: { table: string; label: string; rows: number }[] = []
  for (const t of TRADING_TABLES) {
    try {
      const r = await db.execute<any>(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`))
      const n = Number((r.rows as any[])[0]?.n ?? 0)
      if (n > 0) counts.push({ table: t, label: LABEL[t] ?? t, rows: n })
    } catch { /* a table from a migration this database has not run yet */ }
  }

  const kept: { table: string; label: string; rows: number }[] = []
  /*
   * Named explicitly so the confirmation screen can say what survives.
   *
   * The test setups are the thing a laboratory is most afraid of losing, and
   * the screen listing "lab_values" without saying it means results rather
   * than reference ranges is how that fear starts.
   */
  for (const t of ['staff', 'doctors', 'services', 'service_parameters',
                   'service_interpretations', 'lab_signatories', 'departments',
                   'wards', 'beds', 'products',
                   'suppliers', 'salts', 'manufacturers', 'settings']) {
    try {
      const r = await db.execute<any>(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`))
      kept.push({ table: t, label: KEPT_LABEL[t] ?? t,
        rows: Number((r.rows as any[])[0]?.n ?? 0) })
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
    /*
     * One TRUNCATE, not thirty DELETEs in a guessed order.
     *
     * The loop that stood here caught its own errors, which does not work
     * inside a transaction: the first failure aborts it and every statement
     * afterwards is refused, so one missing table or one foreign key pointing
     * the wrong way silently took the whole clearing down. The `catch` made it
     * look handled.
     *
     * TRUNCATE takes them together and has no order to get wrong. CASCADE is
     * safe only because every table referencing these is named in the list
     * above, which is what the check below enforces: anything that would be
     * dragged in unnamed stops the clearing rather than being deleted
     * quietly.
     */
    const present: string[] = []
    for (const name of TRADING_TABLES) {
      const row = ((await tx.execute<any>(sql`
        SELECT to_regclass(${'public.' + name}) IS NOT NULL AS there`)).rows as any[])[0]
      if (row?.there) present.push(name)
    }

    /*
     * Which tables point at the ones being cleared.
     *
     * Read whole and filtered here rather than built into the query: a list
     * of table names spliced into SQL is one quoting mistake away from a
     * syntax error, and this is the check that is supposed to catch mistakes.
     */
    const refs = (await tx.execute<any>(sql`
      SELECT cl.relname::text AS child, rf.relname::text AS parent
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class rf ON rf.oid = c.confrelid
      WHERE c.contype = 'f'`)).rows as any[]

    const clearing = new Set(present)
    const strays = [...new Set(refs
      .filter((r) => clearing.has(r.parent) && !clearing.has(r.child))
      .map((r) => r.child))].map((name) => ({ name }))

    if (strays.length > 0) {
      throw new WipeError(
        `${strays.map((s) => s.name).join(', ')} point at the data being cleared but are ` +
        'not on the list, so clearing would quietly delete them too. ' +
        'This is a bug — send this message on rather than working around it.',
        'BACKUP_FAILED')
    }

    // Counted before they go, because afterwards there is nothing to count.
    for (const name of present) {
      const row = ((await tx.execute<any>(
        sql.raw(`SELECT COUNT(*)::int AS n FROM ${name}`))).rows as any[])[0]
      deleted[name] = Number(row?.n ?? 0)
    }

    await tx.execute(sql.raw(
      `TRUNCATE TABLE ${present.join(', ')} RESTART IDENTITY CASCADE`))

    /*
     * Counters go back to zero too.
     *
     * Leaving them would mean the first invoice after a clean start is
     * number 4,312, which makes an empty system look like it has been
     * trading for a year. MRNs reset with everything else because the
     * patients they identified are gone.
     */
    /*
     * Every bed goes back to free. The admissions that filled them have just
     * been deleted, so a board still showing somebody in bed G-7 would be
     * showing a patient who no longer exists.
     */
    // A bed deliberately out of use stays that way; it was not holding a
    // patient, so there is nothing about it for this to put right.
    await tx.execute(sql`
      UPDATE beds SET status = 'free' WHERE status <> 'out_of_service'`)
    await tx.execute(sql`DELETE FROM counters`)
  })

  return { backup: backup.file, deleted, at: new Date().toISOString() }
}
