import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import { join } from 'path'
import { runMigrations, url } from './db/client'
import { loadEnv, safeUrl } from './env'

loadEnv()
import { api } from './api/index'
import { startBackupSchedule } from './services/backup'

const PORT = Number(process.env.PORT ?? 4000)
const app = new Hono()

app.route('/api', api)

/**
 * The built client is served by the same process, so a ward PC only needs a
 * browser and the server's address. One thing to run, one thing to keep alive.
 */
const dist = join(process.cwd(), 'dist', 'client')
if (existsSync(dist)) {
  app.use('/assets/*', serveStatic({ root: './dist/client' }))
  app.get('*', serveStatic({ path: './dist/client/index.html' }))
}

async function main() {
  console.log(`[db] ${safeUrl(url)}`)
  await runMigrations()
  console.log('[db] ready')

  // 0.0.0.0, not loopback: the whole point is that other machines reach it.
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
  console.log(`\n  Hospital server running`)
  console.log(`  This machine   http://localhost:${PORT}`)
  console.log(`  Other machines http://<this-pc-ip>:${PORT}\n`)

  // Nobody in a hospital has "run the backup" on their job description, so it
  // runs itself. Catches up on start if the machine was off when one was due.
  startBackupSchedule()
}

main().catch((e: any) => {
  /**
   * A raw ECONNREFUSED stack tells nobody anything, and under `concurrently`
   * it gets swallowed entirely — the symptom is a client that cannot reach the
   * API with no explanation anywhere. Say what failed and what to do.
   */
  const conn = safeUrl(url)
  if (e?.code === 'ECONNREFUSED') {
    console.error(`
  Cannot reach the database.

    Tried: ${conn}

  Check, in this order:
    1. Is PostgreSQL installed and running on this machine?
       Windows: Services -> "postgresql-x64-XX" should say Running
    2. Does the database exist?  createdb hms
    3. Is DATABASE_URL right?    it is read from the .env file in this folder
`)
  } else if (e?.code === '3D000') {
    console.error(`
  The server is there but the database does not exist.

    Tried: ${conn}

  Create it:  createdb -U postgres hms
`)
  } else if (e?.code === '28P01' || e?.code === '28000') {
    console.error(`
  The database refused those credentials.

    Tried: ${conn}

  Fix the username or password in the .env file in this folder.
`)
  } else {
    console.error('\n  Failed to start:', e?.message ?? e, '\n')
    if (e?.stack) console.error(e.stack)
  }
  process.exit(1)
})
