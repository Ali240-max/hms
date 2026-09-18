import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { sql } from 'drizzle-orm'
import { loadEnv, safeUrl } from '../src/server/env'
import { db, url } from '../src/server/db/client'
import { hashPassword } from '../src/server/services/auth'

/**
 * Reset a password from the server console.
 *
 * Passwords are scrypt hashes, so a forgotten one cannot be recovered by
 * anybody, including whoever wrote this. It can only be replaced. That is the
 * correct trade: a system holding diagnoses should not be able to tell you
 * what someone's password is.
 *
 * This runs against the database directly rather than over the API, because
 * the situation it exists for is being locked out of the API. It therefore
 * requires shell access to the server — which is the real authorisation check
 * here, and the reason it is not exposed as an endpoint.
 *
 *   npm run reset-password
 *   npm run reset-password -- admin
 *   npm run reset-password -- admin "new password here"
 */

loadEnv()

const MIN_LENGTH = 8

async function main() {
  const [argUser, argPass] = process.argv.slice(2)
  const rl = createInterface({ input: stdin, output: stdout })

  console.log(`\n  Password reset`)
  console.log(`  Database: ${safeUrl(url)}\n`)

  const staff = (await db.execute<any>(sql`
    SELECT id, username, display_name, role, is_active
    FROM staff ORDER BY role, username`)).rows as any[]

  if (staff.length === 0) {
    console.error('  There are no accounts in this database.')
    console.error('  Start the server and it will walk you through creating the first admin.\n')
    process.exit(1)
  }

  let username = argUser
  if (!username) {
    console.log('  Accounts on this system:\n')
    for (const s of staff) {
      const tag = s.is_active ? '' : '  (archived)'
      console.log(`    ${s.username.padEnd(16)} ${String(s.role).padEnd(14)} ${s.display_name}${tag}`)
    }
    console.log('')
    username = (await rl.question('  Which username? ')).trim()
  }

  const target = staff.find((s) => s.username.toLowerCase() === username.toLowerCase())
  if (!target) {
    console.error(`\n  No account called "${username}".\n`)
    rl.close()
    process.exit(1)
  }

  /**
   * Refuse to leave the hospital with no way in. Resetting the only admin is
   * the whole point of this script, but resetting a *disabled* admin would
   * leave nobody able to sign in and no obvious sign of why.
   */
  if (target.role === 'admin' && !target.is_active) {
    const admins = staff.filter((s) => s.role === 'admin' && s.is_active).length
    if (admins === 0) {
      console.log('\n  This is an archived admin and no active admin is left.')
      const ok = (await rl.question('  Reactivate it as well? [y/N] ')).trim().toLowerCase()
      if (ok === 'y') {
        await db.execute(sql`UPDATE staff SET is_active = true WHERE id = ${target.id}`)
        console.log('  Reactivated.')
      }
    }
  }

  let password = argPass
  if (!password) {
    password = await rl.question(`\n  New password for ${target.username}: `)
    const again = await rl.question('  Type it again: ')
    if (password !== again) {
      console.error('\n  Those did not match. Nothing was changed.\n')
      rl.close()
      process.exit(1)
    }
  }

  if (password.trim().length < MIN_LENGTH) {
    console.error(`\n  Too short — use at least ${MIN_LENGTH} characters. Nothing was changed.\n`)
    rl.close()
    process.exit(1)
  }

  await db.execute(sql`
    UPDATE staff SET password_hash = ${await hashPassword(password)} WHERE id = ${target.id}`)

  console.log(`\n  Done. ${target.username} can sign in with the new password.`)
  console.log('  Any session that was already open keeps working until the server restarts.\n')
  rl.close()
  process.exit(0)
}

main().catch((e: any) => {
  if (e?.code === 'ECONNREFUSED') {
    console.error('\n  Could not reach PostgreSQL. Is the service running?')
    console.error(`  Tried: ${safeUrl(url)}\n`)
  } else {
    console.error('\n  Failed:', e?.message ?? e, '\n')
  }
  process.exit(1)
})
