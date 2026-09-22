import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { documentNo, dateSegment } from './numbering'
import * as s from '../db/schema'
import { createFirstAdmin, createStaff, needsSetup } from './auth'
import { registerPatient, createVisit } from './patients'
import { saveConsultation, upsertService } from './clinical'
import { createChitsForVisit, payChit, completeChit } from './chits'

/**
 * Demo data, generous enough that every screen has something to show.
 *
 * A real install starts empty and asks for an admin on first run. This exists
 * so the system can be walked through before a single real patient is entered,
 * and so a demo does not consist of empty tables.
 */

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
const between = (lo: number, hi: number) => Math.floor(Math.random() * (hi - lo + 1)) + lo

const FIRST_M = ['Asif', 'Bilal', 'Imran', 'Kamran', 'Rizwan', 'Usman', 'Tariq', 'Adnan',
  'Faisal', 'Naveed', 'Waqas', 'Zahid', 'Shahid', 'Junaid', 'Salman']
const FIRST_F = ['Nadia', 'Sana', 'Ayesha', 'Hina', 'Fatima', 'Maryam', 'Saima', 'Rabia',
  'Zainab', 'Amna', 'Kiran', 'Nasreen', 'Shazia', 'Uzma']
const LAST = ['Mahmood', 'Khan', 'Ahmed', 'Tariq', 'Shah', 'Siddiqui', 'Ali', 'Butt',
  'Aslam', 'Noor', 'Ghani', 'Zia', 'Javed', 'Rashid', 'Malik', 'Chaudhry', 'Bhatti']

const COMPLAINTS = ['Fever for three days', 'Cough and sore throat', 'Stomach pain',
  'Headache since morning', 'Lower back pain', 'Skin rash on arms', 'Follow-up visit',
  'Chest tightness', 'Joint pain in knees', 'Vomiting since last night', 'Dizziness',
  'Burning while passing urine', 'Ear pain', 'Child not eating']

const DIAGNOSES = ['Viral fever', 'Upper respiratory infection', 'Acute gastritis', 'Migraine',
  'Lumbar strain', 'Allergic dermatitis', 'Hypertension, controlled', 'Type 2 diabetes, review',
  'Urinary tract infection', 'Otitis media', 'Acute bronchitis', 'Anaemia, under investigation']

const ADVICE = ['Plenty of fluids and rest. Return if the fever does not settle in three days.',
  'Take the full course even if you feel better.', 'Avoid spicy food for two weeks.',
  'Come back with the report.', 'Light exercise, avoid lifting heavy weight.']

export type SeedResult = {
  departments: number; staff: number; services: number
  products: number; patients: number; visits: number; earningsPaisa: number
}

export async function loadDemoData(
  opts: { reset?: boolean; days?: number; futureDays?: number } = {}
): Promise<SeedResult> {
  const days = opts.days ?? 45
  /**
   * Demo data also runs forward, not only back.
   *
   * Backdated-only data goes stale the moment you stop looking at it: come
   * back next week and "today" is empty again, and every screen that filters
   * to today looks broken. Booking visits ahead keeps the queue, the charts
   * and the chit flow populated for months without reloading.
   */
  const futureDays = opts.futureDays ?? 60

  if (opts.reset) {
    // Staff and departments go too: a demo reset should leave a clean slate,
    // and the admin account is recreated below so nobody is locked out.
    //
    // Services are deliberately NOT on this list. The common lab tests and
    // x-rays ship with the software along with their reference ranges, and a
    // TRUNCATE ... CASCADE here took them and every range with them on each
    // reseed. The demo prices them by name instead of recreating them.
    await db.execute(sql`
      TRUNCATE doctor_earnings, service_orders, prescription_items, prescriptions,
               visits, patients, doctor_service_shares, doctors, staff,
               departments, sale_items, sales, stock_ledger, purchase_items, purchases,
               batches, products, suppliers, counters RESTART IDENTITY CASCADE`)
  }

  /* ------------------------------------------------------------ people */
  const depts = await db.insert(s.departments).values([
    { name: 'General Medicine', code: 'GEN' },
    { name: 'Paediatrics', code: 'PAED' },
    { name: 'Orthopaedics', code: 'ORTHO' },
    { name: 'Gynaecology', code: 'GYN' },
    { name: 'ENT', code: 'ENT' }
  ]).returning()

  if (await needsSetup()) {
    await createFirstAdmin({ username: 'admin', displayName: 'Administrator', password: 'admin-demo-1' })
  }
  // The cash window: registration, fees, chit payments.
  await createStaff({ username: 'main-counter', displayName: 'Sana Tariq', password: '1234', role: 'main_counter' })
  await createStaff({ username: 'main-counter2', displayName: 'Hina Butt', password: '1234', role: 'main_counter' })
  // The OPD desk outside the doctors' rooms: queue and vitals, no money.
  await createStaff({ username: 'opd', displayName: 'Nadia Aslam', password: '1234', role: 'receptionist' })
  await createStaff({ username: 'opd2', displayName: 'Rabia Noor', password: '1234', role: 'receptionist' })
  // The emergency desk: admits arrivals, records bedside medicines, no cash.
  await createStaff({ username: 'emergency', displayName: 'Bilal Raza', password: '1234', role: 'ipd_counter' })
  // The store: consumables issued to departments, never sold.
  await createStaff({ username: 'stores', displayName: 'Tariq Mehmood', password: '1234', role: 'store_keeper' })
  // The laboratory: samples, results, reports. Handles no money.
  await createStaff({ username: 'lab', displayName: 'Farhan Javed', password: '1234', role: 'lab_tech' })
  // The accounts desk: reads every report, changes nothing.
  await createStaff({ username: 'reports', displayName: 'Nadia Saleem', password: '1234', role: 'reports' })
  // Radiology keeps its own list: an x-ray room and a blood lab share nothing
  // but the shape of the workflow.
  await createStaff({ username: 'xray', displayName: 'Waseem Akhtar', password: '1234', role: 'radiology' })
  // The pharmacy office: reports, ledgers and who may do what at the counter.
  await createStaff({ username: 'pharmacy-office', displayName: 'Shaafi Ahmed', password: '1234', role: 'pharmacy_admin' })
  await createStaff({ username: 'pharmacy', displayName: 'Bilal Ahmed', password: '1234', role: 'pharmacist' })

  const DOCS = [
    { u: 'dr.yasir', n: 'Dr Yasir Habib', spec: 'General Physician', q: 'MBBS, FCPS', d: 0, room: '3', fee: 100000, keep: 6000, svc: 1000 },
    { u: 'dr.sana', n: 'Dr Sana Iqbal', spec: 'Paediatrician', q: 'MBBS, DCH', d: 1, room: '7', fee: 120000, keep: 7000, svc: 1500 },
    { u: 'dr.imran', n: 'Dr Imran Shah', spec: 'Orthopaedic Surgeon', q: 'MBBS, MS Ortho', d: 2, room: '11', fee: 150000, keep: 5000, svc: 2000 },
    { u: 'dr.ayesha', n: 'Dr Ayesha Noor', spec: 'Gynaecologist', q: 'MBBS, FCPS', d: 3, room: '5', fee: 130000, keep: 6500, svc: 1800 },
    { u: 'dr.kamran', n: 'Dr Kamran Ali', spec: 'ENT Surgeon', q: 'MBBS, FCPS', d: 4, room: '9', fee: 110000, keep: 5500, svc: 1200 }
  ]
  for (const d of DOCS) {
    await createStaff({
      username: d.u, displayName: d.n, password: '1234', role: 'doctor',
      departmentId: depts[d.d].id,
      doctor: {
        specialisation: d.spec, qualification: d.q, room: d.room,
        consultationFeePaisa: d.fee, consultationShareBp: d.keep, defaultServiceShareBp: d.svc
      }
    })
  }
  const doctorIds = ((await db.execute<any>(sql`SELECT id FROM doctors ORDER BY id`)).rows as any[])
    .map((r) => Number(r.id))

  /* ---------------------------------------------------------- services */
  const SERVICES = [
    ['CBC', 'lab', 50000, 1000], ['LFT', 'lab', 120000, 1000], ['RFT', 'lab', 110000, 1000],
    ['Blood Sugar (Fasting)', 'lab', 30000, 500], ['Blood Sugar (Random)', 'lab', 25000, 500],
    ['Urine R/E', 'lab', 40000, 500], ['Lipid Profile', 'lab', 150000, 1200],
    ['Thyroid Profile', 'lab', 200000, 1200], ['HbA1c', 'lab', 180000, 1000],
    ['Dengue NS1', 'lab', 160000, 1000], ['Typhidot', 'lab', 90000, 800],
    ['X-Ray Chest PA', 'radiology', 100000, 2000], ['X-Ray Knee', 'radiology', 90000, 2000],
    ['X-Ray Lumbar Spine', 'radiology', 120000, 2000], ['Ultrasound Abdomen', 'radiology', 180000, 2500],
    ['Ultrasound Pelvis', 'radiology', 180000, 2500], ['ECG', 'procedure', 60000, 1500],
    ['Nebulisation', 'procedure', 40000, 1000], ['Dressing', 'procedure', 35000, 1000],
    ['Injection (IM)', 'procedure', 20000, 500]
  ] as const
  /*
   * Price the tests that ship with the software, rather than creating a
   * second CBC beside the first.
   *
   * The common lab tests and x-rays already exist on every install, unpriced.
   * The demo gives them demo prices by name; only the procedures, which do not
   * ship, are created here.
   */
  for (const [name, cat, price, share] of SERVICES) {
    const existing = ((await db.execute<any>(sql`
      SELECT id FROM services WHERE lower(name) = lower(${name}) LIMIT 1`)).rows as any[])[0]
    await upsertService({
      id: existing?.id, name, category: cat as any, pricePaisa: price, defaultShareBp: share
    })
  }
  // Only what the demo priced. The rest of the shipped catalogue stays
  // unpriced, and ordering it is refused — which is exactly what a real
  // hospital would see before setting its prices.
  const serviceIds = ((await db.execute<any>(sql`
    SELECT id FROM services WHERE price_paisa > 0 AND is_active ORDER BY id`)).rows as any[])
    .map((r) => Number(r.id))

  /* ---------------------------------------------------------- pharmacy */
  const [supplier] = await db.insert(s.suppliers).values({
    name: 'Muslim Distributors, Gujrat', phone: '053-3512340', address: 'GT Road, Gujrat'
  }).returning()

  const MEDS = [
    ['Panadol 500mg', 'Paracetamol', 'GSK Pakistan', 10, 3800, 5000],
    ['Panadol Extra', 'Paracetamol + Caffeine', 'GSK Pakistan', 10, 4800, 6500],
    ['Augmentin 625mg', 'Amoxicillin + Clavulanate', 'GSK Pakistan', 6, 29000, 38000],
    ['Amoxil 500mg', 'Amoxicillin', 'GSK Pakistan', 10, 13500, 17500],
    ['Brufen 400mg', 'Ibuprofen', 'Abbott', 10, 7200, 9500],
    ['Ponstan Forte', 'Mefenamic Acid', 'Pfizer', 10, 11000, 14500],
    ['Nexum 40mg', 'Esomeprazole', 'Getz Pharma', 14, 17500, 23000],
    ['Motilium 10mg', 'Domperidone', 'Searle', 10, 6800, 9000],
    ['Flagyl 400mg', 'Metronidazole', 'Sanofi', 10, 6000, 8000],
    ['Ciproxin 500mg', 'Ciprofloxacin', 'Bayer', 10, 21000, 27500],
    ['Azomax 500mg', 'Azithromycin', 'Getz Pharma', 6, 18000, 24000],
    ['Zyrtec 10mg', 'Cetirizine', 'Getz Pharma', 10, 4800, 6500],
    ['Ventolin Inhaler', 'Salbutamol', 'GSK Pakistan', 1, 38000, 49500],
    ['Calpol Syrup 120ml', 'Paracetamol', 'GSK Pakistan', 1, 9200, 12000],
    ['ORS Sachet', 'Oral Rehydration Salts', 'Searle', 1, 1200, 1800],
    ['Glucophage 500mg', 'Metformin', 'Merck', 20, 5200, 7000],
    ['Tenormin 50mg', 'Atenolol', 'AstraZeneca', 14, 5800, 7800],
    ['Norvasc 5mg', 'Amlodipine', 'Pfizer', 14, 9800, 13000],
    ['Surbex-Z', 'Multivitamin + Zinc', 'Abbott', 10, 19200, 25000],
    ['Betnovate-C Cream', 'Betamethasone + Clioquinol', 'GSK Pakistan', 1, 8800, 11800]
  ] as const

  for (const [name, generic, mfr, pack, cost, price] of MEDS) {
    const [p] = await db.insert(s.products).values({
      name, genericName: generic, manufacturer: mfr, packSize: pack,
      unitLabel: pack > 1 ? 'strip' : 'bottle',
      subUnitLabel: pack > 1 ? 'tablet' : null,
      allowLoose: pack > 1, reorderLevel: pack * between(5, 15)
    }).returning()

    // A couple of batches each so expiry and FEFO have something to work with.
    for (let b = 0; b < between(1, 2); b++) {
      await db.insert(s.batches).values({
        productId: p.id,
        batchNo: `${name.slice(0, 2).toUpperCase()}-${between(1000, 9999)}`,
        expiryDate: new Date(Date.now() + between(b === 0 ? 40 : 300, b === 0 ? 200 : 700) * 86400000)
          .toISOString().slice(0, 10),
        costPaisa: cost, pricePaisa: price,
        qtyOnHand: pack * between(15, 60), supplierId: supplier.id
      })
    }
  }
  const products = (await db.execute<any>(sql`SELECT id, name FROM products`)).rows as any[]

  /* ---------------------------------------------------------- patients */
  let visitCount = 0
  for (let offset = -days; offset <= futureDays; offset++) {
    const daysAgo = -offset
    const future = offset > 0
    const when = new Date()
    when.setDate(when.getDate() + offset)
    // Fridays are quieter, so the charts have a shape rather than a flat line.
    // Days still to come hold a lighter, booked-ahead load rather than a full
    // day's takings, since nothing has actually happened on them yet.
    const busy = future
      ? between(2, 6)
      : when.getDay() === 5 ? between(4, 9) : between(8, 18)

    for (let i = 0; i < busy; i++) {
      const female = Math.random() < 0.5
      const patient = await registerPatient({
        name: `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`,
        fatherName: `${pick(FIRST_M)} ${pick(LAST)}`,
        phone: `03${between(0, 4)}${between(10, 99)}-${between(1000000, 9999999)}`,
        gender: female ? 'female' : 'male',
        ageYears: between(1, 82),
        allergies: Math.random() < 0.08 ? pick(['Penicillin', 'Sulpha drugs', 'Aspirin']) : null
      })
      // Backdate the registration too, or every patient looks new today.
      await db.execute(sql`
        UPDATE patients SET created_at = ${when.toISOString()}::timestamptz WHERE id = ${patient.id}`)

      const doctorId = pick(doctorIds)
      const visit = await createVisit({
        patientId: patient.id, doctorId, complaint: pick(COMPLAINTS), feePaid: Math.random() < 0.95
      })
      const at = new Date(when)
      at.setHours(between(9, 20), between(0, 59), 0, 0)
      await db.execute(sql`
        UPDATE visits SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${visit.id}`)

      // Today's last few stay in the queue so the doctor and reception screens
      // have live patients waiting rather than an empty list.
      // A future visit is a booking: registered and queued, not yet consulted.
      // Today keeps a few waiting so the doctor and reception screens are live.
      /**
       * Today's tail is left mid-flow across the new stages, so every screen
       * has something live in it: someone still unpaid at the window, someone
       * paid and waiting for the OPD desk, someone sent in and sitting outside
       * the doctor's door.
       */
      const leaveWaiting = future || (daysAgo === 0 && i >= busy - 5)
      if (leaveWaiting) {
        if (!future) {
          const stage = i % 3
          if (stage === 0) {
            await db.execute(sql`UPDATE visits SET status='registered', fee_paid=false WHERE id=${visit.id}`)
          } else if (stage === 1) {
            await db.execute(sql`UPDATE visits SET status='waiting', fee_paid=true WHERE id=${visit.id}`)
          } else {
            await db.execute(sql`
              UPDATE visits SET status='ready', fee_paid=true,
                bp_systolic=${between(110,150)}, bp_diastolic=${between(70,95)},
                pulse_bpm=${between(64,98)}, vitals_by='Nadia Aslam', vitals_at=now(),
                sent_in_at=now(), sent_in_by='Nadia Aslam'
              WHERE id=${visit.id}`)
          }
        }
        visitCount++
        continue
      }

      if (Math.random() < 0.9) {
        const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, between(1, 4))
        await saveConsultation({
          visitId: visit.id, doctorId,
          diagnosis: pick(DIAGNOSES), advice: pick(ADVICE),
          items: chosen.map((p) => ({
            productId: Number(p.id), drugName: p.name,
            dose: pick(['1 tablet', '2 tablets', '5ml', '10ml', '1 puff']),
            frequency: pick(['OD', 'BD', 'TDS', 'QID', 'SOS']),
            durationDays: between(3, 10), qtyPrescribed: between(1, 3)
          })),
          services: Math.random() < 0.5
            ? Array.from({ length: between(1, 2) }, () => ({ serviceId: pick(serviceIds) }))
              .filter((v, idx, arr) => arr.findIndex((x) => x.serviceId === v.serviceId) === idx)
            : []
        })
        // Earnings and orders carry now(); move them to when the visit happened
        // or every chart shows one enormous spike today.
        await db.execute(sql`
          UPDATE doctor_earnings SET earned_at = ${at.toISOString()}::timestamptz
          WHERE visit_id = ${visit.id}`)
        await db.execute(sql`
          UPDATE service_orders SET ordered_at = ${at.toISOString()}::timestamptz
          WHERE visit_id = ${visit.id}`)

        // Every consultation that happened was paid for at the window, so it
        // has an invoice behind it — that is what the drawer reconciles to.
        await db.execute(sql`
          INSERT INTO counter_bills
            (bill_no, kind, visit_id, patient_id, subtotal_paisa, total_paisa,
             tendered_paisa, change_paisa, pay_method, cashier_name, created_at)
          SELECT ${await documentNo(db, { prefix: 'INV', letter: 'C', when: at })}, 'consultation', v.id, v.patient_id,
                 v.consultation_fee_paisa, v.consultation_fee_paisa,
                 v.consultation_fee_paisa, 0, 'cash', 'Sana Tariq', ${at.toISOString()}::timestamptz
          FROM visits v WHERE v.id = ${visit.id}
          ON CONFLICT (bill_no) DO NOTHING`)

        // Roughly two in three get vitals taken at the OPD counter; the rest
        // are waved straight through, which is what actually happens.
        if (Math.random() < 0.65) {
          await db.execute(sql`
            UPDATE visits SET
              bp_systolic = ${between(105, 155)}, bp_diastolic = ${between(65, 95)},
              pulse_bpm = ${between(62, 104)},
              temperature_f = ${(96.8 + Math.random() * 5).toFixed(1)},
              weight_kg = ${(45 + Math.random() * 45).toFixed(1)},
              sugar_mg_dl = ${Math.random() < 0.4 ? between(80, 240) : null},
              vitals_by = 'Nadia Aslam', vitals_at = ${at.toISOString()}::timestamptz
            WHERE id = ${visit.id}`)
        }

        /**
         * Chits, at every stage of their life.
         *
         * The payment flow is only testable if the data holds chits that are
         * printed but unpaid, paid but not yet done, and finished — one of
         * each sitting in the queue at any time.
         */
        const ordered = (await db.execute<any>(sql`
          SELECT COUNT(*)::int AS n FROM service_orders WHERE visit_id = ${visit.id}`)).rows[0]
        if (Number(ordered.n) > 0) {
          /**
           * Chits now raise themselves when the consultation is saved, so
           * there is nothing to create here — only to settle. Reading them
           * back rather than creating them is what keeps the demo in step
           * with the real flow.
           */
          await createChitsForVisit(visit.id, 'Sana Tariq').catch(() => [])
          const made = (await db.execute<any>(sql`
            SELECT * FROM chits WHERE visit_id = ${visit.id}`)).rows as any[]
          for (const chit of made) {
            await db.execute(sql`
              UPDATE chits SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${chit.id}`)
            const roll = Math.random()
            // Older visits are mostly settled; recent ones are still moving.
            const settled = daysAgo > 2 ? 0.9 : 0.45
            if (roll < settled) {
              await payChit(chit.id, 'Sana Tariq', pick(['cash', 'easypaisa', 'card'])).catch(() => {})
              await db.execute(sql`
                UPDATE chits SET paid_at = ${at.toISOString()}::timestamptz WHERE id = ${chit.id}`)
              if (Math.random() < 0.75) {
                await completeChit(chit.id, 'Radiology Desk').catch(() => {})
              }
            }
          }
        }
      }
      visitCount++
    }
  }

  const sum = await db.execute<any>(sql`
    SELECT (SELECT count(*)::int FROM departments) d, (SELECT count(*)::int FROM staff) st,
           (SELECT count(*)::int FROM services) sv, (SELECT count(*)::int FROM products) pr,
           (SELECT count(*)::int FROM patients) p, (SELECT count(*)::int FROM visits) v,
           (SELECT COALESCE(SUM(amount_paisa),0)::bigint FROM doctor_earnings) e`)
  const r = (sum.rows as any[])[0]
  /* --------------------------------------------------------- store stock */
  /**
   * Consumables, with a month of issues behind them so the reports and the
   * days-of-cover figures have something to work from rather than showing
   * every item as "no data".
   */
  const SUPPLIES: [string, string, string, number, boolean][] = [
    ['Sterile gauze 10x10cm', 'consumable', 'piece', 400, true],
    ['Cotton roll 500g', 'consumable', 'roll', 20, false],
    ['Surgical gloves 7.5', 'ppe', 'pair', 300, true],
    ['Examination gloves', 'ppe', 'piece', 500, false],
    ['IV cannula 20G', 'consumable', 'piece', 150, true],
    ['IV set', 'consumable', 'piece', 120, true],
    ['Normal saline 500ml', 'consumable', 'bottle', 100, true],
    ['Ringer lactate 500ml', 'consumable', 'bottle', 60, true],
    ['Syringe 5cc', 'consumable', 'piece', 400, true],
    ['Syringe 10cc', 'consumable', 'piece', 250, true],
    ['Surgical mask', 'ppe', 'piece', 600, false],
    ['Suture 3-0 silk', 'consumable', 'piece', 40, true],
    ['Micropore tape', 'consumable', 'roll', 60, false],
    ['Bed sheet', 'linen', 'piece', 40, false],
    ['Disinfectant 5L', 'cleaning', 'bottle', 8, true],
    ['Thermometer', 'instrument', 'piece', 6, false]
  ]

  const deptIds = (await db.execute<any>(sql`SELECT id FROM departments`)).rows as any[]

  for (const [name, category, unit, reorder, expires] of SUPPLIES) {
    const item = (await db.execute<any>(sql`
      INSERT INTO supply_items (name, category, unit_label, reorder_level, tracks_expiry)
      VALUES (${name}, ${category}, ${unit}, ${reorder}, ${expires}) RETURNING *`)).rows[0]

    // Two deliveries, so FEFO has something to choose between.
    for (let d = 0; d < 2; d++) {
      const received = new Date()
      received.setDate(received.getDate() - between(20, 70))
      const expiry = new Date()
      expiry.setDate(expiry.getDate() + between(-20, 500))
      const qty = reorder * between(2, 5)
      const batch = (await db.execute<any>(sql`
        INSERT INTO supply_batches
          (item_id, batch_no, expiry_date, qty_on_hand, cost_paisa, received_at, received_by)
        VALUES (${item.id}, ${'B-' + between(1000, 9999)},
                ${expires ? sql`${expiry.toISOString().slice(0, 10)}::date` : sql`NULL`},
                ${qty}, ${between(500, 25000)}, ${received.toISOString()}::timestamptz,
                'Tariq Mehmood')
        RETURNING *`)).rows[0]
      await db.execute(sql`
        INSERT INTO supply_movements (item_id, batch_id, kind, qty, cost_paisa, moved_by, moved_at)
        VALUES (${item.id}, ${batch.id}, 'receive', ${qty},
                ${qty * Number(batch.cost_paisa)}, 'Tariq Mehmood',
                ${received.toISOString()}::timestamptz)`)
    }

    // A month of issues to departments, drawn down from the batches.
    for (let d = 28; d >= 0; d--) {
      if (Math.random() < 0.45) continue
      const when = new Date()
      when.setDate(when.getDate() - d)
      const take = between(1, Math.max(2, Math.round(reorder / 8)))
      const batch = (await db.execute<any>(sql`
        SELECT * FROM supply_batches WHERE item_id = ${item.id} AND qty_on_hand >= ${take}
        ORDER BY expiry_date NULLS LAST, id LIMIT 1`)).rows[0]
      if (!batch) continue
      const dept = pick(deptIds)
      await db.execute(sql`
        UPDATE supply_batches SET qty_on_hand = qty_on_hand - ${take} WHERE id = ${batch.id}`)
      await db.execute(sql`
        INSERT INTO supply_movements
          (item_id, batch_id, kind, qty, department_id, reason, cost_paisa, moved_by, moved_at)
        VALUES (${item.id}, ${batch.id}, 'issue', ${-take}, ${dept?.id ?? null},
                'Ward restock', ${-take * Number(batch.cost_paisa)}, 'Tariq Mehmood',
                ${when.toISOString()}::timestamptz)`)
    }
  }

  /* -------------------------------------------------------- lab set-up */
  /**
   * Reference ranges and recipes.
   *
   * Ranges are the usual adult values; a real lab tunes them to its own
   * analyser and population, which is exactly why they are editable rather
   * than compiled in. The recipes are what a test actually gets through, so
   * consumption shows up in the store without anyone issuing by hand.
   */
  const PARAMS: Record<string, [string, string | null, number | null, number | null, string | null][]> = {
    'CBC': [
      ['Haemoglobin', 'g/dL', 12, 16, null],
      ['Total Leucocyte Count', '/µL', 4000, 11000, null],
      ['Platelet Count', '/µL', 150000, 450000, null],
      ['Haematocrit', '%', 36, 48, null],
      ['MCV', 'fL', 80, 100, null],
      ['Neutrophils', '%', 40, 75, null],
      ['Lymphocytes', '%', 20, 45, null]
    ],
    'LFT': [
      ['Bilirubin (Total)', 'mg/dL', 0.2, 1.2, null],
      ['Bilirubin (Direct)', 'mg/dL', 0, 0.3, null],
      ['ALT (SGPT)', 'U/L', 7, 56, null],
      ['AST (SGOT)', 'U/L', 10, 40, null],
      ['Alkaline Phosphatase', 'U/L', 44, 147, null],
      ['Albumin', 'g/dL', 3.5, 5.5, null]
    ],
    'RFT': [
      ['Urea', 'mg/dL', 15, 45, null],
      ['Creatinine', 'mg/dL', 0.6, 1.3, null],
      ['Uric Acid', 'mg/dL', 3.5, 7.2, null],
      ['Sodium', 'mmol/L', 135, 145, null],
      ['Potassium', 'mmol/L', 3.5, 5.1, null]
    ],
    'Blood Sugar (Fasting)': [['Glucose (Fasting)', 'mg/dL', 70, 100, null]],
    'Blood Sugar (Random)': [['Glucose (Random)', 'mg/dL', 70, 140, null]],
    'HbA1c': [['HbA1c', '%', 4, 5.6, null]],
    'Lipid Profile': [
      ['Total Cholesterol', 'mg/dL', 0, 200, null],
      ['Triglycerides', 'mg/dL', 0, 150, null],
      ['HDL Cholesterol', 'mg/dL', 40, 60, null],
      ['LDL Cholesterol', 'mg/dL', 0, 100, null]
    ],
    'Thyroid Profile': [
      ['TSH', 'µIU/mL', 0.4, 4.0, null],
      ['Free T4', 'ng/dL', 0.8, 1.8, null],
      ['Free T3', 'pg/mL', 2.3, 4.2, null]
    ],
    'Urine R/E': [
      ['Colour', null, null, null, 'Pale yellow'],
      ['Appearance', null, null, null, 'Clear'],
      ['Protein', null, null, null, 'Nil'],
      ['Glucose', null, null, null, 'Nil'],
      ['Pus Cells', '/HPF', 0, 5, null],
      ['Red Blood Cells', '/HPF', 0, 2, null]
    ],
    'Dengue NS1': [['Dengue NS1 Antigen', null, null, null, 'Negative']],
    'Typhidot': [
      ['Typhidot IgM', null, null, null, 'Negative'],
      ['Typhidot IgG', null, null, null, 'Negative']
    ]
  }

  const svcRows = (await db.execute<any>(sql`SELECT id, name, category FROM services`)).rows as any[]
  const svcByName = new Map(svcRows.map((s2) => [s2.name, s2]))

  for (const [name, rows] of Object.entries(PARAMS)) {
    const svc = svcByName.get(name)
    if (!svc) continue
    // The shipped catalogue already gave the common tests their ranges.
    const has = ((await db.execute<any>(sql`
      SELECT 1 FROM service_parameters WHERE service_id = ${svc.id} LIMIT 1`)).rows as any[]).length
    if (has) continue
    let order = 0
    for (const [pname, unit, low, high, text] of rows) {
      await db.execute(sql`
        INSERT INTO service_parameters
          (service_id, name, unit, ref_low, ref_high, ref_text, display_order)
        VALUES (${svc.id}, ${pname}, ${unit}, ${low}, ${high}, ${text}, ${order++})`)
    }
  }

  const itemRows = (await db.execute<any>(sql`SELECT id, name FROM supply_items`)).rows as any[]
  const itemByName = new Map(itemRows.map((i) => [i.name, i]))
  const RECIPES: Record<string, [string, number][]> = {
    'CBC': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'LFT': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'RFT': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'Lipid Profile': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'Thyroid Profile': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'HbA1c': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'Blood Sugar (Fasting)': [['Syringe 5cc', 1], ['Examination gloves', 1]],
    'Blood Sugar (Random)': [['Syringe 5cc', 1], ['Examination gloves', 1]],
    'Dengue NS1': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'Typhidot': [['Syringe 5cc', 1], ['Examination gloves', 2]],
    'Dressing': [['Sterile gauze 10x10cm', 4], ['Micropore tape', 1], ['Examination gloves', 2]],
    'Injection (IM)': [['Syringe 5cc', 1], ['Examination gloves', 1]],
    'Nebulisation': [['Examination gloves', 1], ['Surgical mask', 1]],
    'ECG': [['Examination gloves', 1]]
  }
  for (const [svcName, items] of Object.entries(RECIPES)) {
    const svc = svcByName.get(svcName)
    if (!svc) continue
    for (const [itemName, qty] of items) {
      const item = itemByName.get(itemName)
      if (!item) continue
      await db.execute(sql`
        INSERT INTO service_consumables (service_id, item_id, qty)
        VALUES (${svc.id}, ${item.id}, ${qty})
        ON CONFLICT (service_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`)
    }
  }

  /* ------------------------------------------------------- lab workload */
  /**
   * Paid tests at every stage, so the lab screen opens with a real day's work
   * on it: some waiting for a sample, some on the bench, some already
   * reported with values that are mostly normal and occasionally not.
   */
  const paidTests = (await db.execute<any>(sql`
    SELECT so.id, so.service_id, so.service_name, so.visit_id, v.patient_id, sv.category
    FROM service_orders so
    JOIN services sv ON sv.id = so.service_id
    JOIN visits v ON v.id = so.visit_id
    -- Radiology too, or the x-ray room opens on an empty screen and every
    -- radiology report reads zero.
    WHERE so.status IN ('paid', 'completed') AND sv.category IN ('lab', 'radiology')
    /*
     * Spread across the whole window, not just the newest ninety.
     *
     * Taking the most recent rows put every lab order inside three days, so
     * the turnaround, by-technician and daily reports all had one bar and
     * nothing to compare. Ordering by the visit date walks the period instead.
     */
    ORDER BY v.created_at LIMIT 400`)).rows as any[]

  let labSeq = 0
  for (const test of paidTests) {
    const stage = labSeq % 4
    labSeq++
    /*
     * Dated from the visit it belongs to.
     *
     * A lab order timestamped a few hours ago on a visit from six weeks back
     * is nonsense on a turnaround report, and it piled every test onto the
     * same two days.
     */
    const visitAt = (await db.execute<any>(sql`
      SELECT created_at FROM visits WHERE id = ${test.visit_id}`)).rows[0]
    const ago = visitAt ? new Date(visitAt.created_at) : new Date()
    ago.setHours(ago.getHours() + between(1, 6))
    const reportNo = await documentNo(db, { prefix: 'LAB', letter: 'L', when: ago })

    if (stage === 0) continue   // still waiting for a sample

    const status = stage === 1 ? 'collected' : stage === 2 ? 'in_progress' : 'resulted'
    const lo = (await db.execute<any>(sql`
      INSERT INTO lab_orders
        (report_no, service_order_id, visit_id, patient_id, status, sample_type,
         collected_at, collected_by, started_at, started_by, created_at)
      VALUES (${reportNo}, ${test.id}, ${test.visit_id}, ${test.patient_id}, ${status},
              ${pick(['Blood (EDTA)', 'Blood (Plain)', 'Urine', 'Serum'])},
              ${ago.toISOString()}::timestamptz, 'Farhan Javed',
              ${stage >= 2 ? sql`${ago.toISOString()}::timestamptz` : sql`NULL`},
              ${stage >= 2 ? 'Farhan Javed' : null},
              ${ago.toISOString()}::timestamptz)
      RETURNING *`)).rows[0]

    if (status !== 'resulted') continue

    const params = (await db.execute<any>(sql`
      SELECT * FROM service_parameters WHERE service_id = ${test.service_id}
      ORDER BY display_order`)).rows as any[]

    let order = 0
    for (const prm of params) {
      let value: string
      let flag: string | null = null
      let refText = prm.ref_text
      if (prm.ref_low != null && prm.ref_high != null) {
        const lo2 = Number(prm.ref_low), hi = Number(prm.ref_high)
        const span = hi - lo2
        // One in six lands outside the range, so the report shows flags.
        const roll = Math.random()
        const n = roll < 0.10 ? lo2 - span * (0.05 + Math.random() * 0.25)
          : roll < 0.18 ? hi + span * (0.05 + Math.random() * 0.35)
          : lo2 + span * (0.15 + Math.random() * 0.7)
        value = span < 10 ? n.toFixed(2) : Math.round(n).toString()
        flag = Number(value) < lo2 ? 'low' : Number(value) > hi ? 'high' : 'normal'
        refText = `${prm.ref_low} – ${prm.ref_high}`
      } else {
        value = prm.ref_text ?? 'Normal'
      }
      await db.execute(sql`
        INSERT INTO lab_values (lab_order_id, name, value, unit, ref_text, flag, display_order)
        VALUES (${lo.id}, ${prm.name}, ${value}, ${prm.unit}, ${refText}, ${flag}, ${order++})`)
    }

    const verified = Math.random() < 0.7
    await db.execute(sql`
      UPDATE lab_orders SET resulted_at = ${ago.toISOString()}::timestamptz,
             resulted_by = 'Farhan Javed',
             verified_at = ${verified ? sql`${ago.toISOString()}::timestamptz` : sql`NULL`},
             verified_by = ${verified ? 'Dr Sana Iqbal' : null},
             supplies_taken_at = now()
      WHERE id = ${lo.id}`)
  }

  /*
   * No counter fix-up here any more.
   *
   * The seeder asks documentNo for its numbers, exactly as the running system
   * does, so the counters are already where they should be. The previous
   * version built the strings itself and then had to remember to push the
   * counter along afterwards — and the day that was forgotten, the first real
   * report of the day collided with a demo one on the unique index.
   */

  return {
    departments: r.d, staff: r.st, services: r.sv, products: r.pr,
    patients: r.p, visits: r.v, earningsPaisa: Number(r.e)
  }
}

export async function hasAnyData(): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM patients`)
  return Number((r.rows as any[])[0].n) > 0
}
