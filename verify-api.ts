/**
 * Exercises the API over a real socket, the way a browser does.
 *
 * Service-level tests cannot see a missing route or a role check that was only
 * ever implemented in the client, so anything the UI talks to gets tested the
 * same way the UI arrives.
 */
import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { db, pool, runMigrations } from './src/server/db/client'
import * as s from './src/server/db/schema'
import { api } from './src/server/api/index'
import { createFirstAdmin, createStaff } from './src/server/services/auth'
import { upsertService } from './src/server/services/clinical'

let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') =>
  c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l} ${d}`))

const PORT = 4599
const base = `http://127.0.0.1:${PORT}/api`
let tok = ''
const call = async (m: string, p: string, body?: any) => {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const as = async (u: string, p: string) => { tok = (await call('POST', '/auth/login', { username: u, password: p })).body.token }

async function main() {
  await runMigrations()
  await db.execute(sql`
    TRUNCATE doctor_earnings, service_orders, prescription_items, prescriptions,
             visits, patients, doctor_service_shares, services, doctors, staff,
             departments, sale_items, sales, stock_ledger, batches, products,
             settings, counters RESTART IDENTITY CASCADE`)

  const [dept] = await db.insert(s.departments).values({ name: 'General', code: 'GEN' }).returning()
  await createFirstAdmin({ username: 'admin', displayName: 'Admin', password: 'longenough1' })
  // Two counters now: the main counter handles money, the OPD desk the queue.
  await createStaff({ username: 'recep', displayName: 'Sana', password: '1234', role: 'main_counter' })
  await createStaff({ username: 'opd', displayName: 'Nadia', password: '1234', role: 'receptionist' })
  await createStaff({ username: 'pharm', displayName: 'Bilal', password: '1234', role: 'pharmacist' })
  await createStaff({
    username: 'doc', displayName: 'Dr Yasir', password: '1234', role: 'doctor', departmentId: dept.id,
    doctor: { consultationFeePaisa: 100000, consultationShareBp: 6000, defaultServiceShareBp: 1000 }
  })
  const xray = await upsertService({ name: 'X-Ray', category: 'radiology', pricePaisa: 100000, defaultShareBp: 2000 })
  const [med] = await db.insert(s.products).values({ name: 'Panadol 500mg', packSize: 10 }).returning()
  await db.insert(s.batches).values({ productId: med.id, batchNo: 'B1', expiryDate: '2027-12-31',
    costPaisa: 3800, pricePaisa: 5000, qtyOnHand: 300 })

  const server = serve({ fetch: (r: Request) => api.fetch(new Request(r.url.replace('/api', ''), r)), port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 300))

  console.log('\n[1] Anonymous callers are refused')
  tok = ''
  check('queue needs a session', (await call('GET', '/visits/queue')).status === 401)
  check('patients need a session', (await call('GET', '/patients/search?q=abc')).status === 401)
  check('health is open', (await call('GET', '/health')).status === 200)

  console.log('\n[2] Roles are enforced on the server, not just hidden in the UI')
  await as('recep', '1234')
  check('main counter cannot list staff', (await call('GET', '/staff')).status === 403)
  check('main counter cannot add a service', (await call('POST', '/services',
    { name: 'X', category: 'lab', pricePaisa: 1, defaultShareBp: 0 })).status === 403)
  check('main counter CAN register a patient',
    (await call('POST', '/patients', { name: 'Test Patient', phone: '0300-1112222' })).status === 201)

  await as('doc', '1234')
  check('a doctor cannot add staff', (await call('POST', '/staff',
    { username: 'x', password: 'yyyy', role: 'admin' })).status === 403)
  check('a doctor cannot change prices', (await call('POST', '/services',
    { name: 'Y', category: 'lab', pricePaisa: 1, defaultShareBp: 0 })).status === 403)

  await as('pharm', '1234')
  check('pharmacy cannot write a prescription',
    (await call('POST', '/visits/1/consultation', { items: [], services: [] })).status === 403)
  check('pharmacy CAN read its own queue', (await call('GET', '/pharmacy/prescriptions')).status === 200)

  console.log('\n[3] The whole patient journey over HTTP')
  await as('recep', '1234')
  const p = (await call('POST', '/patients', { name: 'Asif Mahmood', phone: '0300-1234567', ageYears: 34 })).body
  check('registered with an MRN', /^MRN-/.test(p.mrn), p.mrn)
  const doctors = (await call('GET', '/doctors')).body
  const v = (await call('POST', '/visits', { patientId: p.id, doctorId: doctors[0].id, complaint: 'Fever', feePaid: true })).body
  check('visit created with a token', v.tokenNo >= 1, String(v.tokenNo))

  await as('doc', '1234')
  const q = (await call('GET', '/visits/queue')).body
  check('the doctor sees only their own queue', q.every((x: any) => x.doctor_id === doctors[0].id))
  check('the new patient is in it', q.some((x: any) => x.id === v.id))

  const cons = await call('POST', `/visits/${v.id}/consultation`, {
    diagnosis: 'Viral fever',
    items: [{ productId: med.id, drugName: 'Panadol 500mg', qtyPrescribed: 9, frequency: 'TDS' }],
    services: [{ serviceId: xray.id }]
  })
  check('consultation saved', cons.status === 201, JSON.stringify(cons.body))

  await as('pharm', '1234')
  const pq = (await call('GET', '/pharmacy/prescriptions')).body
  check('the pharmacy can see it', pq.some((x: any) => x.visit_id === v.id))
  const detail = (await call('GET', `/visits/${v.id}/prescription`)).body
  check('with the medicine', detail.items[0].drug_name === 'Panadol 500mg')
  check('and live stock alongside it', detail.items[0].in_stock === 300, String(detail.items[0].in_stock))

  console.log('\n[4] Doctor earnings')
  await as('doc', '1234')
  const today = new Date().toISOString().slice(0, 10)
  const earn = (await call('GET', `/earnings/me?from=${today}&to=${today}`)).body
  check('consultation share Rs 600', Number(earn.totals.consultation_paisa) === 60000, String(earn.totals.consultation_paisa))
  check('X-ray share Rs 200', Number(earn.totals.service_paisa) === 20000, String(earn.totals.service_paisa))

  await as('recep', '1234')
  check('reception cannot read earnings', (await call('GET', `/earnings/me?from=${today}&to=${today}`)).status === 403)
  await as('admin', 'longenough1')
  check('an admin can see every doctor', (await call('GET', `/earnings/all?from=${today}&to=${today}`)).body.length >= 1)

  console.log('\n[5] The prescribing doctor comes from the session, not the body')
  await as('doc', '1234')
  const p2 = { name: 'Second Patient', phone: '0300-9999999' }
  await as('recep', '1234')
  const pat2 = (await call('POST', '/patients', p2)).body
  const v2 = (await call('POST', '/visits', { patientId: pat2.id, doctorId: doctors[0].id })).body
  await as('doc', '1234')
  await call('POST', `/visits/${v2.id}/consultation`, {
    doctorId: 9999, items: [], services: [{ serviceId: xray.id }]
  })
  const who = ((await db.execute<any>(sql`SELECT doctor_id FROM service_orders WHERE visit_id=${v2.id}`)).rows as any[])[0]
  check('a forged doctorId in the body is ignored', Number(who.doctor_id) === doctors[0].id,
    `credited to ${who.doctor_id}, not 9999`)

  console.log(`\n${'='.repeat(48)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(48)}`)
  server.close()
  await pool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1) })
