/**
 * Demo data from the command line.
 *
 *   npm run seed            report what is there, change nothing
 *   npm run seed:reset      wipe it and generate a fresh 45 days back, 60 ahead
 *   npm run seed:more       ADD another spread of data, keeping what is there
 *
 * The same generator the admin screen uses, so there is one source of truth
 * for what a demo looks like.
 */
import { pool, runMigrations } from '../src/server/db/client'
import { loadDemoData, hasAnyData } from '../src/server/services/demo'

/**
 * A flag, however the person managed to pass it.
 *
 * `npm run seed --reset` does NOT reach this script: npm treats the flag as
 * its own and swallows it, so argv never sees it and the script prints "run
 * with --reset" at somebody who just did. It does leave it in the
 * environment as npm_config_reset, so reading both makes the obvious command
 * work as well as the correct one.
 */
function flag(name: string): boolean {
  if (process.argv.includes(`--${name}`)) return true
  const fromNpm = process.env[`npm_config_${name}`]
  return fromNpm !== undefined && fromNpm !== '' && fromNpm !== 'false'
}

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i > -1 && process.argv[i + 1]) return Number(process.argv[i + 1])
  const fromNpm = process.env[`npm_config_${name}`]
  if (fromNpm) return Number(fromNpm)
  return fallback
}

async function main() {
  await runMigrations()
  const reset = flag('reset')
  const add = flag('add') || flag('more')

  if (!reset && !add && await hasAnyData()) {
    console.log(`
  There are already patients in this database, so nothing was changed.

  To WIPE it and start again:          npm run seed:reset
  To ADD more data and keep what is
  already there, including anything
  you have entered yourself:           npm run seed:more

  Both also accept a range:            npm run seed:more -- --days 90 --future 30
`)
    await pool.end()
    return
  }

  const days = num('days', 45)
  const futureDays = num('future', 60)

  console.log(reset
    ? `\nWiping, then generating ${days} days back and ${futureDays} ahead...`
    : `\nAdding ${days} days back and ${futureDays} ahead to what is already there...`)

  const r = await loadDemoData({ reset, days, futureDays })

  console.log(`
  ${r.patients} patients across ${r.visits} visits
  ${r.staff} staff in ${r.departments} departments
  ${r.services} services, ${r.products} medicines in the pharmacy
  Rs ${(r.earningsPaisa / 100).toLocaleString('en-PK')} of doctor earnings

  Dates run from ${new Date(Date.now() - days * 86400000).toDateString()}
             to ${new Date(Date.now() + futureDays * 86400000).toDateString()}
`)

  if (reset) {
    console.log(`Logins (a real install starts with none):
  admin       / admin-demo-1   everything
  main-counter/ 1234           register, take fees, settle chits
  opd         / 1234           queue and vitals, sends to the doctor
  emergency   / 1234           admits arrivals, records bedside medicines
  dr.yasir    / 1234           keeps 60% of fee, 10% of tests
  dr.sana     / 1234           keeps 70%, 15% of tests
  dr.imran    / 1234           keeps 50%, 20% of tests
  dr.ayesha   / 1234           keeps 65%, 18% of tests
  dr.kamran   / 1234           keeps 55%, 12% of tests
  pharmacy    / 1234           dispense prescriptions
`)
  }
  await pool.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
