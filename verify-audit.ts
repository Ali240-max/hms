/**
 * Stock audits and adjustments.
 *
 * The rule under test is the one that protects a day of sales: a count is
 * applied against the stock AT THE MOMENT OF ADJUSTMENT, not against the
 * figure frozen on the sheet, while both are kept for the record.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  previewScope, createAudit, audits, audit, createAdjustment, adjustments,
  adjustment, adjustmentHistory, adjustmentsByCompany, closeAudit, AuditError
} from './src/server/services/stock-audit'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}
const onHand = async (id: number) => Number(((await db.execute<any>(sql`
  SELECT COALESCE(SUM(qty_on_hand)::int, 0) AS n FROM batches
  WHERE product_id = ${id} AND qty_on_hand > 0`)).rows as any[])[0].n)

/* Two products of one company, with known stock. */
const stamp = Date.now().toString().slice(-6)
const mfr = ((await db.execute<any>(sql`
  INSERT INTO manufacturers (name) VALUES (${'Getz ' + stamp}) RETURNING id, name`))
  .rows as any[])[0]

const mk = async (name: string, rack: string, qty: number) => {
  const p = ((await db.execute<any>(sql`
    INSERT INTO products (name, manufacturer_id, rack_location, is_active, pack_label)
    VALUES (${name}, ${mfr.id}, ${rack}, true, '10s')
    RETURNING id`)).rows as any[])[0]
  if (qty > 0) {
    await db.execute(sql`
      INSERT INTO batches (product_id, batch_no, expiry_date, qty_on_hand,
                           cost_paisa, price_paisa)
      VALUES (${p.id}, ${'B1-' + stamp}, CURRENT_DATE + 200, ${qty}, 1000, 1500)`)
  }
  return p.id
}

const panadol = await mk('Panadol ' + stamp, 'A-1', 100)
const brufen = await mk('Brufen ' + stamp, 'A-2', 40)
const rare = await mk('Rare Syrup ' + stamp, 'B-9', 0)

console.log('\n— choosing what to count —')
const byProduct = await previewScope({ scope: 'product', productIds: [panadol, brufen] })
ok('picking medicines one by one', byProduct.length === 2, String(byProduct.length))
ok('each carries what the system thinks is on the shelf',
  byProduct.every((r: any) => Number(r.on_hand) >= 0)
  && Number((byProduct as any[]).find((r) => r.id === panadol).on_hand) === 100)

const byCompany = await previewScope({ scope: 'manufacturer', ref: mfr.name })
ok('a whole company comes back', byCompany.length === 3, String(byCompany.length))
/* Typed by hand on a form, so it cannot be case sensitive. */
ok('and the company name is not case sensitive',
  (await previewScope({ scope: 'manufacturer', ref: mfr.name.toUpperCase() })).length === 3)

const byRack = await previewScope({ scope: 'rack', ref: 'A' })
ok('rack A finds A-1 and A-2, not B-9',
  (byRack as any[]).some((r) => r.id === panadol)
  && (byRack as any[]).some((r) => r.id === brufen)
  && !(byRack as any[]).some((r) => r.id === rare))

console.log('\n— the sheet —')
const sheet: any = await createAudit({
  scope: 'product', productIds: [panadol, brufen], title: 'Morning count',
  by: 'Store Keeper'
})
ok('it gets a number to write at the top', /^AUD-\d{6}-\d{2}$/.test(sheet.audit_no), sheet.audit_no)
ok('with the lines it covers', sheet.lines === 2)
ok('and who printed it', sheet.created_by === 'Store Keeper')

let refused = false
try { await createAudit({ scope: 'product', productIds: [], by: 'X' }) }
catch (e) { refused = e instanceof AuditError && e.code === 'EMPTY' }
ok('an empty sheet is refused', refused)

refused = false
try { await createAudit({ scope: 'manufacturer', ref: 'No Such Company', by: 'X' }) }
catch (e) { refused = e instanceof AuditError && e.code === 'EMPTY' }
ok('and so is a company with nothing in it', refused)

/*
 * THE RULE THIS WHOLE FEATURE RESTS ON.
 *
 * The sheet is printed at 9am and typed back at 4pm. In between the counter
 * sells 10. If the adjustment compared the count against the 9am figure it
 * would put those 10 back and silently reverse a day of trading.
 */
console.log('\n— stock moves while the sheet is out on the floor —')
await db.execute(sql`
  UPDATE batches SET qty_on_hand = qty_on_hand - 10 WHERE product_id = ${panadol}`)
ok('ten were sold during the count', await onHand(panadol) === 90)

const loaded = await audit(sheet.id)
const line: any = loaded.items.find((i: any) => i.product_id === panadol)
ok('the sheet still shows what it said when it printed', Number(line.expected_qty) === 100)
ok('and separately what the system says now', Number(line.on_hand_now) === 90)

console.log('\n— typing the count back in —')
/* Counted 88: two fewer than the system now believes. */
const adj: any = await createAdjustment({
  auditId: sheet.id,
  counts: [{ productId: panadol, countedQty: 88 }, { productId: brufen, countedQty: 40 }],
  by: 'Store Keeper'
})
ok('it gets its own number', /^ADJ-\d{6}-\d{2}$/.test(adj.adjustment_no), adj.adjustment_no)
/*
 * Only the line that differed. Counting forty and finding two wrong must not
 * produce forty rows of zeroes, or the two that matter are invisible.
 */
ok('only the medicine that differed is written', adj.changed === 1, String(adj.changed))
ok('the shelf now holds what was counted', await onHand(panadol) === 88)
ok('and the one that matched was left alone', await onHand(brufen) === 40)

const detail = await adjustment(adj.id)
const row: any = detail.items[0]
ok('all three numbers are kept', Number(row.expected_qty) === 100
  && Number(row.before_qty) === 90 && Number(row.counted_qty) === 88,
  `${row.expected_qty}/${row.before_qty}/${row.counted_qty}`)
/* Against 90, not against the 100 on the paper. The sale survives. */
ok('the difference is against the live figure, so the sale is not undone',
  Number(row.delta_qty) === -2, String(row.delta_qty))
ok('with who did it', detail.adjustment.created_by === 'Store Keeper')
ok('and when', !!detail.adjustment.created_at)
ok('and which sheet it came from', detail.adjustment.audit_no === sheet.audit_no)

console.log('\n— the ledger —')
const led = (await db.execute<any>(sql`
  SELECT qty_delta, balance_after, reason, actor, note FROM stock_ledger
  WHERE product_id = ${panadol} AND reason = 'stock_count'`)).rows as any[]
ok('the movement is written to the stock ledger', led.length === 1, String(led.length))
ok('with the amount', Number(led[0]?.qty_delta) === -2)
ok('the balance it left behind', Number(led[0]?.balance_after) === 88)
ok('and the person responsible', led[0]?.actor === 'Store Keeper')

console.log('\n— what cannot be done —')
refused = false
try {
  await createAdjustment({ auditId: sheet.id,
    counts: [{ productId: rare, countedQty: 5 }], by: 'X' })
} catch (e) { refused = e instanceof AuditError && e.code === 'NOT_FOUND' }
/*
 * The rule that makes an audit worth anything: an adjustment can only touch
 * what somebody actually counted. Otherwise the sheet is a cover story.
 */
ok('a medicine not on the sheet cannot be adjusted through it', refused)

refused = false
try {
  await createAdjustment({ auditId: sheet.id,
    counts: [{ productId: panadol, countedQty: -5 }], by: 'X' })
} catch (e) { refused = e instanceof AuditError && e.code === 'BAD_COUNT' }
ok('a negative count is refused', refused)

console.log('\n— finding stock that was never recorded —')
const found: any = await createAudit({
  scope: 'product', productIds: [rare], by: 'Store Keeper' })
await createAdjustment({ auditId: found.id,
  counts: [{ productId: rare, countedQty: 7 }], by: 'Store Keeper' })
ok('a surplus on a product with no batch at all still applies',
  await onHand(rare) === 7, String(await onHand(rare)))
const madeBatch = ((await db.execute<any>(sql`
  SELECT batch_no FROM batches WHERE product_id = ${rare}`)).rows as any[])[0]
/* Marked, so nobody mistakes it for stock that was received. */
ok('and the batch it made says where it came from',
  String(madeBatch?.batch_no).startsWith('FOUND-'), madeBatch?.batch_no)

console.log('\n— reading it back —')
ok('the adjustment is listed', (await adjustments()).some((r: any) => r.id === adj.id))
const listed: any = (await adjustments()).find((r: any) => r.id === adj.id)
ok('with how much came off', Number(listed.removed) === 2, String(listed.removed))

/*
 * One row per instance, not a net figure. Panadol adjusted five times is five
 * rows — a net of minus twelve hides the pattern that makes somebody look.
 */
await createAdjustment({ auditId: sheet.id,
  counts: [{ productId: panadol, countedQty: 80 }], by: 'Night Staff' })
const hist = await adjustmentHistory({ productId: panadol })
ok('every adjustment of one medicine is its own row', hist.length === 2, String(hist.length))
ok('each with who did it', (hist as any[]).some((h) => h.created_by === 'Night Staff')
  && (hist as any[]).some((h) => h.created_by === 'Store Keeper'))

const byCo = await adjustmentsByCompany()
const mine: any = (byCo as any[]).find((c) => c.manufacturer === mfr.name)
ok('companies whose stock keeps coming up short are listed', !!mine)
ok('with what went missing', Number(mine.removed) === 10, String(mine.removed))
ok('and what was found', Number(mine.added) === 7, String(mine.added))

console.log('\n— closing it —')
await closeAudit(sheet.id, 'Pharmacy Admin')
refused = false
try {
  await createAdjustment({ auditId: sheet.id,
    counts: [{ productId: panadol, countedQty: 1 }], by: 'X' })
} catch (e) { refused = e instanceof AuditError && e.code === 'CLOSED' }
ok('a closed sheet cannot be adjusted against again', refused)

console.log('\n— the printed sheet —')
{
  const { auditSheetPdf, adjustmentPdf } = await import('./src/server/services/audit-pdf')
  const { writeFile } = await import('node:fs/promises')
  const { execSync } = await import('node:child_process')

  const pdf = await auditSheetPdf(sheet.id)
  await writeFile('/mnt/user-data/outputs/sample-count-sheet.pdf', pdf)
  ok('a count sheet is produced', pdf.length > 1000, `${pdf.length} bytes`)

  const text = execSync('pdftotext -layout /mnt/user-data/outputs/sample-count-sheet.pdf -',
    { encoding: 'utf8' })
  ok('it carries the audit number to read back', text.includes(sheet.audit_no))
  ok('and the medicines to count', text.includes('Panadol ' + stamp))
  /*
   * The system figure is printed; the other three columns are empty boxes
   * for somebody to write in. A sheet that pre-filled the count would be
   * answering the only question it exists to ask.
   */
  ok('with the system figure beside each', /\b100\b/.test(text))
  ok('and columns headed for counting', text.includes('COUNTED'))
  ok('somewhere to sign', text.includes('Counted by'))

  const apdf = await adjustmentPdf(adj.id)
  await writeFile('/mnt/user-data/outputs/sample-adjustment.pdf', apdf)
  const atext = execSync('pdftotext -layout /mnt/user-data/outputs/sample-adjustment.pdf -',
    { encoding: 'utf8' })
  ok('the adjustment prints too', apdf.length > 1000)
  ok('naming who did it', atext.includes('Store Keeper'))
  ok('the sheet it came from', atext.includes(sheet.audit_no))
  /* Signed, because a bare 2 that might be plus or minus is worse than none. */
  ok('and the change with its sign', /-2/.test(atext))
}

console.log('\n— what the correction was worth —')
{
  /*
   * A quantity is half an answer. "Panadol plus 105" is followed every time
   * by how much money that is, and the item rows carried no cost at all.
   *
   * The cost is frozen onto the line at adjustment time, weighted across the
   * batches actually on the shelf. Weighted, because a shortfall of a hundred
   * units does not come out of one batch and picking the cheapest or the
   * dearest would both be a lie. Frozen, because reading the cost at report
   * time would revalue every past correction each time a distributor raised
   * a rate.
   */
  const mkCosted = async (name: string, qty: number, cost: number) => {
    const p = ((await db.execute<any>(sql`
      INSERT INTO products (name, manufacturer_id, is_active, pack_label, purchase_paisa)
      VALUES (${name}, ${mfr.id}, true, '10s', ${cost})
      RETURNING id, name`)).rows as any[])[0]
    await db.execute(sql`
      INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa,
                           price_paisa, qty_on_hand)
      VALUES (${p.id}, ${'V' + name}, CURRENT_DATE + 365, ${cost}, ${cost * 2}, ${qty})`)
    return p
  }

  /* Two batches at different costs, so the weighting has something to do. */
  const up = await mkCosted('Valued Up ' + stamp, 100, 5000)
  await db.execute(sql`
    INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa,
                         price_paisa, qty_on_hand)
    VALUES (${up.id}, ${'V2' + stamp}, CURRENT_DATE + 400, 7000, 14000, 100)`)
  const down = await mkCosted('Valued Down ' + stamp, 200, 3000)

  const va = await createAudit({ scope: 'product', productIds: [up.id, down.id],
    by: 'Store Keeper' })
  const vadj: any = await createAdjustment({
    auditId: (va as any).audit?.id ?? (va as any).id, by: 'Store Keeper',
    counts: [
      { productId: up.id, countedQty: 220 },    /* +20 on a 200 shelf */
      { productId: down.id, countedQty: 150 }   /* -50 */
    ]
  })

  const items = (await db.execute<any>(sql`
    SELECT product_id, delta_qty, unit_cost_paisa, value_paisa
    FROM stock_adjustment_items WHERE adjustment_id = ${vadj.id}`)).rows as any[]

  const upRow = items.find((i) => Number(i.product_id) === up.id)
  const downRow = items.find((i) => Number(i.product_id) === down.id)

  /* 100 at 5000 and 100 at 7000 is 6000 a unit. */
  ok('the cost is weighted across the batches on the shelf',
    Number(upRow.unit_cost_paisa) === 6000, `${upRow.unit_cost_paisa} paisa`)
  ok('a surplus is valued positive', Number(upRow.value_paisa) === 20 * 6000,
    `${upRow.value_paisa} paisa`)
  ok('a shortfall is valued negative', Number(downRow.value_paisa) === -50 * 3000,
    `${downRow.value_paisa} paisa`)

  /*
   * And the report splits them into two columns with the side that does not
   * apply left BLANK, not printed as 0.00 — a column of zeroes reads as real
   * figures and hides the one that matters.
   */
  const { adjustmentHistory } = await import('./src/server/services/stock-audit')
  const hist = await adjustmentHistory({}) as any[]
  const seen = hist.filter((h) => Number(h.adjustment_id) === Number(vadj.id))
  ok('the report query carries the value through', seen.length === 2 &&
    seen.every((h) => h.value_paisa !== undefined),
    `${seen.length} rows`)

  const { REPORTS } = await import('./src/server/services/report-catalogue')
  const def = REPORTS.find((r: any) => r.id === 'adjustments-detail') as any
  const rows = await def.run({ from: undefined, to: undefined }, {})
  const mine = rows.filter((r: any) => Number(r.adjustment_id) === Number(vadj.id))
  const plus = mine.find((r: any) => Number(r.delta_qty) > 0)
  const minus = mine.find((r: any) => Number(r.delta_qty) < 0)
  ok('a surplus row fills Added and leaves Removed blank',
    Number(plus.added_paisa) === 120000 && plus.removed_paisa === null,
    `${plus.added_paisa} / ${plus.removed_paisa}`)
  ok('a shortfall row fills Removed and leaves Added blank',
    Number(minus.removed_paisa) === 150000 && minus.added_paisa === null,
    `${minus.added_paisa} / ${minus.removed_paisa}`)

  const stats: any = await def.stats({ from: undefined, to: undefined }, {})
  ok('and there is a closing net-change line', Array.isArray(stats.notes) &&
    stats.notes.length === 3 && /Net change/.test(stats.notes[2]),
    JSON.stringify(stats.notes))
  ok('which says which way it went in words, not a bare sign',
    /MORE stock|LESS stock|cancel out/.test(stats.notes[2]), stats.notes[2])
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
