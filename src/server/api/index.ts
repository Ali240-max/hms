import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sql, eq } from 'drizzle-orm'
import { z, ZodError } from 'zod'
import { db } from '../db/client'
import * as s from '../db/schema'
import {
  needsSetup, createFirstAdmin, login, logout, sessionFor, sessionForUser, listStaff,
  createStaff, setStaffPassword, archiveStaff, restoreStaff, updateDoctor,
  AuthError, type SessionUser, type Role
} from '../services/auth'
import {
  registerPatient, updatePatient, findPossibleDuplicates, searchPatients,
  getPatient, patientHistory, createVisit, todaysQueue, setVisitStatus,
  markFeePaid, abandonVisit, deletePatient, getVisit, PatientError
} from '../services/patients'
import {
  saveConsultation, getPrescription, pendingPrescriptions, doctorEarnings,
  allDoctorEarnings, listServices, upsertService, ClinicalError
} from '../services/clinical'
import { loadDemoData, hasAnyData } from '../services/demo'
import { pharmacy } from './pharmacy'
import { pharma } from './pharma'
import { reports } from './reports'
import {
  createChitsForVisit, chitForPrint, chitsForVisit, payChit, completeChit,
  listChits, ChitError, CATEGORY_LABEL
} from '../services/chits'
import { getModules, saveModules, getHospitalInfo, saveHospitalInfo, setSetting, getSetting } from '../services/settings'
import { createTicket, checkTicket } from '../services/tickets'
import { wipePreview, wipeTradingData, WipeError } from '../services/wipe'
import { extraBackupDir, setExtraBackupDir, checkExtraDir, backupDir } from '../services/backup'
import {
  labQueue, parametersFor, saveParameters, consumablesFor, saveConsumables,
  collectSample, startTest, saveResults, verifyResult, reportFor, labStats,
  collectVisit, visitWork, LabError, LAB_STATUS
} from '../services/lab'
import { labReportPdf, getLabFooter, DEFAULT_FOOTER } from '../services/lab-pdf'
import {
  listItems, summary as supplySummary, createItem, updateItem, archiveItem,
  receiveSupplies, issueSupplies, wasteSupplies, adjustStock, movements,
  consumptionByDepartment, topConsumed, expiringSoon, SupplyError, CATEGORIES
} from '../services/supplies'
import {
  createEmergencyVisit, emergencyQueue, addEmergencyMedicines, emergencyDues,
  closeEmergencyVisit, EmergencyError, TRIAGE
} from '../services/emergency'
import { runBackup, listBackups } from '../services/backup'
import { earningsByPatient } from '../services/clinical'
import {
  draftForVisit, draftForChit, completeBill, billForPrint, listBills,
  directServiceVisit, BillError
} from '../services/billing'

export const api = new Hono()
api.use('*', cors({ origin: '*' }))

api.onError((err, c) => {
  if (err instanceof LabError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  if (err instanceof SupplyError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  if (err instanceof EmergencyError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  if (err instanceof BillError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  if (err instanceof ChitError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 409
    return c.json({ error: err.message, code: err.code }, status)
  }
  if (err instanceof AuthError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'BAD_CREDENTIALS' ? 401 : 409)
  }
  if (err instanceof PatientError || err instanceof ClinicalError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'NOT_FOUND' ? 404 : 409)
  }
  /**
   * A rejected field is the caller's mistake, not the server's. Returning 500
   * for it makes a typo look like an outage, and buries the one thing the
   * operator needs to see: which field was wrong.
   */
  if (err instanceof ZodError) {
    const first = err.issues[0]
    const field = first?.path.join('.') || 'input'
    return c.json({
      error: `${field}: ${first?.message ?? 'is not valid'}`,
      code: 'INVALID_INPUT',
      field,
      issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
    }, 400)
  }
  console.error('[api]', err)
  return c.json({ error: err.message ?? 'Something went wrong' }, 500)
})

const bearer = (c: any): string | undefined =>
  (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '') || undefined

/* ------------------------------------------------------------------ auth */

api.get('/health', (c) => c.json({ ok: true, at: new Date().toISOString() }))

/**
 * Which modules this hospital is using. Readable without a session because the
 * sign-in screen has to draw its cells before anyone has signed in.
 */
api.get('/modules', async (c) => c.json(await getModules()))
api.get('/auth/status', async (c) =>
  c.json({ needsSetup: await needsSetup(), user: sessionFor(bearer(c)) }))

api.post('/auth/setup', async (c) => {
  const b = z.object({
    username: z.string().min(1), displayName: z.string().default(''), password: z.string()
  }).parse(await c.req.json())
  await createFirstAdmin(b)
  return c.json(await login(b.username, b.password), 201)
})

api.post('/auth/login', async (c) => {
  const b = z.object({ username: z.string(), password: z.string() }).parse(await c.req.json())
  return c.json(await login(b.username, b.password))
})

api.post('/auth/logout', (c) => {
  const t = bearer(c)
  if (t) logout(t)
  return c.json({ ok: true })
})

/**
 * Everything past this point needs a signed-in member of staff.
 *
 * This is a real boundary, not just bookkeeping: the server holds diagnoses
 * and prescriptions, and the browsers reaching it are on ward machines that
 * the data does not live on.
 */
api.use('*', async (c, next) => {
  // The router is mounted under /api, but c.req.url carries the whole path.
  // Everything below compares against the route as written, so strip it once.
  const path = new URL(c.req.url).pathname.replace(/^\/api(?=\/|$)/, '')

  /**
   * Listed one by one rather than matched on a prefix.
   *
   * `/auth/*` looks like a reasonable public prefix and is not: /auth/me and
   * /auth/logout both need a session, and letting them through left
   * c.get('user') undefined on the one route whose entire job is reporting who
   * you are. Only these three can be reached signed out.
   */
  const PUBLIC = ['/health', '/auth/status', '/auth/login', '/auth/setup']

  /**
   * Readable signed out, writable only by an admin.
   *
   * The sign-in screen has to know which modules are in use before anybody
   * has a session, so GET is public. Listing the path outright also exempted
   * PUT, which left the admin check reading a user that was never set — the
   * route crashed instead of refusing. Public is a property of the method,
   * not of the path.
   */
  const PUBLIC_GET = ['/modules']

  if (PUBLIC.includes(path)) return next()
  if (c.req.method === 'GET' && PUBLIC_GET.includes(path)) return next()
  let user = sessionFor(bearer(c))

  /**
   * A ticket stands in for the header on file downloads.
   *
   * The browser's PDF viewer, a print job and a plain download all fetch the
   * URL themselves and cannot send an Authorization header. The ticket is
   * bound to this exact path and to the user who asked for it, so it grants
   * nothing they did not already have, and it expires in a minute.
   */
  if (!user) {
    const ticket = c.req.query('ticket')
    if (ticket) {
      const userId = checkTicket(ticket, path)
      if (userId != null) user = sessionForUser(userId)
    }
  }

  if (!user) return c.json({ error: 'Sign in to continue', code: 'NO_SESSION' }, 401)
  c.set('user' as never, user as never)
  return next()
})

/**
 * Issue a ticket for a file the browser will fetch on its own.
 *
 * The path is checked against a list rather than taken as given: a ticket is
 * a bearer credential in a URL, and URLs end up in history and server logs, so
 * it must only ever open a document.
 */
api.post('/tickets', async (c) => {
  const b = z.object({ path: z.string().min(1) }).parse(await c.req.json())
  if (!/^\/(lab|pharma|reports)\/[\w/-]+\/pdf$/.test(b.path)) {
    return c.json({ error: 'That is not a downloadable document', code: 'NOT_A_FILE' }, 400)
  }
  return c.json({ ticket: createTicket(b.path, me(c).id), path: b.path })
})

const me = (c: any): SessionUser => c.get('user')

/** Roles are checked here, not only hidden in the client. */
const allow = (...roles: Role[]) => async (c: any, next: any) => {
  if (!roles.includes(me(c).role)) {
    return c.json({ error: 'Your role cannot do this', code: 'FORBIDDEN' }, 403)
  }
  return next()
}
const adminOnly = allow('admin')

api.get('/auth/me', (c) => c.json(me(c)))

/* ----------------------------------------------------------- departments */

api.get('/departments', async (c) =>
  c.json((await db.execute<any>(sql`
    SELECT d.*, COUNT(st.id)::int AS staff_count
    FROM departments d LEFT JOIN staff st ON st.department_id = d.id AND st.is_active
    WHERE d.is_active GROUP BY d.id ORDER BY d.name`)).rows))

api.post('/departments', adminOnly, async (c) => {
  const b = z.object({ name: z.string().min(1), code: z.string().min(1) }).parse(await c.req.json())
  const [row] = await db.insert(s.departments).values(b).returning()
  return c.json(row, 201)
})

api.patch('/departments/:id', adminOnly, async (c) => {
  const b = z.object({
    name: z.string().optional(), code: z.string().optional(), isActive: z.boolean().optional()
  }).parse(await c.req.json())
  const [row] = await db.update(s.departments).set(b)
    .where(eq(s.departments.id, Number(c.req.param('id')))).returning()
  return c.json(row)
})

/* ----------------------------------------------------------------- staff */

api.get('/staff', adminOnly, async (c) => c.json(await listStaff()))

api.post('/staff', adminOnly, async (c) => {
  const b = z.object({
    username: z.string().min(1), displayName: z.string().default(''), password: z.string(),
    role: z.enum(['admin', 'main_counter', 'receptionist', 'ipd_counter',
                  'store_keeper', 'lab_tech', 'radiology', 'doctor',
                  'pharmacist', 'pharmacy_admin', 'reports']),
    departmentId: z.number().int().nullable().optional(),
    phone: z.string().nullable().optional(),
    doctor: z.object({
      specialisation: z.string().nullable().optional(),
      qualification: z.string().nullable().optional(),
      room: z.string().nullable().optional(),
      consultationFeePaisa: z.number().int().min(0).default(0),
      consultationShareBp: z.number().int().min(0).max(10000).default(10000),
      defaultServiceShareBp: z.number().int().min(0).max(10000).default(0)
    }).optional()
  }).parse(await c.req.json())
  return c.json(await createStaff(b), 201)
})

api.post('/staff/:id/password', adminOnly, async (c) => {
  const b = z.object({ password: z.string() }).parse(await c.req.json())
  await setStaffPassword(Number(c.req.param('id')), b.password)
  return c.json({ ok: true })
})

api.post('/staff/:id/archive', adminOnly, async (c) => {
  await archiveStaff(Number(c.req.param('id')))
  return c.json({ ok: true })
})

api.post('/staff/:id/restore', adminOnly, async (c) => {
  await restoreStaff(Number(c.req.param('id')))
  return c.json({ ok: true })
})

api.patch('/doctors/:id', adminOnly, async (c) => {
  const b = z.object({
    specialisation: z.string().nullable().optional(),
    qualification: z.string().nullable().optional(),
    room: z.string().nullable().optional(),
    consultationFeePaisa: z.number().int().min(0).optional(),
    consultationShareBp: z.number().int().min(0).max(10000).optional(),
    defaultServiceShareBp: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await updateDoctor(Number(c.req.param('id')), b))
})

/** Who reception can book against. */
api.get('/doctors', async (c) =>
  c.json((await db.execute<any>(sql`
    SELECT d.*, st.display_name, st.username, dept.name AS department_name,
           (SELECT COUNT(*)::int FROM visits v
             WHERE v.doctor_id = d.id AND v.created_at >= date_trunc('day', now())
               AND v.status IN ('waiting','in_consultation')) AS waiting
    FROM doctors d
    JOIN staff st ON st.id = d.staff_id
    LEFT JOIN departments dept ON dept.id = st.department_id
    WHERE d.is_active AND st.is_active
    ORDER BY st.display_name`)).rows))

/* -------------------------------------------------------------- services */

api.get('/services', async (c) => c.json(await listServices(c.req.query('all') === '1')))

api.post('/services', adminOnly, async (c) => {
  const b = z.object({
    id: z.number().int().optional(),
    code: z.string().nullable().optional(),
    name: z.string().min(1),
    category: z.enum(['lab', 'radiology', 'procedure', 'other']),
    pricePaisa: z.number().int().min(0),
    defaultShareBp: z.number().int().min(0).max(10000),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await upsertService(b), b.id ? 200 : 201)
})

api.get('/doctors/:id/shares', adminOnly, async (c) =>
  c.json((await db.execute<any>(sql`
    SELECT sv.id AS service_id, sv.name, sv.category, sv.price_paisa,
           sv.default_share_bp, dss.share_bp AS override_bp
    FROM services sv
    LEFT JOIN doctor_service_shares dss
      ON dss.service_id = sv.id AND dss.doctor_id = ${Number(c.req.param('id'))}
    WHERE sv.is_active ORDER BY sv.category, sv.name`)).rows))

api.post('/doctors/:id/shares', adminOnly, async (c) => {
  const doctorId = Number(c.req.param('id'))
  const b = z.object({
    serviceId: z.number().int(),
    shareBp: z.number().int().min(0).max(10000).nullable()
  }).parse(await c.req.json())

  if (b.shareBp === null) {
    await db.execute(sql`
      DELETE FROM doctor_service_shares
      WHERE doctor_id = ${doctorId} AND service_id = ${b.serviceId}`)
    return c.json({ ok: true, cleared: true })
  }
  await db.execute(sql`
    INSERT INTO doctor_service_shares (doctor_id, service_id, share_bp)
    VALUES (${doctorId}, ${b.serviceId}, ${b.shareBp})
    ON CONFLICT (doctor_id, service_id) DO UPDATE SET share_bp = EXCLUDED.share_bp`)
  return c.json({ ok: true })
})

/* -------------------------------------------------------------- patients */

const patientSchema = z.object({
  name: z.string().min(1),
  fatherName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  cnic: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  bloodGroup: z.string().nullable().optional(),
  allergies: z.string().nullable().optional()
})

api.get('/patients/search', async (c) => c.json(await searchPatients(c.req.query('q') ?? '')))

api.post('/patients/check-duplicates', allow('admin', 'main_counter', 'ipd_counter'), async (c) =>
  c.json(await findPossibleDuplicates(patientSchema.partial({ name: true })
    .parse(await c.req.json()) as any)))

api.post('/patients', allow('admin', 'main_counter', 'ipd_counter'), async (c) => {
  const b = patientSchema.parse(await c.req.json())
  return c.json(await registerPatient(b, me(c).id), 201)
})

api.patch('/patients/:id', allow('admin', 'main_counter', 'receptionist', 'ipd_counter', 'doctor'), async (c) => {
  const b = patientSchema.partial().parse(await c.req.json())
  return c.json(await updatePatient(Number(c.req.param('id')), b))
})

api.get('/patients/:id', async (c) => c.json(await getPatient(Number(c.req.param('id')))))
api.get('/patients/:id/history', async (c) => c.json(await patientHistory(Number(c.req.param('id')))))

/* ---------------------------------------------------------------- visits */

api.get('/visits/queue', async (c) => {
  const u = me(c)
  // A doctor sees their own queue by default; the counters see the whole floor.
  const forDoctor = c.req.query('doctor')
    ? Number(c.req.query('doctor'))
    : u.role === 'doctor' ? (u.doctorId ?? undefined) : undefined

  // Only the window that takes the money sees registrations that have not
  // been paid for yet.
  const includeUnpaid = u.role === 'main_counter' || u.role === 'admin'
  return c.json(await todaysQueue(forDoctor, includeUnpaid))
})

api.post('/visits', allow('admin', 'main_counter'), async (c) => {
  const b = z.object({
    patientId: z.number().int(),
    doctorId: z.number().int(),
    complaint: z.string().nullable().optional(),
    feePaid: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await createVisit({ ...b, registeredBy: me(c).id }), 201)
})

api.get('/visits/:id', async (c) => c.json(await getVisit(Number(c.req.param('id')))))

api.post('/visits/:id/status', async (c) => {
  const b = z.object({
    status: z.enum(['registered', 'waiting', 'ready', 'in_consultation', 'completed', 'cancelled'])
  }).parse(await c.req.json())
  const id = Number(c.req.param('id'))

  /**
   * A doctor may only open a patient the OPD desk has sent in.
   *
   * Enforced here rather than by hiding the button, because the queue is
   * shared: if a doctor could pull anyone forward, they would take a patient
   * the desk is still measuring, and both screens would then disagree about
   * where that person is.
   */
  if (b.status === 'in_consultation' && me(c).role === 'doctor') {
    const current = await getVisit(id)
    if (!current) return c.json({ error: 'Visit not found' }, 404)
    const v = (current as any).visit ?? current
    if (v.status !== 'ready' && v.status !== 'in_consultation') {
      return c.json({
        error: v.status === 'registered'
          ? 'This patient has not paid at the main counter yet'
          : 'The OPD counter has not sent this patient in yet',
        code: 'NOT_SENT_IN'
      }, 409)
    }
  }
  return c.json(await setVisitStatus(id, b.status))
})

api.post('/visits/:id/fee-paid', allow('admin', 'main_counter'), async (c) =>
  c.json(await markFeePaid(Number(c.req.param('id')))))

/** Drop a registration nobody paid for. Refuses once money has changed hands. */
api.delete('/patients/:id', allow('admin', 'main_counter'), async (c) =>
  c.json(await deletePatient(Number(c.req.param('id')))))

api.post('/visits/:id/abandon', allow('admin', 'main_counter'), async (c) => {
  const row = await abandonVisit(Number(c.req.param('id')))
  if (!row) {
    return c.json({
      error: 'This visit has already been paid for, so it cannot be dropped. Cancel it instead.',
      code: 'ALREADY_PAID'
    }, 409)
  }
  return c.json(row)
})

/* --------------------------------------------------------- consultations */

api.get('/visits/:id/prescription', async (c) => {
  const r = await getPrescription(Number(c.req.param('id')))
  if (!r) return c.json({ error: 'No prescription for this visit yet' }, 404)
  return c.json(r)
})

api.post('/visits/:id/consultation', allow('admin', 'doctor'), async (c) => {
  const u = me(c)
  const b = z.object({
    diagnosis: z.string().nullable().optional(),
    advice: z.string().nullable().optional(),
    followUpDate: z.string().nullable().optional(),
    items: z.array(z.object({
      productId: z.number().int().nullable().optional(),
      drugName: z.string().min(1),
      dose: z.string().nullable().optional(),
      frequency: z.string().nullable().optional(),
      durationDays: z.number().int().nullable().optional(),
      qtyPrescribed: z.number().int().min(1),
      instructions: z.string().nullable().optional()
    })).default([]),
    services: z.array(z.object({
      serviceId: z.number().int(),
      note: z.string().nullable().optional()
    })).default([])
  }).parse(await c.req.json())

  const visitId = Number(c.req.param('id'))
  // The prescribing doctor comes from the session, never the request body.
  // A client-supplied doctor id is a signature anyone could forge, and it
  // decides who gets paid.
  let doctorId = u.doctorId
  if (!doctorId) {
    const v = await getVisit(visitId)
    doctorId = Number(v.doctor_id)
  }
  return c.json(await saveConsultation({ ...b, visitId, doctorId: doctorId! }), 201)
})

api.get('/me/earnings/by-patient', allow('doctor'), async (c) => {
  const u = me(c)
  if (!u.doctorId) return c.json({ error: 'Not a doctor account' }, 400)
  return c.json(await earningsByPatient(u.doctorId,
    c.req.query('from') ?? new Date().toISOString().slice(0, 10),
    c.req.query('to') ?? new Date().toISOString().slice(0, 10)))
})

/**
 * The OPD desk sends the patient in.
 *
 * Until this happens the doctor can see the patient in the queue but cannot
 * open them: the desk may still be taking a blood pressure, and two people
 * claiming the same patient is how a queue falls apart.
 */
api.post('/visits/:id/send-in', allow('admin', 'receptionist'), async (c) => {
  const row = await setVisitStatus(Number(c.req.param('id')), 'ready', me(c).displayName)
  if (!row) return c.json({ error: 'Visit not found' }, 404)
  return c.json(row)
})

/* ------------------------------------------------------------------- lab */

/**
 * The laboratory handles no money. Everything here is the working life of a
 * test that has already been ordered and paid for; the gate on starting work
 * is enforced in the service, not by hiding a button.
 */
const labOnly = allow('admin', 'lab_tech', 'radiology')

/**
 * Each department sees its own work.
 *
 * The lab has no business in the x-ray list and the radiographer has no
 * business in forty blood tests. Enforced on the query rather than left to a
 * filter the screen might forget to apply.
 */
function ownCategories(role: string, asked: string): string {
  if (role === 'radiology') return 'radiology'
  if (role === 'lab_tech') return asked === 'radiology' ? 'lab' : asked
  return asked
}

api.get('/lab/queue', async (c) =>
  c.json(await labQueue({
    status: c.req.query('status') ?? 'active',
    q: c.req.query('q') ?? '',
    category: ownCategories(me(c).role, c.req.query('category') ?? 'all'),
    excludeCategory: me(c).role === 'lab_tech' ? 'radiology' : undefined
  })))

api.get('/lab/stats', async (c) => c.json(await labStats(
  me(c).role === 'radiology' ? 'radiology'
    : me(c).role === 'lab_tech' ? 'not-radiology' : 'all')))
api.get('/lab/statuses', (c) => c.json(LAB_STATUS))

api.post('/lab/collect', labOnly, async (c) => {
  const b = z.object({
    serviceOrderId: z.number().int(),
    sampleType: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await collectSample({ ...b, by: me(c).displayName }), 201)
})

/** One draw for every test this patient is waiting on. */
api.post('/lab/collect-visit', labOnly, async (c) => {
  const b = z.object({
    visitId: z.number().int(),
    sampleType: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await collectVisit({
    ...b, category: me(c).role === 'radiology' ? 'radiology' : undefined,
    by: me(c).displayName
  }), 201)
})

api.get('/lab/visits/:id/work', async (c) =>
  c.json(await visitWork(Number(c.req.param('id')))))

api.post('/lab/orders/:id/start', labOnly, async (c) =>
  c.json(await startTest(Number(c.req.param('id')), me(c).displayName)))

api.post('/lab/orders/:id/results', labOnly, async (c) => {
  const b = z.object({
    values: z.array(z.object({
      name: z.string().min(1),
      value: z.string(),
      unit: z.string().nullable().optional(),
      refText: z.string().nullable().optional()
    })).min(1),
    notes: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await saveResults({
    labOrderId: Number(c.req.param('id')), ...b, by: me(c).displayName
  }), 201)
})

api.post('/lab/orders/:id/verify', labOnly, async (c) =>
  c.json(await verifyResult(Number(c.req.param('id')), me(c).displayName)))

api.get('/lab/orders/:id', async (c) => c.json(await reportFor(Number(c.req.param('id')))))

/** The report itself. Streamed as a real PDF: this one leaves the building. */
api.get('/lab/orders/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'))
  const pdf = await labReportPdf({ labOrderId: id })
  const { report } = await reportFor(id)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `inline; filename="${report.report_no}-${String(report.patient_name).replace(/[^\w]+/g, '-')}.pdf"`
    }
  })
})

/** Every finished report on one visit, each on its own page. */
api.get('/lab/visits/:id/pdf', async (c) => {
  const visitId = Number(c.req.param('id'))
  const pdf = await labReportPdf({ visitId })
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      /*
       * Inline unless asked otherwise.
       *
       * A browser with its PDF viewer switched off downloads either way, which
       * is why the screen previews the report as HTML and only asks for this
       * when someone presses Download.
       */
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="lab-visit-${visitId}.pdf"`
    }
  })
})

api.get('/lab/footer', async (c) => c.json(await getLabFooter()))

api.put('/lab/footer', adminOnly, async (c) => {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const k of Object.keys(DEFAULT_FOOTER)) shape[k] = z.string().optional()
  const b = z.object(shape).parse(await c.req.json())
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) await setSetting(`lab.${k}`, String(v))
  }
  return c.json(await getLabFooter())
})

/* ------------------------------------------------ test setup, for admins */

api.get('/services/:id/parameters', async (c) =>
  c.json(await parametersFor(Number(c.req.param('id')))))

api.put('/services/:id/parameters', adminOnly, async (c) => {
  const b = z.object({
    parameters: z.array(z.object({
      name: z.string().min(1),
      unit: z.string().nullable().optional(),
      refLow: z.number().nullable().optional(),
      refHigh: z.number().nullable().optional(),
      refText: z.string().nullable().optional()
    }))
  }).parse(await c.req.json())
  return c.json(await saveParameters(Number(c.req.param('id')), b.parameters))
})

api.get('/services/:id/consumables', async (c) =>
  c.json(await consumablesFor(Number(c.req.param('id')))))

api.put('/services/:id/consumables', adminOnly, async (c) => {
  const b = z.object({
    consumables: z.array(z.object({
      itemId: z.number().int(), qty: z.number().int().min(1)
    }))
  }).parse(await c.req.json())
  return c.json(await saveConsumables(Number(c.req.param('id')), b.consumables))
})

/* ---------------------------------------------------------------- stores */

/**
 * Hospital stores. Read by anyone who needs to know what is on the shelf;
 * changed only by the store keeper and an admin.
 */
const storeOnly = allow('admin', 'store_keeper')

api.get('/supplies/items', async (c) =>
  c.json(await listItems({
    q: c.req.query('q') ?? '', category: c.req.query('category') ?? 'all',
    filter: c.req.query('filter') ?? 'all'
  })))

api.get('/supplies/summary', async (c) => c.json(await supplySummary()))
api.get('/supplies/categories', (c) => c.json(CATEGORIES))

api.post('/supplies/items', storeOnly, async (c) => {
  const b = z.object({
    name: z.string().min(1),
    code: z.string().nullable().optional(),
    category: z.enum(CATEGORIES).default('consumable'),
    unitLabel: z.string().default('piece'),
    packSize: z.number().int().min(1).default(1),
    reorderLevel: z.number().int().min(0).default(0),
    tracksExpiry: z.boolean().default(true),
    storageNote: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await createItem(b), 201)
})

api.patch('/supplies/items/:id', storeOnly, async (c) => {
  const b = z.object({
    name: z.string().min(1).optional(),
    code: z.string().nullable().optional(),
    category: z.enum(CATEGORIES).optional(),
    unitLabel: z.string().optional(),
    packSize: z.number().int().min(1).optional(),
    reorderLevel: z.number().int().min(0).optional(),
    tracksExpiry: z.boolean().optional(),
    storageNote: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await updateItem(Number(c.req.param('id')), b))
})

api.post('/supplies/items/:id/archive', storeOnly, async (c) =>
  c.json(await archiveItem(Number(c.req.param('id')))))

api.post('/supplies/receive', storeOnly, async (c) => {
  const b = z.object({
    supplierId: z.number().int().nullable().optional(),
    invoiceNo: z.string().nullable().optional(),
    lines: z.array(z.object({
      itemId: z.number().int(),
      batchNo: z.string().nullable().optional(),
      expiryDate: z.string().nullable().optional(),
      qty: z.number().int().min(1),
      costPaisa: z.number().int().min(0).default(0)
    })).min(1)
  }).parse(await c.req.json())
  return c.json(await receiveSupplies({ ...b, receivedBy: me(c).displayName }), 201)
})

api.post('/supplies/issue', storeOnly, async (c) => {
  const b = z.object({
    itemId: z.number().int(),
    qty: z.number().int().min(1),
    departmentId: z.number().int().nullable().optional(),
    issuedTo: z.string().nullable().optional(),
    reason: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await issueSupplies({ ...b, by: me(c).displayName }), 201)
})

api.post('/supplies/waste', storeOnly, async (c) => {
  const b = z.object({
    itemId: z.number().int(),
    qty: z.number().int().min(1),
    reason: z.string().min(1)
  }).parse(await c.req.json())
  return c.json(await wasteSupplies({ ...b, by: me(c).displayName }), 201)
})

api.post('/supplies/adjust', storeOnly, async (c) => {
  const b = z.object({
    itemId: z.number().int(),
    countedQty: z.number().int().min(0),
    reason: z.string().min(1)
  }).parse(await c.req.json())
  return c.json(await adjustStock({ ...b, by: me(c).displayName }), 201)
})

api.get('/supplies/movements', async (c) =>
  c.json(await movements({
    itemId: c.req.query('item') ? Number(c.req.query('item')) : undefined,
    departmentId: c.req.query('department') ? Number(c.req.query('department')) : undefined,
    kind: c.req.query('kind') ?? 'all',
    from: c.req.query('from') ?? undefined,
    to: c.req.query('to') ?? undefined
  })))

api.get('/supplies/reports', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30), 1), 365)
  return c.json({
    days,
    byDepartment: await consumptionByDepartment(days),
    topConsumed: await topConsumed(days),
    expiring: await expiringSoon(Number(c.req.query('expiryDays') ?? 90))
  })
})

/* ------------------------------------------------------------- emergency */

/**
 * The emergency desk registers and treats; the money is chased afterwards.
 * The main counter and the pharmacy collect it on their own screens, which is
 * why nothing here takes a payment.
 */
api.post('/ipd/visits', allow('admin', 'ipd_counter', 'main_counter'), async (c) => {
  const b = z.object({
    patientId: z.number().int(),
    doctorId: z.number().int(),
    triage: z.enum(TRIAGE).default('standard'),
    arrivalNote: z.string().nullable().optional(),
    broughtBy: z.string().nullable().optional()
  }).parse(await c.req.json())
  const u = me(c)
  return c.json(await createEmergencyVisit({
    ...b, registeredById: u.id, registeredBy: u.displayName
  }), 201)
})

api.get('/ipd/queue', async (c) =>
  c.json(await emergencyQueue({ includeClosed: c.req.query('all') === '1' })))

api.post('/ipd/visits/:id/medicines', allow('admin', 'ipd_counter', 'doctor'), async (c) => {
  const b = z.object({
    items: z.array(z.object({
      productId: z.number().int().nullable().optional(),
      drugName: z.string().min(1),
      dose: z.string().nullable().optional(),
      qtyPrescribed: z.number().int().min(1).default(1),
      instructions: z.string().nullable().optional()
    })).min(1)
  }).parse(await c.req.json())
  return c.json(await addEmergencyMedicines({
    visitId: Number(c.req.param('id')), items: b.items, addedBy: me(c).displayName
  }), 201)
})

api.get('/ipd/visits/:id/dues', async (c) =>
  c.json(await emergencyDues(Number(c.req.param('id')))))

api.post('/ipd/visits/:id/close', allow('admin', 'ipd_counter', 'doctor'), async (c) => {
  const b = z.object({ outcome: z.string().optional() }).parse(await c.req.json().catch(() => ({})))
  return c.json(await closeEmergencyVisit(Number(c.req.param('id')), me(c).displayName, b.outcome))
})

/* --------------------------------------------------------- counter bills */

/**
 * The main counter till.
 *
 * A draft is what the cashier sees before taking money; completing it writes
 * the invoice, marks the fee or chit paid, and moves the patient into the
 * queue. All in one transaction — see services/billing.ts.
 */
api.get('/counter/draft/visit/:id', allow('admin', 'main_counter'), async (c) =>
  c.json(await draftForVisit(Number(c.req.param('id')))))

api.get('/counter/draft/chit/:id', allow('admin', 'main_counter'), async (c) =>
  c.json(await draftForChit(Number(c.req.param('id')))))

api.post('/counter/bills', allow('admin', 'main_counter'), async (c) => {
  const b = z.object({
    kind: z.enum(['consultation', 'chit']),
    visitId: z.number().int().optional(),
    chitId: z.number().int().optional(),
    payMethod: z.enum(['cash', 'card', 'easypaisa', 'jazzcash', 'credit']).default('cash'),
    tenderedPaisa: z.number().int().min(0).default(0),
    discountPaisa: z.number().int().min(0).default(0)
  }).parse(await c.req.json())

  const u = me(c)
  return c.json(await completeBill({
    ...b, cashierStaffId: u.id, cashierName: u.displayName
  }), 201)
})

/**
 * Sell a test to someone who has not seen a doctor.
 *
 * Creates the visit and the chits, then hands the chit straight to the till
 * so the cashier takes the money on the same screen as everything else.
 */
api.post('/counter/direct', allow('admin', 'main_counter'), async (c) => {
  const b = z.object({
    patientId: z.number().int(),
    serviceIds: z.array(z.number().int()).min(1)
  }).parse(await c.req.json())
  const u = me(c)
  return c.json(await directServiceVisit({
    ...b, by: u.displayName, byId: u.id
  }), 201)
})

api.get('/counter/bills', allow('admin', 'main_counter'), async (c) =>
  c.json(await listBills({
    q: c.req.query('q') ?? '', kind: c.req.query('kind') ?? 'all',
    from: c.req.query('from') ?? undefined, to: c.req.query('to') ?? undefined
  })))

api.get('/counter/bills/:id', allow('admin', 'main_counter'), async (c) => {
  const data = await billForPrint(Number(c.req.param('id')))
  return c.json({ ...data, hospital: await getHospitalInfo() })
})

/* ---------------------------------------------------------------- vitals */

/**
 * What the OPD counter records before the doctor sees the patient.
 *
 * Optional by design. A patient with a cough is waved straight through; one
 * complaining of dizziness gets a blood pressure taken first. Forcing every
 * field would make the desk invent numbers, which is worse than blank ones.
 *
 * This desk holds no money, so it can write here and nowhere else.
 */
api.patch('/visits/:id/vitals', allow('admin', 'receptionist', 'doctor'), async (c) => {
  const b = z.object({
    complaint: z.string().nullable().optional(),
    bpSystolic: z.number().int().min(40).max(300).nullable().optional(),
    bpDiastolic: z.number().int().min(20).max(200).nullable().optional(),
    pulseBpm: z.number().int().min(20).max(260).nullable().optional(),
    temperatureF: z.number().min(80).max(115).nullable().optional(),
    weightKg: z.number().min(1).max(400).nullable().optional(),
    sugarMgDl: z.number().int().min(10).max(900).nullable().optional(),
    vitalsNote: z.string().nullable().optional()
  }).parse(await c.req.json())

  const [row] = await db.update(s.visits).set({
    ...b,
    temperatureF: b.temperatureF != null ? String(b.temperatureF) : null,
    weightKg: b.weightKg != null ? String(b.weightKg) : null,
    vitalsBy: me(c).displayName,
    vitalsAt: new Date()
  }).where(eq(s.visits.id, Number(c.req.param('id')))).returning()

  if (!row) return c.json({ error: 'Visit not found' }, 404)
  return c.json(row)
})

/* ----------------------------------------------------------------- chits */

/**
 * The chit is the hinge of the whole payment flow here: doctor orders,
 * reception prints, cashier stamps, department checks. Every role below
 * touches a different step of the same row.
 */

api.get('/chits', allow('admin', 'main_counter', 'receptionist', 'pharmacist', 'doctor'), async (c) =>
  c.json(await listChits({
    status: c.req.query('status') ?? 'all',
    category: c.req.query('category') ?? 'all',
    q: c.req.query('q') ?? '',
    from: c.req.query('from') ?? undefined,
    to: c.req.query('to') ?? undefined
  })))

api.get('/chits/categories', async (c) => c.json(CATEGORY_LABEL))

api.get('/chits/:id', async (c) => {
  const data = await chitForPrint(Number(c.req.param('id')))
  return c.json({ ...data, hospital: await getHospitalInfo() })
})

/** Reception prints. Grouped per department, so one payment per counter. */
api.post('/visits/:id/chits', allow('admin', 'main_counter'), async (c) =>
  c.json(await createChitsForVisit(Number(c.req.param('id')), me(c).displayName), 201))

api.get('/visits/:id/chits', async (c) =>
  c.json(await chitsForVisit(Number(c.req.param('id')))))

/**
 * Only the main counter settles a chit.
 *
 * The patient carries the chit back to the same window that registered them,
 * pays, and takes the stamped slip to the x-ray room or the lab. All money for
 * consultations and procedures goes through one till, so there is one person
 * accountable at close of day. Enforced here and not only by hiding a button,
 * since the endpoint is reachable either way.
 */
api.post('/chits/:id/pay', allow('admin', 'main_counter'), async (c) => {
  const b = z.object({ payMethod: z.enum(['cash', 'card', 'easypaisa', 'jazzcash', 'credit']).default('cash') })
    .parse(await c.req.json().catch(() => ({})))
  return c.json(await payChit(Number(c.req.param('id')), me(c).displayName, b.payMethod))
})

/** The department confirms the work happened. Blocked until paid. */
api.post('/chits/:id/complete', async (c) => {
  const b = z.object({ note: z.string().optional() }).parse(await c.req.json().catch(() => ({})))
  return c.json(await completeChit(Number(c.req.param('id')), me(c).displayName, b.note))
})

/* -------------------------------------------------------------- settings */

api.get('/settings/hospital', async (c) => c.json(await getHospitalInfo()))

api.put('/modules', adminOnly, async (c) => {
  const b = z.object({
    doctor: z.boolean().optional(), opdCounter: z.boolean().optional(),
    pharmacy: z.boolean().optional(), laboratory: z.boolean().optional(),
    radiology: z.boolean().optional(), emergency: z.boolean().optional(),
    stores: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await saveModules(b))
})

api.put('/settings/hospital', adminOnly, async (c) => {
  const b = z.object({
    name: z.string().optional(), tagline: z.string().optional(),
    address: z.string().optional(), phone: z.string().optional(),
    email: z.string().optional(), ntn: z.string().optional(),
    licenceNo: z.string().optional(), chitFooter: z.string().optional(),
    // A data URI, capped so a photograph cannot be pasted in by accident.
    logoDataUri: z.string().max(600_000).optional(),
    receiptFooter: z.string().optional()
  }).parse(await c.req.json())
  return c.json(await saveHospitalInfo(b))
})

api.get('/admin/backups', adminOnly, async (c) => c.json(await listBackups()))

/* ------------------------------------------------ where backups are kept */

api.get('/admin/backup-location', adminOnly, async (c) => c.json({
  defaultDir: backupDir(),
  extraDir: await extraBackupDir(),
  lastCopyAt: await getSetting('backup.lastCopyAt'),
  lastCopyError: await getSetting('backup.lastCopyError')
}))

api.put('/admin/backup-location', adminOnly, async (c) => {
  const b = z.object({ extraDir: z.string().nullable() }).parse(await c.req.json())
  const dir = (b.extraDir ?? '').trim()

  /*
   * Checked before it is saved.
   *
   * A path that looks right and is not writable is worse than no second copy
   * at all, because the screen would say a copy is being taken when none is.
   */
  if (dir) {
    const check = await checkExtraDir(dir)
    if (!check.ok) {
      return c.json({ error: `Cannot write there: ${check.error}`, code: 'BAD_FOLDER' }, 400)
    }
  }
  return c.json({ extraDir: await setExtraBackupDir(dir || null) })
})

/* ---------------------------------------------------------- start again */

api.get('/admin/wipe-preview', adminOnly, async (c) => c.json(await wipePreview()))

api.post('/admin/wipe', adminOnly, async (c) => {
  const b = z.object({
    password: z.string().min(1),
    typedName: z.string().min(1)
  }).parse(await c.req.json())
  const hospital = await getHospitalInfo()
  try {
    return c.json(await wipeTradingData({
      staffId: me(c).id, password: b.password,
      hospitalName: hospital.name, typedName: b.typedName
    }))
  } catch (e: any) {
    if (e instanceof WipeError) return c.json({ error: e.message, code: e.code }, 409)
    throw e
  }
})
api.post('/admin/backups', adminOnly, async (c) => c.json(await runBackup('manual'), 201))

/**
 * The reception day, for closing the counter.
 *
 * Everything is anchored to the last 24 hours rather than the calendar day,
 * because these desks run past midnight and the person counting cash at 1am
 * wants the shift they just worked, not two hours of it.
 *
 * Consultation fees only. Money for tests and scans is taken at the pharmacy
 * counter and is reported there, so the two tills never double count.
 */
api.get('/reception/overview', allow('admin', 'main_counter'), async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 24), 1), 168)
  const since = sql`now() - (${hours} || ' hours')::interval`

  const kpi = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS visits,
           COUNT(*) FILTER (WHERE fee_paid)::int AS paid_visits,
           COUNT(*) FILTER (WHERE NOT fee_paid)::int AS unpaid_visits,
           COALESCE(SUM(consultation_fee_paisa) FILTER (WHERE fee_paid), 0)::bigint AS collected_paisa,
           COALESCE(SUM(consultation_fee_paisa) FILTER (WHERE NOT fee_paid), 0)::bigint AS outstanding_paisa,
           COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
           COUNT(DISTINCT patient_id)::int AS patients
    FROM visits WHERE created_at >= ${since} AND status <> 'cancelled'`)).rows[0]

  const newVsReturning = (await db.execute<any>(sql`
    SELECT COUNT(*) FILTER (WHERE first_visit >= ${since})::int AS new_patients,
           COUNT(*) FILTER (WHERE first_visit <  ${since})::int AS returning_patients
    FROM (
      SELECT v.patient_id, MIN(all_v.created_at) AS first_visit
      FROM visits v JOIN visits all_v ON all_v.patient_id = v.patient_id
      WHERE v.created_at >= ${since} AND v.status <> 'cancelled'
      GROUP BY v.patient_id
    ) f`)).rows[0]

  /** Hour by hour, so the desk can see when the rush actually lands. */
  const hourly = (await db.execute<any>(sql`
    SELECT to_char(g.h, 'HH24:00') AS hour, g.h AS at,
           COALESCE(v.visits, 0)::int AS visits,
           COALESCE(v.fees, 0)::bigint AS fees_paisa
    FROM generate_series(date_trunc('hour', ${since}), date_trunc('hour', now()), '1 hour') g(h)
    LEFT JOIN (
      SELECT date_trunc('hour', created_at) AS h, COUNT(*) AS visits,
             SUM(consultation_fee_paisa) FILTER (WHERE fee_paid) AS fees
      FROM visits WHERE status <> 'cancelled' GROUP BY 1
    ) v ON v.h = g.h
    ORDER BY g.h`)).rows

  const byDoctor = (await db.execute<any>(sql`
    SELECT st.display_name AS doctor_name, dep.name AS department,
           COUNT(*)::int AS visits,
           COALESCE(SUM(v.consultation_fee_paisa) FILTER (WHERE v.fee_paid), 0)::bigint AS fees_paisa
    FROM visits v
    JOIN doctors d ON d.id = v.doctor_id
    JOIN staff st  ON st.id = d.staff_id
    LEFT JOIN departments dep ON dep.id = st.department_id
    WHERE v.created_at >= ${since} AND v.status <> 'cancelled'
    GROUP BY st.display_name, dep.name
    ORDER BY visits DESC LIMIT 12`)).rows

  /** Chits printed here but settled at the pharmacy, shown for handover only. */
  const chits = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS printed,
           COUNT(*) FILTER (WHERE status = 'ordered')::int AS unpaid,
           COALESCE(SUM(total_paisa) FILTER (WHERE status = 'ordered'), 0)::bigint AS unpaid_paisa,
           COALESCE(SUM(total_paisa) FILTER (WHERE status <> 'ordered'), 0)::bigint AS settled_paisa
    FROM chits WHERE created_at >= ${since}`)).rows[0]

  const prev = (await db.execute<any>(sql`
    SELECT COALESCE(SUM(consultation_fee_paisa) FILTER (WHERE fee_paid), 0)::bigint AS collected_paisa,
           COUNT(*)::int AS visits
    FROM visits
    WHERE created_at >= now() - (${hours * 2} || ' hours')::interval
      AND created_at <  now() - (${hours} || ' hours')::interval
      AND status <> 'cancelled'`)).rows[0]

  return c.json({ hours, kpi: { ...kpi, ...newVsReturning }, hourly, byDoctor, chits, prev })
})

/* ----------------------------------------------------- patient directory */

/**
 * Everyone who has ever been registered, bucketed by when they were last
 * seen. Reception looks people up by "was here last week" at least as often
 * as by name.
 */
api.get('/patients', async (c) => {
  const bucket = c.req.query('bucket') ?? 'today'
  const q = (c.req.query('q') ?? '').trim()
  const like = `%${q}%`
  const window = {
    today: sql`v.last_visit >= date_trunc('day', now())`,
    week:  sql`v.last_visit >= date_trunc('day', now()) - interval '7 days'`,
    month: sql`v.last_visit >= date_trunc('day', now()) - interval '30 days'`,
    all:   sql`true`
  }[bucket] ?? sql`true`

  const r = await db.execute<any>(sql`
    SELECT p.*, v.visits, v.last_visit, v.last_doctor
    FROM patients p
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS visits, MAX(vi.created_at) AS last_visit,
             (SELECT st.display_name FROM visits v2
              LEFT JOIN doctors d ON d.id = v2.doctor_id
              LEFT JOIN staff st ON st.id = d.staff_id
              WHERE v2.patient_id = p.id ORDER BY v2.created_at DESC LIMIT 1) AS last_doctor
      FROM visits vi WHERE vi.patient_id = p.id
    ) v ON true
    WHERE ${window}
      AND (${q} = '' OR p.name ILIKE ${like} OR p.mrn ILIKE ${like}
           OR p.phone ILIKE ${like} OR p.cnic ILIKE ${like})
    ORDER BY v.last_visit DESC NULLS LAST, p.created_at DESC
    LIMIT 400`)

  const counts = await db.execute<any>(sql`
    WITH last AS (SELECT patient_id, MAX(created_at) AS d FROM visits GROUP BY patient_id)
    SELECT COUNT(*) FILTER (WHERE d >= date_trunc('day', now()))::int AS today,
           COUNT(*) FILTER (WHERE d >= date_trunc('day', now()) - interval '7 days')::int AS week,
           COUNT(*) FILTER (WHERE d >= date_trunc('day', now()) - interval '30 days')::int AS month,
           (SELECT COUNT(*)::int FROM patients) AS all
    FROM last`)
  return c.json({ rows: r.rows, counts: (counts.rows as any[])[0] })
})

/* -------------------------------------------------------------- pharmacy */

// The whole till, carried over from the standalone app. Admins get in too so
// they can check stock and prices without a second login.
api.use('/pharmacy/*', allow('admin', 'pharmacist', 'pharmacy_admin'))
api.route('/pharmacy', pharmacy)

/**
 * The rebuilt pharmacy: masters, ledgers, returns and reports.
 *
 * Mounted alongside the till rather than replacing it, so the counter keeps
 * working while the rest grows.
 */
api.use('/pharma/*', allow('admin', 'pharmacist', 'pharmacy_admin'))
api.route('/pharma', pharma)

/**
 * Every report in the system. Each role sees its own module's; the reports
 * desk and administrators see all of them.
 */
api.route('/reports', reports)

api.get('/pharmacy/prescriptions', allow('admin', 'pharmacist', 'pharmacy_admin'), async (c) =>
  c.json(await pendingPrescriptions(c.req.query('q') ?? undefined)))

/** Catalogue search with live stock, for prescribing and for dispensing. */
api.get('/products/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json([])
  return c.json((await db.execute<any>(sql`
    SELECT p.id, p.name, p.generic_name, p.strength, p.form, p.manufacturer, p.unit_label,
           p.sub_unit_label, p.pack_size, p.allow_loose, p.schedule, p.tax_rate_bp,
           -- Price lives on the medicine, so receiving can show it read-only.
           p.purchase_paisa, p.trade_paisa, p.retail_paisa,
           COALESCE(st.total_qty, 0)::int AS total_qty,
           fefo.id AS batch_id, fefo.batch_no, fefo.expiry_date, fefo.price_paisa
    FROM products p
    LEFT JOIN LATERAL (
      SELECT SUM(qty_on_hand) AS total_qty FROM batches
      WHERE product_id = p.id AND qty_on_hand > 0 AND expiry_date > CURRENT_DATE) st ON true
    LEFT JOIN LATERAL (
      SELECT id, batch_no, expiry_date, price_paisa FROM batches
      WHERE product_id = p.id AND qty_on_hand > 0 AND expiry_date > CURRENT_DATE
      ORDER BY expiry_date ASC, id ASC LIMIT 1) fefo ON true
    WHERE p.is_active
      AND (p.name ILIKE ${'%' + q + '%'} OR p.generic_name ILIKE ${'%' + q + '%'}
           OR p.barcode = ${q} OR p.product_code ILIKE ${'%' + q + '%'})
    ORDER BY (p.barcode = ${q}) DESC, p.name LIMIT 25`)).rows)
})

/* -------------------------------------------------------------- earnings */

api.get('/earnings/me', allow('doctor', 'admin'), async (c) => {
  const u = me(c)
  const doctorId = c.req.query('doctor') ? Number(c.req.query('doctor')) : u.doctorId
  if (!doctorId) return c.json({ error: 'This account is not a doctor' }, 400)
  const today = new Date().toISOString().slice(0, 10)
  return c.json(await doctorEarnings(doctorId,
    c.req.query('from') ?? today, c.req.query('to') ?? today))
})

api.get('/earnings/all', adminOnly, async (c) => {
  const today = new Date().toISOString().slice(0, 10)
  return c.json(await allDoctorEarnings(c.req.query('from') ?? today, c.req.query('to') ?? today))
})

/* ------------------------------------------------------------ demo data */

api.get('/admin/demo-status', adminOnly, async (c) => c.json({ hasData: await hasAnyData() }))

/**
 * Fills the system with realistic data so every screen can be tried.
 *
 * Destructive when reset is true, so it is admin-only and the client demands a
 * typed confirmation. Refuses to add on top of existing data, because two
 * overlapping sets of demo patients is worse than none.
 */
api.post('/admin/demo-data', adminOnly, async (c) => {
  const b = z.object({
    reset: z.boolean().default(false),
    days: z.number().int().min(1).max(180).default(45)
  }).parse(await c.req.json().catch(() => ({})))

  if (!b.reset && await hasAnyData()) {
    return c.json({
      error: 'There are already patients in this system',
      detail: 'Loading demo data on top would mix real records with invented ones. ' +
              'Choose the replace option if this is a test system.',
      code: 'HAS_DATA'
    }, 409)
  }
  return c.json(await loadDemoData({ reset: b.reset, days: b.days }), 201)
})

/* ------------------------------------------------------------ admin home */

api.get('/stats/today', async (c) => {
  const r = await db.execute<any>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM visits WHERE created_at >= date_trunc('day', now())) AS visits,
      (SELECT COUNT(*)::int FROM visits WHERE created_at >= date_trunc('day', now())
         AND status = 'waiting') AS waiting,
      (SELECT COUNT(*)::int FROM visits WHERE created_at >= date_trunc('day', now())
         AND status = 'completed') AS completed,
      (SELECT COUNT(*)::int FROM patients WHERE created_at >= date_trunc('day', now())) AS new_patients,
      (SELECT COALESCE(SUM(consultation_fee_paisa), 0)::bigint FROM visits
         WHERE created_at >= date_trunc('day', now()) AND fee_paid) AS fees_paisa,
      (SELECT COALESCE(SUM(price_paisa), 0)::bigint FROM service_orders
         WHERE ordered_at >= date_trunc('day', now())) AS services_paisa,
      (SELECT COALESCE(SUM(amount_paisa), 0)::bigint FROM doctor_earnings
         WHERE earned_at >= date_trunc('day', now())) AS doctor_share_paisa`)
  return c.json((r.rows as any[])[0])
})
