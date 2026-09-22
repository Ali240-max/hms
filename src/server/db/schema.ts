import { sql } from 'drizzle-orm'
import {
  bigint, boolean, date, index, integer, numeric, pgEnum, pgTable, serial, text, timestamp, uniqueIndex
} from 'drizzle-orm/pg-core'

/**
 * One database for the whole hospital.
 *
 * MONEY IS INTEGER PAISA everywhere. Rs 249.50 is 24950. Postgres numeric is
 * exact but node-postgres hands it back as a string, so you either parseFloat
 * it and land back in float arithmetic or carry strings through every
 * calculation. Integers avoid both.
 *
 * PERCENTAGES ARE BASIS POINTS. 20% is 2000. Doctor shares and tax rates both
 * use this, so neither can drift into float rounding.
 */

/* ========================================================== organisation */

/**
 * Roles follow the two physical counters a hospital here actually has.
 *
 * `main_counter` is the cash window: registration, consultation fees, and
 * settling the chits for tests and scans. `receptionist` is the OPD desk
 * outside the doctors' rooms — it holds the queue and records vitals, and
 * touches no money at all. Keeping the old value rather than renaming it
 * avoids rewriting every existing staff row and index.
 */
export const staffRole = pgEnum('staff_role',
  ['admin', 'main_counter', 'receptionist', 'ipd_counter', 'store_keeper', 'lab_tech', 'radiology',
   'doctor', 'pharmacist', 'pharmacy_admin', 'reports'])

export const departments = pgTable(
  'departments',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ codeUq: uniqueIndex('departments_code_uq').on(sql`lower(${t.code})`) })
)

export const staff = pgTable(
  'staff',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /** scrypt$salt$hash. Never plaintext, never reversible. */
    passwordHash: text('password_hash').notNull(),
    role: staffRole('role').notNull(),
    departmentId: integer('department_id').references(() => departments.id),
    phone: text('phone'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // Case-insensitive: "Ahmed" and "ahmed" must not be two accounts, or the
    // author of a prescription becomes ambiguous.
    usernameUq: uniqueIndex('staff_username_uq').on(sql`lower(${t.username})`),
    roleIdx: index('staff_role_idx').on(t.role)
  })
)

/** Doctor-specific detail. One row per staff member whose role is doctor. */
export const doctors = pgTable(
  'doctors',
  {
    id: serial('id').primaryKey(),
    staffId: integer('staff_id').notNull().references(() => staff.id),
    specialisation: text('specialisation'),
    qualification: text('qualification'),
    room: text('room'),
    consultationFeePaisa: bigint('consultation_fee_paisa', { mode: 'number' }).notNull().default(0),
    /** Doctor's cut of their own consultation fee. 10000 = they keep all of it. */
    consultationShareBp: integer('consultation_share_bp').notNull().default(10000),
    /** Fallback cut of any service they order, when no per-service rate is set. */
    defaultServiceShareBp: integer('default_service_share_bp').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true)
  },
  (t) => ({ staffUq: uniqueIndex('doctors_staff_uq').on(t.staffId) })
)

/* ============================================================== services */

export const serviceCategory = pgEnum('service_category', [
  'lab', 'radiology', 'procedure', 'other'
])

/** Anything chargeable that is not a medicine: tests, scans, procedures. */
export const services = pgTable(
  'services',
  {
    id: serial('id').primaryKey(),
    code: text('code'),
    name: text('name').notNull(),
    category: serviceCategory('category').notNull().default('lab'),
    pricePaisa: bigint('price_paisa', { mode: 'number' }).notNull().default(0),
    /** House default share for the ordering doctor. */
    defaultShareBp: integer('default_share_bp').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    nameIdx: index('services_name_idx').on(t.name),
    catIdx: index('services_category_idx').on(t.category)
  })
)

/** Per-doctor override of a service's share. Beats the service default. */
export const doctorServiceShares = pgTable(
  'doctor_service_shares',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id').notNull().references(() => doctors.id, { onDelete: 'cascade' }),
    serviceId: integer('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
    shareBp: integer('share_bp').notNull()
  },
  (t) => ({ uq: uniqueIndex('doctor_service_share_uq').on(t.doctorId, t.serviceId) })
)

/* ============================================================== patients */

export const gender = pgEnum('gender', ['male', 'female', 'other'])

/**
 * The identity problem is where systems like this actually fail, and it is a
 * data problem rather than a code one. The same person returns months later,
 * gives their name slightly differently, has no CNIC on them, and shares a
 * name with dozens of others in the same town.
 *
 * So: a generated MRN is the identifier printed on everything, and phone is
 * the practical search anchor because people remember their own number.
 * Registration warns on likely duplicates rather than silently creating one.
 */
export const patients = pgTable(
  'patients',
  {
    id: serial('id').primaryKey(),
    mrn: text('mrn').notNull(),
    name: text('name').notNull(),
    fatherName: text('father_name'),
    phone: text('phone'),
    gender: gender('gender'),
    /** Stored as a birth year when only an age is known; exact date otherwise. */
    dateOfBirth: date('date_of_birth'),
    ageYears: integer('age_years'),
    cnic: text('cnic'),
    address: text('address'),
    bloodGroup: text('blood_group'),
    allergies: text('allergies'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    mrnUq: uniqueIndex('patients_mrn_uq').on(t.mrn),
    phoneIdx: index('patients_phone_idx').on(t.phone),
    nameIdx: index('patients_name_idx').on(t.name),
    cnicIdx: index('patients_cnic_idx').on(t.cnic)
  })
)

/* ================================================================ visits */

/**
 * The stages a visit actually passes through in this hospital.
 *
 *   registered  created at the main counter, bill not yet completed
 *   waiting     paid, in the queue, waiting for the OPD desk
 *   ready       OPD has taken details and sent them in; the doctor may open it
 *   in_consultation / completed / cancelled
 *
 * `registered` and `ready` exist so that a doctor never opens a patient who
 * has not paid or has not been seen by the OPD desk, and so an unpaid slip at
 * the window does not appear as someone standing in the queue.
 */
export const visitStatus = pgEnum('visit_status', [
  'registered', 'waiting', 'ready', 'in_consultation', 'completed', 'cancelled'
])

export const visits = pgTable(
  'visits',
  {
    id: serial('id').primaryKey(),
    visitNo: text('visit_no').notNull(),
    /** Resets daily. What the receptionist calls out and the patient holds. */
    tokenNo: integer('token_no').notNull(),
    patientId: integer('patient_id').notNull().references(() => patients.id),
    /**
     * Null for a walk-in test bought without a consultation. Everything that
     * pays a doctor joins through this column, so a null keeps those visits
     * out of the earnings tables without a special case.
     */
    doctorId: integer('doctor_id').references(() => doctors.id),
    departmentId: integer('department_id').references(() => departments.id),
    status: visitStatus('status').notNull().default('waiting'),
    /** Snapshot: the fee at the time of the visit, not today's fee. */
    consultationFeePaisa: bigint('consultation_fee_paisa', { mode: 'number' }).notNull().default(0),
    feePaid: boolean('fee_paid').notNull().default(false),
    complaint: text('complaint'),

    /**
     * Taken at the OPD counter before the consultation. On the visit, not the
     * patient: a blood pressure is a reading from one morning, not a property
     * of the person, and the doctor wants the one from today.
     */
    bpSystolic: integer('bp_systolic'),
    bpDiastolic: integer('bp_diastolic'),
    pulseBpm: integer('pulse_bpm'),
    temperatureF: numeric('temperature_f', { precision: 4, scale: 1 }),
    weightKg: numeric('weight_kg', { precision: 5, scale: 1 }),
    sugarMgDl: integer('sugar_mg_dl'),
    vitalsNote: text('vitals_note'),
    vitalsBy: text('vitals_by'),
    vitalsAt: timestamp('vitals_at', { withTimezone: true }),

    /** Set when the OPD desk hands the patient over to the doctor. */
    sentInAt: timestamp('sent_in_at', { withTimezone: true }),
    sentInBy: text('sent_in_by'),

    /**
     * 'opd' or 'emergency'.
     *
     * Emergency inverts the order of events: the patient is treated first and
     * billed afterwards, so these visits skip the payment gate on the queue
     * and appear at the main counter as an amount owed instead.
     */
    visitType: text('visit_type').notNull().default('opd'),
    triage: text('triage'),
    arrivalNote: text('arrival_note'),
    broughtBy: text('brought_by'),
    registeredBy: integer('registered_by').references(() => staff.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    seenAt: timestamp('seen_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true })
  },
  (t) => ({
    visitNoUq: uniqueIndex('visits_visit_no_uq').on(t.visitNo),
    patientIdx: index('visits_patient_idx').on(t.patientId),
    doctorIdx: index('visits_doctor_idx').on(t.doctorId),
    createdIdx: index('visits_created_idx').on(t.createdAt),
    statusIdx: index('visits_status_idx').on(t.status)
  })
)

/* ========================================================= prescriptions */

export const prescriptions = pgTable(
  'prescriptions',
  {
    id: serial('id').primaryKey(),
    visitId: integer('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
    doctorId: integer('doctor_id').notNull().references(() => doctors.id),
    diagnosis: text('diagnosis'),
    advice: text('advice'),
    followUpDate: date('follow_up_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ visitUq: uniqueIndex('prescriptions_visit_uq').on(t.visitId) })
)

export const dispenseStatus = pgEnum('dispense_status', ['pending', 'partial', 'dispensed', 'cancelled'])

/**
 * A prescribed line.
 *
 * productId is nullable ON PURPOSE. A doctor prescribes what is clinically
 * right, not what happens to be on the pharmacy shelf, so free-text entry for
 * anything not in the catalogue has to be possible. Stock is shown as advice
 * while prescribing, never as a restriction.
 *
 * qtyDispensed is tracked separately from qtyPrescribed because patients here
 * routinely buy part of a course. "Prescribed 20, dispensed 10" is a normal
 * outcome, not an error.
 */
export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: serial('id').primaryKey(),
    prescriptionId: integer('prescription_id').notNull()
      .references(() => prescriptions.id, { onDelete: 'cascade' }),
    productId: integer('product_id').references(() => products.id),
    /** Snapshot of what was written, so history survives a catalogue rename. */
    drugName: text('drug_name').notNull(),
    dose: text('dose'),
    frequency: text('frequency'),
    durationDays: integer('duration_days'),
    qtyPrescribed: integer('qty_prescribed').notNull().default(1),
    qtyDispensed: integer('qty_dispensed').notNull().default(0),
    instructions: text('instructions'),
    status: dispenseStatus('status').notNull().default('pending')
  },
  (t) => ({ prescIdx: index('prescription_items_presc_idx').on(t.prescriptionId) })
)

/* ========================================================= service orders */

export const orderStatus = pgEnum('order_status', ['ordered', 'paid', 'completed', 'cancelled'])

/**
 * A test or scan ordered during a consultation.
 *
 * The price and the doctor's share percentage are BOTH snapshotted here.
 * Changing a price or a share next month must not silently rewrite what a
 * doctor already earned.
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    id: serial('id').primaryKey(),
    visitId: integer('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
    serviceId: integer('service_id').notNull().references(() => services.id),
    doctorId: integer('doctor_id').notNull().references(() => doctors.id),
    serviceName: text('service_name').notNull(),
    pricePaisa: bigint('price_paisa', { mode: 'number' }).notNull(),
    shareBp: integer('share_bp').notNull().default(0),
    sharePaisa: bigint('share_paisa', { mode: 'number' }).notNull().default(0),
    status: orderStatus('status').notNull().default('ordered'),
    /** Which chit this line was printed on. Null until reception prints one. */
    chitId: integer('chit_id'),
    note: text('note'),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    visitIdx: index('service_orders_visit_idx').on(t.visitId),
    doctorIdx: index('service_orders_doctor_idx').on(t.doctorId),
    orderedIdx: index('service_orders_ordered_idx').on(t.orderedAt)
  })
)

/* =============================================================== earnings */

export const earningSource = pgEnum('earning_source', ['consultation', 'service'])

/**
 * Append-only ledger of what each doctor has earned.
 *
 * A ledger rather than a computed total: the day-closing figure a doctor is
 * paid against must be reconstructable line by line months later, and must not
 * shift because someone edited a price.
 */
export const doctorEarnings = pgTable(
  'doctor_earnings',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id').notNull().references(() => doctors.id),
    visitId: integer('visit_id').references(() => visits.id, { onDelete: 'cascade' }),
    source: earningSource('source').notNull(),
    refTable: text('ref_table'),
    refId: integer('ref_id'),
    description: text('description').notNull(),
    grossPaisa: bigint('gross_paisa', { mode: 'number' }).notNull(),
    shareBp: integer('share_bp').notNull(),
    amountPaisa: bigint('amount_paisa', { mode: 'number' }).notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    doctorIdx: index('doctor_earnings_doctor_idx').on(t.doctorId),
    earnedIdx: index('doctor_earnings_earned_idx').on(t.earnedAt),
    // One earning per source row. Without this, re-saving a consultation would
    // pay the doctor twice for the same visit.
    refUq: uniqueIndex('doctor_earnings_ref_uq').on(t.source, t.refTable, t.refId)
  })
)

/* ================================================== pharmacy (carried over) */

export const drugSchedule = pgEnum('drug_schedule', ['otc', 'g', 'controlled', 'refrigerated'])
export const movementReason = pgEnum('movement_reason', [
  'purchase', 'sale', 'sale_return', 'purchase_return', 'expiry_writeoff', 'damage', 'stock_count'
])
export const saleStatus = pgEnum('sale_status', ['completed', 'voided', 'returned'])
export const payMethod = pgEnum('pay_method', ['cash', 'card', 'easypaisa', 'jazzcash', 'credit'])

/**
 * A payment chit.
 *
 * This is how a Pakistani hospital actually runs. The doctor orders an x-ray;
 * reception prints a chit; the patient carries it to the cashier and pays; the
 * radiographer will not start until that chit reads paid. The paper is the
 * patient's proof, and the row here is the same fact in a form the x-ray room
 * can check without holding the paper.
 *
 * One chit per department, not one per line: a patient pays once at the lab
 * counter for all their tests, not once per tube of blood.
 */
export const chits = pgTable(
  'chits',
  {
    id: serial('id').primaryKey(),
    chitNo: text('chit_no').notNull(),
    visitId: integer('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
    patientId: integer('patient_id').notNull().references(() => patients.id),
    category: serviceCategory('category').notNull(),
    totalPaisa: bigint('total_paisa', { mode: 'number' }).notNull().default(0),
    status: orderStatus('status').notNull().default('ordered'),

    /** Who printed it, so a reprint query has someone to ask. */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Set by whoever took the money: pharmacy counter or reception. */
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidBy: text('paid_by'),
    payMethod: payMethod('pay_method'),

    /** Set by the department once the procedure has actually been done. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
    note: text('note')
  },
  (t) => ({
    chitNoUq: uniqueIndex('chits_chit_no_uq').on(t.chitNo),
    visitIdx: index('chits_visit_idx').on(t.visitId),
    statusIdx: index('chits_status_idx').on(t.status),
    createdIdx: index('chits_created_idx').on(t.createdAt)
  })
)


export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    barcode: text('barcode'),
    /**
     * Free-text internal or distributor code. Deliberately NOT a composite
     * "smart code" encoding distributor + company + pack into digits: those
     * break the moment a product changes distributor, and the same medicine
     * from two distributors needs two of them. This is a searchable label,
     * never a key. Company and distributor are filtered as real relations.
     */
    productCode: text('product_code'),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    manufacturer: text('manufacturer'),
    form: text('form'), // Tablet, Syrup, Injection, Cream
    strength: text('strength'), // "500mg", "125mg/5ml"
    /**
     * How many sellable sub-units are inside one pack. A strip of Panadol is
     * 10 tablets, so packSize = 10. Bottles and inhalers stay at 1.
     */
    packSize: integer('pack_size').notNull().default(1),
    unitLabel: text('unit_label').notNull().default('unit'), // strip, bottle, vial
    /** What one sub-unit is called: tablet, capsule, ml. */
    subUnitLabel: text('sub_unit_label'),
    /**
     * Whether a pack may be broken open. Strips yes; a sealed syrup bottle or
     * an inhaler no. Blocks selling "4 tablets" of something indivisible.
     */
    allowLoose: boolean('allow_loose').notNull().default(false),
    schedule: drugSchedule('schedule').notNull().default('otc'),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    reorderLevel: integer('reorder_level').notNull().default(0),
    rackLocation: text('rack_location'),

    /**
     * Price per single unit, in paisa. A pack price is this times packSize and
     * is deliberately not stored — two numbers that must agree eventually do
     * not, and then a half strip is charged wrongly.
     */
    purchasePaisa: bigint('purchase_paisa', { mode: 'number' }).notNull().default(0),
    tradePaisa: bigint('trade_paisa', { mode: 'number' }).notNull().default(0),
    retailPaisa: bigint('retail_paisa', { mode: 'number' }).notNull().default(0),
    packLabel: text('pack_label'),
    maxLevel: integer('max_level').notNull().default(0),
    saltId: integer('salt_id'),
    manufacturerId: integer('manufacturer_id'),
    groupId: integer('group_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    barcodeUq: uniqueIndex('products_barcode_uq').on(t.barcode),
    nameIdx: index('products_name_idx').on(t.name),
    genericIdx: index('products_generic_idx').on(t.genericName),
    codeIdx: index('products_code_idx').on(t.productCode)
  })
)

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  address: text('address'),
  ntn: text('ntn'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

/** Stock is held per BATCH, and in base sub-units, never packs. */
export const batches = pgTable(
  'batches',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
    batchNo: text('batch_no').notNull(),
    expiryDate: date('expiry_date').notNull(),
    costPaisa: bigint('cost_paisa', { mode: 'number' }).notNull(),
    pricePaisa: bigint('price_paisa', { mode: 'number' }).notNull(),
    qtyOnHand: integer('qty_on_hand').notNull().default(0),
    supplierId: integer('supplier_id').references(() => suppliers.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    productBatchUq: uniqueIndex('batches_product_batchno_uq').on(t.productId, t.batchNo),
    fefoIdx: index('batches_fefo_idx').on(t.productId, t.expiryDate),
    expiryIdx: index('batches_expiry_idx').on(t.expiryDate)
  })
)

export const sales = pgTable(
  'sales',
  {
    id: serial('id').primaryKey(),
    invoiceNo: text('invoice_no').notNull(),
    invoiceSeq: integer('invoice_seq').notNull().default(0),
    /** Set when the sale settles a prescription rather than a walk-in. */
    visitId: integer('visit_id').references(() => visits.id),
    patientId: integer('patient_id').references(() => patients.id),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull().defaultNow(),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    doctorName: text('doctor_name'),
    subtotalPaisa: bigint('subtotal_paisa', { mode: 'number' }).notNull(),
    discountPaisa: bigint('discount_paisa', { mode: 'number' }).notNull().default(0),
    taxPaisa: bigint('tax_paisa', { mode: 'number' }).notNull().default(0),
    totalPaisa: bigint('total_paisa', { mode: 'number' }).notNull(),
    paidPaisa: bigint('paid_paisa', { mode: 'number' }).notNull().default(0),
    payMethod: payMethod('pay_method').notNull().default('cash'),
    status: saleStatus('status').notNull().default('completed'),
    cashier: text('cashier'),
    cashierStaffId: integer('cashier_staff_id').references(() => staff.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    invoiceUq: uniqueIndex('sales_invoice_uq').on(t.invoiceNo),
    soldAtIdx: index('sales_sold_at_idx').on(t.soldAt),
    seqIdx: index('sales_invoice_seq_idx').on(t.invoiceSeq),
    visitIdx: index('sales_visit_idx').on(t.visitId)
  })
)

export const saleItems = pgTable(
  'sale_items',
  {
    id: serial('id').primaryKey(),
    saleId: integer('sale_id').notNull().references(() => sales.id, { onDelete: 'cascade' }),
    batchId: integer('batch_id').notNull().references(() => batches.id, { onDelete: 'restrict' }),
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    batchNo: text('batch_no').notNull(),
    expiryDate: date('expiry_date').notNull(),
    /** Base sub-units, always. One strip of 10 records 10. */
    qty: integer('qty').notNull(),
    soldAs: text('sold_as').notNull().default('pack'),
    displayQty: integer('display_qty').notNull().default(1),
    unitPricePaisa: bigint('unit_price_paisa', { mode: 'number' }).notNull(),
    unitCostPaisa: bigint('unit_cost_paisa', { mode: 'number' }).notNull(),
    discountPaisa: bigint('discount_paisa', { mode: 'number' }).notNull().default(0),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    lineTaxPaisa: bigint('line_tax_paisa', { mode: 'number' }).notNull().default(0),
    lineTotalPaisa: bigint('line_total_paisa', { mode: 'number' }).notNull()
  },
  (t) => ({
    saleIdx: index('sale_items_sale_idx').on(t.saleId),
    batchIdx: index('sale_items_batch_idx').on(t.batchId)
  })
)

export const stockLedger = pgTable(
  'stock_ledger',
  {
    id: serial('id').primaryKey(),
    batchId: integer('batch_id').notNull().references(() => batches.id, { onDelete: 'restrict' }),
    productId: integer('product_id').notNull(),
    qtyDelta: integer('qty_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: movementReason('reason').notNull(),
    refTable: text('ref_table'),
    refId: integer('ref_id'),
    note: text('note'),
    actor: text('actor'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    batchIdx: index('stock_ledger_batch_idx').on(t.batchId),
    occurredIdx: index('stock_ledger_occurred_idx').on(t.occurredAt)
  })
)

export const purchases = pgTable(
  'purchases',
  {
    id: serial('id').primaryKey(),
    supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
    supplierInvoiceNo: text('supplier_invoice_no').notNull(),
    /**
     * Our own reference for the act of receiving: GRN-260919-G00007.
     *
     * The supplier's invoice number belongs to them — two suppliers reuse the
     * same one and some send none at all — so it cannot identify a delivery
     * on our side.
     */
    grnNo: text('grn_no'),
    invoiceDate: date('invoice_date').notNull(),
    totalPaisa: bigint('total_paisa', { mode: 'number' }).notNull().default(0),
    note: text('note'),
    receivedBy: text('received_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    invoiceUq: uniqueIndex('purchases_supplier_invoice_uq').on(t.supplierId, t.supplierInvoiceNo),
    supplierIdx: index('purchases_supplier_idx').on(t.supplierId)
  })
)

export const purchaseItems = pgTable('purchase_items', {
  id: serial('id').primaryKey(),
  purchaseId: integer('purchase_id').notNull().references(() => purchases.id, { onDelete: 'cascade' }),
  batchId: integer('batch_id').notNull().references(() => batches.id, { onDelete: 'restrict' }),
  qty: integer('qty').notNull(),
  unitCostPaisa: bigint('unit_cost_paisa', { mode: 'number' }).notNull(),
  bonusQty: integer('bonus_qty').notNull().default(0)
})

/* ================================================================ shared */

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/** Gapless sequence numbers. Row-locked on increment inside the transaction. */
export const counters = pgTable('counters', {
  key: text('key').primaryKey(),
  value: integer('value').notNull().default(0)
})

export type Patient = typeof patients.$inferSelect
export type Visit = typeof visits.$inferSelect
export type Staff = typeof staff.$inferSelect
export type Service = typeof services.$inferSelect
export type Chit = typeof chits.$inferSelect
