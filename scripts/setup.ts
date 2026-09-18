import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

/**
 * First-run setup.
 *
 * This exists because the first install took an evening of fighting with psql
 * to work out that the database simply did not exist yet. That is not a thing
 * anyone should have to discover. Everything here can be done by hand, but
 * nobody should have to.
 *
 * It connects to the `postgres` maintenance database — which always exists —
 * creates the hms role and database if they are missing, writes the .env file,
 * and leaves the rest to the server, which runs its own migrations on start.
 *
 *   npm run setup
 *
 * Safe to run twice. It creates nothing that is already there and never drops
 * anything.
 */

const { Client } = pg

const DEFAULTS = {
  host: 'localhost',
  port: '5432',
  superUser: 'postgres',
  appUser: 'hms',
  appPassword: 'hms',
  database: 'hms',
  appPort: '4000'
}

function say(msg = '') { console.log(msg) }

/**
 * Flags, so the whole thing can run without prompts.
 *
 * Useful when installing at a client site from a written checklist, and it is
 * the only way to test this script — piped answers do not work with readline.
 *
 *   npm run setup -- --yes --superpass=secret --db=hms
 */
function flags() {
  const out: Record<string, string> = {}
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] ?? 'true'
  }
  return out
}

async function main() {
  const f = flags()
  const auto = f.yes === 'true' || f.y === 'true'
  const rl = auto ? null : createInterface({ input: stdin, output: stdout })

  const ask = async (q: string, fallback: string, flag?: string) => {
    if (flag && f[flag] != null) return f[flag]
    if (auto) return fallback
    const a = (await rl!.question(`  ${q} [${fallback}]: `)).trim()
    return a || fallback
  }
  const askSecret = async (q: string, flag: string) => {
    if (f[flag] != null) return f[flag]
    if (auto) return ''
    return rl!.question(`  ${q}: `)
  }
  const close = () => rl?.close()

  say('\n  Hospital system — first-run setup\n')
  say('  This creates the database and the .env file. It does not install')
  say('  PostgreSQL; if that is not installed yet, stop and install it first.\n')

  const envPath = join(process.cwd(), '.env')
  if (existsSync(envPath)) {
    say('  A .env file already exists:')
    say('    ' + readFileSync(envPath, 'utf8').trim().split('\n')
      .map((l) => l.replace(/:([^:@/]+)@/, ':****@')).join('\n    '))
    const go = auto ? 'y'
      : (await rl!.question('\n  Carry on and overwrite it? [y/N] ')).trim().toLowerCase()
    if (go !== 'y') { say('\n  Nothing changed.\n'); close(); process.exit(0) }
    say('')
  }

  const host = await ask('PostgreSQL host', DEFAULTS.host, 'host')
  const port = await ask('PostgreSQL port', DEFAULTS.port, 'port')
  const superUser = await ask('Admin username (set when you installed PostgreSQL)',
    DEFAULTS.superUser, 'superuser')
  const superPassword = await askSecret(`Password for ${superUser}`, 'superpass')
  const database = await ask('Database name to create', DEFAULTS.database, 'db')
  const appUser = await ask('Database user for this app', DEFAULTS.appUser, 'user')
  const appPassword = await ask('Password for that user', DEFAULTS.appPassword, 'pass')
  const appPort = await ask('Port the hospital server should listen on',
    DEFAULTS.appPort, 'appport')

  /* ---------------------------------------------------------- connect */

  say('\n  Connecting…')
  const admin = new Client({
    host, port: Number(port), user: superUser, password: superPassword, database: 'postgres'
  })

  try {
    await admin.connect()
  } catch (e: any) {
    say('')
    if (e.code === 'ECONNREFUSED') {
      say('  Could not reach PostgreSQL at ' + host + ':' + port + '.')
      say('')
      say('  On Windows, open Services and look for "postgresql-x64-…".')
      say('  It should say Running. If it is not there at all, PostgreSQL is')
      say('  not installed yet.')
    } else if (e.code === '28P01' || e.code === '28000') {
      say('  PostgreSQL is running but rejected that password.')
      say('')
      say('  This is the password you chose during installation, for the user')
      say('  "' + superUser + '". There is no way to read it back — if it is')
      say('  lost, the quickest fix is to reinstall PostgreSQL.')
    } else {
      say('  Could not connect: ' + (e.message ?? e))
    }
    say('')
    close()
    process.exit(1)
  }

  /* ------------------------------------------------------ role and db */

  const roleExists = (await admin.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser])).rowCount! > 0

  if (roleExists) {
    say(`  User "${appUser}" already exists — leaving it alone.`)
  } else {
    // Quoting the identifier, interpolating the literal: role names cannot be
    // parameterised in DDL, so the name is validated instead.
    if (!/^[a-z_][a-z0-9_]*$/i.test(appUser)) {
      say(`\n  "${appUser}" is not a usable user name. Use letters, digits and underscores.\n`)
      close(); process.exit(1)
    }
    await admin.query(
      `CREATE ROLE "${appUser}" WITH LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`)
    say(`  Created user "${appUser}".`)
  }

  const dbExists = (await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount! > 0

  if (dbExists) {
    say(`  Database "${database}" already exists — leaving it alone.`)
  } else {
    if (!/^[a-z_][a-z0-9_]*$/i.test(database)) {
      say(`\n  "${database}" is not a usable database name.\n`)
      close(); process.exit(1)
    }
    await admin.query(`CREATE DATABASE "${database}" OWNER "${appUser}"`)
    say(`  Created database "${database}".`)
  }

  await admin.query(
    `GRANT ALL PRIVILEGES ON DATABASE "${database}" TO "${appUser}"`)
  await admin.end()

  /**
   * On PostgreSQL 15 and later the public schema is no longer writable by
   * everyone, so a fresh non-owner role cannot create tables and the first
   * migration fails with a permission error that says nothing useful.
   */
  const inDb = new Client({
    host, port: Number(port), user: superUser, password: superPassword, database
  })
  await inDb.connect()
  await inDb.query(`GRANT ALL ON SCHEMA public TO "${appUser}"`)
  await inDb.query(`ALTER SCHEMA public OWNER TO "${appUser}"`)
  await inDb.end()
  say('  Granted permissions on the public schema.')

  /* ------------------------------------------------------------- .env */

  const url = `postgres://${appUser}:${encodeURIComponent(appPassword)}@${host}:${port}/${database}`
  writeFileSync(envPath,
`# Written by npm run setup. Safe to edit by hand.
DATABASE_URL=${url}
PORT=${appPort}

# Where the 12-hourly backups are written. Point this at a second drive or a
# mapped network folder if you have one: a backup on the same disk as the
# database is not a backup.
# BACKUP_DIR=D:\\hms-backups
`)
  say(`  Wrote .env`)

  say('\n  Done. Next:\n')
  say('    npm run dev        start the system (server and client together)')
  say('    npm run seed       load demo data — WIPES everything, testing only')
  say('')
  say('  Then open http://localhost:5173 and create the first admin account.')
  say('  Other machines on the network use http://<this-pc-ip>:' + appPort + '\n')

  close()
  process.exit(0)
}

main().catch((e: any) => {
  say('\n  Setup failed: ' + (e?.message ?? e) + '\n')
  process.exit(1)
})
