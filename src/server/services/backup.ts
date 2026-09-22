import { createGzip } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { getSetting, setSetting } from './settings'

/**
 * Unattended backups, every twelve hours.
 *
 * A hospital has nobody whose job is remembering to run a backup, so this has
 * to happen without being asked. NDJSON.gz rather than pg_dump because the
 * restore must not depend on a matching PostgreSQL version being present on
 * whatever machine the data ends up needing to be read on.
 *
 * The table list is derived from the live database rather than hand-written.
 * A hand-kept list has already been the cause of two silent gaps in the
 * pharmacy build, where a table added later was simply never backed up and
 * nobody found out until a restore was needed.
 */

const KEEP = 14
const EVERY_MS = 12 * 60 * 60 * 1000

async function tableNames(): Promise<string[]> {
  const r = await db.execute<any>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'current_schema'::text OR schemaname = 'public'
    ORDER BY tablename`)
  return (r.rows as any[]).map((t) => t.tablename).filter((n) => n !== '_migrations')
}

/**
 * Where backups always go.
 *
 * Beside the application unless BACKUP_DIR says otherwise. This copy is never
 * skipped, whatever else is configured: a second drive can be unplugged, a
 * network share can be unreachable, and a hospital that quietly stopped
 * backing up months ago discovers it on the worst possible day.
 */
export function backupDir(): string {
  return process.env.BACKUP_DIR?.trim() || join(process.cwd(), 'backups')
}

/**
 * An extra copy, somewhere the administrator chose.
 *
 * A USB drive, a second disk, a mapped network folder. Optional, and its
 * failure is recorded rather than thrown — a missing USB stick must not stop
 * the local backup from being written.
 */
export async function extraBackupDir(): Promise<string | null> {
  const v = (await getSetting('backup.extraDir'))?.trim()
  return v ? v : null
}

export async function setExtraBackupDir(dir: string | null) {
  await setSetting('backup.extraDir', dir?.trim() ?? '')
  return extraBackupDir()
}

/** Is the chosen folder actually writable right now? */
export async function checkExtraDir(dir: string) {
  const target = dir.trim()
  if (!target) return { ok: false, error: 'No folder given' }
  try {
    await mkdir(target, { recursive: true })
    const probe = join(target, '.hms-write-test')
    await writeFile(probe, 'ok')
    await unlink(probe)
    return { ok: true as const, dir: target }
  } catch (e: any) {
    return { ok: false as const, error: e?.message ?? String(e) }
  }
}

export async function runBackup(reason: 'scheduled' | 'manual' = 'manual') {
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(dir, `hms-${stamp}.ndjson.gz`)
  const tables = await tableNames()

  async function* lines() {
    yield JSON.stringify({
      _meta: true, takenAt: new Date().toISOString(), reason, tables, format: 'ndjson.gz/v1'
    }) + '\n'
    for (const t of tables) {
      const rows = (await db.execute<any>(sql.raw(`SELECT * FROM ${t}`))).rows as any[]
      for (const row of rows) yield JSON.stringify({ _table: t, row }) + '\n'
    }
  }

  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file))
  const size = (await stat(file)).size
  await setSetting('backup.lastAt', new Date().toISOString())
  await setSetting('backup.lastFile', file)

  await prune(dir)

  /*
   * The second copy, if one is configured.
   *
   * Written after the local one and never allowed to fail the backup: a
   * detached USB drive is a reason to warn somebody, not a reason to have no
   * backup at all.
   */
  let copiedTo: string | null = null
  let copyError: string | null = null
  const extra = await extraBackupDir()
  if (extra) {
    try {
      await mkdir(extra, { recursive: true })
      await copyFile(file, join(extra, `hms-${stamp}.ndjson.gz`))
      copiedTo = join(extra, `hms-${stamp}.ndjson.gz`)
      await prune(extra)
      await setSetting('backup.lastCopyAt', new Date().toISOString())
      await setSetting('backup.lastCopyError', '')
    } catch (e: any) {
      copyError = e?.message ?? String(e)
      await setSetting('backup.lastCopyError', copyError ?? 'unknown error')
    }
  }

  return {
    file, size, tables: tables.length, takenAt: new Date().toISOString(),
    copiedTo, copyError
  }
}

/** Keep the most recent few; a disk that fills up takes the hospital down. */
async function prune(dir: string) {
  const all = (await readdir(dir)).filter((f) => f.startsWith('hms-') && f.endsWith('.ndjson.gz')).sort()
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) {
    await unlink(join(dir, f)).catch(() => {})
  }
}

export async function listBackups() {
  const dir = backupDir()
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson.gz'))
    const out = await Promise.all(files.map(async (f) => {
      const s = await stat(join(dir, f))
      return { file: f, path: join(dir, f), size: s.size, takenAt: s.mtime.toISOString() }
    }))
    return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt))
  } catch { return [] }
}

/**
 * Starts the timer, and catches up if the machine was switched off when a
 * backup was due — the common case, since these machines get powered down at
 * night and during load shedding.
 */
export function startBackupSchedule() {
  const tick = async () => {
    try {
      const last = await getSetting('backup.lastAt')
      const due = !last || Date.now() - new Date(last).getTime() >= EVERY_MS
      if (due) {
        const r = await runBackup('scheduled')
        console.log(`[backup] ${r.file} (${Math.round(r.size / 1024)} kB)`)
      }
    } catch (e: any) {
      // Never let a failed backup take the server down with it.
      console.error('[backup] failed:', e?.message ?? e)
    }
  }
  setTimeout(tick, 30_000).unref?.()
  setInterval(tick, 60 * 60 * 1000).unref?.()
}
