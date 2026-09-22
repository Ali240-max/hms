import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'

/**
 * Demo data for the rebuilt pharmacy.
 *
 * The salt list, the manufacturer list and the product names are real — taken
 * from a system that ran a hospital pharmacy in Gujrat for twenty years. That
 * matters more than it sounds: invented drug names make a demo feel like a
 * demo, and a pharmacist testing the search wants to type "cetirizine" and
 * find the brands they actually stock.
 *
 * Prices are the real ones too, which is why the margins look plausible
 * rather than uniformly 30%.
 */

/**
 * Only the formula and company lists are taken from the old system. Its
 * product rows are left behind on purpose — see the note further down.
 */
type Ref = { salts: string[]; companies: string[] }

const between = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1))
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

const GROUPS = ['Tablets', 'Capsules', 'Syrups', 'Injections', 'Surgical',
                'Drops', 'Ointments', 'Sachets', 'Inhalers', 'Cosmetics']

/** Which group a product belongs to, read off its name the way a shelf is arranged. */
function groupFor(name: string): string {
  const n = name.toUpperCase()
  if (/\bINJ\b|INJECTION|AMP\b|VIAL/.test(n)) return 'Injections'
  if (/\bSYP\b|SYRUP|SUSP|ELIXIR|\bML\b/.test(n)) return 'Syrups'
  if (/\bCAP\b|CAPS/.test(n)) return 'Capsules'
  if (/DROP|\bEYE\b|\bEAR\b/.test(n)) return 'Drops'
  if (/CREAM|OINT|GEL\b|LOTION/.test(n)) return 'Ointments'
  if (/SACHET|POWDER/.test(n)) return 'Sachets'
  if (/INHALER|ROTACAP|PUFF/.test(n)) return 'Inhalers'
  if (/BD |SYRINGE|CANNULA|GLOVE|GAUZE|COTTON|SET\b/.test(n)) return 'Surgical'
  if (/SOAP|SHAMPOO|LIP |SUNBLOCK/.test(n)) return 'Cosmetics'
  return 'Tablets'
}

/**
 * Point a product at a generic.
 *
 * Tries the brand name first, which works for the minority that carry their
 * salt in the name (Paracetamol Tab, Vancomycin Inj). A brand like Panadol or
 * Augmentin says nothing about its composition, so for the rest the demo
 * assigns one.
 *
 * That assignment is demo scaffolding, not data: it makes the salt search and
 * the brand-substitution screens usable for testing, and a real pharmacy sets
 * the true salt when it adds the medicine.
 */
function saltFor(name: string, salts: string[], fallbackIndex: number): string | null {
  const n = name.toUpperCase()
  for (const s of salts) {
    const key = s.toUpperCase().split(' ')[0]
    if (key.length >= 6 && n.includes(key)) return s
  }
  return salts.length ? salts[fallbackIndex % salts.length] : null
}

export async function loadPharmacyDemo(opts: { days?: number; futureDays?: number } = {}) {
  const days = opts.days ?? 60
  /**
   * The pharmacy also trades into the future.
   *
   * Backdated-only data goes stale the moment you stop looking at it: come
   * back in a month and every "today" screen is empty, every daily report
   * reads zero, and the system looks broken when it is merely out of date.
   * Running forward means a demo installed in September still shows a busy
   * counter in November.
   */
  const futureDays = opts.futureDays ?? 45
  const ref: Ref = JSON.parse(
    readFileSync(join(process.cwd(), 'scripts', 'vfp-reference.json'), 'utf8'))

  /* ------------------------------------------------------------ masters */

  const saltNames = ref.salts.filter((s) => /^[A-Za-z]/.test(s)).slice(0, 1200)
  for (const chunk of chunks(saltNames, 200)) {
    await db.execute(sql`
      INSERT INTO salts (name)
      VALUES ${sql.join(chunk.map((n) => sql`(${n})`), sql`, `)}
      ON CONFLICT (lower(name)) DO NOTHING`)
  }

  const companyNames = ref.companies.filter((s) => /^[A-Za-z0-9]/.test(s)).slice(0, 600)
  for (const chunk of chunks(companyNames, 200)) {
    await db.execute(sql`
      INSERT INTO manufacturers (name)
      VALUES ${sql.join(chunk.map((n) => sql`(${n})`), sql`, `)}
      ON CONFLICT (lower(name)) DO NOTHING`)
  }

  await db.execute(sql`
    INSERT INTO product_groups (name)
    VALUES ${sql.join(GROUPS.map((n) => sql`(${n})`), sql`, `)}
    ON CONFLICT (lower(name)) DO NOTHING`)

  const salts = (await db.execute<any>(sql`SELECT id, name FROM salts`)).rows as any[]
  // Only the companies still offered in the dropdown, so demo medicines point
  // at a properly named company rather than a retired capital-case duplicate.
  const makers = (await db.execute<any>(sql`
    SELECT id, name FROM manufacturers WHERE is_active`)).rows as any[]
  const groups = (await db.execute<any>(sql`SELECT id, name FROM product_groups`)).rows as any[]
  const saltByName = new Map(salts.map((s) => [s.name, s.id]))
  const groupByName = new Map(groups.map((g) => [g.name, g.id]))
  const saltNameList = salts.map((s) => s.name)

  /* ----------------------------------------------------------- products */

  /**
   * The medicines already in the system are used as they are.
   *
   * The old software's catalogue was imported once and then dropped: twenty
   * years of hand-typed names carry four spellings of the same tablet, stray
   * punctuation and pack strings nobody would choose today. Its *formula* list
   * is worth keeping — a generic name is a generic name — but its product rows
   * are not a good starting point for a clean system.
   *
   * So this links the existing catalogue to a formula, a manufacturer and a
   * shelf group, and sets per-unit prices where they are missing.
   */
  /**
   * A properly written catalogue, typed out rather than imported.
   *
   * Name, form, strength, generic and pack are each in their own field and
   * spelled one way. That is the difference from the old system's list, where
   * "TAB." and "TABLET" and "TB" all appear and the strength is buried in the
   * name — fine for a shop that has lived with it, useless as a starting point.
   */
  const CATALOGUE: [string, string, string, string, string, number, number][] = [
    // name, generic, form, strength, pack label, units per pack, retail per unit (Rs)
    ['Panadol', 'Paracetamol', 'Tablet', '500mg', '1X10', 10, 3.5],
    ['Calpol Syrup', 'Paracetamol', 'Syrup', '120mg/5ml', '60ml', 1, 95],
    ['Brufen', 'Ibuprofen', 'Tablet', '400mg', '2X10', 20, 6],
    ['Ponstan', 'Mefenamic Acid', 'Tablet', '500mg', '1X10', 10, 12],
    ['Augmentin', 'Amoxicillin', 'Tablet', '625mg', '1X6', 6, 68],
    ['Amoxil', 'Amoxicillin', 'Capsule', '500mg', '1X10', 10, 22],
    ['Velosef', 'Cephradine', 'Capsule', '500mg', '1X12', 12, 38],
    ['Ciproxin', 'Ciprofloxacin', 'Tablet', '500mg', '1X10', 10, 42],
    ['Flagyl', 'Metronidazole', 'Tablet', '400mg', '2X10', 20, 7],
    ['Azomax', 'Azithromycin', 'Capsule', '250mg', '1X6', 6, 58],
    ['Klaricid', 'Clarithromycin', 'Tablet', '500mg', '1X10', 10, 88],
    ['Risek', 'Omeprazole', 'Capsule', '20mg', '2X7', 14, 18],
    ['Nexum', 'Esomeprazole', 'Capsule', '40mg', '1X14', 14, 32],
    ['Motilium', 'Domperidone', 'Tablet', '10mg', '3X10', 30, 5],
    ['Gravinate', 'Dimenhydrinate', 'Tablet', '50mg', '2X10', 20, 6],
    ['Buscopan', 'Hyoscine', 'Tablet', '10mg', '2X10', 20, 11],
    ['Zyrtec', 'Cetirizine', 'Tablet', '10mg', '1X10', 10, 14],
    ['Avil', 'Pheniramine', 'Tablet', '25mg', '2X10', 20, 4],
    ['Telfast', 'Fexofenadine', 'Tablet', '120mg', '1X10', 10, 26],
    ['Ventolin Inhaler', 'Salbutamol', 'Inhaler', '100mcg', '1', 1, 480],
    ['Ventolin Syrup', 'Salbutamol', 'Syrup', '2mg/5ml', '120ml', 1, 145],
    ['Deriphyllin', 'Etophylline', 'Tablet', '150mg', '2X10', 20, 9],
    ['Glucophage', 'Metformin', 'Tablet', '500mg', '3X10', 30, 5.5],
    ['Diamicron MR', 'Gliclazide', 'Tablet', '60mg', '1X15', 15, 34],
    ['Januvia', 'Sitagliptin', 'Tablet', '50mg', '1X14', 14, 92],
    ['Lantus SoloStar', 'Insulin Glargine', 'Injection', '100IU/ml', '1', 1, 2450],
    ['Tenormin', 'Atenolol', 'Tablet', '50mg', '2X14', 28, 8],
    ['Concor', 'Bisoprolol', 'Tablet', '5mg', '2X10', 20, 21],
    ['Norvasc', 'Amlodipine', 'Tablet', '5mg', '2X10', 20, 13],
    ['Capoten', 'Captopril', 'Tablet', '25mg', '2X10', 20, 9],
    ['Lipitor', 'Atorvastatin', 'Tablet', '20mg', '1X10', 10, 46],
    ['Loprin', 'Aspirin', 'Tablet', '75mg', '3X10', 30, 2.5],
    ['Lasix', 'Furosemide', 'Tablet', '40mg', '1X10', 10, 6],
    ['Aldactone', 'Spironolactone', 'Tablet', '25mg', '2X10', 20, 14],
    ['Warfarin', 'Warfarin', 'Tablet', '5mg', '1X28', 28, 11],
    ['Tegral', 'Carbamazepine', 'Tablet', '200mg', '2X10', 20, 16],
    ['Epival', 'Sodium Valproate', 'Tablet', '500mg', '1X10', 10, 42],
    ['Lexotanil', 'Bromazepam', 'Tablet', '3mg', '2X10', 20, 18],
    ['Tofranil', 'Imipramine', 'Tablet', '25mg', '2X10', 20, 15],
    ['Prozac', 'Fluoxetine', 'Capsule', '20mg', '1X14', 14, 36],
    ['Thyroxine', 'Levothyroxine', 'Tablet', '100mcg', '1X30', 30, 7],
    ['Prednisolone', 'Prednisolone', 'Tablet', '5mg', '2X10', 20, 4],
    ['Decadron', 'Dexamethasone', 'Injection', '4mg/ml', '1X5', 5, 28],
    ['Solu-Medrol', 'Methylprednisolone', 'Injection', '500mg', '1', 1, 690],
    ['Toradol', 'Ketorolac', 'Injection', '30mg/ml', '1X5', 5, 46],
    ['Nalbin', 'Nalbuphine', 'Injection', '10mg/ml', '1X5', 5, 88],
    ['Perfalgan', 'Paracetamol', 'Injection', '1g/100ml', '1', 1, 320],
    ['Rocephin', 'Ceftriaxone', 'Injection', '1g', '1', 1, 385],
    ['Maxipime', 'Cefepime', 'Injection', '1g', '1', 1, 640],
    ['Tazocin', 'Piperacillin', 'Injection', '4.5g', '1', 1, 1180],
    ['Vancocin', 'Vancomycin', 'Injection', '500mg', '1', 1, 1450],
    ['Gentamicin', 'Gentamicin', 'Injection', '80mg/2ml', '1X5', 5, 24],
    ['Dextrose 5%', 'Dextrose', 'Infusion', '500ml', '1', 1, 165],
    ['Normal Saline', 'Sodium Chloride', 'Infusion', '500ml', '1', 1, 148],
    ['Ringer Lactate', 'Compound Sodium Lactate', 'Infusion', '500ml', '1', 1, 172],
    ['Polyfax', 'Polymyxin B', 'Ointment', '20g', '1', 1, 210],
    ['Betnovate', 'Betamethasone', 'Cream', '20g', '1', 1, 185],
    ['Daktarin', 'Miconazole', 'Cream', '30g', '1', 1, 240],
    ['Fucidin', 'Fusidic Acid', 'Cream', '15g', '1', 1, 395],
    ['Tobrex', 'Tobramycin', 'Eye Drops', '5ml', '1', 1, 285],
    ['Optive', 'Carboxymethylcellulose', 'Eye Drops', '10ml', '1', 1, 640],
    ['Otrivin', 'Xylometazoline', 'Nasal Drops', '10ml', '1', 1, 215],
    ['Surbex Z', 'Multivitamin', 'Tablet', '', '3X10', 30, 9],
    ['Calcium Sandoz', 'Calcium Carbonate', 'Tablet', '500mg', '1X10', 10, 18],
    ['Ferrous Sulphate', 'Ferrous Sulphate', 'Tablet', '200mg', '3X10', 30, 3],
    ['Folic Acid', 'Folic Acid', 'Tablet', '5mg', '3X10', 30, 2],
    ['Neurobion', 'Vitamin B Complex', 'Injection', '3ml', '1X3', 3, 125],
    ['Zincat Syrup', 'Zinc Sulphate', 'Syrup', '60ml', '1', 1, 118],
    ['ORS Sachet', 'Oral Rehydration Salts', 'Sachet', '', '1', 1, 22],
    ['Entamizole', 'Diloxanide', 'Suspension', '60ml', '1', 1, 168],
    ['Dettol', 'Chloroxylenol', 'Antiseptic', '250ml', '1', 1, 340],
    ['Pyodine Solution', 'Povidone Iodine', 'Antiseptic', '60ml', '1', 1, 155],
    ['Disprin', 'Aspirin', 'Tablet', '300mg', '1X10', 10, 3],
    ['Strepsils', 'Amylmetacresol', 'Lozenge', '', '1X8', 8, 9],
    ['Actifed Syrup', 'Triprolidine', 'Syrup', '60ml', '1', 1, 165],
    ['Hydryllin', 'Diphenhydramine', 'Syrup', '120ml', '1', 1, 142],
    ['Cough Syrup', 'Dextromethorphan', 'Syrup', '120ml', '1', 1, 132],
    ['Arinac Forte', 'Ibuprofen', 'Tablet', '400mg', '2X10', 20, 11],
    ['Sinarest', 'Chlorpheniramine', 'Tablet', '', '2X10', 20, 7],
    ['Loprin 150', 'Aspirin', 'Tablet', '150mg', '3X10', 30, 3],
    ['Insulin Mixtard', 'Insulin Human', 'Injection', '100IU/ml', '1', 1, 1180],
    ['Heparin', 'Heparin Sodium', 'Injection', '5000IU', '1', 1, 420],
    ['Clexane', 'Enoxaparin', 'Injection', '40mg', '1X2', 2, 1650],
    ['Tranexamic Acid', 'Tranexamic Acid', 'Injection', '500mg', '1X5', 5, 68],
    ['Oxytocin', 'Oxytocin', 'Injection', '5IU', '1X5', 5, 42],
    ['Methergin', 'Methylergometrine', 'Injection', '0.2mg', '1X5', 5, 55],
    ['Duphaston', 'Dydrogesterone', 'Tablet', '10mg', '1X20', 20, 96],
    ['Folic + Iron', 'Ferrous Fumarate', 'Tablet', '', '3X10', 30, 5]
  ]

  for (const [name, generic, form, strength, packLabel, perPack, retail] of CATALOGUE) {
    await db.execute(sql`
      INSERT INTO products
        (name, generic_name, form, strength, pack_label, pack_size,
         unit_label, sub_unit_label, allow_loose, schedule, reorder_level,
         retail_paisa)
      VALUES (${name}, ${generic}, ${form}, ${strength || null}, ${packLabel}, ${perPack},
              ${perPack > 1 ? packLabel.includes('X') ? 'pack' : 'box' : form.toLowerCase()},
              ${perPack > 1 ? form.toLowerCase() : null}, ${perPack > 1},
              'otc', ${between(10, 60)}, ${Math.round(retail * 100)})
      ON CONFLICT DO NOTHING`)
  }

  const existing = (await db.execute<any>(sql`
    SELECT id, name, generic_name, pack_size, retail_paisa FROM products WHERE is_active`))
    .rows as any[]

  const productIds: number[] = []
  let saltCursor = 0
  for (const p of existing) {
    // Match on the generic name where the catalogue has one; that is exactly
    // what the formula list is for.
    const saltName = saltFor(p.generic_name || p.name, saltNameList, saltCursor++ * 7)

    // A plausible margin rather than a uniform one, so the profit reports
    // have something to separate.
    const retail = Number(p.retail_paisa) || between(500, 60000)
    const purchase = Math.round(retail / (1 + between(12, 38) / 100))
    const trade = Math.round(purchase * 1.04)

    await db.execute(sql`
      UPDATE products SET
        salt_id = COALESCE(salt_id, ${saltName ? saltByName.get(saltName) ?? null : null}),
        manufacturer_id = COALESCE(manufacturer_id, ${pick(makers).id}),
        group_id = COALESCE(group_id, ${groupByName.get(groupFor(p.name)) ?? null}),
        pack_label = COALESCE(pack_label,
          ${Number(p.pack_size) > 1 ? `1X${p.pack_size}` : '1'}),
        purchase_paisa = CASE WHEN purchase_paisa = 0 THEN ${purchase} ELSE purchase_paisa END,
        trade_paisa    = CASE WHEN trade_paisa = 0 THEN ${trade} ELSE trade_paisa END,
        retail_paisa   = CASE WHEN retail_paisa = 0 THEN ${retail} ELSE retail_paisa END
      WHERE id = ${p.id}`)
    productIds.push(p.id)
  }

  if (productIds.length === 0) {
    throw new Error('No medicines in the catalogue yet. Run npm run seed first.')
  }

  /* ---------------------------------------------------------- suppliers */

  const supplierNames = [
    'Muslim Distributors, Gujrat', 'Allied Medical Supplies', 'Hammas Traders',
    'Chenab Pharma', 'Gujrat Medicine Agency', 'Punjab Drug House',
    'Al-Noor Distributors', 'Shifa Medicos'
  ]
  const supplierIds: number[] = []
  for (const name of supplierNames) {
    const r = (await db.execute<any>(sql`
      INSERT INTO suppliers (name, phone, address)
      VALUES (${name}, ${'053-35' + between(10000, 99999)}, 'GT Road, Gujrat')
      RETURNING id`)).rows[0]
    supplierIds.push(r.id)
  }

  /* ------------------------------------------------------------ parties */

  const parties: [string, string, number][] = [
    ['Counter', 'counter', 0],
    ['General Ward', 'department', 0],
    ['Emergency Room', 'department', 0],
    ['Eye OPD', 'department', 0],
    ['Dialysis Room', 'department', 0],
    ['Laboratory', 'department', 0],
    ['Dr Tariq (staff)', 'credit', 5000000],
    ['Chaudhry Medical Store', 'credit', 20000000],
    ['Rana Ali Hussnain', 'credit', 10000000]
  ]
  const partyIds: Record<string, number> = {}
  for (const [name, kind, limit] of parties) {
    const r = (await db.execute<any>(sql`
      INSERT INTO parties (name, kind, credit_limit_paisa)
      VALUES (${name}, ${kind}, ${limit}) RETURNING id`)).rows[0]
    partyIds[name] = r.id
  }

  /* ---------------------------------------------------------- purchases */

  let batchCount = 0
  /**
   * Deliveries every day or two, big enough that the shelf is never empty.
   * A demo that sells out halfway through the period reports zero revenue for
   * the recent days, which reads as a broken system rather than a quiet week.
   */
  for (let d = days; d >= -futureDays; d -= between(1, 2)) {
    const when = new Date(); when.setDate(when.getDate() - d)
    const supplierId = pick(supplierIds)
    const lines = between(10, 22)
    const seq = await nextCounter(db as any, 'purchase')
    /*
     * Deliveries carry a GRN, the same as a real one.
     *
     * The demo used to insert purchases straight into the table, so every row
     * on a purchase report read "no GRN" — which made the GRN-range filter
     * impossible to try.
     */
    const grnNo = await documentNo(db as any, {
      prefix: 'GRN', letter: 'G', when
    })
    const purchase = (await db.execute<any>(sql`
      INSERT INTO purchases (supplier_id, supplier_invoice_no, grn_no, invoice_date,
                             total_paisa, received_by)
      VALUES (${supplierId}, ${'INV-' + between(1000, 99999)}, ${grnNo},
              ${when.toISOString().slice(0, 10)}::date, 0, 'Demo')
      RETURNING *`)).rows[0]

    let total = 0
    for (let i = 0; i < lines; i++) {
      const productId = pick(productIds)
      const prod = ((await db.execute<any>(sql`
        SELECT * FROM products WHERE id = ${productId}`)).rows as any[])[0]
      const packs = between(20, 90)
      const bonus = Math.random() < 0.25 ? between(1, 3) : 0
      const qty = packs * prod.pack_size
      const bonusQty = bonus * prod.pack_size
      const expiry = new Date()
      expiry.setDate(expiry.getDate() + between(-30, 900))

      const batch = (await db.execute<any>(sql`
        INSERT INTO batches (product_id, batch_no, expiry_date, qty_on_hand,
                             cost_paisa, price_paisa, supplier_id, received_at)
        VALUES (${productId}, ${'B' + between(1000, 99999)},
                ${expiry.toISOString().slice(0, 10)}::date, ${qty + bonusQty},
                ${prod.purchase_paisa}, ${prod.retail_paisa}, ${supplierId},
                ${when.toISOString()}::timestamptz)
        RETURNING *`)).rows[0]
      batchCount++

      const lineTotal = packs * prod.pack_size * Number(prod.purchase_paisa)
      total += lineTotal
      await db.execute(sql`
        INSERT INTO purchase_items (purchase_id, batch_id, qty, bonus_qty, unit_cost_paisa)
        VALUES (${purchase.id}, ${batch.id}, ${packs}, ${bonus}, ${prod.purchase_paisa})`)
    }

    await db.execute(sql`
      UPDATE purchases SET total_paisa = ${total} WHERE id = ${purchase.id}`)
    await db.execute(sql`
      INSERT INTO ledger_entries (party_kind, party_ref, entry_date, description,
                                  credit_paisa, source, source_id, created_by)
      VALUES ('supplier', ${supplierId}, ${when.toISOString().slice(0, 10)}::date,
              ${'Purchase ' + purchase.supplier_invoice_no}, ${total},
              'purchase', ${purchase.id}, 'Demo')`)
  }

  /* -------------------------------------------------------------- sales */

  let invoices = 0, returns = 0, cancelled = 0
  const cashiers = ['Bilal', 'Awais', 'Idrees']
  for (let d = days; d >= -futureDays; d--) {
    const when = new Date(); when.setDate(when.getDate() - d)
    const busy = when.getDay() === 5 ? between(15, 35) : between(40, 90)

    for (let i = 0; i < busy; i++) {
      const at = new Date(when)
      at.setHours(between(9, 21), between(0, 59), between(0, 59))
      const credit = Math.random() < 0.10
      const party = credit
        ? pick(['Dr Tariq (staff)', 'Chaudhry Medical Store', 'Rana Ali Hussnain',
                'General Ward', 'Emergency Room'])
        : 'Counter'

      const n = await nextCounter(db as any, 'sale')
      const lineCount = between(1, 5)
      let subtotal = 0, cost = 0, discount = 0

      const sale = (await db.execute<any>(sql`
        INSERT INTO sales (invoice_no, invoice_seq, sold_at, cashier, pay_method,
                           sale_kind, party_id, customer_name, salesman,
                           subtotal_paisa, discount_paisa, tax_paisa, total_paisa, paid_paisa)
        VALUES (${await documentNo(db, { prefix: 'PH', letter: 'S', when: at })}, ${n}, ${at.toISOString()}::timestamptz,
                ${pick(cashiers)}, ${credit ? 'credit' : pick(['cash','cash','cash','easypaisa','card'])},
                ${credit ? 'credit' : 'counter'}, ${partyIds[party]},
                ${credit ? party : pick(['Walk-in customer','Muhammad Aslam','Fatima Bibi',
                  'Rashid Mehmood','Ayesha Khan','Imran Ali'])},
                ${pick(cashiers)}, 0, 0, 0, 0, 0)
        RETURNING *`)).rows[0]

      for (let j = 0; j < lineCount; j++) {
        const batch = ((await db.execute<any>(sql`
          SELECT b.*, p.name, p.retail_paisa, p.pack_size, p.unit_label
          FROM batches b JOIN products p ON p.id = b.product_id
          WHERE b.qty_on_hand > 0 ORDER BY random() LIMIT 1`)).rows as any[])[0]
        if (!batch) continue
        const qty = Math.min(Number(batch.qty_on_hand), between(1, 6))
        const gross = qty * Number(batch.retail_paisa)
        const off = Math.random() < 0.18 ? Math.round(gross * (between(2, 10) / 100)) : 0
        subtotal += gross; discount += off
        cost += qty * Number(batch.cost_paisa)

        await db.execute(sql`
          UPDATE batches SET qty_on_hand = qty_on_hand - ${qty} WHERE id = ${batch.id}`)
        await db.execute(sql`
          INSERT INTO sale_items (sale_id, product_id, batch_id, product_name, batch_no,
                                  expiry_date, qty, display_qty, sold_as, unit_price_paisa,
                                  unit_cost_paisa, discount_paisa, line_tax_paisa, line_total_paisa)
          VALUES (${sale.id}, ${batch.product_id}, ${batch.id}, ${batch.name}, ${batch.batch_no},
                  ${batch.expiry_date}, ${qty}, ${qty}, 'unit', ${batch.retail_paisa},
                  ${batch.cost_paisa}, ${off}, 0, ${gross - off})`)
      }

      const total = subtotal - discount
      await db.execute(sql`
        UPDATE sales SET subtotal_paisa = ${subtotal}, discount_paisa = ${discount},
               total_paisa = ${total}, paid_paisa = ${credit ? 0 : total}
        WHERE id = ${sale.id}`)
      invoices++

      if (credit) {
        await db.execute(sql`
          INSERT INTO ledger_entries (party_kind, party_ref, entry_date, description,
                                      debit_paisa, source, source_id, created_by)
          VALUES ('customer', ${partyIds[party]}, ${at.toISOString().slice(0, 10)}::date,
                  ${'Invoice ' + sale.invoice_no}, ${total}, 'sale', ${sale.id}, 'Demo')`)
      }

      // A few go wrong, the way they do.
      if (Math.random() < 0.015) {
        await db.execute(sql`
          UPDATE sales SET cancelled_at = ${at.toISOString()}::timestamptz,
                 cancelled_by = 'Bilal', cancel_reason = 'Entered against the wrong customer'
          WHERE id = ${sale.id}`)
        cancelled++
      } else if (Math.random() < 0.02) {
        const rn = await nextCounter(db as any, 'sale_return')
        const item = ((await db.execute<any>(sql`
          SELECT * FROM sale_items WHERE sale_id = ${sale.id} LIMIT 1`)).rows as any[])[0]
        if (item) {
          const ret = (await db.execute<any>(sql`
            INSERT INTO sale_returns (return_no, sale_id, party_id, customer_name,
                                      total_paisa, reason, returned_by, returned_at)
            VALUES (${await documentNo(db, { prefix: 'SR', letter: 'R', when: at })}, ${sale.id}, ${partyIds[party]},
                    ${sale.customer_name}, ${item.line_total_paisa},
                    ${pick(['Wrong medicine', 'Patient did not need it', 'Damaged strip'])},
                    'Bilal', ${at.toISOString()}::timestamptz)
            RETURNING *`)).rows[0]
          await db.execute(sql`
            INSERT INTO sale_return_items (return_id, product_id, batch_id, product_name,
                                           qty, unit_price_paisa, line_total_paisa, restock)
            VALUES (${ret.id}, ${item.product_id}, ${item.batch_id}, ${item.product_name},
                    ${item.qty}, ${item.unit_price_paisa}, ${item.line_total_paisa}, true)`)
          await db.execute(sql`
            UPDATE batches SET qty_on_hand = qty_on_hand + ${item.qty} WHERE id = ${item.batch_id}`)
          returns++
        }
      }
    }
  }

  /* --------------------------------------------------- payments, prices */

  for (const name of ['Dr Tariq (staff)', 'Chaudhry Medical Store', 'Rana Ali Hussnain']) {
    for (let k = 0; k < between(2, 5); k++) {
      const when = new Date(); when.setDate(when.getDate() - between(0, days))
      const amount = between(2000, 40000) * 100
      const n = await nextCounter(db as any, 'receipt_vou')
      const v = (await db.execute<any>(sql`
        INSERT INTO payments (voucher_no, kind, party_kind, party_ref, amount_paisa,
                              method, created_by, created_at)
        VALUES (${await documentNo(db, { prefix: 'RV', letter: 'R', when })}, 'receipt', 'customer',
                ${partyIds[name]}, ${amount}, 'cash', 'Demo',
                ${when.toISOString()}::timestamptz)
        RETURNING *`)).rows[0]
      await db.execute(sql`
        INSERT INTO ledger_entries (party_kind, party_ref, entry_date, description,
                                    credit_paisa, source, source_id, created_by)
        VALUES ('customer', ${partyIds[name]}, ${when.toISOString().slice(0, 10)}::date,
                ${'Received — ' + v.voucher_no}, ${amount}, 'payment', ${v.id}, 'Demo')`)
    }
  }

  for (const supplierId of supplierIds) {
    for (let k = 0; k < between(1, 4); k++) {
      const when = new Date(); when.setDate(when.getDate() - between(0, days))
      const amount = between(20000, 200000) * 100
      const n = await nextCounter(db as any, 'payment_vou')
      const v = (await db.execute<any>(sql`
        INSERT INTO payments (voucher_no, kind, party_kind, party_ref, amount_paisa,
                              method, created_by, created_at)
        VALUES (${await documentNo(db, { prefix: 'PV', letter: 'P', when })}, 'payment', 'supplier',
                ${supplierId}, ${amount}, ${pick(['cash', 'cheque'])}, 'Demo',
                ${when.toISOString()}::timestamptz)
        RETURNING *`)).rows[0]
      await db.execute(sql`
        INSERT INTO ledger_entries (party_kind, party_ref, entry_date, description,
                                    debit_paisa, source, source_id, created_by)
        VALUES ('supplier', ${supplierId}, ${when.toISOString().slice(0, 10)}::date,
                ${'Paid — ' + v.voucher_no}, ${amount}, 'payment', ${v.id}, 'Demo')`)
    }
  }

  // A year of price movements, so the rate-change report has something in it.
  for (let k = 0; k < 220; k++) {
    const productId = pick(productIds)
    const p = ((await db.execute<any>(sql`
      SELECT * FROM products WHERE id = ${productId}`)).rows as any[])[0]
    const factor = 1 + between(3, 18) / 100
    const when = new Date(); when.setDate(when.getDate() - between(0, days * 4))
    await db.execute(sql`
      INSERT INTO price_history (product_id, old_purchase_paisa, new_purchase_paisa,
                                 old_trade_paisa, new_trade_paisa,
                                 old_retail_paisa, new_retail_paisa,
                                 changed_by, changed_at, reason)
      VALUES (${productId}, ${Math.round(Number(p.purchase_paisa) / factor)}, ${p.purchase_paisa},
              ${Math.round(Number(p.trade_paisa) / factor)}, ${p.trade_paisa},
              ${Math.round(Number(p.retail_paisa) / factor)}, ${p.retail_paisa},
              ${pick(cashiers)}, ${when.toISOString()}::timestamptz,
              ${pick(['Company increased the rate', 'New price list', 'Margin correction'])})`)
  }

  return {
    salts: saltNames.length, manufacturers: companyNames.length,
    products: productIds.length, suppliers: supplierIds.length,
    batches: batchCount, invoices, returns, cancelled
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
