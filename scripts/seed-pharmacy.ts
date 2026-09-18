import { loadEnv } from '../src/server/env'
import { runMigrations } from '../src/server/db/client'
import { loadPharmacyDemo } from '../src/server/services/pharma-demo'

/**
 * Fill the rebuilt pharmacy with demo trading.
 *
 *   npm run seed:pharmacy
 *
 * Adds to whatever is already there rather than wiping, so it can be run on a
 * database that already holds the hospital demo.
 */
loadEnv()

async function main() {
  await runMigrations()
  console.log('\n  Loading pharmacy demo data — this takes a minute.\n')
  const r = await loadPharmacyDemo({ days: Number(process.argv[2] ?? 60) })
  console.log(`  ${r.salts} salts, ${r.manufacturers} manufacturers`)
  console.log(`  ${r.products} medicines, ${r.suppliers} suppliers, ${r.batches} batches`)
  console.log(`  ${r.invoices} invoices, ${r.returns} returns, ${r.cancelled} cancelled\n`)
  process.exit(0)
}

main().catch((e: any) => { console.error('\n  Failed:', e?.message ?? e, '\n'); process.exit(1) })
