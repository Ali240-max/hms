import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Hospital details, used as the letterhead on every printed document.
 *
 * Kept as key/value rather than a one-row table so adding a field later needs
 * no migration on an install that is already running in a hospital.
 */

export type HospitalInfo = {
  name: string
  tagline: string
  address: string
  phone: string
  email: string
  ntn: string
  licenceNo: string
  chitFooter: string
  receiptFooter: string
  /** PNG or JPEG as a data URI, printed at the top left of every report. */
  logoDataUri: string
}

export const DEFAULT_INFO: HospitalInfo = {
  name: 'Hospital Name',
  tagline: '',
  address: '',
  phone: '',
  email: '',
  ntn: '',
  licenceNo: '',
  chitFooter: 'Please pay at the counter and keep this slip.',
  receiptFooter: 'Get well soon.',
  logoDataUri: ''
}

export async function getHospitalInfo(): Promise<HospitalInfo> {
  const rows = (await db.execute<any>(sql`
    SELECT key, value FROM settings WHERE key LIKE 'hospital.%'`)).rows
  const out = { ...DEFAULT_INFO }
  for (const r of rows) {
    const k = r.key.replace('hospital.', '') as keyof HospitalInfo
    if (k in out) out[k] = r.value
  }
  return out
}

export async function saveHospitalInfo(patch: Partial<HospitalInfo>) {
  const entries = Object.entries(patch).filter(([k]) => k in DEFAULT_INFO)
  if (entries.length === 0) return getHospitalInfo()
  await db.transaction(async (tx) => {
    for (const [k, v] of entries) {
      await tx.execute(sql`
        INSERT INTO settings (key, value, updated_at)
        VALUES (${'hospital.' + k}, ${String(v ?? '')}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`)
    }
  })
  return getHospitalInfo()
}

export async function getSetting(key: string): Promise<string | null> {
  const r = (await db.execute<any>(sql`SELECT value FROM settings WHERE key = ${key}`)).rows[0]
  return r?.value ?? null
}

export async function setSetting(key: string, value: string) {
  await db.execute(sql`
    INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`)
}

/* --------------------------------------------------------------- modules */

/**
 * Which parts of the system this hospital is actually using.
 *
 * Not every hospital buys everything at once. The first deployment here is the
 * main counter, the laboratory and radiology — no doctor terminal, no
 * pharmacy, because their pharmacy is a separate business that is not
 * connecting yet.
 *
 * Turning a module off hides its sign-in cell and its screens. It does **not**
 * delete anything or block the API: a hospital that switches the doctor module
 * on in March must find its January data exactly where it left it, and a
 * half-migrated database is a far worse failure than an extra button.
 *
 * Off means "we are not using this yet", never "this never existed".
 */
export type Modules = {
  doctor: boolean
  opdCounter: boolean
  pharmacy: boolean
  laboratory: boolean
  radiology: boolean
  emergency: boolean
  stores: boolean
}

export const DEFAULT_MODULES: Modules = {
  doctor: true,
  opdCounter: true,
  pharmacy: true,
  laboratory: true,
  radiology: true,
  emergency: true,
  stores: true
}

export async function getModules(): Promise<Modules> {
  const rows = (await db.execute<any>(sql`
    SELECT key, value FROM settings WHERE key LIKE 'module.%'`)).rows as any[]
  const out = { ...DEFAULT_MODULES }
  for (const r of rows) {
    const k = String(r.key).replace('module.', '') as keyof Modules
    if (k in out) out[k] = r.value === 'true'
  }
  return out
}

export async function saveModules(patch: Partial<Modules>) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_MODULES)) continue
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES (${'module.' + k}, ${String(!!v)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
  }
  return getModules()
}
