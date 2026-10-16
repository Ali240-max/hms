/**
 * Every check, in one command.
 *
 * The suites were only ever runnable one at a time, which meant "is the
 * system healthy" took twenty commands and nobody ran all of them. The ones
 * that need no server run first, so a typo or a missing translation is
 * reported in seconds rather than after a database round trip.
 */
import { execSync } from 'node:child_process'

const OFFLINE = [
  ['typecheck', 'npm run typecheck'],
  ['render', 'npm run verify:render'],
  ['i18n', 'npm run verify:i18n'],
  ['tabs', 'npm run verify:tabs'],
  ['print', 'npm run verify:print'],
  ['crossmatch', 'npm run verify:crossmatch'],
  ['layouts', 'npm run verify:layouts'],
  ['ipd', 'npm run verify:ipd'],
  ['attendance', 'npm run verify:attendance'],
  ['terminal', 'npm run verify:terminal'],
  ['audit', 'npm run verify:audit'],
  ['ordering', 'npm run verify:ordering'],
  ['writeoff', 'npm run verify:writeoff'],
  ['demo', 'npm run verify:demo'],
  ['roles', 'npm run verify:roles'],
  ['lan', 'npm run verify:lan']
]

const ONLINE = [
  'billing', 'chits', 'screens', 'pharmacy', 'supplies', 'emergency',
  'lab', 'returns', 'modules', 'reports', 'numbering', 'admin', 'escpos',
  /* Credit bills, department bills, the expired badge, the lab's booked time.
     Also reads DATABASE_URL directly, so it must be the server's database. */
  'credit',
  /* Service categories, department token queues, the department report
     filter and the pharmacy bill tabs. Its restore section only runs with
     VERIFY_RESTORE=1, because it replaces the whole database. */
  'queues',
  /* The attendance agent's whole HTTP protocol, minus the SDK calls. */
  'agent'
]

const base = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
let failed = 0

function run(name, cmd) {
  process.stdout.write(`  ${name.padEnd(12)}`)
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const line = out.split('\n').reverse().find((l) => /passed|clean|every key/.test(l))
    console.log(line ? line.trim() : 'ok')
  } catch (e) {
    failed++
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const line = out.split('\n').find((l) => /FAIL|error|Error/.test(l))
    console.log(`FAILED${line ? ' — ' + line.trim().slice(0, 90) : ''}`)
  }
}

console.log('\n— checks that need no server —')
for (const [name, cmd] of OFFLINE) run(name, cmd)

console.log(`\n— checks against a running server at ${base} —`)
/*
 * Tried a few times before giving up.
 *
 * A dev server started a second ago is not listening yet, and one probe that
 * happens to land in that gap reports the whole system unreachable and skips
 * thirteen suites without saying anything useful. Three tries a second apart
 * covers a slow start and a dropped connection.
 */
let reachable = false
for (let attempt = 0; attempt < 3 && !reachable; attempt++) {
  if (attempt > 0) execSync('node -e "setTimeout(()=>{},1000)"', { stdio: 'ignore' })
  try {
    execSync(
      `node -e "fetch('${base}/auth/status')` +
      `.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
      { stdio: 'ignore' })
    reachable = true
  } catch { /* try again */ }
}

if (!reachable) {
  console.log('  no server is running, so these were skipped.')
  console.log('  start one with `npm run dev` and run this again,')
  console.log('  or point it elsewhere with API_BASE=http://host:port/api')
} else {
  for (const s of ONLINE) run(s, `npm run verify:${s}`)
}

console.log(failed === 0
  ? '\n  everything passed\n'
  : `\n  ${failed} check(s) failed\n`)
process.exit(failed ? 1 : 0)
