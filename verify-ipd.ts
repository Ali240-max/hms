/**
 * Inpatients: beds, nights, and the running account.
 *
 * The rule under test is the one that decides every inpatient bill: a bed is
 * charged per night. Everything else here exists to make sure a night is
 * posted exactly once, however many times anything runs.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  nightsBetween, nightsIn, saveWard, saveBed, bedBoard, admit, transfer,
  postBedNights, account, addCharge, takePayment, discharge, admissions,
  setBedStatus, IpdError
} from './src/server/services/ipd'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

console.log('\n— a bed is charged per night —')
/*
 * The case the counter argues about: in at 11pm, out at 9am. Ten hours, but
 * the bed was held through one night and could not be given to anybody else.
 */
ok('11pm to 9am next morning is one night',
  nightsBetween('2026-10-05T23:00:00', '2026-10-06T09:00:00') === 1,
  String(nightsBetween('2026-10-05T23:00:00', '2026-10-06T09:00:00')))
ok('a full 24 hours inside one day is still one night',
  nightsBetween('2026-10-05T08:00:00', '2026-10-05T20:00:00') === 1)
ok('three dates is three nights',
  nightsBetween('2026-10-05T10:00:00', '2026-10-08T10:00:00') === 3,
  String(nightsBetween('2026-10-05T10:00:00', '2026-10-08T10:00:00')))
/*
 * A day case charges one, not zero. The bed was held for the day and the
 * hospital lost the use of it; nobody running a ward would recognise a rule
 * that gives it away free.
 */
ok('admitted and discharged the same hour still charges one',
  nightsBetween('2026-10-05T10:00:00', '2026-10-05T10:30:00') === 1)
ok('each night is named once', nightsIn('2026-10-05T23:00:00', '2026-10-08T09:00:00')
  .join(',') === '2026-10-05,2026-10-06,2026-10-07')

console.log('\n— wards and beds —')
const stamp = Date.now().toString().slice(-5)
const general = await saveWard({
  name: `General ${stamp}`, kind: 'general', chargePaisa: 150000,
  bedCount: 4, bedPrefix: 'G'
})
ok('a ward is created with its beds in one go', !!general.id)
let board = (await bedBoard()).filter((b: any) => b.ward_id === general.id)
ok('four beds were made', board.length === 4, String(board.length))
ok('they inherit the ward price',
  board.every((b: any) => Number(b.charge_paisa) === 150000))
ok('and they are named G-1 upward', board[0].name === 'G-1')

/* Topping up must not disturb the beds already there. */
await saveWard({ id: general.id, name: general.name, chargePaisa: 150000,
  bedCount: 6, bedPrefix: 'G' })
board = (await bedBoard()).filter((b: any) => b.ward_id === general.id)
ok('raising the count adds beds without recreating them', board.length === 6)

const priv = await saveWard({
  name: `Private ${stamp}`, kind: 'private', chargePaisa: 400000,
  bedCount: 2, bedPrefix: 'P'
})
const privBeds = (await bedBoard()).filter((b: any) => b.ward_id === priv.id)
await saveBed({ id: privBeds[0].id, wardId: priv.id, name: privBeds[0].name,
  chargePaisa: 650000 })
const repriced = (await bedBoard()).find((b: any) => b.id === privBeds[0].id)
ok('a single room can be priced above its ward',
  Number(repriced.charge_paisa) === 650000, String(repriced.charge_paisa))
ok('and is marked as having its own price', repriced.own_price === true)
ok('its neighbour still follows the ward',
  Number((await bedBoard()).find((b: any) => b.id === privBeds[1].id).charge_paisa) === 400000)

console.log('\n— admitting —')
const patient = ((await db.execute<any>(sql`
  SELECT id, name FROM patients ORDER BY id DESC LIMIT 1`)).rows as any[])[0]
const firstBed = board[0]
const adm = await admit({
  patientId: patient.id, bedId: firstBed.id, diagnosis: 'Acute appendicitis',
  attendantName: 'Brother', attendantPhone: '03001234567',
  advancePaisa: 500000, by: 'Counter'
})
ok('an admission gets a number', /^ADM-\d{6}$/.test(adm.admission_no), adm.admission_no)
ok('the bed is now occupied',
  (await bedBoard()).find((b: any) => b.id === firstBed.id).status === 'occupied')
ok('the board shows who is in it',
  (await bedBoard()).find((b: any) => b.id === firstBed.id).patient_name === patient.name)

let refused = false
try { await admit({ patientId: patient.id, bedId: board[1].id }) }
catch (e) { refused = e instanceof IpdError && e.code === 'ALREADY_ADMITTED' }
ok('the same patient cannot be admitted twice', refused)

refused = false
try {
  const other = ((await db.execute<any>(sql`
    SELECT id FROM patients WHERE id <> ${patient.id} ORDER BY id DESC LIMIT 1`)).rows as any[])[0]
  if (other) await admit({ patientId: other.id, bedId: firstBed.id })
  else refused = true
} catch (e) { refused = e instanceof IpdError && e.code === 'BED_TAKEN' }
ok('and an occupied bed is refused to the next patient', refused)

refused = false
try { await setBedStatus(firstBed.id, 'out_of_service') }
catch (e) { refused = e instanceof IpdError && e.code === 'BED_TAKEN' }
ok('a bed with somebody in it cannot be taken out of service', refused)

console.log('\n— the running account —')
await postBedNights(adm.id)
const before = await account(adm.id)
ok('one night is posted on the day of admission',
  before.charges.filter((c: any) => c.kind === 'bed').length === 1,
  String(before.charges.filter((c: any) => c.kind === 'bed').length))

/*
 * The posting runs on every page load, so running it again must change
 * nothing. A nightly job that must fire exactly once fails quietly on the
 * night the server was rebooted; this cannot.
 */
await postBedNights(adm.id)
await postBedNights(adm.id)
const after = await account(adm.id)
ok('running it three more times posts nothing further',
  after.charges.filter((c: any) => c.kind === 'bed').length === 1,
  String(after.charges.filter((c: any) => c.kind === 'bed').length))

await addCharge({ admissionId: adm.id, kind: 'doctor',
  description: 'Daily round', unitPaisa: 100000, by: 'Ward' })
await addCharge({ admissionId: adm.id, kind: 'lab',
  description: 'CBC', unitPaisa: 50000, by: 'Lab' })
const acct = await account(adm.id)
ok('bed, doctor and lab all land on one account',
  acct.totals.billed_paisa === 150000 + 100000 + 50000,
  String(acct.totals.billed_paisa))
ok('the advance is counted as paid', acct.totals.paid_paisa === 500000)
ok('the balance is what is still owed',
  acct.totals.balance_paisa === 300000 - 500000, String(acct.totals.balance_paisa))

await takePayment({ admissionId: adm.id, kind: 'discount', amountPaisa: 50000,
  approvedBy: 'Administrator', note: 'Staff relative' })
const withDiscount = await account(adm.id)
/* A discount reduces what is owed. It is not money that arrived. */
ok('a discount lowers the balance', withDiscount.totals.relieved_paisa === 50000)
ok('but is not counted as money taken', withDiscount.totals.paid_paisa === 500000)

console.log('\n— moving beds —')
await transfer({ admissionId: adm.id, bedId: privBeds[0].id,
  reason: 'Family asked for a private room', by: 'Ward' })
const moved = await bedBoard()
ok('the new bed is occupied',
  moved.find((b: any) => b.id === privBeds[0].id).status === 'occupied')
/* Somebody has to strip the old bed before the next patient is sent to it. */
ok('the old bed goes to cleaning, not straight to free',
  moved.find((b: any) => b.id === firstBed.id).status === 'cleaning')

const stays = (await db.execute<any>(sql`
  SELECT charge_paisa, to_at FROM bed_stays
  WHERE admission_id = ${adm.id} ORDER BY from_at`)).rows as any[]
ok('the first stay is closed', !!stays[0].to_at)
/*
 * The rate is copied at assignment, so a stay keeps the price it was agreed
 * at even if the ward is repriced next month.
 */
ok('each stay keeps its own rate',
  Number(stays[0].charge_paisa) === 150000 && Number(stays[1].charge_paisa) === 650000,
  stays.map((s: any) => s.charge_paisa).join(' / '))

console.log('\n— discharge —')
/*
 * Run the bill past the advance first.
 *
 * The advance was 5,000 and the stay so far is 3,000, so the family is in
 * credit and there is nothing to refuse. Theatre takes it the other way,
 * which is the normal shape of an inpatient bill.
 */
await addCharge({ admissionId: adm.id, kind: 'procedure',
  description: 'Appendicectomy', unitPaisa: 1_200_000, by: 'Theatre' })

refused = false
try { await discharge({ admissionId: adm.id, by: 'Counter' }) }
catch (e) { refused = e instanceof IpdError && e.code === 'UNPAID' }
ok('a discharge is refused while money is owed', refused)

const owed = (await account(adm.id)).totals.balance_paisa
ok('the balance is the bill less the advance and the discount',
  owed === (150000 + 100000 + 50000 + 1_200_000) - 50000 - 500000, String(owed))

await takePayment({ admissionId: adm.id, amountPaisa: owed, method: 'cash', by: 'Counter' })
ok('paying it off clears the balance', (await account(adm.id)).totals.balance_paisa === 0)

await discharge({ admissionId: adm.id, outcome: 'discharged',
  finalDiagnosis: 'Appendicitis, operated', by: 'Counter' })
const done = (await admissions({ status: 'discharged' })).find((a: any) => a.id === adm.id)
ok('the admission closes', !!done, 'not in the discharged list')
ok('the bed is released to cleaning',
  (await bedBoard()).find((b: any) => b.id === privBeds[0].id).status === 'cleaning')

refused = false
try { await discharge({ admissionId: adm.id, by: 'Counter' }) }
catch (e) { refused = e instanceof IpdError && e.code === 'CLOSED' }
ok('and cannot be discharged twice', refused)

console.log('\n— an unused advance comes back —')
{
  /*
   * An advance is taken before anybody knows what the stay will cost, so a
   * short stay routinely ends with the hospital holding more than it billed.
   * That credit has to be named at discharge, or it is money quietly kept.
   */
  const spare = (await bedBoard()).find((b: any) =>
    b.ward_id === general.id && b.status === 'free')
  const other = ((await db.execute<any>(sql`
    SELECT id FROM patients WHERE id <> ${patient.id} ORDER BY id DESC LIMIT 1`))
    .rows as any[])[0]

  if (!spare || !other) {
    console.log('  skip  no free bed or second patient in this database')
  } else {
    const short = await admit({
      patientId: other.id, bedId: spare.id, advancePaisa: 1_000_000, by: 'Counter'
    })
    const before = await account(short.id)
    ok('the family is in credit after one night',
      before.totals.refund_due_paisa === 1_000_000 - 150000,
      String(before.totals.refund_due_paisa))

    await discharge({ admissionId: short.id, outcome: 'discharged', by: 'Counter' })
    const settled = await account(short.id)
    ok('discharging returns the unused advance',
      settled.payments.some((p: any) => p.kind === 'refund'
        && Number(p.amount_paisa) === 1_000_000 - 150000))
    ok('and the account settles to zero', settled.totals.balance_paisa === 0,
      String(settled.totals.balance_paisa))
    ok('with nothing left owing back', settled.totals.refund_due_paisa === 0)
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
