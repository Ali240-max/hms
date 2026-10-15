import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sql, eq } from 'drizzle-orm'
import { z, ZodError } from 'zod'
import { db } from '../db/client'
import * as s from '../db/schema'
import {
  needsSetup, createFirstAdmin, login, logout, sessionFor, sessionForUser, listStaff,
  createStaff, setStaffPassword, archiveStaff, restoreStaff, updateDoctor,
  updateStaff, deleteStaff,
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
import { patientStickers, wardLabels } from '../services/labels-pdf'
import { createCrossMatch, crossMatch, crossMatches } from '../services/cross-match'
import {
  day as attendanceDay, onSite, monthFor, staffForAttendance, recordPunch,
  recentPunches,
  deletePunch, devices, saveDevice, deviceByKey, fingerprintsFor,
  saveFingerprint,
  deleteFingerprint, templatesForAgent, rosterForAgent, todayLocal
} from '../services/attendance'
import {
  syncStatus, requestSync, cancelJob, claimJobs, finishJob, TerminalSyncError
} from '../services/terminal-sync'
import {
  wards, saveWard, deleteWard, bedBoard, saveBed, deleteBed, setBedStatus,
  admit, transfer, account, addCharge, takePayment, discharge, admissions
} from '../services/ipd'
import { crossMatchPdf } from '../services/cross-match-pdf'
import {
  previewScope, createAudit, audits, audit as auditOne, closeAudit,
  createAdjustment, adjustments, adjustment as adjustmentOne,
  adjustmentHistory, adjustmentsByCompany
} from '../services/stock-audit'
import { auditSheetPdf, adjustmentPdf } from '../services/audit-pdf'
import {
  shelf, createWriteOff, writeOffs, writeOff as writeOffOne
} from '../services/write-off'
import { hasPermission as hasPharmaPermission } from '../services/pharma'
import { writeOffPdf } from '../services/write-off-pdf'
import {
  printerConfig, savePrinterConfig, allPrinterConfigs, sendToPrinter,
  windowsPrinters, PrintError
} from '../services/printing'
import { chitReceipt, billReceipt, saleReceipt, testPage } from '../services/escpos'
import { saleForPrint } from '../services/sales'
import {
  ADMIN_PERMISSIONS, adminPermissionsFor, saveAdminPermissions, adminAccounts,
  hasAdminPermission, guardRootAccount
} from '../services/admin-perms'
import { extraBackupDir, setExtraBackupDir, checkExtraDir, backupDir } from '../services/backup'
import {
  labQueue, parametersFor, saveParameters, consumablesFor, saveConsumables,
  collectSample, startTest, saveResults, verifyResult, reportFor, labStats,
  interpretationsFor, saveInterpretations, signatories, saveSignatories,
  reportLayoutFor, saveReportLayout,
  reportNoteFor, saveReportNote,
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
  if (err instanceof TerminalSyncError) {
    const status = err.code === 'NOT_FOUND' || err.code === 'NO_STAFF' ? 404
      : err.code === 'BAD_ID' ? 400 : 409
    return c.json({ error: err.message, code: err.code }, status)
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

/**
 * Health, and which build is actually running.
 *
 * The build matters as much as the health. Updates reach this hospital as a
 * zip that somebody extracts over a folder on a server a long way away, and
 * there is no way to see from the outside whether it landed. Twice now a
 * feature has been reported missing when the real question was whether the
 * bundle that contained it had been applied, and neither of us could answer
 * it without a screenshot.
 *
 * The highest migration that has run is the honest answer, because it is
 * read out of the database rather than off a number somebody could forget
 * to change. Public, like the rest of this route: it says which version of
 * an application is running and nothing about anybody's data.
 */
/**
 * The bundle this build came from.
 *
 * Changed by hand with each update, and deliberately not read from
 * package.json: the version there has not moved since the first commit and
 * making it meaningful now would mean remembering two things instead of one.
 */
const BUILD = 'v58'

api.get('/health', async (c) => {
  let migration: string | null = null
  try {
    migration = ((await db.execute<any>(sql`
      SELECT name FROM _migrations ORDER BY name DESC LIMIT 1`)).rows as any[])[0]
      ?.name ?? null
  } catch { /* an install that has never migrated still answers */ }
  return c.json({ ok: true, at: new Date().toISOString(), build: BUILD, migration })
})

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

api.post('/auth/logout', async (c) => {
  const t = bearer(c)
  if (t) await logout(t)
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

  /*
   * The attendance agent carries a reader key, not a session.
   *
   * It runs unattended on a PC by a door, through the night, with nobody
   * signed in anywhere — so it cannot hold a staff session, and these two
   * routes check `x-device-key` themselves instead. Without this they were
   * answered 401 whatever key was sent, which would have made the agent
   * useless in a way that looks exactly like a wrong key.
   *
   * Listed by exact path and nothing wider. `/attendance/*` would have
   * exposed the day sheet and the corrections route to anybody on the LAN.
   */
  const DEVICE_KEY_ROUTES = [
    '/attendance/agent/templates',
    /*
     * Terminal mode needs the roster instead of the templates: the device
     * holds its own fingerprints and only the id-to-staff mapping is
     * missing. Listed by exact path like the other two.
     */
    '/attendance/agent/roster',
    '/attendance/agent/punch',
    /*
     * Terminal jobs: putting staff onto the device from HMS. Two exact paths,
     * the job id travelling in the body, so nothing here needs a pattern.
     */
    '/attendance/agent/jobs',
    '/attendance/agent/job-result'
  ]
  if (DEVICE_KEY_ROUTES.includes(path)) return next()

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
  let user = await sessionFor(bearer(c))

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
      if (userId != null) user = await sessionForUser(userId)
    }
  }

  if (!user) return c.json({ error: 'Sign in to continue', code: 'NO_SESSION' }, 401)

  /*
   * The door terminal is allowed exactly four paths and refused everything
   * else.
   *
   * Every other role is allowed by default and refused where a route says so,
   * which is right for a person at a keyboard: a missed `allow` on a new
   * route costs them a screen they should not have had, and somebody notices.
   *
   * This one is different. It is a browser left signed in forever on a
   * machine in a corridor, so a route added next month with no `allow` on it
   * would quietly become readable by anyone who walks past. Listing what it
   * MAY reach means a new route is invisible to it until somebody decides
   * otherwise.
   *
   * This was found by probing the live server rather than by reading the
   * code: patient search answered a kiosk token with 200.
   */
  if ((user as any).role === 'kiosk') {
    const ALLOWED = ['/attendance/recent', '/auth/me', '/auth/logout', '/modules']
    if (!ALLOWED.includes(path)) {
      return c.json({
        error: 'The attendance board can only show scans.',
        code: 'NOT_ALLOWED'
      }, 403)
    }
  }

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
  /*
   * Anchored on /pdf, with an optional filename after it.
   *
   * The trailing segment is there so a download manager gets the right name:
   * IDM and its kind ignore content-disposition and take the last segment of
   * the URL, so a URL ending in /pdf saves a file called "pdf". The route
   * handlers ignore the segment entirely — it names the file and reaches
   * nothing — and the ticket is still bound to the whole path, so a ticket
   * for one report cannot be pointed at another by editing it.
   *
   * The charset is narrow on purpose: letters, digits, spaces, dots, hyphens,
   * underscores, brackets, and percent for an encoded space. No slashes, so
   * it cannot climb into another path segment.
   */
  if (!/^\/(lab|pharma|reports|patients|visits)\/[\w/-]+\/pdf(\/[\w %.()'-]+\.pdf)?$/
    .test(b.path)) {
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

/**
 * An administrator holding one particular power.
 *
 * Checked on the server, not only hidden in the interface. A second
 * administrator who is not allowed to change prices must be refused when the
 * request arrives, or the restriction is decoration: the screen is the easy
 * part to work around.
 */
const adminCan = (key: string) => async (c: any, next: any) => {
  const u = me(c)
  if (u.role !== 'admin') {
    return c.json({ error: 'Administrators only', code: 'NOT_ALLOWED' }, 403)
  }
  if (!(await hasAdminPermission(u.id, key))) {
    return c.json({
      error: 'Your account is not set up to do that. The main administrator can allow it.',
      code: 'NOT_ALLOWED'
    }, 403)
  }
  return next()
}

api.get('/auth/me', (c) => c.json(me(c)))

/* ----------------------------------------------------------- departments */

api.get('/departments', async (c) =>
  c.json((await db.execute<any>(sql`
    SELECT d.*, COUNT(st.id)::int AS staff_count
    FROM departments d LEFT JOIN staff st ON st.department_id = d.id AND st.is_active
    WHERE d.is_active GROUP BY d.id ORDER BY d.name`)).rows))

api.post('/departments', adminCan('admin.departments'), async (c) => {
  const b = z.object({ name: z.string().min(1), code: z.string().min(1) }).parse(await c.req.json())
  const [row] = await db.insert(s.departments).values(b).returning()
  return c.json(row, 201)
})

api.delete('/departments/:id', adminCan('admin.departments'), async (c) => {
  const id = Number(c.req.param('id'))
  /*
   * Refused while anything points at it. A department deleted out from under a
   * doctor or a visit leaves rows referring to something that is gone, and the
   * screens that join on it start showing blanks.
   */
  const used = ((await db.execute<any>(sql`
    SELECT (SELECT COUNT(*)::int FROM staff WHERE department_id = ${id})  AS staff,
           (SELECT COUNT(*)::int FROM visits WHERE department_id = ${id}) AS visits
  `)).rows as any[])[0]
  if (Number(used.staff) + Number(used.visits) > 0) {
    return c.json({
      error: `${used.staff} staff and ${used.visits} visits still use this department. ` +
        'Move them first, or switch it off instead of deleting it.',
      code: 'IN_USE'
    }, 409)
  }
  await db.execute(sql`DELETE FROM departments WHERE id = ${id}`)
  return c.json({ deleted: true })
})

api.patch('/departments/:id', adminCan('admin.departments'), async (c) => {
  const b = z.object({
    name: z.string().optional(), code: z.string().optional(), isActive: z.boolean().optional()
  }).parse(await c.req.json())
  const [row] = await db.update(s.departments).set(b)
    .where(eq(s.departments.id, Number(c.req.param('id')))).returning()
  return c.json(row)
})

/* ----------------------------------------------------------------- staff */

api.get('/staff', adminOnly, async (c) => c.json(await listStaff()))

api.post('/staff', adminCan('admin.staff.edit'), async (c) => {
  const b = z.object({
    username: z.string().min(1), displayName: z.string().default(''), password: z.string(),
    role: z.enum(['admin', 'main_counter', 'receptionist', 'ipd_counter',
                  'store_keeper', 'lab_tech', 'radiology', 'doctor', 'ward', 'kiosk',
                  'pharmacist', 'pharmacy_admin', 'reports']),
    // When they are expected, and whether they are expected at all.
    shiftStart: z.string().nullable().optional(),
    shiftEnd: z.string().nullable().optional(),
    attendanceRequired: z.boolean().optional(),
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

api.post('/staff/:id/password', adminCan('admin.staff.password'), async (c) => {
  try {
    await guardRootAccount(Number(c.req.param('id')), me(c).id)
  } catch (e: any) {
    return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 403)
  }
  const b = z.object({ password: z.string() }).parse(await c.req.json())
  await setStaffPassword(Number(c.req.param('id')), b.password)
  return c.json({ ok: true })
})

api.patch('/staff/:id', adminCan('admin.staff.edit'), async (c) => {
  const id = Number(c.req.param('id'))
  try { await guardRootAccount(id, me(c).id) }
  catch (e: any) { return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 403) }

  const b = z.object({
    displayName: z.string().min(1).optional(),
    role: z.enum(['admin', 'main_counter', 'receptionist', 'ipd_counter',
      'store_keeper', 'lab_tech', 'radiology', 'doctor', 'ward', 'kiosk',
      'pharmacist', 'pharmacy_admin', 'reports']).optional(),
    departmentId: z.number().int().nullable().optional(),
    phone: z.string().nullable().optional(),
    /*
     * The shift, which could be set at creation and never changed.
     *
     * Declared here or zod strips it and the change is silently dropped —
     * the exact failure that left purchase orders open forever two bundles
     * ago. Null clears it, an absent key leaves it alone.
     */
    shiftStart: z.string().nullable().optional(),
    shiftEnd: z.string().nullable().optional(),
    attendanceRequired: z.boolean().optional(),
    /* Their id on a standalone attendance terminal, where one is in use. */
    deviceUserId: z.string().nullable().optional()
  }).parse(await c.req.json())
  return c.json(await updateStaff(id, b))
})

api.delete('/staff/:id', adminCan('admin.staff.edit'), async (c) => {
  const id = Number(c.req.param('id'))
  try { await guardRootAccount(id, me(c).id) }
  catch (e: any) { return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 403) }
  return c.json(await deleteStaff(id))
})

api.post('/staff/:id/archive', adminCan('admin.staff.edit'), async (c) => {
  try {
    await guardRootAccount(Number(c.req.param('id')), me(c).id)
  } catch (e: any) {
    return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 403)
  }
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

/**
 * Delete a service outright.
 *
 * Refused once it has been ordered, because every bill, chit and lab report
 * naming it would be left pointing at nothing. Switching it off is the answer
 * there: it disappears from the counter's list and the history stays whole,
 * which is what the error says.
 */
api.delete('/services/:id', adminCan('admin.services.edit'), async (c) => {
  const id = Number(c.req.param('id'))
  const used = ((await db.execute<any>(sql`
    SELECT COUNT(*)::int AS n FROM service_orders WHERE service_id = ${id}`)).rows as any[])[0]

  if (Number(used.n) > 0) {
    return c.json({
      error: `This has been ordered ${used.n} time(s), so the bills and reports naming it ` +
        'would be left pointing at nothing. Switch it off instead — it disappears from the ' +
        'counter and the history stays whole.',
      code: 'IN_USE'
    }, 409)
  }

  await db.execute(sql`DELETE FROM service_parameters WHERE service_id = ${id}`)
  await db.execute(sql`DELETE FROM service_interpretations WHERE service_id = ${id}`)
  await db.execute(sql`DELETE FROM service_consumables WHERE service_id = ${id}`)
  await db.execute(sql`DELETE FROM doctor_service_shares WHERE service_id = ${id}`)
  await db.execute(sql`DELETE FROM services WHERE id = ${id}`)
  return c.json({ deleted: true })
})

api.post('/services', adminOnly, async (c) => {
  const b = z.object({
    id: z.number().int().optional(),
    code: z.string().nullable().optional(),
    name: z.string().min(1),
    category: z.enum(['lab', 'radiology', 'procedure', 'other']),
    pricePaisa: z.number().int().min(0),
    defaultShareBp: z.number().int().min(0).max(10000),
    // Which department owns it, so reports can split an ECG from an X-ray
    // rather than lumping both under "radiology".
    departmentId: z.number().int().nullable().optional(),
    /* Billing it without naming a doctor is refused. Mostly for procedures. */
    requiresDoctor: z.boolean().optional(),
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
/**
 * "Amna Javed AJ35-09102026-571.pdf".
 *
 * A folder of MRN-000597-lab-report.pdf is unsearchable by the one thing
 * anybody remembers. Punctuation Windows refuses in a filename is stripped
 * rather than escaped, because a report saved with a slash in its name simply
 * fails to save.
 */
export function labFileName(row: any) {
  const clean = (s: any) => String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()
  /*
   * Name then MRN, not the report number.
   *
   * A folder sorted by name puts every report for one patient together, and
   * the MRN is the thing staff read back over the phone. A report number is
   * meaningless outside the system.
   */
  const name = clean(row?.patient_name) || 'Lab report'
  const mrn = clean(row?.mrn)
  return `${name}${mrn ? ' ' + mrn : ''}.pdf`
}

/*
 * One report, reachable two ways, and until now named two ways.
 *
 * This route named the file after the report number — "LAB-261009-L00003-Amna-
 * Javed.pdf" — while the per-visit route below named it after the patient. The
 * lab reported saving reports called "lab 001"; that was this route, and the
 * two routes disagreeing was the whole of it. Both now use labFileName.
 *
 * The optional trailing segment is the filename, and the handler ignores it
 * completely. It exists because a download manager does not read
 * content-disposition: IDM and friends take the last segment of the URL, so a
 * URL ending in /pdf produces a file called "pdf" or whatever the tool
 * invents. Putting the real name in the path makes every downloader agree
 * with the header, without the handler trusting a single character of it.
 */
const labOrderPdf = async (c: any) => {
  const id = Number(c.req.param('id'))
  const pdf = await labReportPdf({ labOrderId: id })
  const { report } = await reportFor(id)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="${labFileName(report)}"`
    }
  })
}
api.get('/lab/orders/:id/pdf', labOrderPdf)
api.get('/lab/orders/:id/pdf/:filename', labOrderPdf)

/** Every finished report on one visit, each on its own page. */

const labVisitPdf = async (c: any) => {
  const visitId = Number(c.req.param('id'))

  /*
   * Refused clearly when there is nothing finished to print.
   *
   * This used to throw, and the error handler turned it into a 204 with an
   * empty body — which a PDF viewer reports as "Unexpected server response
   * (204)". A half-filled report is not printable, and saying so is more use
   * than a status code.
   */
  const ready = (await visitWork(visitId))
    .filter((w: any) => w.lab_status === 'resulted' && w.lab_order_id)
  if (ready.length === 0) {
    return c.json({
      error: 'No finished report on this visit yet. Fill in every line first.',
      code: 'NOTHING_TO_PRINT'
    }, 409)
  }

  /*
   * The patient, read from the visit rather than taken off the work row.
   *
   * This route named every file "Lab report.pdf" and nobody could see why:
   * labFileName falls back to that string when it gets no name, and
   * visitWork() returns the work on a visit — the tests, their statuses, the
   * order ids — with no patient on it at all. The fallback was doing all the
   * work, silently, on the one route the Download button actually calls.
   *
   * Fixed last round on the per-order route, which did carry the patient, and
   * tested there. Testing the route I had changed instead of the route the
   * button calls is how it shipped still broken.
   */
  const who = ((await db.execute<any>(sql`
    SELECT p.name AS patient_name, p.mrn
    FROM visits v JOIN patients p ON p.id = v.patient_id
    WHERE v.id = ${visitId}`)).rows as any[])[0]

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
        // Named for the patient and their MRN, same as the client asks for,
        // so a file saved from either route lands with the same name.
        `filename="${labFileName(who)}"`
    }
  })
}
api.get('/lab/visits/:id/pdf', labVisitPdf)
/* The trailing filename is cosmetic and ignored; see labOrderPdf above. */
api.get('/lab/visits/:id/pdf/:filename', labVisitPdf)

/* ------------------------------------------------------------- labels */

/**
 * 21 stickers for one patient, three across and seven down on plain A4.
 *
 * `from` starts part way down a sheet that has already had some peeled off.
 */
/** This patient's visits, newest first. Used to pick one for ward labels. */
api.get('/patients/:id/visits',
  allow('admin', 'main_counter', 'receptionist', 'ipd_counter', 'doctor'), async (c) => {
  const r = await db.execute<any>(sql`
    SELECT v.id, v.visit_no, v.created_at, v.status,
           COALESCE(st.display_name, '—') AS doctor_name
    FROM visits v
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    WHERE v.patient_id = ${Number(c.req.param('id'))}
    ORDER BY v.created_at DESC LIMIT 20`)
  return c.json(r.rows)
})

api.get('/patients/:id/stickers/pdf',
  allow('admin', 'main_counter', 'receptionist', 'ipd_counter'), async (c) => {
  const pdf = await patientStickers(Number(c.req.param('id')), {
    from: Number(c.req.query('from') ?? 1),
    count: c.req.query('count') ? Number(c.req.query('count')) : undefined
  })
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="stickers-${c.req.param('id')}.pdf"`
    }
  })
})

/** Bed, door and file labels for one visit, three to a sheet. */
api.get('/visits/:id/ward-labels/pdf',
  allow('admin', 'main_counter', 'receptionist', 'ipd_counter'), async (c) => {
  const pdf = await wardLabels(Number(c.req.param('id')), {
    diagnosis: c.req.query('diagnosis') || null,
    admittedOn: c.req.query('admittedOn') || null
  })
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="ward-labels-${c.req.param('id')}.pdf"`
    }
  })
})

/* ------------------------------------------- what a test's result means */

api.get('/services/:id/interpretations', async (c) =>
  c.json(await interpretationsFor(Number(c.req.param('id')))))

/*
 * Set by the laboratory, like the reference ranges. They are the people who
 * know what their own method reports.
 */
api.put('/services/:id/interpretations',
  allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({
    rows: z.array(z.object({ title: z.string(), rangeText: z.string() }))
  }).parse(await c.req.json())
  return c.json(await saveInterpretations(Number(c.req.param('id')), b.rows))
})

/* ------------------------------------------------------ report signatures */

/** The note printed under this test, worded by the laboratory. */
api.get('/services/:id/report-note', async (c) =>
  c.json(await reportNoteFor(Number(c.req.param('id')))))

api.put('/services/:id/report-note',
  allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({
    noteHeading: z.string().nullable().optional(),
    noteText: z.string().max(4000).nullable().optional()
  }).parse(await c.req.json())
  return c.json(await saveReportNote(Number(c.req.param('id')), b))
})

api.get('/lab/signatories', async (c) => c.json(await signatories()))

api.put('/lab/signatories', allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({
    rows: z.array(z.object({
      name: z.string(),
      qualification: z.string().nullable().optional(),
      designation: z.string().nullable().optional(),
      registration: z.string().nullable().optional(),
      // A scanned signature as a data URI, capped so a photograph cannot be
      // pasted in by mistake.
      signature: z.string().max(400_000).nullable().optional()
    }))
  }).parse(await c.req.json())
  return c.json(await saveSignatories(b.rows))
})

/** Headings and defaults the laboratory can word for itself. */
api.get('/lab/report-settings', async (c) => c.json({
  noteHeading: (await getSetting('lab.noteHeading')) || 'Note',
  noteDefault: (await getSetting('lab.noteDefault')) || '',
  logoPosition: (await getSetting('lab.logoPosition')) || 'right',
  /*
   * How big the logo prints, as a percentage of the default box.
   *
   * A logo is whatever file the hospital happens to have, and fitting every
   * one of them into one fixed box makes a tall narrow emblem print tiny.
   * Rather than guess, the laboratory sizes it by eye against a printed
   * sheet, which is the only way to tell.
   */
  logoScale: Number((await getSetting('lab.logoScale')) || '100')
}))

api.put('/lab/report-settings', allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({
    noteHeading: z.string().optional(),
    noteDefault: z.string().optional(),
    logoPosition: z.enum(['left', 'right', 'none']).optional(),
    /* Clamped: below 40 it is unreadable, above 400 it pushes the patient
     * block off the page. */
    logoScale: z.number().int().min(40).max(400).optional()
  }).parse(await c.req.json())
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) await setSetting(`lab.${k}`, String(v))
  }
  return c.json({
    noteHeading: (await getSetting('lab.noteHeading')) || 'Note',
    noteDefault: (await getSetting('lab.noteDefault')) || '',
    logoPosition: (await getSetting('lab.logoPosition')) || 'right',
    logoScale: Number((await getSetting('lab.logoScale')) || '100')
  })
})

/* ---------------------------------------------------------- printing */

/**
 * Receipts are printed by the server, in ESC/POS, straight to the printer.
 *
 * Not through the browser. A browser prints pages, and a thermal printer feeds
 * to the end of whatever page its driver is set to — which is why a receipt
 * used to be followed by three metres of blank roll. ESC/POS has no pages: the
 * printer prints what it is sent and cuts where it is told.
 */
/** Which PC is asking. Sent by the browser, kept in its own storage. */
const device = (c: any) => c.req.header('x-device-id') || c.req.query('device') || null

api.get('/printing/config/:module', async (c) =>
  c.json(await printerConfig(c.req.param('module'), device(c))))

api.get('/printing/configs', adminOnly, async (c) => c.json(await allPrinterConfigs()))

api.put('/printing/config/:module',
  allow('admin', 'main_counter', 'pharmacist', 'pharmacy_admin', 'lab_tech', 'radiology'),
  async (c) => {
    /*
     * A half-filled setting is allowed to be saved.
     *
     * The address was required here, which meant choosing "Network printer"
     * from the dropdown — which saves the choice before there is anywhere to
     * type an address — was rejected outright, and the dropdown snapped back
     * to "Not set". There was no order in which the form could be filled in.
     *
     * Configuration is a draft until it works. What must not be half-filled
     * is a print, and that is checked when one is attempted: an empty address
     * is refused there with a message naming the counter.
     */
    const b = z.object({
      target: z.union([
        z.object({ kind: z.literal('network'), host: z.string(),
                   port: z.number().int().optional() }),
        z.object({
          kind: z.literal('share'), unc: z.string(),
          // For the PC holding the printer, not for this system.
          user: z.string().nullable().optional(),
          pass: z.string().nullable().optional()
        }),
        z.object({ kind: z.literal('local'), unc: z.string() }),
        z.object({ kind: z.literal('none') })
      ]).optional(),
      width: z.enum(['58mm', '80mm']).optional(),
      copies: z.number().int().min(1).max(5).optional(),
      feedLines: z.number().int().min(0).max(10).optional(),
      kickDrawer: z.boolean().optional()
    }).parse(await c.req.json())
    const b2 = b as any
    return c.json(await savePrinterConfig(c.req.param('module'), b2, device(c)))
  })

/** What this server can see. A printer missing here cannot be printed to. */
api.get('/printing/available', async (c) => c.json({
  platform: process.platform,
  printers: await windowsPrinters()
}))

const printFailed = (c: any, e: any) => {
  if (e instanceof PrintError) return c.json({ error: e.message, code: e.code }, 409)
  throw e
}

api.post('/printing/test/:module', async (c) => {
  const cfg = await printerConfig(c.req.param('module'), device(c))
  try {
    const r = await sendToPrinter(c.req.param('module'),
      testPage(await getHospitalInfo(), cfg.width), { copies: 1, device: device(c) })
    return c.json({ ok: true, ...r })
  } catch (e) { return printFailed(c, e) }
})

api.post('/printing/chit/:id', async (c) => {
  const module = c.req.query('module') || 'counter'
  const cfg = await printerConfig(module, device(c))
  const data = await chitForPrint(Number(c.req.param('id')))
  try {
    const r = await sendToPrinter(module, chitReceipt({
      ...data, hospital: await getHospitalInfo(),
      width: cfg.width, feedLines: cfg.feedLines
    }), { copies: cfg.copies, device: device(c) })
    return c.json({ ok: true, ...r })
  } catch (e) { return printFailed(c, e) }
})

api.post('/printing/bill/:id', async (c) => {
  const module = c.req.query('module') || 'counter'
  const cfg = await printerConfig(module, device(c))
  const data = await billForPrint(Number(c.req.param('id')))
  try {
    const r = await sendToPrinter(module, billReceipt({
      bill: data.bill, items: data.items, hospital: await getHospitalInfo(),
      width: cfg.width, feedLines: cfg.feedLines
    }), { copies: cfg.copies, device: device(c) })
    return c.json({ ok: true, ...r })
  } catch (e) { return printFailed(c, e) }
})

api.post('/printing/sale/:id', async (c) => {
  const module = c.req.query('module') || 'pharmacy'
  const cfg = await printerConfig(module, device(c))
  const data = await saleForPrint(Number(c.req.param('id')))
  try {
    const r = await sendToPrinter(module, saleReceipt({
      sale: data.sale, items: data.items, hospital: await getHospitalInfo(),
      width: cfg.width, feedLines: cfg.feedLines
    }), { copies: cfg.copies, device: device(c) })
    return c.json({ ok: true, ...r })
  } catch (e) { return printFailed(c, e) }
})

/* -------------------------------------------------------- attendance */

const attendanceAdmin = adminCan('admin.staff.edit')

api.get('/attendance/day', allow('admin', 'reports'), async (c) =>
  c.json(await attendanceDay(c.req.query('date') ?? todayLocal())))

/*
 * The screen by the door.
 *
 * A login rather than an open page: this is a list of who is in the building
 * and when they arrived, which on a hospital LAN is staff movement. The kiosk
 * role can reach this and nothing else.
 */
api.get('/attendance/recent', allow('admin', 'kiosk', 'ward', 'reports'), async (c) =>
  c.json(await recentPunches({
    since: c.req.query('since') ? Number(c.req.query('since')) : undefined
  })))

api.get('/attendance/on-site', allow('admin', 'reports'), async (c) =>
  c.json(await onSite()))

api.get('/attendance/month', allow('admin', 'reports'), async (c) =>
  c.json(await monthFor(
    Number(c.req.query('staffId')),
    Number(c.req.query('year') ?? new Date().getFullYear()),
    Number(c.req.query('month') ?? new Date().getMonth() + 1))))

api.get('/attendance/staff', attendanceAdmin, async (c) =>
  c.json(await staffForAttendance()))

/* A punch added by hand, for the morning the reader will not read a thumb. */
api.post('/attendance/punch', attendanceAdmin, async (c) => {
  const b = z.object({
    staffId: z.number().int(),
    at: z.string(),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  try {
    return c.json(await recordPunch({
      ...b, source: 'manual', by: me(c).displayName
    }), 201)
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

api.delete('/attendance/punch/:id', attendanceAdmin, async (c) => {
  try { return c.json(await deletePunch(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 404) }
})

api.get('/attendance/devices', attendanceAdmin, async (c) => c.json(await devices()))

api.post('/attendance/devices', attendanceAdmin, async (c) => {
  const b = z.object({
    id: z.number().int().optional(),
    name: z.string().min(1),
    location: z.string().nullable().optional(),
    /*
     * Declared, or zod strips it and every device silently stays a reader.
     * The same failure that left purchase orders open forever.
     */
    kind: z.enum(['reader', 'terminal']).optional(),
    host: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await saveDevice(b), b.id ? 200 : 201)
})

api.get('/attendance/fingerprints/:staffId', attendanceAdmin, async (c) =>
  c.json(await fingerprintsFor(Number(c.req.param('staffId')))))

/*
 * The template the agent produced, on its way into HMS.
 *
 * The agent cannot post this itself: it has a reader key, which is deliberately
 * only good for reading templates and writing punches. Enrolment is an
 * administrator deciding whose finger this is, so it travels with that
 * administrator's session instead.
 */
api.post('/attendance/fingerprints', attendanceAdmin, async (c) => {
  const b = z.object({
    staffId: z.number().int(),
    fingerIndex: z.number().int().min(1).max(9),
    template: z.string().min(16)
  }).parse(await c.req.json())
  return c.json(await saveFingerprint({ ...b, by: me(c).displayName }), 201)
})

api.delete('/attendance/fingerprints/:id', attendanceAdmin, async (c) =>
  c.json(await deleteFingerprint(Number(c.req.param('id')))))

/* ------------------------------------ staff onto the network terminal */

/*
 * Behind the same permission as setting somebody's terminal id by hand,
 * because that is what it ends up doing — and the first administrator's
 * account is theirs alone to change, here as on the staff form.
 */
api.get('/attendance/terminal-sync/:staffId', attendanceAdmin, async (c) =>
  c.json(await syncStatus(Number(c.req.param('staffId')))))

api.post('/attendance/terminal-sync', attendanceAdmin, async (c) => {
  const b = z.object({
    staffId: z.number().int().positive(),
    deviceId: z.number().int().positive().nullable().optional(),
    deviceUserId: z.string().max(24).nullable().optional()
  }).parse(await c.req.json())
  try { await guardRootAccount(b.staffId, me(c).id) }
  catch (e: any) { return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 403) }

  const r = await requestSync({ ...b, by: me(c).displayName })
  return c.json(r, r.existing ? 200 : 202)
})

api.post('/attendance/terminal-sync/:jobId/cancel', attendanceAdmin, async (c) =>
  c.json(await cancelJob(Number(c.req.param('jobId')))))

/* ------------------------------------------------- what the agent calls */

/*
 * The agent authenticates with its reader's key, not with a staff login.
 *
 * It runs unattended on a PC by a door and has to keep working through a
 * night shift with nobody signed in anywhere.
 */
async function agentDevice(c: any) {
  const key = c.req.header('x-device-key') ?? ''
  return deviceByKey(key)
}

api.get('/attendance/agent/templates', async (c) => {
  try {
    await agentDevice(c)
    return c.json(await templatesForAgent())
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 401) }
})

/**
 * The id-to-staff mapping, for an agent running against a terminal.
 *
 * Separate from the templates route rather than folded into it, because the
 * two modes want different things and a terminal has no business fetching
 * fingerprint templates it cannot use.
 */
api.get('/attendance/agent/roster', async (c) => {
  try {
    await agentDevice(c)
    return c.json(await rosterForAgent())
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 401) }
})

api.post('/attendance/agent/punch', async (c) => {
  let device: any
  try { device = await agentDevice(c) }
  catch (e: any) { return c.json({ error: e.message, code: 'NO_DEVICE' }, 401) }

  const b = z.object({
    staffId: z.number().int(),
    /* The agent's own clock, so a punch queued offline keeps its real time. */
    at: z.string().optional(),
    raw: z.string().nullable().optional()
  }).parse(await c.req.json())

  try {
    return c.json(await recordPunch({
      ...b, source: 'device', deviceId: device.id, by: device.name
    }), 201)
  } catch (e: any) {
    /*
     * A repeat is answered with 200, not an error.
     *
     * The agent retries anything it could not confirm, and treating a
     * duplicate as a failure would make it retry forever.
     */
    if (e.code === 'TOO_SOON') return c.json({ ok: true, duplicate: true })
    return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409)
  }
})

/*
 * Jobs for a terminal's agent: people to create on the device.
 *
 * Taking them marks them as the agent's, so a second copy of the agent
 * running by mistake with the same key does not do them twice.
 */
api.get('/attendance/agent/jobs', async (c) => {
  let device: any
  try { device = await agentDevice(c) }
  catch (e: any) { return c.json({ error: e.message, code: 'NO_DEVICE' }, 401) }
  return c.json(await claimJobs(device.id))
})

api.post('/attendance/agent/job-result', async (c) => {
  let device: any
  try { device = await agentDevice(c) }
  catch (e: any) { return c.json({ error: e.message, code: 'NO_DEVICE' }, 401) }

  const b = z.object({
    id: z.number().int().positive(),
    code: z.enum(['CREATED', 'ALREADY_PRESENT', 'DEVICE_FULL', 'DEVICE_ERROR',
      'DEVICE_UNREACHABLE', 'VERIFY_FAILED']),
    message: z.string().max(1000).nullable().optional(),
    deviceName: z.string().max(100).nullable().optional(),
    expectedName: z.string().max(100).nullable().optional()
  }).parse(await c.req.json())
  return c.json(await finishJob(device.id, b))
})

/* --------------------------------------------------------------- IPD */

/*
 * The ward, and the counter that bills for it.
 *
 * `ward` is the nursing station: the board, the admission, the notes. The
 * counter is included because the family settles the bill at the window, not
 * at the bedside.
 */
const ipdStaff = allow('admin', 'ward', 'ipd_counter', 'main_counter', 'receptionist')

api.get('/ipd/wards', ipdStaff, async (c) =>
  c.json(await wards({ all: c.req.query('all') === '1' })))

api.post('/ipd/wards', adminCan('admin.services.edit'), async (c) => {
  const b = z.object({
    id: z.number().int().optional(),
    name: z.string().min(1),
    kind: z.string().optional(),
    floor: z.string().nullable().optional(),
    chargePaisa: z.number().int().min(0),
    /* Fills a new ward with numbered beds in one go. */
    bedCount: z.number().int().min(0).max(500).optional(),
    bedPrefix: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await saveWard(b), b.id ? 200 : 201)
})

api.delete('/ipd/wards/:id', adminCan('admin.services.edit'), async (c) => {
  try { return c.json(await deleteWard(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

api.get('/ipd/beds', ipdStaff, async (c) => c.json(await bedBoard()))

api.post('/ipd/beds', adminCan('admin.services.edit'), async (c) => {
  const b = z.object({
    id: z.number().int().optional(),
    wardId: z.number().int(),
    name: z.string().min(1),
    /* Null means "whatever the ward charges". Set for private rooms. */
    chargePaisa: z.number().int().min(0).nullable().optional(),
    status: z.string().optional(),
    note: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await saveBed(b), b.id ? 200 : 201)
})

api.delete('/ipd/beds/:id', adminCan('admin.services.edit'), async (c) => {
  try { return c.json(await deleteBed(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

/* Cleaning to free, or taking a bed out of use. The ward does this, not an admin. */
api.post('/ipd/beds/:id/status', ipdStaff, async (c) => {
  const b = z.object({
    status: z.enum(['free', 'cleaning', 'reserved', 'out_of_service']),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  try { return c.json(await setBedStatus(Number(c.req.param('id')), b.status, b.note)) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

api.get('/ipd/admissions', ipdStaff, async (c) =>
  c.json(await admissions({
    status: c.req.query('status') ?? 'open', q: c.req.query('q')
  })))

api.post('/ipd/admissions', ipdStaff, async (c) => {
  const b = z.object({
    patientId: z.number().int(),
    bedId: z.number().int(),
    visitId: z.number().int().nullable().optional(),
    doctorId: z.number().int().nullable().optional(),
    departmentId: z.number().int().nullable().optional(),
    admissionType: z.enum(['planned', 'emergency', 'day_case', 'delivery']).optional(),
    diagnosis: z.string().nullable().optional(),
    attendantName: z.string().nullable().optional(),
    attendantPhone: z.string().nullable().optional(),
    attendantRelation: z.string().nullable().optional(),
    advancePaisa: z.number().int().min(0).nullable().optional()
  }).parse(await c.req.json())
  try { return c.json(await admit({ ...b, by: me(c).displayName }), 201) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

api.get('/ipd/admissions/:id', ipdStaff, async (c) => {
  try { return c.json(await account(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 404) }
})

api.post('/ipd/admissions/:id/transfer', ipdStaff, async (c) => {
  const b = z.object({
    bedId: z.number().int(), reason: z.string().nullable().optional()
  }).parse(await c.req.json())
  try {
    return c.json(await transfer({
      admissionId: Number(c.req.param('id')), ...b, by: me(c).displayName
    }))
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

api.post('/ipd/admissions/:id/charges', ipdStaff, async (c) => {
  const b = z.object({
    kind: z.enum(['bed', 'doctor', 'procedure', 'lab', 'radiology',
      'pharmacy', 'supplies', 'other']),
    description: z.string().min(1),
    qty: z.number().optional(),
    unitPaisa: z.number().int().min(0)
  }).parse(await c.req.json())
  return c.json(await addCharge({
    admissionId: Number(c.req.param('id')), ...b, by: me(c).displayName
  }), 201)
})

api.post('/ipd/admissions/:id/payments', ipdStaff, async (c) => {
  const b = z.object({
    kind: z.enum(['advance', 'payment', 'refund', 'discount', 'waived']).optional(),
    amountPaisa: z.number().int().min(1),
    method: z.string().nullable().optional(),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())

  /*
   * A discount or a waiver carries the name of whoever allowed it. They are
   * the two lines on an inpatient bill that cost the hospital money without
   * anything arriving, so neither is anonymous.
   */
  const needsApproval = b.kind === 'discount' || b.kind === 'waived'
  return c.json(await takePayment({
    admissionId: Number(c.req.param('id')), ...b,
    approvedBy: needsApproval ? me(c).displayName : null,
    by: me(c).displayName
  }), 201)
})

api.post('/ipd/admissions/:id/discharge', ipdStaff, async (c) => {
  const b = z.object({
    outcome: z.enum(['discharged', 'referred', 'lama', 'death']).optional(),
    outcomeNote: z.string().nullable().optional(),
    finalDiagnosis: z.string().nullable().optional(),
    allowBalance: z.boolean().optional()
  }).parse(await c.req.json())
  try {
    return c.json(await discharge({
      admissionId: Number(c.req.param('id')), ...b, by: me(c).displayName
    }))
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 409) }
})

/* -------------------------------------------------------- cross match */

api.get('/lab/cross-matches', allow('admin', 'lab_tech', 'reports'), async (c) =>
  c.json(await crossMatches({ q: c.req.query('q'), status: c.req.query('status') })))

api.get('/lab/cross-matches/:id', allow('admin', 'lab_tech', 'reports'), async (c) =>
  c.json(await crossMatch(Number(c.req.param('id')))))

api.post('/lab/cross-matches', allow('admin', 'lab_tech'), async (c) => {
  const b = z.object({
    patientId: z.number().int(),
    visitId: z.number().int().nullable().optional(),
    patientGroup: z.string().nullable().optional(),
    patientRh: z.string().nullable().optional(),
    donorName: z.string().min(1),
    donorAge: z.number().int().nullable().optional(),
    donorSex: z.string().nullable().optional(),
    donorGroup: z.string().nullable().optional(),
    donorRh: z.string().nullable().optional(),
    donorHb: z.string().nullable().optional(),
    bloodBagNo: z.string().nullable().optional(),
    hbsag: z.string().nullable().optional(),
    antiHcv: z.string().nullable().optional(),
    hiv: z.string().nullable().optional(),
    vdrl: z.string().nullable().optional(),
    mp: z.string().nullable().optional(),
    directPhase: z.string().nullable().optional(),
    albuminPhase: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    // Marks the booked test reported in the same transaction.
    labOrderId: z.number().int().nullable().optional(),
    sampleTakenAt: z.string().nullable().optional()
  }).parse(await c.req.json())
  try {
    return c.json(await createCrossMatch(b, me(c).displayName), 201)
  } catch (e: any) {
    return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 400)
  }
})

api.get('/lab/cross-matches/:id/pdf', async (c) => {
  const r = await crossMatch(Number(c.req.param('id')))
  const pdf = await crossMatchPdf(Number(c.req.param('id')))
  const clean = (s: any) => String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="${clean(r.patient_name)} ${clean(r.report_no)}.pdf"`
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

/*
 * The laboratory sets its own reference ranges.
 *
 * An administrator decides what a test is called and what it costs. What it
 * reports, in what units, against which ranges, is the laboratory's own
 * business: they are the ones who know what their analyser produces, and
 * routing every range change through an administrator means the ranges are
 * wrong until somebody gets round to it.
 */
/** Four columns or three, per test. Set by the laboratory. */
api.get('/services/:id/report-layout', async (c) =>
  c.json({ layout: await reportLayoutFor(Number(c.req.param('id'))) }))

api.put('/services/:id/report-layout',
  allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({ layout: z.enum(['standard', 'qualitative', 'ranges']) })
    .parse(await c.req.json())
  return c.json(await saveReportLayout(Number(c.req.param('id')), b.layout))
})

api.put('/services/:id/parameters', allow('admin', 'lab_tech', 'radiology'), async (c) => {
  const b = z.object({
    parameters: z.array(z.object({
      name: z.string().min(1),
      unit: z.string().nullable().optional(),
      refLow: z.number().nullable().optional(),
      refHigh: z.number().nullable().optional(),
      refText: z.string().nullable().optional(),
      // Normal values that differ by sex. Free text, like refText.
      maleLow: z.number().nullable().optional(),
      maleHigh: z.number().nullable().optional(),
      femaleLow: z.number().nullable().optional(),
      femaleHigh: z.number().nullable().optional(),
      hasSexRanges: z.boolean().optional(),
      // A written range: an operator and a number, so a result can be compared.
      refOp: z.enum(['<', '<=', '>', '>=', '=']).nullable().optional(),
      refValue: z.number().nullable().optional(),
      // The heading this parameter starts, for tests reported in timed blocks.
      section: z.string().nullable().optional()
    }))
  }).parse(await c.req.json())
  return c.json(await saveParameters(Number(c.req.param('id')), b.parameters))
})

api.get('/services/:id/consumables', async (c) =>
  c.json(await consumablesFor(Number(c.req.param('id')))))

/*
 * The laboratory sets what a test uses up, alongside its reference ranges.
 *
 * This was administrators only, which broke saving from the lab's own Test
 * setup screen: the dialog saves parameters and consumables together, so the
 * whole save was refused with "your role cannot do this" even though the
 * ranges themselves were allowed. Whoever runs the test knows how many
 * cuvettes it takes; an administrator does not.
 */
api.put('/services/:id/consumables', allow('admin', 'lab_tech', 'radiology'), async (c) => {
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
    serviceIds: z.array(z.number().int()).min(1),
    // Who prescribed them, where anybody did. Null is the normal case.
    doctorId: z.number().int().nullable().optional()
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

api.put('/modules', adminCan('admin.modules'), async (c) => {
  const b = z.object({
    doctor: z.boolean().optional(), opdCounter: z.boolean().optional(),
    pharmacy: z.boolean().optional(), laboratory: z.boolean().optional(),
    radiology: z.boolean().optional(), emergency: z.boolean().optional(),
    stores: z.boolean().optional()
  }).parse(await c.req.json())
  return c.json(await saveModules(b))
})

api.put('/settings/hospital', adminCan('admin.settings'), async (c) => {
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

/* -------------------------------------------- discounts at the counter */

/**
 * The same two rules the pharmacy has, under their own keys.
 *
 * Readable by anybody who can open the till, because the screen has to know
 * whether to draw the box at all. Writable only by an administrator holding
 * admin.settings — a cashier who can raise their own ceiling has no ceiling.
 */
api.get('/settings/counter-discount', async (c) => c.json({
  discountEnabled: ((await getSetting('counter.discountEnabled')) ?? 'true') !== 'false',
  /* Zero means no ceiling, which is how this till behaved before the
   * setting existed. The switch is what turns discounts off. */
  discountMaxPct: Number((await getSetting('counter.discountMaxPct')) ?? '0')
}))

api.put('/settings/counter-discount', adminCan('admin.settings'), async (c) => {
  const b = z.object({
    discountEnabled: z.boolean().optional(),
    discountMaxPct: z.number().int().min(0).max(100).optional()
  }).parse(await c.req.json())
  if (b.discountEnabled !== undefined) {
    await setSetting('counter.discountEnabled', b.discountEnabled ? 'true' : 'false')
  }
  if (b.discountMaxPct !== undefined) {
    await setSetting('counter.discountMaxPct', String(b.discountMaxPct))
  }
  return c.json({
    discountEnabled: ((await getSetting('counter.discountEnabled')) ?? 'true') !== 'false',
    discountMaxPct: Number((await getSetting('counter.discountMaxPct')) ?? '0')
  })
})

api.get('/admin/backups', adminCan('admin.backup'), async (c) => c.json(await listBackups()))

/* ------------------------------------------------ where backups are kept */

api.get('/admin/backup-location', adminCan('admin.backup'), async (c) => c.json({
  defaultDir: backupDir(),
  extraDir: await extraBackupDir(),
  lastCopyAt: await getSetting('backup.lastCopyAt'),
  lastCopyError: await getSetting('backup.lastCopyError')
}))

api.put('/admin/backup-location', adminCan('admin.backup'), async (c) => {
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

/* -------------------------------------------- what an administrator may do */

api.get('/admin/permissions', adminOnly, (c) => c.json(ADMIN_PERMISSIONS))

/** Own permissions, so the screen knows which tabs to draw. */
api.get('/admin/permissions/me', adminOnly, async (c) =>
  c.json(await adminPermissionsFor(me(c).id)))

api.get('/admin/accounts', adminCan('admin.access'), async (c) =>
  c.json(await adminAccounts()))

api.get('/admin/permissions/:staffId', adminCan('admin.access'), async (c) =>
  c.json(await adminPermissionsFor(Number(c.req.param('staffId')))))

api.put('/admin/permissions/:staffId', adminCan('admin.access'), async (c) => {
  const b = z.object({ allowed: z.array(z.string()) }).parse(await c.req.json())
  try {
    return c.json(await saveAdminPermissions(Number(c.req.param('staffId')), b.allowed))
  } catch (e: any) {
    return c.json({ error: e.message, code: 'NOT_ALLOWED' }, 409)
  }
})

api.get('/admin/wipe-preview', adminCan('admin.wipe'), async (c) => c.json(await wipePreview()))

api.post('/admin/wipe', adminCan('admin.wipe'), async (c) => {
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
api.post('/admin/backups', adminCan('admin.backup'), async (c) => c.json(await runBackup('manual'), 201))

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

/* ------------------------------------------------- stock audits */

api.post('/pharma/audits/preview', async (c) => {
  const b = z.object({
    scope: z.enum(['product', 'manufacturer', 'rack']),
    ref: z.string().nullable().optional(),
    productIds: z.array(z.number().int()).optional()
  }).parse(await c.req.json())
  return c.json(await previewScope(b))
})

api.post('/pharma/audits', async (c) => {
  const b = z.object({
    scope: z.enum(['product', 'manufacturer', 'rack']),
    ref: z.string().nullable().optional(),
    productIds: z.array(z.number().int()).optional(),
    title: z.string().nullable().optional(),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  try { return c.json(await createAudit({ ...b, by: me(c).displayName }), 201) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 400) }
})

api.get('/pharma/audits', async (c) => c.json(await audits({
  status: c.req.query('status'), q: c.req.query('q'),
  from: c.req.query('from'), to: c.req.query('to')
})))

api.get('/pharma/audits/:id', async (c) => {
  try { return c.json(await auditOne(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 404) }
})

api.get('/pharma/audits/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'))
  const { audit: a } = await auditOne(id)
  const pdf = await auditSheetPdf(id)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="Count sheet ${a.audit_no}.pdf"`
    }
  })
})

api.post('/pharma/audits/:id/close', async (c) =>
  c.json(await closeAudit(Number(c.req.param('id')), me(c).displayName)))

/* --------------------------------------------- stock adjustments */

api.post('/pharma/adjustments', async (c) => {
  const b = z.object({
    auditId: z.number().int(),
    counts: z.array(z.object({
      productId: z.number().int(),
      /*
       * No upper bound here on purpose. A pharmacy that finds more than the
       * system knew about has found something worth recording, and refusing
       * the number would make somebody write a smaller one.
       */
      countedQty: z.number().int().min(0)
    })).min(1),
    note: z.string().nullable().optional()
  }).parse(await c.req.json())
  try {
    return c.json(await createAdjustment({ ...b, by: me(c).displayName }), 201)
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 400) }
})

api.get('/pharma/adjustments', async (c) => c.json(await adjustments({
  from: c.req.query('from'), to: c.req.query('to'), q: c.req.query('q')
})))

api.get('/pharma/adjustments/history', async (c) => c.json(await adjustmentHistory({
  from: c.req.query('from'), to: c.req.query('to'),
  productId: c.req.query('productId') ? Number(c.req.query('productId')) : undefined,
  manufacturer: c.req.query('manufacturer')
})))

api.get('/pharma/adjustments/by-company', async (c) =>
  c.json(await adjustmentsByCompany({
    from: c.req.query('from'), to: c.req.query('to')
  })))

api.get('/pharma/adjustments/:id', async (c) => {
  try { return c.json(await adjustmentOne(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 404) }
})

api.get('/pharma/adjustments/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'))
  const { adjustment: a } = await adjustmentOne(id)
  const pdf = await adjustmentPdf(id)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="Adjustment ${a.adjustment_no}.pdf"`
    }
  })
})

/* ------------------------------------------ damage and expiry write-offs */

/**
 * Stock off the shelf without a sale.
 *
 * Under /pharma, so it is behind the same role gate as audits and
 * adjustments: a counter hand can sell, but taking stock out of existence is
 * the pharmacist's signature.
 */

api.get('/pharma/write-offs/shelf', async (c) => {
  const d = c.req.query('expiringWithinDays')
  return c.json(await shelf({
    q: c.req.query('q') ?? undefined,
    /*
     * Zero is a real window — "what has already expired" — so it cannot be
     * tested for truthiness. Written out rather than left to a `||`, which
     * is how a zero-day window silently became no window at all.
     */
    expiringWithinDays: d === undefined || d === '' ? undefined : Number(d)
  }))
})

/**
 * Checked on the server as well as hidden in the rail.
 *
 * A hidden tab is a courtesy, not a control: the route is reachable by
 * anybody who can open the pharmacy at all, and this is the one place where
 * stock stops existing. The read routes are deliberately left open to the
 * module, because seeing what was thrown away is not the dangerous half.
 */
async function canWriteOff(c: any, kind: string) {
  const u = me(c)
  if (u.role === 'admin') return true
  return hasPharmaPermission(u.id,
    kind === 'damage' ? 'stock.damage' : 'stock.expiry')
}

api.post('/pharma/write-offs', async (c) => {
  const b = z.object({
    kind: z.enum(['damage', 'expiry']),
    note: z.string().nullable().optional(),
    lines: z.array(z.object({
      productId: z.number().int(),
      batchId: z.number().int().nullable().optional(),
      qty: z.number().int().min(1),
      reason: z.string().nullable().optional()
    })).min(1)
  }).parse(await c.req.json())
  if (!(await canWriteOff(c, b.kind))) {
    return c.json({
      error: b.kind === 'damage'
        ? 'You are not set up to write off damaged stock'
        : 'You are not set up to write off expired stock',
      code: 'NOT_ALLOWED'
    }, 403)
  }
  try {
    return c.json(await createWriteOff({ ...b, by: me(c).displayName }), 201)
  } catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 400) }
})

api.get('/pharma/write-offs', async (c) => c.json(await writeOffs({
  kind: c.req.query('kind') as any,
  q: c.req.query('q'), from: c.req.query('from'), to: c.req.query('to')
})))

api.get('/pharma/write-offs/:id', async (c) => {
  try { return c.json(await writeOffOne(Number(c.req.param('id')))) }
  catch (e: any) { return c.json({ error: e.message, code: e.code ?? 'ERROR' }, 404) }
})

api.get('/pharma/write-offs/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'))
  const w: any = await writeOffOne(id)
  const pdf = await writeOffPdf(id, me(c).displayName)
  return new Response(pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; ` +
        `filename="${w.kind === 'damage' ? 'Damage' : 'Expiry'} ${w.write_off_no}.pdf"`
    }
  })
})

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
api.post('/admin/demo-data', adminCan('admin.demo'), async (c) => {
  const b = z.object({
    reset: z.boolean().default(false),
    days: z.number().int().min(1).max(180).default(45),
    /*
     * The pharmacy's trading, on by default.
     *
     * It was never loaded from here at all. The only way to get it was
     * `npm run seed:pharmacy` at a terminal, which nobody has on a machine
     * installed from the offline bundle — so a trial install loaded its demo
     * from this screen and got a pharmacy full of medicines with no bills
     * behind them.
     */
    pharmacy: z.boolean().default(true)
  }).parse(await c.req.json().catch(() => ({})))

  if (!b.reset && await hasAnyData()) {
    return c.json({
      error: 'There are already patients in this system',
      detail: 'Loading demo data on top would mix real records with invented ones. ' +
              'Choose the replace option if this is a test system.',
      code: 'HAS_DATA'
    }, 409)
  }
  return c.json(await loadDemoData(
    { reset: b.reset, days: b.days, pharmacy: b.pharmacy }), 201)
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
