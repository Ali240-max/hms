import { Pool, types as pgTypes } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import * as schema from './schema'
import { DATABASE_URL, loadEnv } from '../env'

// Before anything reads process.env. Imports run in order, and the pool below
// is created at module load.
loadEnv()

/**
 * node-postgres turns a DATE into a JS Date at local midnight. A follow-up of
 * 2027-03-31 read on a UTC+5 machine and re-serialised becomes 2027-03-30.
 * Keep DATE as the string Postgres sent.
 */
pgTypes.setTypeParser(1082, (v: string) => v)
/** BIGINT arrives as a string; our money columns are paisa and fit in a Number. */
pgTypes.setTypeParser(20, (v: string) => Number(v))

export const url = DATABASE_URL()
export const pool = new Pool({ connectionString: url, max: 20 })
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema })

/**
 * ONE TRANSACTION PER FILE. Postgres has transactional DDL, so a migration
 * either applies completely or not at all. Without it a file that fails on its
 * fifth statement leaves four applied but unrecorded, the next start replays
 * from the first, ADD COLUMN fails "already exists", and the server never
 * comes up again.
 */
export async function runMigrations(dir = join(process.cwd(), 'drizzle')) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`)

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const seen = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM _migrations WHERE name = ${file}`)
    if (Number((seen.rows as any[])[0].n) > 0) continue

    const body = readFileSync(join(dir, file), 'utf8')
    await db.transaction(async (tx) => {
      for (const stmt of body.split('--> statement-breakpoint')) {
        const trimmed = stmt.trim()
        if (trimmed) await tx.execute(sql.raw(trimmed))
      }
      await tx.execute(sql`INSERT INTO _migrations (name) VALUES (${file})`)
    })
    console.log(`[db] applied ${file}`)
  }
}

/** Gapless, row-locked counter. Used for MRNs, visit numbers and invoices. */
export async function nextCounter(tx: any, key: string): Promise<number> {
  const r = await tx.execute(sql`
    INSERT INTO counters (key, value) VALUES (${key}, 1)
    ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
    RETURNING value`)
  return Number(((r as any).rows ?? [])[0].value)
}
