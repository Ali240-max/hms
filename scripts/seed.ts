/**
 * Demo data from the command line.  npm run seed -- --reset
 *
 * The same generator the admin screen uses, so there is one source of truth
 * for what a demo looks like.
 */
import { pool, runMigrations } from '../src/server/db/client'
import { loadDemoData, hasAnyData } from '../src/server/services/demo'

async function main() {
  await runMigrations()
  const reset = process.argv.includes('--reset')

  if (!reset && await hasAnyData()) {
    console.log('\nThere are already patients in this database.')
    console.log('Run with --reset to wipe it and start again.\n')
    await pool.end()
    return
  }

  const daysArg = process.argv.indexOf('--days')
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 45

  console.log(`\nGenerating ${days} days of demo data...`)
  const r = await loadDemoData({ reset, days })

  console.log(`
  ${r.patients} patients across ${r.visits} visits
  ${r.staff} staff in ${r.departments} departments
  ${r.services} services, ${r.products} medicines in the pharmacy
  Rs ${(r.earningsPaisa / 100).toLocaleString('en-PK')} of doctor earnings

Logins (a real install starts with none):
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
  await pool.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
