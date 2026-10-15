/**
 * Purchase orders, supplier terms and opening stock.
 *
 * Four rules are worth a test here, because each one was a decision rather
 * than an obvious implementation:
 *
 *   1. Choosing a supplier narrows the medicine list to the companies they
 *      carry — but a supplier with NO companies recorded shows everything,
 *      because an empty list means nobody filled the card in.
 *   2. The suggested quantity is what sold in the window, flat, with returns
 *      netted off. Not scaled, and not reduced by stock on hand.
 *   3. Receiving against an order closes it in the same transaction as the
 *      stock, and a short delivery closes it too.
 *   4. Opening stock SETS the figure rather than adding to it, and only the
 *      rows actually sent are touched.
 *
 * Runs against the database directly, no HTTP.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  addCompany, companiesFor, removeCompany, addSlot, slotsFor, removeSlot,
  suppliersWithTerms, orderSheet, createOrder, listOrders, orderDetail,
  deleteOrder, setOpeningStock, openingSheet, OrderError
} from './src/server/services/ordering'
import { receiveGoods } from './src/server/services/purchase'
import { purchaseOrderPdf, slotLabel } from './src/server/services/order-pdf'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n))
    : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}
const onHand = async (id: number) => Number(((await db.execute<any>(sql`
  SELECT COALESCE(SUM(qty_on_hand)::int, 0) AS n FROM batches
  WHERE product_id = ${id}`)).rows as any[])[0].n)

const stamp = Date.now().toString().slice(-6)

/* Two companies, so scoping has something to exclude. */
const mine = ((await db.execute<any>(sql`
  INSERT INTO manufacturers (name) VALUES (${'Mine ' + stamp}) RETURNING id, name`))
  .rows as any[])[0]
const theirs = ((await db.execute<any>(sql`
  INSERT INTO manufacturers (name) VALUES (${'Theirs ' + stamp}) RETURNING id, name`))
  .rows as any[])[0]

const supplier = ((await db.execute<any>(sql`
  INSERT INTO suppliers (name) VALUES (${'Distributor ' + stamp}) RETURNING id, name`))
  .rows as any[])[0]

const mk = async (name: string, mfrId: number, packSize: number) =>
  ((await db.execute<any>(sql`
    INSERT INTO products (name, manufacturer_id, pack_size, is_active, pack_label,
                          purchase_paisa, retail_paisa, tax_rate_bp)
    VALUES (${name}, ${mfrId}, ${packSize}, true, ${packSize + 's'}, 5000, 8000, 1750)
    RETURNING id, name, pack_size`)).rows as any[])[0]

const alpha = await mk('Alpha ' + stamp, mine.id, 10)
const beta = await mk('Beta ' + stamp, mine.id, 20)
const outsider = await mk('Outsider ' + stamp, theirs.id, 10)

console.log('\n— what a supplier carries —')

ok('a supplier starts with no companies recorded',
  (await companiesFor(supplier.id)).length === 0)

await addCompany(supplier.id, mine.id)
ok('a company can be added', (await companiesFor(supplier.id)).length === 1)

await addCompany(supplier.id, mine.id)
ok('adding the same one twice is not an error and does not duplicate',
  (await companiesFor(supplier.id)).length === 1)

console.log('\n— when they take orders —')

await addSlot(supplier.id, 6, '19:00')
const slots = await slotsFor(supplier.id)
ok('a booking time can be set', slots.length === 1)
ok('it keeps the day and the time', Number(slots[0].weekday) === 6 &&
  String(slots[0].at_time).startsWith('19:00'), JSON.stringify(slots[0]))

await addSlot(supplier.id, 6, '19:00')
ok('the same day and time twice is a mis-click, not a second slot',
  (await slotsFor(supplier.id)).length === 1)

/*
 * A rep reads "Saturday 7:00 pm", not "6 at 19:00". The printed sheet and the
 * screen both go through this, so it is worth pinning.
 */
ok('the printed label reads as a human would say it',
  slotLabel(6, '19:00') === 'Saturday 7:00 pm', slotLabel(6, '19:00'))
ok('midnight does not come out as 0:00', slotLabel(1, '00:30') === 'Monday 12:30 am',
  slotLabel(1, '00:30'))
ok('noon is pm, not am', slotLabel(3, '12:15') === 'Wednesday 12:15 pm',
  slotLabel(3, '12:15'))

let bad = false
try { await addSlot(supplier.id, 9, '19:00') } catch (e) { bad = e instanceof OrderError }
ok('a weekday outside 0-6 is refused', bad)

bad = false
try { await addSlot(supplier.id, 2, 'half seven') } catch (e) { bad = e instanceof OrderError }
ok('a time that is not HH:MM is refused', bad)

const terms = (await suppliersWithTerms()).find((s: any) => s.id === supplier.id) as any
ok('the list folds companies and slots into one row',
  (terms.companies ?? []).length === 1 && (terms.slots ?? []).length === 1)

console.log('\n— the order sheet —')

const sheet = await orderSheet({ supplierId: supplier.id, windowDays: 7 })
const ids = sheet.rows.map((r: any) => Number(r.product_id))
ok('it lists the medicines of the companies they carry',
  ids.includes(alpha.id) && ids.includes(beta.id))
/*
 * The one scoping rule that matters. A distributor who does not carry a
 * company cannot bring its medicines, and offering them is how a shop ends up
 * ordering from the wrong supplier.
 */
ok('and leaves out a company they do not carry', !ids.includes(outsider.id))

/* Sell some, so the suggestion has something to be built from. */
const sale = ((await db.execute<any>(sql`
  INSERT INTO sales (invoice_no, cashier, subtotal_paisa, total_paisa, paid_paisa, status)
  VALUES (${'S-ORD-' + stamp}, 'Tester', 8000, 8000, 8000, 'completed')
  RETURNING id`)).rows as any[])[0]

/* A batch to sell off, so the sale line can point at one. */
const batch = ((await db.execute<any>(sql`
  INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa, price_paisa, qty_on_hand)
  VALUES (${alpha.id}, ${'B' + stamp}, CURRENT_DATE + 365, 5000, 8000, 500)
  RETURNING id`)).rows as any[])[0]

await db.execute(sql`
  INSERT INTO sale_items (sale_id, batch_id, product_id, product_name, batch_no,
                          expiry_date, qty, sold_as, display_qty,
                          unit_price_paisa, unit_cost_paisa, line_total_paisa)
  VALUES (${sale.id}, ${batch.id}, ${alpha.id}, ${alpha.name}, ${'B' + stamp},
          CURRENT_DATE + 365, 240, 'unit', 240, 8000, 5000, 1920000)`)

const sheet2 = await orderSheet({ supplierId: supplier.id, windowDays: 7 })
const rowA = sheet2.rows.find((r: any) => Number(r.product_id) === alpha.id) as any
ok('a medicine that sold shows the units that left the shelf',
  Number(rowA.sold_units) === 240, String(rowA.sold_units))
/*
 * Flat, as asked for. Not scaled, and not reduced by the 500 on the shelf —
 * a formula that quietly subtracts stock gives numbers nobody can check by
 * eye, so stock is shown in its own column instead.
 */
/*
 * The suggestion is in PACKS now, because the order is placed in packs — a
 * depot ships packs and the sheet has to say packs or somebody there divides.
 * Rounded UP: 240 units of a pack of ten is 24 packs exactly, but 95 of a
 * pack of ten is ten, not nine, because a depot cannot split one.
 */
ok('the suggestion is that demand in whole packs, not reduced by stock',
  Number(rowA.suggest_packs) === 24, String(rowA.suggest_packs))
ok('and the unit demand it came from is still reported',
  Number(rowA.suggest_units) === 240, String(rowA.suggest_units))
ok('stock on hand is reported beside it', Number(rowA.stock_units) === 500,
  String(rowA.stock_units))

const rowB = sheet2.rows.find((r: any) => Number(r.product_id) === beta.id) as any
ok('a medicine that sold nothing suggests nothing', Number(rowB.suggest_packs) === 0)

/* Goods that came straight back are not demand. */
const ret = ((await db.execute<any>(sql`
  INSERT INTO sale_returns (return_no, sale_id, total_paisa, returned_by)
  VALUES (${'R-ORD-' + stamp}, ${sale.id}, 1000, 'Tester') RETURNING id`))
  .rows as any[])[0]
await db.execute(sql`
  INSERT INTO sale_return_items (return_id, product_id, product_name, qty,
                                 unit_price_paisa, line_total_paisa, restock)
  VALUES (${ret.id}, ${alpha.id}, ${alpha.name}, 90, 8000, 720000, true)`)

const sheet3 = await orderSheet({ supplierId: supplier.id, windowDays: 7 })
const rowA3 = sheet3.rows.find((r: any) => Number(r.product_id) === alpha.id) as any
ok('a refund is taken off the demand figure', Number(rowA3.sold_units) === 150,
  String(rowA3.sold_units))
/* 150 units of a pack of ten is fifteen packs. */
ok('and the pack suggestion follows it down', Number(rowA3.suggest_packs) === 15,
  String(rowA3.suggest_packs))

/*
 * Rounding up is the whole point, so it gets its own case: a quantity that
 * does not divide evenly must come out as the next whole pack.
 */
const odd = await mk('Odd ' + stamp, mine.id, 20)
const oddBatch = ((await db.execute<any>(sql`
  INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa, price_paisa, qty_on_hand)
  VALUES (${odd.id}, ${'OD' + stamp}, CURRENT_DATE + 365, 5000, 8000, 300)
  RETURNING id`)).rows as any[])[0]
await db.execute(sql`
  INSERT INTO sale_items (sale_id, batch_id, product_id, product_name, batch_no,
                          expiry_date, qty, sold_as, display_qty,
                          unit_price_paisa, unit_cost_paisa, line_total_paisa)
  VALUES (${sale.id}, ${oddBatch.id}, ${odd.id}, ${odd.name}, ${'OD' + stamp},
          CURRENT_DATE + 365, 95, 'unit', 95, 8000, 5000, 760000)`)
const oddSheet = await orderSheet({ supplierId: supplier.id, windowDays: 7 })
const oddRow = oddSheet.rows.find((r: any) => Number(r.product_id) === odd.id) as any
ok('95 units of a pack of 20 rounds up to 5 packs, not down to 4',
  Number(oddRow.suggest_packs) === 5, String(oddRow.suggest_packs))

/* A supplier with nothing recorded shows everything, not nothing. */
const blank = ((await db.execute<any>(sql`
  INSERT INTO suppliers (name) VALUES (${'Unfilled ' + stamp}) RETURNING id`))
  .rows as any[])[0]
const blankSheet = await orderSheet({ supplierId: blank.id, windowDays: 7 })
ok('a supplier with no companies recorded lists every medicine',
  blankSheet.rows.length > sheet3.rows.length, `${blankSheet.rows.length}`)

ok('the window is clamped to something sane',
  (await orderSheet({ supplierId: supplier.id, windowDays: 9999 })).windowDays === 365)

/*
 * The window actually excludes older sales.
 *
 * Worth its own test because the failure is silent and plausible: get the
 * interval arithmetic wrong and every window returns every sale ever, so 7
 * days and 90 days agree and the timeframe buttons look like they work. The
 * demo data cannot catch this — the pharmacy seeder stamps every invoice with
 * now(), so on seeded data all windows genuinely do agree.
 *
 * So: one sale of Beta, forty days old. A 7-day window must not see it; a
 * 60-day window must.
 */
const oldSale = ((await db.execute<any>(sql`
  INSERT INTO sales (invoice_no, cashier, subtotal_paisa, total_paisa, paid_paisa,
                     status, created_at)
  VALUES (${'S-OLD-' + stamp}, 'Tester', 8000, 8000, 8000, 'completed',
          now() - interval '40 days')
  RETURNING id`)).rows as any[])[0]
const oldBatch = ((await db.execute<any>(sql`
  INSERT INTO batches (product_id, batch_no, expiry_date, cost_paisa, price_paisa, qty_on_hand)
  VALUES (${beta.id}, ${'OB' + stamp}, CURRENT_DATE + 365, 5000, 8000, 100)
  RETURNING id`)).rows as any[])[0]
await db.execute(sql`
  INSERT INTO sale_items (sale_id, batch_id, product_id, product_name, batch_no,
                          expiry_date, qty, sold_as, display_qty,
                          unit_price_paisa, unit_cost_paisa, line_total_paisa)
  VALUES (${oldSale.id}, ${oldBatch.id}, ${beta.id}, ${beta.name}, ${'OB' + stamp},
          CURRENT_DATE + 365, 77, 'unit', 77, 8000, 5000, 616000)`)

const near = await orderSheet({ supplierId: supplier.id, windowDays: 7 })
const far = await orderSheet({ supplierId: supplier.id, windowDays: 60 })
const betaNear = near.rows.find((r: any) => Number(r.product_id) === beta.id) as any
const betaFar = far.rows.find((r: any) => Number(r.product_id) === beta.id) as any
ok('a sale from forty days ago is outside a seven day window',
  Number(betaNear.sold_units) === 0, String(betaNear.sold_units))
ok('and inside a sixty day one', Number(betaFar.sold_units) === 77,
  String(betaFar.sold_units))

console.log('\n— raising an order —')

bad = false
try {
  await createOrder({ supplierId: supplier.id, by: 'Tester',
    lines: [{ productId: alpha.id, orderPacks: 0 }] })
} catch (e) { bad = e instanceof OrderError }
ok('an order of nothing but zeroes is refused', bad)

const order = await createOrder({
  supplierId: supplier.id, windowDays: 7, by: 'Store Keeper', note: 'Saturday run',
  lines: [
    { productId: alpha.id, orderPacks: 24, soldUnits: 150, stockUnits: 500 },
    /* Left at zero, so it must not reach the order. */
    { productId: beta.id, orderPacks: 0 }
  ]
})

ok('the number carries the date', /^PO-\d{6}-\d{2}$/.test(order.order_no), order.order_no)
ok('only the lines with a quantity are kept', order.items.length === 1,
  String(order.items.length))
ok('it records who raised it', order.created_by === 'Store Keeper')
ok('the window it was suggested from is kept', Number(order.window_days) === 7)
/*
 * Without these an order read back later is a number with no argument behind
 * it: you cannot tell whether 240 was reasonable.
 */
ok('the figures the suggestion came from are frozen on the line',
  Number(order.items[0].sold_units) === 150 && Number(order.items[0].stock_units) === 500)
ok('the name and pack are copied, so a later rename does not rewrite history',
  order.items[0].product_name === alpha.name && Number(order.items[0].pack_size) === 10)
ok('stock is also read live, for whoever opens it today',
  Number(order.items[0].stock_now) === 500, String(order.items[0].stock_now))

const open1 = await listOrders({ status: 'open' })
ok('it appears in the waiting list',
  open1.some((o: any) => o.order_no === order.order_no))
ok('the list totals its packs',
  Number((open1.find((o: any) => o.id === order.id) as any).packs) === 24,
  String((open1.find((o: any) => o.id === order.id) as any).packs))
/* Units are derived and kept, because the shelf is counted in them. */
ok('and keeps the unit equivalent beside it',
  Number((open1.find((o: any) => o.id === order.id) as any).units) === 240,
  String((open1.find((o: any) => o.id === order.id) as any).units))
ok('the line stores both figures',
  Number(order.items[0].order_packs) === 24 &&
  Number(order.items[0].order_units) === 240,
  `${order.items[0].order_packs} packs / ${order.items[0].order_units} units`)


/*
 * The three rates the receive screen prefills from.
 *
 * Receiving fills purchase rate, sales tax and retail rate from the
 * medicine's own setup. A delivery raised against an ORDER was filling them
 * from the order's lines, which carry none of the three - so the boxes came
 * up empty on exactly the deliveries with the most lines in them.
 *
 * Checked here rather than on the screen because the screen can only show
 * what this function hands it.
 */
const forReceiving = await orderDetail(order.id)
ok('an order line carries the medicine\'s purchase rate, for the receive screen',
  Number((forReceiving.items[0] as any).purchase_paisa) === 5000,
  String((forReceiving.items[0] as any).purchase_paisa))
ok('and its retail rate',
  Number((forReceiving.items[0] as any).retail_paisa) === 8000,
  String((forReceiving.items[0] as any).retail_paisa))
ok('and the sales tax set against it, so 17.5% survives the trip',
  Number((forReceiving.items[0] as any).tax_rate_bp) === 1750,
  String((forReceiving.items[0] as any).tax_rate_bp))

const pdf = await purchaseOrderPdf(await orderDetail(order.id), 'Store Keeper')
ok('it prints', pdf.length > 900 && pdf.slice(0, 5).toString() === '%PDF-',
  `${pdf.length} bytes`)

console.log('\n— receiving against it —')

const before = await onHand(alpha.id)
/*
 * Deliberately SHORT: 20 packs of 10 is 200 units against 240 ordered. The
 * decision taken was that one receive finishes an order, so this must close
 * it rather than leave a balance outstanding.
 */
await receiveGoods(db, {
  supplierId: supplier.id,
  supplierInvoiceNo: 'INV-' + stamp,
  invoiceDate: new Date().toISOString().slice(0, 10),
  receivedBy: 'Store Keeper',
  purchaseOrderId: order.id,
  lines: [{ productId: alpha.id, batchNo: 'D' + stamp,
    expiryDate: '2027-12-31', qty: 20, costPaisa: 5000 }]
})

ok('the stock arrives', (await onHand(alpha.id)) === before + 200,
  `${before} -> ${await onHand(alpha.id)}`)

const closed = await orderDetail(order.id)
ok('the order is closed even though the delivery was short',
  closed.status === 'received', closed.status)
ok('and it records who closed it', closed.closed_by === 'Store Keeper')
ok('it leaves the waiting list',
  !(await listOrders({ status: 'open' })).some((o: any) => o.id === order.id))

const linked = await listOrders({})
ok('the delivery it answers is findable from the order',
  /^GRN-/.test(String((linked.find((o: any) => o.id === order.id) as any).grn_no)),
  String((linked.find((o: any) => o.id === order.id) as any).grn_no))

console.log('\n— throwing an order away —')

const spare = await createOrder({ supplierId: supplier.id, by: 'Tester',
  lines: [{ productId: beta.id, orderPacks: 3 }] })
const gone = await deleteOrder(spare.id, 'Tester')
ok('an order with no delivery behind it is deleted outright', gone.deleted === true)
let missing = false
try { await orderDetail(spare.id) } catch (e) { missing = e instanceof OrderError }
ok('and it is really gone', missing)

/*
 * The one that matters: deleting an order a delivery points at would leave
 * that delivery pointing at nothing and lose the only link between the stock
 * on the shelf and the decision to buy it.
 */
const kept = await deleteOrder(order.id, 'Tester')
ok('an order with a delivery against it is cancelled, not deleted',
  kept.deleted === false && kept.cancelled === true)
ok('and it says why', typeof kept.reason === 'string' && kept.reason!.length > 20)
ok('the order is still there to be found',
  (await orderDetail(order.id)).status === 'cancelled')

console.log('\n— opening stock —')

const fresh = await mk('Fresh ' + stamp, mine.id, 10)
ok('a new medicine starts at nothing', (await onHand(fresh.id)) === 0)

await setOpeningStock({ by: 'Owner', lines: [{ productId: fresh.id, units: 120 }] })
ok('the figure typed in becomes the stock', (await onHand(fresh.id)) === 120)

/*
 * SETS, never adds. Somebody correcting a typo five minutes later expects the
 * box to mean what it says — "90" meaning "another ninety" is how a
 * changeover ends up with double the stock in the shop.
 */
await setOpeningStock({ by: 'Owner', lines: [{ productId: fresh.id, units: 90 }] })
ok('typing it again replaces the figure rather than adding to it',
  (await onHand(fresh.id)) === 90, String(await onHand(fresh.id)))

const led = ((await db.execute<any>(sql`
  SELECT qty_delta, balance_after, reason, actor FROM stock_ledger
  WHERE product_id = ${fresh.id} ORDER BY id DESC LIMIT 1`)).rows as any[])[0]
ok('the correction is a real delta in the ledger, not the typed figure',
  Number(led.qty_delta) === -30 && Number(led.balance_after) === 90,
  `${led.qty_delta} / ${led.balance_after}`)
ok('the ledger calls it opening stock', led.reason === 'opening')
ok('and names who did it', led.actor === 'Owner')

const unchanged = await onHand(beta.id)
await setOpeningStock({ by: 'Owner', lines: [{ productId: fresh.id, units: 90 }] })
ok('setting the same figure again changes nothing',
  (await onHand(fresh.id)) === 90 && (await onHand(beta.id)) === unchanged)

/*
 * Only the rows sent are touched. The screen lists every medicine in the
 * shop, and saving must not write zeroes over the ones nobody typed into.
 */
const sheetOpen = await openingSheet('Fresh ' + stamp)
ok('the sheet reports what is there now',
  Number((sheetOpen[0] as any).stock_units) === 90)
ok('and separates the opening batch from the rest',
  Number((sheetOpen[0] as any).opening_units) === 90)

bad = false
try { await setOpeningStock({ by: 'Owner', lines: [] }) }
catch (e) { bad = e instanceof OrderError }
ok('sending no rows is refused rather than silently doing nothing', bad)

/* ----------------------------------------------------------------- tidy */

await removeSlot(supplier.id, Number(slots[0].id))
ok('a booking time can be removed', (await slotsFor(supplier.id)).length === 0)
await removeCompany(supplier.id, mine.id)
ok('a company can be removed', (await companiesFor(supplier.id)).length === 0)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
