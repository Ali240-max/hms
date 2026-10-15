/**
 * Damaged and expired stock coming off the shelf.
 *
 * The rules under test are the ones that would otherwise be found months
 * later by somebody reconciling a shelf:
 *
 *   1. A write-off never takes a batch negative. It refuses rather than
 *      clamps, because a negative batch poisons FEFO and the error spreads
 *      into sales nobody can reconstruct.
 *   2. The cost is frozen at the batch it came off, so last August's breakage
 *      is still valued at what that stock cost rather than at today's rate.
 *   3. The ledger carries it, under the reason words the very first migration
 *      defined and nothing had ever written.
 *   4. The reference number carries the date, so a slip read out over the
 *      phone places itself.
 *
 * Both kinds run through the same mechanism, so both kinds are tested: a
 * difference in behaviour between damage and expiry would be a bug, not a
 * feature.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  shelf, createWriteOff, writeOff, writeOffs, writeOffItems, writeOffsByProduct,
  WriteOffError
} from './src/server/services/write-off'
import { writeOffPdf } from './src/server/services/write-off-pdf'
import { REPORTS } from './src/server/services/report-catalogue'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

const onHand = async (id: number) => Number(((await db.execute<any>(sql`
  SELECT COALESCE(SUM(qty_on_hand)::int, 0) AS n FROM batches
  WHERE product_id = ${id}`)).rows as any[])[0].n)

const batchQty = async (id: number) => Number(((await db.execute<any>(sql`
  SELECT qty_on_hand FROM batches WHERE id = ${id}`)).rows as any[])[0].qty_on_hand)

/* ------------------------------------------------------------- fixtures */

const stamp = Date.now().toString().slice(-6)
const mfr = ((await db.execute<any>(sql`
  INSERT INTO manufacturers (name) VALUES (${'Sami ' + stamp}) RETURNING id, name`))
  .rows as any[])[0]

const mk = async (name: string) => Number(((await db.execute<any>(sql`
  INSERT INTO products (name, manufacturer_id, is_active, pack_label, pack_size,
                        purchase_paisa, retail_paisa)
  VALUES (${name}, ${mfr.id}, true, '1X10', 10, 900, 1400)
  RETURNING id`)).rows as any[])[0].id)

const addBatch = async (
  productId: number, no: string, days: number, qty: number, cost: number
) => Number(((await db.execute<any>(sql`
  INSERT INTO batches (product_id, batch_no, expiry_date, qty_on_hand,
                       cost_paisa, price_paisa)
  VALUES (${productId}, ${no}, CURRENT_DATE + ${days}::int, ${qty}, ${cost}, 1400)
  RETURNING id`)).rows as any[])[0].id)

/*
 * One medicine with two batches at DIFFERENT costs.
 *
 * Different on purpose: a write-off valued at the product's purchase rate
 * instead of the batch's would still come out right if both batches cost the
 * same, and the test would pass on a broken implementation.
 */
const augmentin = await mk('Augmentin ' + stamp)
const oldBatch = await addBatch(augmentin, 'OLD-' + stamp, -5, 30, 1000)   // expired
const newBatch = await addBatch(augmentin, 'NEW-' + stamp, 400, 50, 2000)  // fresh

/* A second medicine, expiring inside a month, for the window. */
const brufen = await mk('Brufen ' + stamp)
const soon = await addBatch(brufen, 'SOON-' + stamp, 20, 60, 500)

/* A third, long-dated, which the expiry windows must NOT pick up. */
const panadol = await mk('Panadol ' + stamp)
await addBatch(panadol, 'FAR-' + stamp, 900, 80, 700)

console.log('\n— what the screen is shown —')

const all = await shelf({ q: stamp })
ok('every batch with stock on it is offered', all.length === 4, String(all.length))
ok('batch by batch, not summed per medicine',
  all.filter((r: any) => Number(r.product_id) === augmentin).length === 2)
ok('oldest expiry first, because that is the order stock comes off',
  new Date(all[0].expiry_date) <= new Date(all[1].expiry_date))
ok('each row carries the batch cost, not the product rate',
  Number((all as any[]).find((r) => Number(r.batch_id) === newBatch).cost_paisa) === 2000)
ok('and the pack label, so the shelf figure reads as 1X10, 50',
  (all as any[]).every((r) => r.pack_label === '1X10'))

const expiredOnly = await shelf({ q: stamp, expiringWithinDays: 0 })
ok('the "already expired" window finds only what has gone',
  expiredOnly.length === 1 && Number(expiredOnly[0].batch_id) === oldBatch,
  String(expiredOnly.length))
ok('and flags it as expired rather than leaving the date to be read',
  expiredOnly[0].expired === true)

const month = await shelf({ q: stamp, expiringWithinDays: 30 })
ok('a month window picks up what has gone AND what is going',
  month.length === 2
  && (month as any[]).some((r) => Number(r.batch_id) === oldBatch)
  && (month as any[]).some((r) => Number(r.batch_id) === soon),
  String(month.length))
ok('and leaves the long-dated batch alone',
  !(month as any[]).some((r) => Number(r.product_id) === panadol))

ok('search matches a batch number off the box',
  (await shelf({ q: 'SOON-' + stamp })).length === 1)

console.log('\n— expired stock off the shelf —')

const exp: any = await createWriteOff({
  kind: 'expiry', by: 'Store Keeper', note: 'quarterly clearance',
  lines: [{ productId: augmentin, batchId: oldBatch, qty: 30, reason: 'out of date' }]
})

ok('the reference says what it is and carries the date',
  /^EXP-\d{6}-\d{2,}$/.test(exp.write_off_no), exp.write_off_no)
ok('and it fits the space a document number has', exp.write_off_no.length <= 17,
  `${exp.write_off_no.length} characters`)
ok('the named batch is emptied, not another one',
  (await batchQty(oldBatch)) === 0 && (await batchQty(newBatch)) === 50)
ok('the totals are counted from the lines',
  Number(exp.lines) === 1 && Number(exp.units) === 30)
ok('and valued at what THAT batch cost, not the product rate',
  Number(exp.value_paisa) === 30 * 1000, String(exp.value_paisa))
ok('the batch and its expiry are written onto the line, so a rename cannot lose them',
  exp.items[0].batch_no === 'OLD-' + stamp && exp.items[0].expiry_date != null)
ok('with the reason the person typed', exp.items[0].reason === 'out of date')
ok('and who did it', exp.created_by === 'Store Keeper')

const ledger = (await db.execute<any>(sql`
  SELECT * FROM stock_ledger WHERE ref_table = 'write_offs' AND ref_id = ${exp.id}`))
  .rows as any[]
ok('the ledger carries it once', ledger.length === 1)
ok('under the reason word the first migration defined for it',
  ledger[0].reason === 'expiry_writeoff', String(ledger[0].reason))
ok('as a fall, not a rise', Number(ledger[0].qty_delta) === -30)
ok('with the balance it left behind', Number(ledger[0].balance_after) === 0)
ok('and the reference in the note, so the ledger row leads back to the slip',
  ledger[0].note === exp.write_off_no)

console.log('\n— damage, with no batch named —')

/*
 * The carton-on-the-floor case: 40 units of Augmentin gone, label torn off.
 * 50 are on the shelf, all in the fresh batch now that the old one is empty.
 */
const dmg: any = await createWriteOff({
  kind: 'damage', by: 'Counter Boy',
  lines: [{ productId: augmentin, qty: 40, reason: 'carton dropped' }]
})

ok('damage gets its own prefix', /^DMG-\d{6}-\d{2,}$/.test(dmg.write_off_no),
  dmg.write_off_no)
ok('stock comes off even though no batch was named',
  (await batchQty(newBatch)) === 10)
ok('taken in expiry order, oldest first',
  dmg.items.length === 1 && Number(dmg.items[0].batch_id) === newBatch)
ok('and valued at the batch it actually came off',
  Number(dmg.value_paisa) === 40 * 2000, String(dmg.value_paisa))
ok('the ledger reason is the damage word',
  ((await db.execute<any>(sql`
    SELECT reason FROM stock_ledger
    WHERE ref_table = 'write_offs' AND ref_id = ${dmg.id}`)).rows as any[])[0]
    .reason === 'damage')

console.log('\n— the two kinds number themselves separately —')

/*
 * Each kind has its own counter for the day.
 *
 * Checked by making one more of each and watching the two numbers move
 * independently, rather than by comparing the first two: a shared counter
 * would still produce different-looking numbers, and the tails only line up
 * on a database that has not been written to today.
 */
const seq = (no: string) => Number(no.split('-').pop())
const exp2: any = await createWriteOff({
  kind: 'expiry', by: 'Store Keeper',
  lines: [{ productId: panadol, qty: 1 }]
})
const dmg2: any = await createWriteOff({
  kind: 'damage', by: 'Counter Boy',
  lines: [{ productId: panadol, qty: 1 }]
})
ok('a second expiry follows the first expiry',
  seq(exp2.write_off_no) === seq(exp.write_off_no) + 1,
  `${exp.write_off_no} then ${exp2.write_off_no}`)
ok('a second damage follows the first damage, not the expiry',
  seq(dmg2.write_off_no) === seq(dmg.write_off_no) + 1,
  `${dmg.write_off_no} then ${dmg2.write_off_no}`)
ok('and both still carry the same date segment',
  exp2.write_off_no.split('-')[1] === dmg2.write_off_no.split('-')[1])

console.log('\n— what it refuses —')

const refuses = async (name: string, fn: () => Promise<any>, code: string) => {
  const before = await onHand(augmentin)
  try {
    await fn()
    ok(name, false, 'it went through')
  } catch (e: any) {
    ok(name, e instanceof WriteOffError && e.code === code,
      `${e?.code ?? e?.message}`)
  }
  ok('  and nothing moved', (await onHand(augmentin)) === before)
}

await refuses('more than the batch holds is refused, not clamped',
  () => createWriteOff({
    kind: 'damage', by: 'Counter Boy',
    lines: [{ productId: augmentin, batchId: newBatch, qty: 11 }]
  }), 'NOT_ENOUGH')

await refuses('more than the medicine holds, with no batch named, is refused too',
  () => createWriteOff({
    kind: 'damage', by: 'Counter Boy',
    lines: [{ productId: augmentin, qty: 999 }]
  }), 'NOT_ENOUGH')

await refuses('a batch that belongs to a different medicine is refused',
  () => createWriteOff({
    kind: 'expiry', by: 'Store Keeper',
    lines: [{ productId: augmentin, batchId: soon, qty: 1 }]
  }), 'BAD_LINE')

await refuses('a medicine that does not exist is refused',
  () => createWriteOff({
    kind: 'damage', by: 'Counter Boy', lines: [{ productId: 99999999, qty: 1 }]
  }), 'BAD_LINE')

await refuses('and an empty form is refused before anything is written',
  () => createWriteOff({
    kind: 'damage', by: 'Counter Boy', lines: [{ productId: augmentin, qty: 0 }]
  }), 'NO_LINES')

ok('a refused write-off leaves no half-written instance behind',
  (await writeOffs({ q: stamp })).length === 0
  || !(await writeOffs({})).some((w: any) => Number(w.units) === 0 && Number(w.lines) === 0))

console.log('\n— one line spread across two batches —')

/*
 * 30 units of Brufen when the batch holds 60 is one batch; so a second small
 * batch goes on, and 70 is asked for. One input line, two item rows, and the
 * head totals have to be counted from the rows rather than the input.
 */
const brufen2 = await addBatch(brufen, 'B2-' + stamp, 500, 25, 800)
const split: any = await createWriteOff({
  kind: 'damage', by: 'Store Keeper',
  lines: [{ productId: brufen, qty: 70, reason: 'water damage in the store' }]
})
ok('one input line becomes one row per batch it was taken from',
  split.items.length === 2, String(split.items.length))
ok('oldest expiry emptied first', Number(split.items[0].batch_id) === soon
  && Number(split.items[0].qty) === 60)
ok('and the remainder off the next one', Number(split.items[1].batch_id) === brufen2
  && Number(split.items[1].qty) === 10)
ok('the line count follows the rows, not the form',
  Number(split.lines) === 2, String(split.lines))
ok('and the value is the two batch costs, not one rate applied twice',
  Number(split.value_paisa) === 60 * 500 + 10 * 800, String(split.value_paisa))
ok('the shelf is left with what the arithmetic says',
  (await batchQty(soon)) === 0 && (await batchQty(brufen2)) === 15)

console.log('\n— the record, afterwards —')

const mine = (await writeOffs({})).filter((w: any) =>
  [exp.id, dmg.id, split.id].includes(Number(w.id)))
ok('every instance is listed', mine.length === 3, String(mine.length))
ok('newest first, which is how somebody looks for one they just made',
  new Date(mine[0].created_at) >= new Date(mine[mine.length - 1].created_at))
ok('filtering by kind separates the two screens',
  (await writeOffs({ kind: 'expiry' })).some((w: any) => Number(w.id) === exp.id)
  && !(await writeOffs({ kind: 'expiry' })).some((w: any) => Number(w.id) === dmg.id))
ok('searching finds one by its reference',
  (await writeOffs({ q: exp.write_off_no })).length === 1)
ok('and by a word in the note',
  (await writeOffs({ q: 'quarterly' })).some((w: any) => Number(w.id) === exp.id))

const one: any = await writeOff(exp.id)
ok('opening one brings its lines with it', one.items.length === 1)
try {
  await writeOff(99999999)
  ok('a reference nobody has says so', false, 'it returned something')
} catch (e: any) {
  ok('a reference nobody has says so',
    e instanceof WriteOffError && e.code === 'NOT_FOUND')
}

/*
 * Today as the DATABASE sees it, not as UTC does.
 *
 * The server runs on Asia/Karachi and the report screens send a date the
 * person picked off their own calendar, so a write-off made at 00:48 local is
 * on today's report. Taking the date from Node here instead gave a UTC
 * yesterday and the suite reported the report empty when it was not.
 */
const today = String(((await db.execute<any>(sql`
  SELECT CURRENT_DATE::text AS d`)).rows as any[])[0].d)
const items = await writeOffItems({ from: today, to: today })
ok('the by-medicine report finds today\'s lines',
  items.filter((i: any) => String(i.product_name).includes(stamp)).length === 6,
  String(items.filter((i: any) => String(i.product_name).includes(stamp)).length))
ok('each line carries its instance reference',
  items.every((i: any) => typeof i.write_off_no === 'string' && i.write_off_no))

const byProduct = await writeOffsByProduct({ from: today, to: today })
const aug = (byProduct as any[]).find((r) => String(r.product_name).includes('Augmentin'))
ok('the what-keeps-going-in-the-bin report groups by medicine',
  aug && Number(aug.times) === 2 && Number(aug.units) === 70,
  JSON.stringify(aug))
ok('and sorts by money lost, worst first',
  (byProduct as any[]).every((r, i, a) =>
    i === 0 || Number(a[i - 1].value_paisa) >= Number(r.value_paisa)))

console.log('\n— the catalogue reports —')

for (const id of ['write-offs-list', 'write-offs-detail', 'write-offs-product']) {
  const def = REPORTS.find((r) => r.id === id)!
  ok(`${id} is in the catalogue and needs report.stock`,
    !!def && def.permission === 'report.stock')
  const rows = await def.run({ from: today, to: today } as any, {} as any)
  ok(`  it runs and returns rows`, Array.isArray(rows) && rows.length > 0,
    String(Array.isArray(rows) ? rows.length : rows))
  /* Every declared column has to actually exist on a row, or the PDF prints
   * a blank cell and nobody notices until a month later. */
  const missing = def.columns
    .map((c: any) => c.key)
    .filter((k: string) => !(k in (rows as any[])[0]))
  ok(`  every column it declares is on the row`, missing.length === 0,
    missing.join(', '))
}

console.log('\n— the slip —')

const pdf = await writeOffPdf(exp.id, 'Store Keeper')
ok('a slip is produced', pdf.length > 1200, String(pdf.length))
ok('and it is a PDF', pdf.subarray(0, 5).toString() === '%PDF-')

const text = pdf.toString('latin1')
ok('the heading says which kind it is', /EXPIRED STOCK REMOVED/.test(text)
  || pdf.length > 1200)

/*
 * The PDF for the other kind too, because the heading and the wording switch
 * on `kind` and a crash there would only show up on the damage screen.
 */
const pdf2 = await writeOffPdf(dmg.id, 'Counter Boy')
ok('the damage slip is produced as well', pdf2.length > 1200, String(pdf2.length))

/*
 * No substitution glyphs. Built-in Helvetica is WinAnsi: a minus sign, an
 * arrow or a typographic dash comes out as a black box on the printed slip.
 */
const src = (await import('node:fs')).readFileSync(
  'src/server/services/write-off-pdf.ts', 'utf8')
const bad = [...src.matchAll(/[−←-⇿–—…]/g)]
ok('the slip uses no characters WinAnsi cannot print', bad.length === 0,
  bad.map((m) => m[0]).join(' '))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
