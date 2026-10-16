import { Pool, types as pgTypes } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
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
const rootDb: NodePgDatabase<typeof schema> = drizzle(pool, { schema })

/**
 * A transaction that every `db` call inside `fn` runs on, wherever it is made.
 *
 * Written for the demo loader. It calls a dozen services (createStaff,
 * registerPatient, saveConsultation, payChit…) that each import `db` and open
 * their own transactions, and it used to run them all on autocommit. When it
 * failed halfway — a duplicate department code on the very first insert, a
 * pharmacy error two minutes in — it left staff, patients and stock behind,
 * and the next press was refused with "there are already patients" while the
 * data was only half there.
 *
 * Threading `tx` through every one of those services would have meant
 * changing all their signatures for one caller. Instead `db` below consults
 * this store: inside `withTransactionScope` it IS the transaction, and a
 * service's own `db.transaction(...)` becomes a savepoint within it. Outside
 * the scope nothing changes — the store is empty and `db` is the pool.
 *
 * Do not run work in parallel (Promise.all) inside a scope: it is one
 * connection, and savepoints from two interleaved transactions corrupt each
 * other.
 */
const scope = new AsyncLocalStorage<NodePgDatabase<typeof schema>>()

export const db: NodePgDatabase<typeof schema> = new Proxy(rootDb, {
  get(target, prop) {
    const active = (scope.getStore() ?? target) as any
    const value = active[prop]
    return typeof value === 'function' ? value.bind(active) : value
  }
})

export function withTransactionScope<T>(fn: (tx: NodePgDatabase<typeof schema>) => Promise<T>) {
  return rootDb.transaction((tx) => scope.run(tx as any, () => fn(tx as any)))
}

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
