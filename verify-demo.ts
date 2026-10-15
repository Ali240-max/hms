/**
 * Demo data, and the one path that nobody could reach.
 *
 * The pharmacy's trading was only ever loadable by running
 * `npm run seed:pharmacy` at a terminal. A machine installed from the
 * offline bundle has no such command — the script was not even declared in
 * the bundled package.json — and the Demo data button in the settings screen
 * did not load it either. So a trial install got a hospital full of patients
 * and a pharmacy holding medicines with NOT ONE BILL behind them, which is
 * the state the pharmacy module looks most unfinished in.
 *
 * What is checked here:
 *
 *   1. The pharmacy loader can be called from inside the server, which means
 *      finding its reference data without depending on the working
 *      directory. It used to read `process.cwd() + '/scripts/...'`, correct
 *      only when started from the project root — true of a terminal, not of
 *      a service or a desktop shortcut.
 *   2. It produces bills, on the shelf and on today, rather than only
 *      masters.
 *   3. The settings button reaches it, and the bundled install declares the
 *      script too.
 *
 * It loads a DELIBERATELY TINY window — two days — because this runs in the
 * normal suite and the full sixty-day load takes a couple of minutes.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import { loadPharmacyDemo } from './src/server/services/pharma-demo'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

const count = async (q: any) =>
  Number(((await db.execute<any>(q)).rows as any[])[0].n)

console.log('\n— the pharmacy demo runs from inside the server —')

const before = await count(sql`SELECT COUNT(*)::int AS n FROM sales`)
/*
 * The high-water mark, so every count below is about the rows THIS call
 * made.
 *
 * The first version counted the whole table and reported 2,685 future-dated
 * bills on a database that had been seeded a dozen times at the default
 * forty-five days of forward trading. The code was right and the check was
 * measuring the wrong thing, which is the more dangerous of the two.
 */
const mark = await count(sql`SELECT COALESCE(MAX(id), 0)::int AS n FROM sales`)

/*
 * Called the way the settings button calls it: as a function, in process,
 * with no assumption about where the server was started from.
 */
const r = await loadPharmacyDemo({ days: 2, futureDays: 0 })

ok('it finds its reference data without a working directory to help it',
  r.products > 0, `${r.products} medicines`)
ok('it stocks the shelf', r.batches > 0, `${r.batches} batches`)
ok('and it writes BILLS, which was the whole complaint',
  r.invoices > 0, `${r.invoices} invoices`)

const after = await count(sql`SELECT COUNT(*)::int AS n FROM sales`)
ok('the bills are really in the table, not just in the return value',
  after > before, `${before} then ${after}`)

const today = await count(sql`
  SELECT COUNT(*)::int AS n FROM sales
  WHERE id > ${mark}
    AND sold_at >= date_trunc('day', now())
    AND sold_at < date_trunc('day', now()) + interval '1 day'`)
ok('and some of them are on TODAY, which is the day every screen opens on',
  today > 0, `${today} today`)

/*
 * Zero future days means zero future bills.
 *
 * The demo trades forward on purpose, so that a system installed in
 * September still shows a busy counter in November. That is a reasonable
 * choice and it has a knob, so the knob is what gets tested: asked for none,
 * there must be none. A bill dated next month that nobody asked for would
 * inflate every report and appear on no "today" screen.
 */
const future = await count(sql`
  SELECT COUNT(*)::int AS n FROM sales
  WHERE id > ${mark} AND sold_at > now() + interval '1 day'`)
ok('asked for no future trading, it writes none', future === 0,
  `${future} bills dated ahead`)

const items = await count(sql`
  SELECT COUNT(*)::int AS n FROM sale_items si
  JOIN sales sa ON sa.id = si.sale_id WHERE sa.id > ${mark}`)
ok('every bill has lines on it', items > 0, `${items} lines`)

console.log('\n— and the two ways a trial install can reach it —')

/*
 * Source checks, because the route that loads demo data wipes the database
 * and cannot be run inside a suite that everything else shares. What can be
 * asserted is that the wiring exists: the button's handler reaches the
 * pharmacy loader, and the bundled install declares the script.
 */
const demoSrc = readFileSync('src/server/services/demo.ts', 'utf8')
ok('loadDemoData imports the pharmacy loader',
  /import\('\.\/pharma-demo'\)/.test(demoSrc)
  || /from '\.\/pharma-demo'/.test(demoSrc))
ok('and calls it unless it was turned off',
  /opts\.pharmacy !== false/.test(demoSrc)
  && /loadPharmacyDemo\(/.test(demoSrc))
ok('and reports what it loaded, so the screen can show bills were made',
  /out\.pharmacy\s*=/.test(demoSrc))

const apiSrc = readFileSync('src/server/api/index.ts', 'utf8')
ok('the settings route declares the pharmacy option',
  /pharmacy: z\.boolean\(\)\.default\(true\)/.test(apiSrc),
  'zod strips what it does not declare, so the screen would send it and '
  + 'the server would drop it')
ok('and passes it through to the loader',
  /pharmacy: b\.pharmacy/.test(apiSrc))

const bundleSrc = readFileSync('scripts/bundle.mjs', 'utf8')
ok('the offline bundle declares seed:pharmacy',
  /'seed:pharmacy'/.test(bundleSrc),
  'a bundled install had no command for this at all')
ok('and ships the scripts folder it lives in',
  /cp\('scripts'/.test(bundleSrc))

const refOk = (() => {
  const s = readFileSync('src/server/services/pharma-demo.ts', 'utf8')
  return /function referenceFile\(\)/.test(s) && !/join\(process\.cwd\(\), 'scripts'/
    .test(s.replace(/join\(process\.cwd\(\), 'scripts', 'vfp-reference\.json'\)/g, (m) =>
      /referenceFile/.test(s) ? 'INSIDE_LOCATOR' : m))
})()
ok('the reference file is located rather than assumed', refOk,
  'still reading straight from the working directory')


console.log('\n— the reset list covers every document number —')
{
  /*
   * THE RULE, CHECKED AGAINST THE SCHEMA RATHER THAN A LIST.
   *
   * A demo reset truncates `counters`, so every table holding a number
   * drawn from them must go in the same breath. Leave one behind and the
   * next load collides on a unique index.
   *
   * This has now been wrong four times — stock audits, stock adjustments,
   * purchase orders, and then write-offs — and the fifth was found by
   * pressing the button rather than reading the list: `payments`, which
   * reaches nothing by cascade because its party_ref is a plain integer
   * rather than a foreign key. The load died with "duplicate key value
   * violates unique constraint payments_voucher_uq", which from the outside
   * looks exactly like a pharmacy that will not load its bills.
   *
   * So the rule is read out of Postgres: every ordinary table with a
   * single-column UNIQUE index on a text column is a document number, and
   * must be named in the TRUNCATE. Configuration tables that legitimately
   * survive a reset are listed once, by name, with a reason.
   */
  const KEPT = new Set([
    '_migrations',      // which migrations ran. Not data.
    'counters',         // truncated, just named separately in the statement
    'settings',         // the hospital name, the logo, the printer setup
    'sessions',         // signed-in sessions; the reset signs everybody out
    'attendance_devices', // the readers on the wall, bought not invented
    'supply_items',     // the store catalogue: gauze, cannulas, gloves
    'services'          // lab tests and their reference ranges, shipped
  ])

  const numbered = ((await db.execute<any>(sql`
    SELECT DISTINCT t.relname AS name
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisunique AND t.relkind = 'r' AND n.nspname = 'public'
      AND a.atttypid = 'text'::regtype
      AND array_length(i.indkey, 1) = 1
    ORDER BY 1`)).rows as any[]).map((r) => String(r.name))

  ok('the database has document-numbered tables to check',
    numbered.length > 10, `${numbered.length} tables`)

  /*
   * COMMENTS STRIPPED FIRST, and this matters.
   *
   * The first version of this check matched from the word TRUNCATE to
   * RESTART IDENTITY CASCADE across the raw source. The paragraph explaining
   * the rule sits directly above the statement and says the words "TRUNCATE
   * ... CASCADE" and "payments" in prose — so the match began inside a
   * comment, ran 3,441 characters, and found every table name in the
   * explanation rather than in the SQL. Removing `payments` from the real
   * statement left the check passing, which is the worst kind of green.
   *
   * The same trap as the translation checker reading its own documentation.
   * A check that reads source has to be told where the source stops being
   * prose.
   */
  const resetSrc = readFileSync('src/server/services/demo.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    /* SQL line comments too: the statement carries one of its own. */
    .replace(/--.*$/gm, '')
  /* Table names only: letters, underscores, commas and whitespace. */
  const truncate = (resetSrc.match(
    /TRUNCATE\s+[a-z_]+[a-z_,\s]*RESTART IDENTITY CASCADE/) ?? [''])[0]
  ok('the reset statement was found, and it is SQL rather than a comment',
    truncate.length > 50 && !/[.!]/.test(truncate), `${truncate.length} characters`)

  const missing = numbered
    .filter((t) => !KEPT.has(t))
    .filter((t) => !new RegExp(`\\b${t}\\b`).test(truncate))

  ok('every table with a document number is on the reset list',
    missing.length === 0,
    `left off: ${missing.join(', ')} — a reset would restart the counters and `
    + 'the next load would collide on their unique index')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
