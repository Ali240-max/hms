import { sql } from 'drizzle-orm'
import { db, pool, runMigrations } from './src/server/db/client'
import * as s from './src/server/db/schema'
import { createFirstAdmin, createStaff, login, sessionFor } from './src/server/services/auth'
import {
  registerPatient, findPossibleDuplicates, searchPatients, createVisit,
  todaysQueue, setVisitStatus, patientHistory
} from './src/server/services/patients'
import {
  saveConsultation, getPrescription, doctorEarnings, upsertService, pendingPrescriptions
} from './src/server/services/clinical'

let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') =>
  c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l} ${d}`))
const rows = async (q: any) => ((await db.execute<any>(q)) as any).rows as any[]
const today = new Date().toISOString().slice(0, 10)

async function fixture() {
  await runMigrations()
  await db.execute(sql`
    TRUNCATE doctor_earnings, service_orders, prescription_items, prescriptions,
             visits, patients, doctor_service_shares, services, doctors, staff,
             departments, sale_items, sales, stock_ledger, purchase_items, purchases,
             batches, products, suppliers, settings, counters RESTART IDENTITY CASCADE`)

  const [dept] = await db.insert(s.departments).values({ name: 'General Medicine', code: 'GEN' }).returning()
  const admin = await createFirstAdmin({ username: 'admin', displayName: 'Administrator', password: 'longenough1' })

  const docStaff = await createStaff({
    username: 'dr.yasir', displayName: 'Dr Yasir Habib', password: '1234',
    role: 'doctor', departmentId: dept.id,
    doctor: {
      specialisation: 'General Physician', room: '3',
      consultationFeePaisa: 100000,      // Rs 1000
      consultationShareBp: 6000,          // doctor keeps 60%
      defaultServiceShareBp: 1000         // 10% of anything they order
    }
  })
  const docRow = (await rows(sql`SELECT id FROM doctors WHERE staff_id = ${docStaff.id}`))[0]

  const xray = await upsertService({
    name: 'X-Ray Chest', category: 'radiology', pricePaisa: 100000, defaultShareBp: 2000
  })
  const cbc = await upsertService({
    name: 'CBC', category: 'lab', pricePaisa: 50000, defaultShareBp: 0
  })

  const [panadol] = await db.insert(s.products).values({
    name: 'Panadol 500mg', unitLabel: 'strip', subUnitLabel: 'tablet', packSize: 10, allowLoose: true
  }).returning()
  await db.insert(s.batches).values({
    productId: panadol.id, batchNo: 'PL-1', expiryDate: '2027-12-31',
    costPaisa: 3800, pricePaisa: 5000, qtyOnHand: 500
  })

  return { dept, admin, docStaff, doctorId: Number(docRow.id), xray, cbc, panadol }
}

async function main() {
  const F = await fixture()

  console.log('\n[1] Registration gives every patient an MRN')
  const p1 = await registerPatient({ name: 'Asif Mahmood', phone: '0300-1234567', gender: 'male', ageYears: 34 })
  check('MRN generated', /^MRN-\d{6}$/.test(p1.mrn), p1.mrn)
  const p2 = await registerPatient({ name: 'Nadia Khan', phone: '0321-9876543', gender: 'female', ageYears: 28 })
  check('MRNs are sequential and unique', p2.mrn !== p1.mrn && p2.mrn > p1.mrn, `${p1.mrn} then ${p2.mrn}`)

  console.log('\n[2] Duplicate detection at registration')
  const samePhone = await findPossibleDuplicates({ name: 'Asif M.', phone: '0300-1234567' })
  check('same phone is flagged', samePhone.length === 1, JSON.stringify(samePhone.map((r: any) => r.name)))
  check('and says why', samePhone[0]?.why === 'same phone', samePhone[0]?.why)
  const sameName = await findPossibleDuplicates({ name: 'asif mahmood', phone: '0333-0000000' })
  check('same name, different phone still flagged', sameName.length === 1, JSON.stringify(sameName))
  const noMatch = await findPossibleDuplicates({ name: 'Someone Entirely New', phone: '0345-1111111' })
  check('a genuinely new patient is not flagged', noMatch.length === 0)
  check('phone matching ignores formatting',
    (await findPossibleDuplicates({ name: 'X', phone: '03001234567' })).length === 1,
    'dashes stripped both sides')

  console.log('\n[3] Duplicates are a warning, never a block')
  const twin = await registerPatient({ name: 'Asif Mahmood', phone: '0300-1234567', ageYears: 6 })
  check('the receptionist can still register a namesake', twin.id !== p1.id)
  check('they get their own MRN', twin.mrn !== p1.mrn)

  console.log('\n[4] Search finds a patient every way a receptionist would try')
  check('by MRN', (await searchPatients(p1.mrn)).some((r: any) => r.id === p1.id))
  check('by name', (await searchPatients('nadia')).some((r: any) => r.id === p2.id))
  check('by phone with dashes', (await searchPatients('0321-9876543')).some((r: any) => r.id === p2.id))
  check('by phone without dashes', (await searchPatients('03219876543')).some((r: any) => r.id === p2.id))
  check('by partial phone', (await searchPatients('9876543')).some((r: any) => r.id === p2.id))
  check('a single character returns nothing', (await searchPatients('a')).length === 0)

  console.log('\n[5] Visits and the daily token')
  const v1 = await createVisit({ patientId: p1.id, doctorId: F.doctorId, complaint: 'Fever, 3 days' })
  const v2 = await createVisit({ patientId: p2.id, doctorId: F.doctorId, complaint: 'Cough' })
  check('tokens count up from 1', v1.tokenNo === 1 && v2.tokenNo === 2, `${v1.tokenNo}, ${v2.tokenNo}`)
  check('visit numbers are unique', v1.visitNo !== v2.visitNo)
  check('the fee is snapshotted onto the visit', v1.consultationFeePaisa === 100000, String(v1.consultationFeePaisa))

  // Changing the doctor's fee must not alter a visit already created.
  await db.execute(sql`UPDATE doctors SET consultation_fee_paisa = 150000 WHERE id = ${F.doctorId}`)
  const again = (await rows(sql`SELECT consultation_fee_paisa FROM visits WHERE id = ${v1.id}`))[0]
  check('raising the fee does not rewrite an existing visit',
    Number(again.consultation_fee_paisa) === 100000, String(again.consultation_fee_paisa))
  await db.execute(sql`UPDATE doctors SET consultation_fee_paisa = 100000 WHERE id = ${F.doctorId}`)

  console.log('\n[6] The queue')
  /**
   * The queue is gated on payment. An unpaid registration is work at the cash
   * window, not a patient waiting for a doctor, so it is hidden from everyone
   * except the counter that has to bill it.
   */
  const unpaidQ = await todaysQueue(F.doctorId)
  check('unpaid registrations stay out of the queue', unpaidQ.length === 0, String(unpaidQ.length))

  const tillQ = await todaysQueue(F.doctorId, true)
  check('the till still sees them', tillQ.length === 2, String(tillQ.length))

  await db.execute(sql`
    UPDATE visits SET fee_paid = true, status = 'waiting'
    WHERE id IN (${v1.id}, ${v2.id})`)
  const q = await todaysQueue(F.doctorId)
  check('both patients waiting once billed', q.length === 2, String(q.length))
  check('ordered by token', q[0].token_no === 1)
  await setVisitStatus(v1.id, 'in_consultation')
  const q2 = await todaysQueue(F.doctorId)
  check('the patient being seen is listed first', q2[0].id === v1.id && q2[0].status === 'in_consultation')

  console.log('\n[7] A consultation: medicines and tests together')
  const saved = await saveConsultation({
    visitId: v1.id, doctorId: F.doctorId,
    diagnosis: 'Viral fever', advice: 'Fluids and rest',
    items: [
      { productId: F.panadol.id, drugName: 'Panadol 500mg', dose: '1 tablet', frequency: 'TDS', durationDays: 3, qtyPrescribed: 9 },
      { productId: null, drugName: 'Some Import Not Stocked', dose: '5ml', frequency: 'BD', qtyPrescribed: 1 }
    ],
    services: [{ serviceId: F.xray.id }, { serviceId: F.cbc.id }]
  })
  check('prescription saved', saved.items === 2)
  const pres = await getPrescription(v1.id)
  check('both medicines recorded', pres!.items.length === 2)
  check('a drug NOT in the catalogue is allowed',
    pres!.items.some((i: any) => i.product_id === null && i.drug_name.includes('Import')),
    'doctors prescribe clinically, not from the shelf')
  check('stock shown as advice on the catalogue item',
    pres!.items.find((i: any) => i.product_id)?.in_stock === 500)
  check('visit closed automatically', (await rows(sql`SELECT status FROM visits WHERE id=${v1.id}`))[0].status === 'completed')

  console.log('\n[8] Doctor earnings')
  const e = await doctorEarnings(F.doctorId, today, today)
  // consultation 100000 x 60% = 60000; xray 100000 x 20% = 20000; CBC share 0
  check('consultation share is Rs 600', Number(e.totals.consultation_paisa) === 60000, String(e.totals.consultation_paisa))
  check('X-ray share is Rs 200', Number(e.totals.service_paisa) === 20000, String(e.totals.service_paisa))
  check('total is Rs 800', Number(e.totals.total_paisa) === 80000, String(e.totals.total_paisa))
  check('a zero-share service earns nothing but is still ordered',
    (await rows(sql`SELECT count(*)::int n FROM service_orders WHERE visit_id=${v1.id}`))[0].n === 2)
  check('each earning line is traceable to what caused it',
    e.lines.every((l: any) => l.ref_table && l.ref_id))

  console.log('\n[9] Re-saving a consultation does not pay the doctor twice')
  await saveConsultation({
    visitId: v1.id, doctorId: F.doctorId, diagnosis: 'Viral fever, corrected',
    items: [{ productId: F.panadol.id, drugName: 'Panadol 500mg', qtyPrescribed: 9 }],
    services: []
  })
  const e2 = await doctorEarnings(F.doctorId, today, today)
  check('consultation still counted once', Number(e2.totals.consultation_paisa) === 60000, String(e2.totals.consultation_paisa))
  check('the diagnosis was updated', (await getPrescription(v1.id))!.prescription.diagnosis.includes('corrected'))

  console.log('\n[10] Changing a price later does not move past earnings')
  await upsertService({ id: F.xray.id, name: 'X-Ray Chest', category: 'radiology',
    pricePaisa: 200000, defaultShareBp: 5000 })
  const e3 = await doctorEarnings(F.doctorId, today, today)
  check('yesterday\'s share is unchanged', Number(e3.totals.service_paisa) === 20000, String(e3.totals.service_paisa))
  const order = (await rows(sql`SELECT price_paisa, share_bp FROM service_orders WHERE service_id=${F.xray.id}`))[0]
  check('the order kept the old price', Number(order.price_paisa) === 100000)
  check('and the old share rate', Number(order.share_bp) === 2000)

  console.log('\n[11] A per-doctor share beats the service default')
  await db.insert(s.doctorServiceShares).values({
    doctorId: F.doctorId, serviceId: F.cbc.id, shareBp: 3000
  })
  await saveConsultation({
    visitId: v2.id, doctorId: F.doctorId, diagnosis: 'Chest infection',
    items: [], services: [{ serviceId: F.cbc.id }]
  })
  const cbcOrder = (await rows(sql`
    SELECT share_bp, share_paisa FROM service_orders WHERE visit_id=${v2.id}`))[0]
  check('override applied instead of the 0% default', Number(cbcOrder.share_bp) === 3000, String(cbcOrder.share_bp))
  check('Rs 150 earned on a Rs 500 test', Number(cbcOrder.share_paisa) === 15000, String(cbcOrder.share_paisa))

  console.log('\n[12] The pharmacy can find the prescription')
  const pending = await pendingPrescriptions()
  check('shows up in the pharmacy queue', pending.some((r: any) => r.visit_id === v1.id))
  check('searchable by MRN', (await pendingPrescriptions(p1.mrn)).length > 0)
  check('searchable by patient name', (await pendingPrescriptions('Asif')).length > 0)

  console.log('\n[13] Patient history')
  const hist = await patientHistory(p1.id)
  check('the visit is on record', hist.length === 1)
  check('with its diagnosis', hist[0].diagnosis?.includes('corrected'))
  check('and a medicine count', hist[0].medicine_count === 1, String(hist[0].medicine_count))

  console.log('\n[14] Login and roles')
  const sess = await login('dr.yasir', '1234')
  check('doctor signs in', sess.user.role === 'doctor')
  check('their doctorId is attached so the queue can be filtered',
    sess.user.doctorId === F.doctorId, String(sess.user.doctorId))
  check('session resolves', (await sessionFor(sess.token))?.username === 'dr.yasir')
  let bad = false
  try { await login('dr.yasir', 'wrong') } catch { bad = true }
  check('wrong password refused', bad)
  check('admin has no doctorId', (await login('admin', 'longenough1')).user.doctorId === null)

  console.log(`\n${'='.repeat(48)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(48)}`)
  await pool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1) })
