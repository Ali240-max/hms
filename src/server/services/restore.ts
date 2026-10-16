import { createGunzip } from 'node:zlib'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { backupDir, runBackup } from './backup'
import { verifyPassword, clearSessionCache } from './auth'
import { setSetting } from './settings'
import { linkUncategorisedServices } from './service-categories'

/**
 * Restoring a backup written by backup.ts.
 *
 * The file is the system's own NDJSON.gz: a `_meta` line naming the tables,
 * one `{ _table, row }` line per row, and — on backups written since restore
 * existed — an `_end` line with the row count of every table. Nothing in it is
 * ever executed. Table and column names are checked against the live
 * database's own catalogue and quoted; row values travel as one JSON
 * parameter and are turned into column values by PostgreSQL itself
 * (jsonb_populate_recordset). There is no SQL text in a backup to run, and an
 * uploaded file that tries to name a table or column the database does not
 * have is refused before anything is touched.
 *
 * Replacing a hospital's data is the most destructive thing after clearing
 * it, so it is built the same way the wipe is (wipe.ts):
 *
 *   1. checked first, end to end, without touching the database: the gzip
 *      must be whole, every line must parse, every table and column must
 *      exist here, the row counts must match the closing line, and the
 *      restored staff list must contain an administrator who can sign in
 *   2. an administrator holding `admin.restore` re-enters their password and
 *      types RESTORE
 *   3. a full backup of the CURRENT data is written first, and the restore is
 *      abandoned if that fails — so a wrong file is always one more restore
 *      away from being undone
 *   4. the replacement is ONE transaction. Any failure — a bad row, a broken
 *      reference, the power going — rolls it back and the data is exactly as
 *      it was. There is no half-restored state to recover from.
 *
 * pg_dump was not used, for the reason backup.ts gives: the backup must be
 * readable with no matching PostgreSQL tools on the machine, and the restore
 * is held to the same rule.
 */

export class RestoreError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'INVALID_FILE' | 'INCOMPATIBLE' | 'WRONG_PASSWORD' | 'NOT_CONFIRMED'
    | 'BACKUP_FAILED' | 'BUSY' | 'TOO_LARGE' | 'RESTORE_FAILED' | 'NO_ADMIN') {
    super(msg)
  }
}

/** Far beyond any hospital of this size; stops a runaway upload filling the disk. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
/** Rows per INSERT. Small enough to keep each statement's JSON a few MB. */
const BATCH_ROWS = 500
const NAME = /^[a-z_][a-z0-9_]*$/

let busy = false

function uploadsDir() {
  return join(backupDir(), 'restore-uploads')
}

/* ------------------------------------------------------------- the file */

/**
 * The lines of a backup, decompressed as they are read.
 *
 * Streamed, never read whole: a hospital's backup can run to hundreds of
 * megabytes once unpacked. A truncated or corrupted gzip makes zlib throw
 * here, which is the integrity check — gzip carries its own CRC and length.
 */
async function* backupLines(file: string): AsyncGenerator<string> {
  const rs = createReadStream(file)
  const gz = createGunzip()
  rs.on('error', (e) => gz.destroy(e))
  rs.pipe(gz)
  const decoder = new StringDecoder('utf8')
  let rest = ''
  try {
    for await (const chunk of gz) {
      rest += decoder.write(chunk as Buffer)
      let at = rest.indexOf('\n')
      let from = 0
      while (at >= 0) {
        const line = rest.slice(from, at)
        if (line.trim()) yield line
        from = at + 1
        at = rest.indexOf('\n', from)
      }
      rest = rest.slice(from)
    }
    rest += decoder.end()
    if (rest.trim()) yield rest
  } finally {
    rs.destroy()
    gz.destroy()
  }
}

type DbColumns = Map<string, Set<string>>

/** Every table in this database, with its columns. The allow-list for names. */
async function liveColumns(tx: any = db): Promise<DbColumns> {
  const rows = (await tx.execute(sql`
    SELECT c.table_name::text AS t, c.column_name::text AS col
    FROM information_schema.columns c
    JOIN pg_tables pt ON pt.tablename = c.table_name AND pt.schemaname = c.table_schema
    WHERE c.table_schema = 'public'`)).rows as any[]
  const out: DbColumns = new Map()
  for (const r of rows) {
    if (r.t === '_migrations') continue
    if (!out.has(r.t)) out.set(r.t, new Set())
    out.get(r.t)!.add(r.col)
  }
  return out
}

export type BackupSummary = {
  takenAt: string | null
  reason: string | null
  format: string
  lastMigration: string | null
  currentMigration: string | null
  sizeBytes: number
  tables: number
  totalRows: number
  /** The tables a person would recognise, with their row counts. */
  highlights: { table: string; label: string; rows: number }[]
  /** Tables in this database the backup does not have (it is older). */
  notInBackup: string[]
  /** Written before backups carried their own row counts. */
  completenessChecked: boolean
  admins: number
}

const HIGHLIGHT: [string, string][] = [
  ['patients', 'Patients'], ['visits', 'Visits'], ['counter_bills', 'Counter bills'],
  ['chits', 'Chits'], ['lab_orders', 'Lab and radiology reports'],
  ['sales', 'Pharmacy sales'], ['products', 'Pharmacy products'],
  ['admissions', 'Admissions'], ['staff', 'Staff accounts'], ['services', 'Services'],
  ['departments', 'Departments']
]

/**
 * Read a backup end to end and say what is in it, or why it cannot be used.
 *
 * Touches nothing. Also returns, privately, the column list per table that the
 * restore needs, so the file is trusted only as far as this check went.
 */
async function scan(file: string) {
  let size = 0
  try { size = (await stat(file)).size } catch {
    throw new RestoreError('That backup file could not be found', 'NOT_FOUND')
  }
  const live = await liveColumns()
  let meta: any = null
  let end: any = null
  const counts = new Map<string, number>()
  const columns = new Map<string, Set<string>>()
  let admins = 0
  let lineNo = 0

  try {
    for await (const line of backupLines(file)) {
      lineNo++
      let obj: any
      try { obj = JSON.parse(line) } catch {
        throw new RestoreError(`Line ${lineNo} of the backup is not readable — the file is damaged.`,
          'INVALID_FILE')
      }
      if (lineNo === 1) {
        if (!obj || obj._meta !== true || obj.format !== 'ndjson.gz/v1' || !Array.isArray(obj.tables)) {
          throw new RestoreError(
            'This is not a backup made by this system. Choose one of the hms-….ndjson.gz files ' +
            'from the backups folder.', 'INVALID_FILE')
        }
        meta = obj
        for (const t of meta.tables) {
          if (typeof t !== 'string' || !NAME.test(t) || t === '_migrations') {
            throw new RestoreError('The backup names a table that is not valid.', 'INVALID_FILE')
          }
          if (!live.has(t)) {
            throw new RestoreError(
              `The backup contains "${t}", which this version of the software does not have. ` +
              'It was made by a newer version — upgrade this one first, then restore.', 'INCOMPATIBLE')
          }
          counts.set(t, 0)
          columns.set(t, new Set())
        }
        continue
      }
      if (end) {
        throw new RestoreError('The backup has data after its closing line — the file is damaged.',
          'INVALID_FILE')
      }
      if (obj && obj._end === true) { end = obj; continue }
      const t = obj?._table
      const row = obj?.row
      if (typeof t !== 'string' || !counts.has(t) || !row || typeof row !== 'object' || Array.isArray(row)) {
        throw new RestoreError(`Line ${lineNo} of the backup is not a row the backup declared.`,
          'INVALID_FILE')
      }
      const cols = columns.get(t)!
      const liveCols = live.get(t)!
      for (const k of Object.keys(row)) {
        if (cols.has(k)) continue
        if (!NAME.test(k) || !liveCols.has(k)) {
          throw new RestoreError(
            `The backup's "${t}" table has a column "${k}" this version does not know. ` +
            'It was made by a newer version — upgrade this one first, then restore.', 'INCOMPATIBLE')
        }
        cols.add(k)
      }
      counts.set(t, counts.get(t)! + 1)
      if (t === 'staff' && row.role === 'admin' && row.is_active !== false
          && typeof row.password_hash === 'string' && row.password_hash) admins++
    }
  } catch (e: any) {
    if (e instanceof RestoreError) throw e
    // zlib: "unexpected end of file", "incorrect header check", CRC errors.
    throw new RestoreError(
      'The backup file is damaged or incomplete and cannot be read' +
      (lineNo === 0 ? ' — it may not be a backup file at all.' : '.'), 'INVALID_FILE')
  }

  if (!meta) throw new RestoreError('The backup file is empty.', 'INVALID_FILE')
  if (end) {
    for (const [t, n] of counts) {
      if (Number(end.counts?.[t] ?? -1) !== n) {
        throw new RestoreError(
          `The backup is incomplete: "${t}" should have ${end.counts?.[t]} rows and has ${n}.`,
          'INVALID_FILE')
      }
    }
  }
  if (!counts.has('staff') || admins === 0) {
    /*
     * Restoring a staff list with no administrator in it would leave nobody
     * able to sign in and undo it. Refused before anything is touched.
     */
    throw new RestoreError(
      'The backup has no active administrator account, so nobody could sign in after restoring it.',
      'NO_ADMIN')
  }

  const currentMigration = ((await db.execute<any>(sql`
    SELECT name FROM _migrations ORDER BY name DESC LIMIT 1`)).rows as any[])[0]?.name ?? null
  if (meta.lastMigration && currentMigration && String(meta.lastMigration) > currentMigration) {
    throw new RestoreError(
      `The backup was made by a newer version of the software (${meta.lastMigration}). ` +
      'Upgrade this one first, then restore.', 'INCOMPATIBLE')
  }

  const summary: BackupSummary = {
    takenAt: typeof meta.takenAt === 'string' ? meta.takenAt : null,
    reason: typeof meta.reason === 'string' ? meta.reason : null,
    format: meta.format,
    lastMigration: meta.lastMigration ?? null,
    currentMigration,
    sizeBytes: size,
    tables: counts.size,
    totalRows: [...counts.values()].reduce((a, b) => a + b, 0),
    highlights: HIGHLIGHT.filter(([t]) => counts.has(t))
      .map(([t, label]) => ({ table: t, label, rows: counts.get(t)! })),
    notInBackup: [...live.keys()].filter((t) => !counts.has(t)).sort(),
    completenessChecked: !!end,
    admins
  }
  return { summary, meta, counts, columns }
}

/* --------------------------------------------------- where the file is */

export type RestoreSource = { upload: string } | { file: string }

/** A file from the backups folder, by bare name only — never a path. */
function resolveSource(src: RestoreSource): string {
  if ('upload' in src) {
    if (!/^[a-f0-9]{24}$/.test(src.upload)) throw new RestoreError('Upload not found', 'NOT_FOUND')
    return join(uploadsDir(), `upload-${src.upload}.ndjson.gz`)
  }
  if (!/^hms-[A-Za-z0-9-]+\.ndjson\.gz$/.test(src.file)) {
    throw new RestoreError('That is not one of the backups in the backups folder', 'NOT_FOUND')
  }
  return join(backupDir(), src.file)
}

/**
 * Save an uploaded backup to disk, streamed, and check it.
 *
 * Kept on the server between "check" and "restore" so the person confirms
 * exactly the file that was checked, and so a large backup is not sent twice
 * over the LAN. Uploads older than a day are cleared on the way in.
 */
export async function saveUpload(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new RestoreError('No file was sent', 'INVALID_FILE')
  const dir = uploadsDir()
  await mkdir(dir, { recursive: true })
  await pruneUploads(dir)
  const id = randomBytes(12).toString('hex')
  const file = join(dir, `upload-${id}.ndjson.gz`)
  let bytes = 0
  const limit = new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length
      if (bytes > MAX_UPLOAD_BYTES) done(new RestoreError('That file is far too large to be a backup', 'TOO_LARGE'))
      else done(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(body as any), limit, createWriteStream(file))
  } catch (e) {
    await unlink(file).catch(() => {})
    if (e instanceof RestoreError) throw e
    throw new RestoreError('The upload did not complete. Try again.', 'INVALID_FILE')
  }
  try {
    const { summary } = await scan(file)
    return { upload: id, summary }
  } catch (e) {
    await unlink(file).catch(() => {})
    throw e
  }
}

export async function discardUpload(id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) return
  await unlink(join(uploadsDir(), `upload-${id}.ndjson.gz`)).catch(() => {})
}

async function pruneUploads(dir: string) {
  try {
    for (const f of await readdir(dir)) {
      const p = join(dir, f)
      const s = await stat(p)
      if (Date.now() - s.mtimeMs > 24 * 60 * 60 * 1000) await unlink(p).catch(() => {})
    }
  } catch { /* nothing to prune */ }
}

export async function inspectBackup(src: RestoreSource) {
  const { summary } = await scan(resolveSource(src))
  return summary
}

/* ------------------------------------------------------------ restoring */

/**
 * Tables that must be emptied along with the restored ones.
 *
 * Every restored table is emptied. So is any table the backup does not have
 * (it predates it) that points at one of them, directly or through another —
 * its rows would otherwise reference patients or bills that no longer exist.
 * Tables the backup does not have and nothing restored touches are left
 * alone.
 */
async function tablesToEmpty(tx: any, restored: Set<string>) {
  const refs = (await tx.execute(sql`
    SELECT cl.relname::text AS child, rf.relname::text AS parent
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class rf ON rf.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`)).rows as any[]
  const out = new Set(restored)
  let grew = true
  while (grew) {
    grew = false
    for (const r of refs) {
      if (out.has(r.parent) && !out.has(r.child)) { out.add(r.child); grew = true }
    }
  }
  return out
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

export async function restoreBackup(input: {
  source: RestoreSource
  staffId: number
  password: string
  confirm: string
}) {
  if (input.confirm.trim().toUpperCase() !== 'RESTORE') {
    throw new RestoreError('Type RESTORE to confirm', 'NOT_CONFIRMED')
  }
  const row = ((await db.execute<any>(sql`
    SELECT password_hash FROM staff WHERE id = ${input.staffId} AND is_active`)).rows as any[])[0]
  if (!row || !(await verifyPassword(input.password, row.password_hash))) {
    throw new RestoreError('That password is not right', 'WRONG_PASSWORD')
  }
  if (busy) throw new RestoreError('A restore is already running', 'BUSY')
  busy = true

  /*
   * Worked on from a private copy. A file chosen from the backups folder
   * could otherwise be pruned away by the safety backup below, which keeps
   * only the newest fourteen.
   */
  const original = resolveSource(input.source)
  await mkdir(uploadsDir(), { recursive: true })
  const work = join(uploadsDir(), `working-${randomBytes(6).toString('hex')}.ndjson.gz`)
  try {
    try { await copyFile(original, work) } catch {
      throw new RestoreError('That backup file could not be found', 'NOT_FOUND')
    }

    // Checked again, in full: the file is trusted only as far as this goes.
    const { summary, meta, counts, columns } = await scan(work)

    let safety
    try {
      safety = await runBackup('pre-restore')
    } catch (e: any) {
      throw new RestoreError(
        'The backup of the current data failed, so nothing was restored. ' +
        'Check there is space on the disk and try again.', 'BACKUP_FAILED')
    }

    const restored = new Set<string>(meta.tables)
    try {
      await db.transaction(async (tx) => {
        const empty = await tablesToEmpty(tx, restored)

        /*
         * Foreign keys are checked at COMMIT rather than row by row, so the
         * tables can be loaded in the order the file has them (alphabetical)
         * rather than parents-first — which a table that points at itself
         * would make impossible anyway. Every reference is still checked
         * before anything is kept: SET CONSTRAINTS ALL IMMEDIATE below makes
         * PostgreSQL verify them all, and one broken reference aborts the
         * lot. The constraints are put back exactly as they were, inside the
         * same transaction.
         */
        const fks = (await tx.execute(sql`
          SELECT c.conname::text AS name, cl.relname::text AS tbl
          FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT c.condeferrable`)).rows as any[]
        const touched = fks.filter((f) => empty.has(f.tbl))
        for (const f of touched) {
          await tx.execute(sql.raw(
            `ALTER TABLE ${q(f.tbl)} ALTER CONSTRAINT ${q(f.name)} DEFERRABLE INITIALLY DEFERRED`))
        }
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`)

        await tx.execute(sql.raw(
          `TRUNCATE TABLE ${[...empty].map(q).join(', ')} RESTART IDENTITY`))

        // Identity columns declared ALWAYS need OVERRIDING to take saved ids.
        const always = new Set(((await tx.execute(sql`
          SELECT DISTINCT table_name::text AS t FROM information_schema.columns
          WHERE table_schema = 'public' AND identity_generation = 'ALWAYS'`)).rows as any[])
          .map((r) => r.t))
        const generated = ((await tx.execute(sql`
          SELECT table_name::text AS t, column_name::text AS col FROM information_schema.columns
          WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`)).rows as any[])

        let table = ''
        let batch: any[] = []
        let cols: string[] = []
        const flush = async () => {
          if (!batch.length) return
          const list = cols.map(q).join(', ')
          await tx.execute(sql`${sql.raw(`INSERT INTO ${q(table)} (${list})
            ${always.has(table) ? 'OVERRIDING SYSTEM VALUE' : ''}
            SELECT ${list} FROM jsonb_populate_recordset(NULL::${q(table)}, `)}${JSON.stringify(batch)}::jsonb)`)
          batch = []
        }
        for await (const line of backupLines(work)) {
          const obj = JSON.parse(line)
          if (obj._meta || obj._end) continue
          if (obj._table !== table) {
            await flush()
            table = obj._table
            const skip = new Set(generated.filter((g) => g.t === table).map((g) => g.col))
            cols = [...columns.get(table)!].filter((c) => !skip.has(c))
          }
          batch.push(obj.row)
          if (batch.length >= BATCH_ROWS) await flush()
        }
        await flush()

        // Every reference checked now; a broken one throws and rolls back.
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`)
        for (const f of touched) {
          await tx.execute(sql.raw(
            `ALTER TABLE ${q(f.tbl)} ALTER CONSTRAINT ${q(f.name)} NOT DEFERRABLE`))
        }

        /*
         * Sequences moved past the highest restored id, or the next patient
         * registered would collide with patient 1 of the restored data.
         */
        const seqs = (await tx.execute(sql`
          SELECT c.table_name::text AS t, c.column_name::text AS col,
                 pg_get_serial_sequence(quote_ident(c.table_name), c.column_name)::text AS seq
          FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND (c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES')`)).rows as any[]
        for (const s of seqs) {
          if (!s.seq || !empty.has(s.t)) continue
          await tx.execute(sql.raw(
            `SELECT setval('${s.seq.replace(/'/g, "''")}', ` +
            `COALESCE((SELECT MAX(${q(s.col)}) FROM ${q(s.t)}), 0) + 1, false)`))
        }

        /*
         * Put right what a backup from an older version cannot carry. Only
         * service categories so far (drizzle/0040): the built-in four are
         * re-created if the backup predates them, and every service is filed
         * under one.
         */
        await tx.execute(sql`
          INSERT INTO service_categories (name, kind, department_id, is_builtin, sort_order)
          SELECT v.name, v.kind::service_category,
                 (SELECT d.id FROM departments d
                  WHERE v.dept_code IS NOT NULL AND upper(d.code) = v.dept_code
                  ORDER BY d.id LIMIT 1),
                 true, v.sort_order
          FROM (VALUES
            ('Laboratory tests', 'lab', 'LAB', 10), ('Radiology procedures', 'radiology', 'RAD', 20),
            ('Procedures', 'procedure', NULL, 30), ('Other', 'other', NULL, 40)
          ) AS v(name, kind, dept_code, sort_order)
          WHERE NOT EXISTS (SELECT 1 FROM service_categories sc
                            WHERE sc.kind = v.kind::service_category)
            AND NOT EXISTS (SELECT 1 FROM service_categories sc
                            WHERE lower(btrim(sc.name)) = lower(v.name))`)
        await linkUncategorisedServices(tx)

        /*
         * Every session in the restored data is stale, and the ones in memory
         * may belong to accounts that are not in it. Everybody signs in again.
         */
        if (restored.has('sessions') || empty.has('sessions')) {
          await tx.execute(sql`DELETE FROM sessions`)
        }
      })
    } catch (e: any) {
      /*
       * The database's own message stays in the server log. It can quote
       * row values — a patient's name in a duplicate-key error — and the
       * screen only needs to know what kind of problem it was.
       */
      console.error('[restore] rolled back:', e?.message ?? e)
      const why = ({
        '23503': 'Something in the backup points at a record the backup does not contain.',
        '23505': 'The backup contains the same record twice.',
        '23502': 'The backup is missing a value this version of the software requires.',
        '23514': 'A value in the backup is not allowed by this version of the software.',
        '42501': 'The database account the server uses is not allowed to do this. ' +
                 'It must own the HMS tables, as it does after a normal install.'
      } as Record<string, string>)[String(e?.code ?? e?.cause?.code ?? '')]
        ?? 'See the server log for the details.'
      throw new RestoreError(
        'The restore could not be completed and was rolled back — the data is exactly as it was ' +
        `before. ${why} The backup of the current data is in ${safety.file}.`, 'RESTORE_FAILED')
    }

    clearSessionCache()
    const at = new Date().toISOString()
    await setSetting('restore.lastAt', at)
    await setSetting('restore.lastTakenAt', summary.takenAt ?? '')
    await setSetting('restore.safetyBackup', safety.file)
    console.log(`[restore] restored backup taken ${summary.takenAt}; previous data saved to ${safety.file}`)

    if ('upload' in input.source) await discardUpload(input.source.upload)
    return {
      restoredAt: at,
      takenAt: summary.takenAt,
      tables: counts.size,
      rows: summary.totalRows,
      safetyBackup: safety.file
    }
  } finally {
    await unlink(work).catch(() => {})
    busy = false
  }
}
