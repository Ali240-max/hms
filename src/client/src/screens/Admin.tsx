import { motion } from 'framer-motion'
import { DUR, EASE } from '../lib/motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, rs, toPaisa, bpToPct, pctToBp, today, type SessionUser , newId} from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Tabs, Th } from '../components/ui'
import { useT } from '../lib/prefs'
import { Sidebar, type NavItem } from '../components/Sidebar'
import { Reports } from './pharma/Reports'
import { useModules } from '../lib/modules'
import { BackupLocationCard, DangerZoneCard } from './admin/DangerZone'
import { AdminAccess } from './admin/AdminAccess'
import { ReportAccess } from './admin/ReportAccess'
import { WardSetup } from './admin/WardSetup'
import { Attendance } from './admin/Attendance'
import {
  LayoutDashboard, BarChart3, Users, Percent, ClipboardList,
  Building2, Settings, Database, FlaskConical, ScanLine, Syringe, Plus, AlertTriangle,
  ShieldCheck, Upload, BedDouble, Clock } from 'lucide-react'
import { t as tr } from '../lib/prefs'

const TABS = ['Overview', 'Staff', 'Services', 'Doctor shares', 'Departments',
  'Wards and beds', 'Attendance', 'Reports', 'Access', 'Report access',
  'Demo data', 'Settings'] as const
type Tab = typeof TABS[number]

const NAV: (NavItem & { id: Tab })[] = [
  { id: 'Overview', label: 'Overview', glyph: 'O', icon: LayoutDashboard },
  { id: 'Reports', label: 'Reports', glyph: 'R', icon: BarChart3 },
  { id: 'Staff', label: 'Staff', glyph: 'S', icon: Users, section: 'People' },
  { id: 'Doctor shares', label: 'Doctor shares', glyph: 'D', icon: Percent },
  { id: 'Services', label: 'Services', glyph: 'Sv', icon: ClipboardList, section: 'Setup' },
  { id: 'Departments', label: 'Departments', glyph: 'Dp', icon: Building2 },
  { id: 'Wards and beds', label: 'Wards and beds', glyph: 'Wb', icon: BedDouble },
  { id: 'Attendance', label: 'Attendance', glyph: 'At', icon: Clock },
  { id: 'Access', label: 'Access', glyph: 'Ac', icon: ShieldCheck },
  { id: 'Report access', label: 'Report access', glyph: 'Ra', icon: BarChart3 },
  { id: 'Settings', label: 'Settings', glyph: 'St', icon: Settings },
  { id: 'Demo data', label: 'Demo data', glyph: 'Dm', icon: Database }
]

export function Admin({ me }: { me: SessionUser }) {
  const tr = useT()
  const [tab, setTab] = useState<Tab>('Overview')

  /**
   * What this administrator is allowed to change.
   *
   * Until it loads, every tab is shown. That is deliberate: a slow answer
   * should not flash a stripped-down panel at the person who owns the
   * hospital. Pressing something they cannot do is refused by the server
   * anyway, so the worst case is a message rather than a wrong action.
   */
  const [allowed, setAllowed] = useState<Set<string> | null>(null)
  useEffect(() => {
    api.myAdminPermissions()
      .then((r: any) => setAllowed(new Set(r.allowed)))
      .catch(() => setAllowed(null))
  }, [])

  const can = (t: string) => {
    const key = TAB_PERMISSION[t]
    return !key || !allowed || allowed.has(key)
  }
  const items = NAV.filter((n) => can(n.id))

  // If the tab we are on becomes one this account cannot use, move somewhere
  // it can rather than showing an empty panel.
  useEffect(() => {
    if (allowed && !can(tab)) setTab((items[0]?.id as Tab) ?? 'Overview')
  }, [allowed])

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={items} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Administration" subtitle={me.displayName} brandIcon={Building2} />
      {/*
        A keyed panel that animates in, with no exit and no AnimatePresence.

        This was `AnimatePresence mode="wait"`, which holds the incoming tab
        until the outgoing one has finished animating away. When that exit
        never completed — an interrupted transition, a child unmounting with
        its own exit animation partway through — the new tab was never mounted
        and every screen in the module stayed blank until the whole app was
        remounted by signing in again.

        Waiting buys a slightly tidier crossfade and costs a module that can
        wedge itself. Not a trade worth making on a counter.
      */}
        <motion.div key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.page, ease: EASE }}
          className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
      {tab === 'Overview' && <Overview />}
      {tab === 'Staff' && <StaffTab me={me} />}
      {tab === 'Services' && <ServicesTab />}
      {tab === 'Doctor shares' && <SharesTab />}
      {tab === 'Departments' && <DepartmentsTab />}
      {tab === 'Demo data' && <DemoTab />}
      {tab === 'Settings' && <SettingsTab />}
      {tab === 'Settings' && <BackupLocationCard />}
      {tab === 'Settings' && <DangerZoneCard me={me} />}
      {tab === 'Reports' && <Reports me={me} />}
      {tab === 'Wards and beds' && <WardSetup />}
      {tab === 'Attendance' && <Attendance me={me} />}
      {tab === 'Access' && <AdminAccess me={me} />}
      {tab === 'Report access' && <ReportAccess me={me} />}
      </motion.div>
    </div>
  )
}

/* -------------------------------------------------------------- overview */

function Overview() {
  const [stats, setStats] = useState<any>(null)
  const [earnings, setEarnings] = useState<any[]>([])
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())

  useEffect(() => { api.statsToday().then(setStats).catch(() => {}) }, [])
  useEffect(() => { api.allEarnings(from, to).then(setEarnings).catch(() => {}) }, [from, to])

  const totalEarned = earnings.reduce((n, d) => n + Number(d.earned_paisa), 0)
  const totalBilled = earnings.reduce((n, d) => n + Number(d.generated_paisa), 0)

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Administrative figures, so these count. Nothing clinical here. */}
        <Stat label={tr('Patients today')} value={String(stats?.visits ?? 0)}
          count={Number(stats?.visits ?? 0)}
          sub={`${stats?.new_patients ?? 0} newly registered`} />
        {/*
          Not counted. "Waiting now" is a queue length somebody acts on, and a
          figure sweeping up from zero reads as a queue that is growing.
        */}
        <Stat label={tr('Waiting now')} value={String(stats?.waiting ?? 0)} tone="warn" />
        <Stat label={tr('Consultation fees')} value={`Rs ${rs(stats?.fees_paisa)}`} tone="accent" />
        <Stat label={tr('Tests and scans')} value={`Rs ${rs(stats?.services_paisa)}`} tone="accent" />
      </div>

      <Card title={tr('Doctor earnings')} hint={tr('Read from the ledger, so it does not move if a price changes')}
        action={
          <div className="flex items-center gap-2 text-2xs">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="field w-36 py-1.5 num" />
            <span className="text-muted">{tr('to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="field w-36 py-1.5 num" />
          </div>
        }>
        {earnings.length === 0 ? (
          <Empty title={tr('Nothing earned in this period')} />
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Stat label={tr('Billed to patients')} value={`Rs ${rs(totalBilled)}`} tone="primary" />
              <Stat label={tr('Owed to doctors')} value={`Rs ${rs(totalEarned)}`} tone="accent"
                sub={totalBilled > 0 ? `${((totalEarned / totalBilled) * 100).toFixed(0)}% of what was billed` : undefined} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="thead-strip">
                  <tr>
                    <Th>{tr('Doctor')}</Th><Th w="w-40">{tr('Department')}</Th>
                    <Th w="w-24" right>{tr('Patients')}</Th><Th w="w-24" right>{tr('Tests')}</Th>
                    <Th w="w-28" right>{tr('Billed')}</Th><Th w="w-28" right>{tr('Earned')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide rows-striped anim-rows">
                  {earnings.map((d) => (
                    <tr key={d.doctor_id}>
                      <td className="px-3 py-2 text-sm text-heading">{d.doctor_name}</td>
                      <td className="px-3 py-2 text-2xs text-muted">{d.department ?? '—'}</td>
                      <td className="px-3 py-2 text-right num text-2xs">{d.consultations}</td>
                      <td className="px-3 py-2 text-right num text-2xs">{d.services}</td>
                      <td className="px-3 py-2 text-right num text-2xs text-muted">{rs(d.generated_paisa)}</td>
                      <td className="px-3 py-2 text-right num font-medium text-primary">{rs(d.earned_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

/* ----------------------------------------------------------------- staff */

function StaffTab({ me }: { me: SessionUser }) {
  const [rows, setRows] = useState<any[]>([])
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<any | null>(null)
  const [editing, setEditing] = useState<any | null>(null)
  const [deleting, setDeleting] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => { api.staff().then(setRows).catch((e) => setErr(e.message)) }, [])
  useEffect(() => { load() }, [load])

  // Grouped by role rather than one long list: the questions an admin actually
  // asks are "which doctors do we have" and "who is on reception", not "who is
  // alphabetically third".
  const GROUPS: [string, string, string][] = [
    ['doctor', 'Doctors', 'Consultation fee and the share they keep'],
    ['main_counter', 'Main counter', 'Registration, fees and chit payments'],
    ['receptionist', 'OPD counter', 'Queue and vitals — handles no money'],
    ['ipd_counter', 'Emergency', 'Admits arrivals and records bedside medicines'],
    ['store_keeper', 'Stores', 'Hospital consumables — gauze, gloves, IV sets'],
    ['lab_tech', 'Laboratory', 'Takes samples, enters results, issues reports'],
    ['reports', 'Reports', 'Reads every report in the hospital and changes nothing'],
    ['radiology', 'Radiology', 'X-ray and imaging — its own work list'],
    ['pharmacist', 'Pharmacy', 'Run the till and hold stock'],
    ['admin', 'Administrators', 'Full access, including staff and rates']
  ]

  return (
    <Card title={tr('Staff')} hint={tr('Everyone who can sign in')}
      action={<button onClick={() => setAdding(true)} className="btn-primary">{tr('Add staff')}</button>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="space-y-5 overflow-x-auto">
        {GROUPS.map(([role, label, blurb]) => {
          const group = rows.filter((u) => u.role === role)
          return (
            <section key={role}>
              <div className="flex items-baseline justify-between border-b border-divide pb-1.5">
                <h3 className="text-sm font-medium text-heading">
                  {tr(label)} <span className="num ml-1 text-2xs font-normal text-muted">{group.length}</span>
                </h3>
                <p className="text-2xs text-muted">{tr(blurb)}</p>
              </div>
              {group.length === 0 ? (
                <p className="py-3 text-2xs text-muted">{tr('Nobody in this role yet.')}</p>
              ) : (
        <table className="w-full">
          <thead>
            <tr>
              <Th>{tr('Name')}</Th><Th w="w-28">{tr('Username')}</Th>
              <Th w="w-36">{tr('Department')}</Th><Th w="w-28" right>{tr('Fee')}</Th>
              <Th w="w-24" right>{tr('Keeps')}</Th><Th w="w-40" right />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {group.map((u) => (
              <tr key={u.id} className={u.is_active ? '' : 'opacity-50'}>
                <td className="px-3 py-2">
                  <span className="text-sm text-heading">{u.display_name}</span>
                  {u.id === me.id && <span className="ml-1 text-2xs text-muted">(you)</span>}
                  {!u.is_active && <Badge>{tr('retired')}</Badge>}
                  {u.specialisation && <div className="text-2xs text-muted">{u.specialisation}</div>}
                </td>
                <td className="px-3 py-2 text-2xs text-muted">{u.username}</td>
                <td className="px-3 py-2 text-2xs text-muted">{u.department_name ?? '—'}</td>
                <td className="px-3 py-2 text-right num text-2xs">
                  {u.doctor_id ? rs(u.consultation_fee_paisa) : '—'}
                </td>
                <td className="px-3 py-2 text-right num text-2xs text-primary">
                  {u.doctor_id ? `${bpToPct(u.consultation_share_bp)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditing(u)} className="btn-ghost mr-1 px-2 py-1 text-2xs">
                    {tr('Edit')}
                  </button>
                  <button onClick={() => setResetting(u)} className="btn-ghost mr-1 px-2 py-1 text-2xs">
                    {tr('Password')}
                  </button>
                  {/*
                    Delete outright. Refused by the server once the person has
                    taken a bill or reported a result, because those records
                    carry their name: the answer there is to archive, and the
                    message says so.
                  */}
                  <button disabled={u.id === me.id}
                    onClick={() => setDeleting(u)}
                    className="btn-ghost px-2 py-1 text-2xs text-bad">
                    {tr('Delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
              )}
            </section>
          )
        })}
      </div>

      {adding && <AddStaff onClose={() => setAdding(false)} onDone={() => { setAdding(false); load() }} />}
      {resetting && (
        <ResetPassword user={resetting} onClose={() => setResetting(null)}
          onDone={() => { setResetting(null); load() }} />
      )}
      {editing && (
        <EditStaff user={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }} />
      )}
      {deleting && (
        <DeleteStaff user={deleting} onClose={() => setDeleting(null)}
          onDone={() => { setDeleting(null); load() }} />
      )}
    </Card>
  )
}

function AddStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    username: '', displayName: '', password: '', role: 'main_counter',
    departmentId: '', phone: '', specialisation: '', qualification: '', room: '',
    fee: '', consultShare: '100', serviceShare: '0', pharmacyAdmin: false,
    shiftStart: '', shiftEnd: '', attendanceRequired: true
  })
  const [depts, setDepts] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api.departments().then(setDepts).catch(() => {}) }, [])

  const isDoctor = f.role === 'doctor'

  async function save() {
    setBusy(true); setErr(null)
    try {
      const created = await api.createStaff({
        username: f.username.trim(), displayName: f.displayName.trim(),
        password: f.password, role: f.role,
        departmentId: f.departmentId ? Number(f.departmentId) : null,
        phone: f.phone.trim() || null,
        shiftStart: f.shiftStart || null,
        shiftEnd: f.shiftEnd || null,
        attendanceRequired: f.attendanceRequired,
        ...(isDoctor ? {
          doctor: {
            specialisation: f.specialisation.trim() || null,
            qualification: f.qualification.trim() || null,
            room: f.room.trim() || null,
            consultationFeePaisa: toPaisa(f.fee),
            consultationShareBp: pctToBp(f.consultShare),
            defaultServiceShareBp: pctToBp(f.serviceShare)
          }
        } : {})
      })

      /**
       * A pharmacy administrator is a pharmacist with every permission ticked,
       * including the one that lets them set other people's. Stored as
       * permissions rather than as a role so it can be given and taken away
       * without touching the account.
       */
      if (f.role === 'pharmacist' && f.pharmacyAdmin && created?.id) {
        const all = await api.pharmaPermissions()
        await api.savePermissions(created.id, all.map((p: any) => p.key))
      }
      onDone()
    } catch (e: any) { setErr(e.message ?? 'Could not add') }
    finally { setBusy(false) }
  }

  return (
    <Modal title={tr('Add staff')} wide onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button onClick={save} disabled={busy || !f.username.trim() || !f.password}
            className="btn-primary">{busy ? 'Saving…' : 'Add'}</button>
        </>
      }>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Full name')}>
          <input autoFocus value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })}
            placeholder={tr('Dr Yasir Habib')} className="field" />
        </Field>
        <Field label={tr('Username')}>
          <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })}
            autoCapitalize="off" placeholder="dr.yasir" className="field" />
        </Field>
        <Field label={tr('Role')}>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="field">
            <option value="main_counter">{tr('Main counter — registration and payments')}</option>
            <option value="receptionist">{tr('OPD counter — queue and vitals')}</option>
            <option value="ipd_counter">{tr('Emergency — admissions and bedside medicines')}</option>
            <option value="store_keeper">{tr('Stores — hospital consumables')}</option>
            <option value="ward">{tr('Ward — beds, admissions and discharges')}</option>
            {/*
              The terminal by the door. It can read the scan board and nothing
              else, so it is safe to leave signed in on a machine anybody can
              reach.
            */}
            <option value="kiosk">
              {tr('Attendance board — the screen by the door, nothing else')}
            </option>
            <option value="lab_tech">{tr('Laboratory — samples and results')}</option>
            <option value="reports">{tr('Reports — every report, read only')}</option>
            <option value="radiology">{tr('Radiology — x-ray and imaging')}</option>
            <option value="doctor">{tr('Doctor')}</option>
            <option value="pharmacist">{tr('Pharmacy — counter, stock and reports')}</option>
            <option value="admin">{tr('Administrator')}</option>
          </select>
        </Field>
        <Field label={tr('Department')}>
          <select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}
            className="field">
            <option value="">{tr('None')}</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>

      {/*
        The shift, and whether this person is expected at all.

        A consultant who comes when there are patients should not appear on an
        absentee list every morning; a list full of people nobody expected is
        a list nobody reads. The shift is what lateness is measured against,
        so somebody with none set is present or absent and never late.
      */}
      <p className="label mt-4">{tr('Attendance')}</p>
      <label className="mt-1 flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={!f.attendanceRequired}
          onChange={(e) => setF({ ...f, attendanceRequired: !e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="block text-sm text-heading">
            {tr('This person does not need to mark attendance')}
          </span>
          <span className="block text-2xs text-muted">
            {tr('They will never show as absent or late, and their finger will not be sent to the readers.')}
          </span>
        </span>
      </label>

      {f.attendanceRequired && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={tr('Shift starts')}
            hint={tr('Lateness is measured from here. Leave blank if there is no set time.')}>
            <input type="time" value={f.shiftStart}
              onChange={(e) => setF({ ...f, shiftStart: e.target.value })}
              className="field num mt-1" />
          </Field>
          <Field label={tr('Shift ends')}
            hint={tr('Earlier than the start means a night shift that crosses midnight.')}>
            <input type="time" value={f.shiftEnd}
              onChange={(e) => setF({ ...f, shiftEnd: e.target.value })}
              className="field num mt-1" />
          </Field>
        </div>
      )}
        <Field label={tr('Password')} hint={f.role === 'admin' ? 'at least 8 characters' : 'at least 4'}>
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
            className="field" />
        </Field>
        <Field label={tr('Phone')}>
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="field num" />
        </Field>

        {/*
          A pharmacy administrator is a pharmacist with one extra power: they
          decide what the other pharmacy staff may do. Making it a second role
          produced two "pharmacy" entries in this list and two apparent
          applications, when it was only ever one module with a different set
          of tabs.
        */}
        {f.role === 'pharmacist' && (
          <div className="sm:col-span-2 rounded-xl border-2 border-line bg-raised p-3">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={f.pharmacyAdmin}
                onChange={(e) => setF({ ...f, pharmacyAdmin: e.target.checked })}
                className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <span className="block text-sm text-heading">
                  {tr('Pharmacy administrator')}
                </span>
                <span className="block text-2xs text-muted">
                  {tr('Gets every pharmacy tab, and an Access tab for deciding what the other pharmacy staff can see and do.')}
                </span>
              </span>
            </label>
          </div>
        )}

        {isDoctor && (
          <>
            <div className="sm:col-span-2 border-t border-divide pt-3">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted">{tr('Doctor details')}</p>
            </div>
            <Field label={tr('Specialisation')}>
              <input value={f.specialisation} onChange={(e) => setF({ ...f, specialisation: e.target.value })}
                placeholder={tr('General Physician')} className="field" />
            </Field>
            <Field label={tr('Room')}>
              <input value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} className="field" />
            </Field>
            <Field label={tr('Consultation fee')} hint={tr('What the patient pays')}>
              <input value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })}
                placeholder="1000" className="field num" />
            </Field>
            <Field label={tr('Doctor keeps (%)')} hint={tr('Of their own consultation fee')}>
              <input value={f.consultShare} onChange={(e) => setF({ ...f, consultShare: e.target.value })}
                className="field num" />
            </Field>
            <Field label={tr('Default share of tests (%)')} span
              hint={tr('Applied to anything they order, unless overridden per test under Doctor shares')}>
              <input value={f.serviceShare} onChange={(e) => setF({ ...f, serviceShare: e.target.value })}
                className="field num" />
            </Field>
          </>
        )}
      </div>
      <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

function ResetPassword({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal title={`New password for ${user.display_name}`} onClose={onClose}
      hint={tr('The old one stops working immediately and any open session is ended.')}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button disabled={busy || !pw} className="btn-primary"
            onClick={async () => {
              setBusy(true); setErr(null)
              try { await api.setStaffPassword(user.id, pw); onDone() }
              catch (e: any) { setErr(e.message) } finally { setBusy(false) }
            }}>{busy ? 'Saving…' : 'Change password'}</button>
        </>
      }>
      <Field label={tr('New password')}>
        <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="field" />
      </Field>
      <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/* -------------------------------------------------------------- services */

/**
 * Services, one department at a time.
 *
 * Everything in one list made it hard to find anything once the catalogue
 * shipped with fifty entries: CBC sat between a dressing and an ultrasound.
 * Split by department, each list is short enough to read, and the lab
 * in-charge and the radiographer each see only their own.
 */
const SERVICE_GROUPS: { id: string; label: string; icon: any; blurb: string }[] = [
  { id: 'lab', label: 'Laboratory tests', icon: FlaskConical,
    blurb: 'Blood, urine and serology. Each has its reference ranges under Test setup.' },
  { id: 'radiology', label: 'Radiology procedures', icon: ScanLine,
    blurb: 'X-rays, ultrasounds and scans.' },
  { id: 'procedure', label: 'Procedures', icon: Syringe,
    blurb: 'Dressings, injections, ECG and other bedside work.' },
  { id: 'other', label: 'Other', icon: ClipboardList,
    blurb: 'Anything that fits none of the above.' }
]

/**
 * The permission each tab needs to be worth showing.
 *
 * Hiding a tab is a courtesy, not the control: the server refuses the request
 * whatever the screen draws. A tab whose every action would be refused is
 * simply not offered.
 */
const TAB_PERMISSION: Record<string, string> = {
  'Overview': 'admin.overview',
  'Reports': 'admin.reports',
  'Staff': 'admin.staff.view',
  'Services': 'admin.services.view',
  'Doctor shares': 'admin.shares',
  'Departments': 'admin.departments',
  'Access': 'admin.access',
  'Report access': 'admin.access',
  'Wards and beds': 'admin.services.edit',
  'Attendance': 'admin.staff.view',
  'Demo data': 'admin.demo',
  'Settings': 'admin.settings'
}

function ServicesTab() {
  const [rows, setRows] = useState<any[]>([])
  const [group, setGroup] = useState('lab')
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [setup, setSetup] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => { api.services(true).then(setRows).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const shown = rows.filter((s) => s.category === group)
  const current = SERVICE_GROUPS.find((g) => g.id === group)!
  /*
   * The shipped tests arrive unpriced, and an unpriced test is refused at the
   * counter. Counting them here is what tells an administrator there is work
   * to do before the lab can open.
   */
  const unpriced = shown.filter((s) => s.is_active && Number(s.price_paisa) <= 0)

  return (
    <Card title={tr('Tests, scans and procedures')}
      hint={tr('What a doctor can order, what it costs, and the default cut the ordering doctor gets')}
      action={<button onClick={() => setEditing('new')}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add service')}
      </button>}>

      <ErrorNote>{err}</ErrorNote>

      <Tabs id="service-groups" value={group} onChange={setGroup} className="mb-4 w-fit"
        tabs={SERVICE_GROUPS.map((g) => ({
          value: g.id, label: tr(g.label), icon: g.icon,
          count: rows.filter((s) => s.category === g.id).length
        }))} />

      <p className="mb-3 text-2xs text-muted">{tr(current.blurb)}</p>

      {unpriced.length > 0 && (
        <div className="anim-in mb-3 flex items-start gap-2 rounded-xl border-2 border-warn/40
                        bg-warn/5 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-2xs text-warn">
            {unpriced.length} {tr('have no price yet and cannot be ordered until they do.')}{' '}
            <span className="text-muted">
              {tr('They ship unpriced because only the hospital knows what it charges.')}
            </span>
          </p>
        </div>
      )}

      {shown.length === 0 ? (
        <Empty title={tr('Nothing here yet')}
          action={<button onClick={() => setEditing('new')} className="btn-primary">
            {tr('Add the first one')}</button>} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Service')}</Th><Th w="w-28" right>{tr('Price')}</Th>
                <Th w="w-28" right>{tr('Doctor gets')}</Th><Th w="w-24" right>{tr('Ordered')}</Th>
                <Th w="w-40" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {shown.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{s.name}</span>
                    {!s.is_active && <Badge>{tr('hidden')}</Badge>}
                    {s.code && <div className="text-2xs text-muted">{s.code}</div>}
                  </td>
                  <td className="px-3 py-2 text-right num font-medium">
                    {Number(s.price_paisa) > 0
                      ? <span className="text-primary">{rs(s.price_paisa)}</span>
                      : <Badge tone="warn">{tr('no price')}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs text-accent">
                    {bpToPct(s.default_share_bp)}%
                    <div className="text-muted">
                      {rs(Math.round(Number(s.price_paisa) * s.default_share_bp / 10000))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{s.times_ordered}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(s)} className="btn-ghost px-2 py-1 text-2xs">
                      {tr('Edit')}
                    </button>
                    {/*
                      What the test reports and what it uses up. Kept behind
                      its own button because most services never need it and
                      the ones that do need a lot of rows.
                    */}
                    {/* Cross match has a fixed report and nothing to set up. */}
                    {s.code !== 'XMATCH' && (
                      <button onClick={() => setSetup(s)}
                        className="ml-1 btn-ghost px-2 py-1 text-2xs">
                        {tr('Test setup')}
                      </button>
                    )}
                    {/*
                      Deleting is refused by the server once the service has
                      been ordered, because every bill and report naming it
                      would point at nothing. The message says to switch it
                      off instead, which is almost always what is wanted.
                    */}
                    <button
                      onClick={() => {
                        setErr(null)
                        api.deleteService(s.id).then(load).catch((e: any) => setErr(e.message))
                      }}
                      className="ml-1 btn-ghost px-2 py-1 text-2xs text-bad">
                      {tr('Delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {setup && <TestSetup service={setup} onClose={() => setSetup(null)} />}
      {editing && (
        <ServiceForm initial={editing === 'new' ? null : editing} defaultCategory={group}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />
      )}
    </Card>
  )
}

function ServiceForm({ initial, defaultCategory, onClose, onDone }: {
  initial: any | null; defaultCategory?: string; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', code: initial?.code ?? '',
    // A new service starts in whichever department's list it was added from.
    category: initial?.category ?? defaultCategory ?? 'lab',
    price: initial ? rs(initial.price_paisa) : '',
    share: initial ? bpToPct(initial.default_share_bp) : '0',
    departmentId: initial?.department_id ? String(initial.department_id) : '',
    /*
     * A new procedure starts needing a doctor, which is the common case. An
     * existing service keeps whatever it was saved with.
     */
    requiresDoctor: initial
      ? !!initial.requires_doctor
      : (defaultCategory ?? 'lab') === 'procedure',
    isActive: initial ? initial.is_active : true
  })
  const [depts, setDepts] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api.departments().then(setDepts).catch(() => {}) }, [])
  const share = Math.round(toPaisa(f.price) * pctToBp(f.share) / 10000)

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add a service'} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button disabled={busy || !f.name.trim()} className="btn-primary"
            onClick={async () => {
              setBusy(true); setErr(null)
              try {
                await api.saveService({
                  ...(initial ? { id: initial.id } : {}),
                  name: f.name.trim(), code: f.code.trim() || null,
                  category: f.category, pricePaisa: toPaisa(f.price),
                  defaultShareBp: pctToBp(f.share), isActive: f.isActive,
                  departmentId: f.departmentId ? Number(f.departmentId) : null,
                  requiresDoctor: f.requiresDoctor
                })
                onDone()
              } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
            }}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }>
      <div className="space-y-3">
        <Field label={tr('Name')}>
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('X-Ray Chest')} className="field" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('Category')}>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="field">
              <option value="lab">{tr('Lab')}</option>
              <option value="radiology">{tr('Radiology')}</option>
              <option value="procedure">{tr('Procedure')}</option>
              <option value="other">{tr('Other')}</option>
            </select>
          </Field>
          {/*
            Which department owns it.
            The category routes a service to the right screen; the department
            is what reports break on, so an ECG and an X-ray can be told
            apart instead of both appearing as "radiology".
          */}
          <Field label={tr('Department')} hint={tr('Used by the department reports')}>
            <select value={f.departmentId ?? ''}
              onChange={(e) => setF({ ...f, departmentId: e.target.value })}
              className="field">
              <option value="">{tr('Not set — reports use the category')}</option>
              {depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={tr('Code')}>
            <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="field" />
          </Field>
          <Field label={tr('Price')}>
            <input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })}
              placeholder="1000" className="field num" />
          </Field>
          <Field label={tr('Doctor\'s share (%)')}>
            <input value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} className="field num" />
          </Field>
        </div>

        {/*
          Who performed it, where that matters.

          A dressing, a nebulisation, an ECG: somebody does these, and that
          person has a share in them. Billed with nobody named, the share has
          nowhere to go and vanishes without trace — a month later the doctor
          asks why their earnings are short and there is nothing to answer
          with.

          A flag per service rather than a rule about the procedure category,
          because the two do not line up: some procedures are nurse-led and
          need no doctor, and in a small hospital some tests genuinely are
          performed by a named consultant. Whoever sets the service up knows;
          the category does not.
        */}
        <label className="flex items-start gap-2 rounded-lg border-2 border-line p-3">
          <input type="checkbox" checked={f.requiresDoctor} className="mt-0.5"
            onChange={(e) => setF({ ...f, requiresDoctor: e.target.checked })} />
          <span>
            <span className="block text-sm text-heading">
              {tr('A doctor must be named to bill this')}
            </span>
            <span className="block text-2xs text-muted">
              {tr('The counter will not take payment without choosing who is performing it, so the share reaches them. Usual for procedures.')}
            </span>
          </span>
        </label>

        {toPaisa(f.price) > 0 && (
          <div className="rounded-lg border border-line bg-tint p-3 text-2xs">
            <div className="flex justify-between">
              <span className="text-muted">{tr('Patient pays')}</span>
              <span className="num font-medium text-primary">Rs {rs(toPaisa(f.price))}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">{tr('Ordering doctor earns')}</span>
              <span className="num font-medium text-accent">Rs {rs(share)}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">{tr('Hospital keeps')}</span>
              <span className="num text-body">Rs {rs(toPaisa(f.price) - share)}</span>
            </div>
          </div>
        )}

        {initial && (
          <label className="flex items-center gap-2 text-2xs">
            <input type="checkbox" checked={f.isActive}
              onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            {tr('Available for doctors to order')}
          </label>
        )}
        <p className="text-2xs text-muted">
          Changing a price only affects future orders. Anything already ordered keeps the
          price and share it was booked at.
        </p>
        <ErrorNote>{err}</ErrorNote>
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------------- shares */

function SharesTab() {
  const [doctors, setDoctors] = useState<any[]>([])
  const [doctorId, setDoctorId] = useState(0)
  const [rows, setRows] = useState<any[]>([])
  const [saving, setSaving] = useState<number | null>(null)

  useEffect(() => {
    api.doctors().then((d) => { setDoctors(d); setDoctorId(d[0]?.id ?? 0) }).catch(() => {})
  }, [])
  const load = useCallback(() => {
    if (doctorId) api.doctorShares(doctorId).then(setRows).catch(() => {})
  }, [doctorId])
  useEffect(() => { load() }, [load])

  async function setShare(serviceId: number, value: string) {
    setSaving(serviceId)
    const bp = value.trim() === '' ? null : pctToBp(value)
    try { await api.setDoctorShare(doctorId, serviceId, bp); load() }
    finally { setSaving(null) }
  }

  const doctor = doctors.find((d) => d.id === doctorId)

  return (
    <Card title={tr('Doctor shares')}
      hint={tr('Override what a specific doctor earns from a specific test. Blank means the default applies.')}
      action={
        <select value={doctorId} onChange={(e) => setDoctorId(Number(e.target.value))}
          className="field w-64 py-1.5 text-2xs">
          {doctors.map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}
        </select>
      }>
      {doctor && (
        <div className="mb-4 rounded-lg border border-line bg-tint p-3 text-2xs">
          <div className="flex flex-wrap gap-6">
            <span>
              <span className="block text-muted">{tr('Consultation fee')}</span>
              <span className="num font-medium text-primary">Rs {rs(doctor.consultation_fee_paisa)}</span>
            </span>
            <span>
              <span className="block text-muted">{tr('Keeps of that')}</span>
              <span className="num font-medium text-accent">{bpToPct(doctor.consultation_share_bp)}%</span>
            </span>
            <span>
              <span className="block text-muted">{tr('Default on tests')}</span>
              <span className="num font-medium text-accent">{bpToPct(doctor.default_service_share_bp)}%</span>
            </span>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Service')}</Th><Th w="w-28" right>{tr('Price')}</Th>
              <Th w="w-24" right>{tr('Default')}</Th><Th w="w-32" right>{tr('This doctor')}</Th>
              <Th w="w-28" right>{tr('They earn')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((r) => {
              const bp = r.override_bp ?? r.default_share_bp
              return (
                <tr key={r.service_id}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{r.name}</span>
                    <Badge>{r.category}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs">{rs(r.price_paisa)}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{bpToPct(r.default_share_bp)}%</td>
                  <td className="px-3 py-2 text-right">
                    <input
                      defaultValue={r.override_bp != null ? bpToPct(r.override_bp) : ''}
                      onBlur={(e) => setShare(r.service_id, e.target.value)}
                      placeholder={tr('default')}
                      className="field w-24 py-1 text-right text-2xs num" />
                    {saving === r.service_id && <span className="ml-1 text-2xs text-muted">…</span>}
                  </td>
                  <td className="px-3 py-2 text-right num font-medium text-accent">
                    {rs(Math.round(Number(r.price_paisa) * bp / 10000))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ---------------------------------------------------------- departments */

function DepartmentsTab() {
  const [editing, setEditing] = useState<number | null>(null)
  const draft = useRef<{ name?: string; code?: string }>({})
  const [rows, setRows] = useState<any[]>([])
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => { api.departments().then(setRows).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  return (
    <Card title={tr('Departments')} hint={tr('Used to group staff and to label visits')}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={tr('Name')}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder={tr('General Medicine')} className="field w-64" />
        </Field>
        <Field label={tr('Short code')}>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={tr('GEN')} className="field w-28" />
        </Field>
        <button disabled={!name.trim() || !code.trim()} className="btn-primary"
          onClick={async () => {
            setErr(null)
            try {
              await api.createDepartment({ name: name.trim(), code: code.trim() })
              setName(''); setCode(''); load()
            } catch (e: any) { setErr(e.message) }
          }}>{tr('Add')}</button>
      </div>
      <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>

      <ul className="mt-4 divide-y divide-divide">
        {rows.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 py-2">
            {editing === d.id ? (
              <>
                <input defaultValue={d.name} autoFocus
                  onChange={(e) => (draft.current.name = e.target.value)}
                  className="field flex-1 py-1 text-sm" />
                <input defaultValue={d.code}
                  onChange={(e) => (draft.current.code = e.target.value)}
                  className="field num w-24 py-1 text-sm" />
                <button className="btn-primary px-2 py-1 text-2xs"
                  onClick={() => api.updateDepartment(d.id, {
                    name: draft.current.name ?? d.name,
                    code: draft.current.code ?? d.code
                  }).then(() => { setEditing(null); load() })
                    .catch((e: any) => setErr(e.message))}>
                  {tr('Save')}
                </button>
                <button onClick={() => setEditing(null)} className="btn-ghost px-2 py-1 text-2xs">
                  {tr('Cancel')}
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-heading">{d.name}</span>
                  <Badge tone="primary">{d.code}</Badge>
                </span>
                <span className="num text-2xs text-muted">{d.staff_count} staff</span>
                <button
                  onClick={() => { draft.current = {}; setEditing(d.id) }}
                  className="btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                {/*
                  Refused by the server while any staff or visit still points
                  at it, because those rows would otherwise refer to something
                  that no longer exists.
                */}
                <button
                  onClick={() => api.deleteDepartment(d.id).then(load)
                    .catch((e: any) => setErr(e.message))}
                  className="btn-ghost px-2 py-1 text-2xs text-bad">{tr('Delete')}</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}


/* ------------------------------------------------------------ demo data */

/**
 * Fills the system so every screen can be tried before a real patient exists.
 *
 * Replacing is destructive, so it asks for the phrase to be typed rather than
 * relying on a confirm dialog nobody reads.
 */
function DemoTab() {
  const [hasData, setHasData] = useState<boolean | null>(null)
  const [days, setDays] = useState('45')
  /*
   * The pharmacy's trading, on by default.
   *
   * It was never loaded from this screen at all, so a trial install got a
   * pharmacy full of medicines with no bills behind them and the whole
   * module looked unfinished. It is the slow half, so it can be turned off
   * for somebody who only wants the hospital side.
   */
  const [withPharmacy, setWithPharmacy] = useState(true)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { api.demoStatus().then((r) => setHasData(r.hasData)).catch(() => {}) }, [])

  const PHRASE = 'REPLACE ALL DATA'
  const needsConfirm = hasData === true
  const ready = !busy && (!needsConfirm || typed === PHRASE)

  async function run() {
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await api.loadDemoData(
        needsConfirm, Math.max(1, Number(days) || 45), withPharmacy)
      setResult(r)
      setTyped('')
      setHasData(true)
    } catch (e: any) {
      setErr(e.message ?? 'Could not load demo data')
    } finally { setBusy(false) }
  }

  return (
    <Card title={tr('Demo data')} hint={tr('Realistic patients, visits, prescriptions and earnings for testing')}>
      {hasData === null ? (
        <p className="text-2xs text-muted">{tr('Checking…')}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-2xs text-muted">
            Generates patients, visits, prescriptions, test orders and doctor earnings
            spread over the last few weeks, plus staff, departments, a service list and
            a stocked pharmacy. Today keeps a few patients still waiting so the queue
            screens have something live in them.
          </p>

          {/*
            The pharmacy tick.
          
            Spelled out rather than silent, because it is the difference
            between a two-second load and a two-minute one, and somebody
            watching a button do nothing for ninety seconds assumes it has
            hung.
          */}
          <label className="flex items-start gap-2 rounded-xl border-2 border-line
                            bg-raised px-3 py-2">
            <input type="checkbox" checked={withPharmacy} className="mt-0.5"
              onChange={(e) => setWithPharmacy(e.target.checked)} />
            <span>
              <span className="block text-2xs font-medium text-heading">
                {tr('Include the pharmacy\u2019s trading')}
              </span>
              <span className="block text-2xs text-muted">
                {tr('Deliveries, batches, counter sales and returns, so the till, the stock screens and every pharmacy report have something in them. Takes a minute or two on its own \u2014 without it the pharmacy has medicines and no bills.')}
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <Field label={tr('Days of history')}>
              <input value={days} onChange={(e) => setDays(e.target.value)}
                className="field w-28 num" />
            </Field>
            {!needsConfirm && (
              <button onClick={run} disabled={!ready} className="btn-primary">
                {busy ? 'Generating…' : 'Load demo data'}
              </button>
            )}
          </div>

          {needsConfirm && (
            <div className="rounded-lg border border-bad/25 bg-bad/5 p-4">
              <p className="text-2xs font-medium text-bad">
                {tr('This system already has patient records')}
              </p>
              <p className="mt-1 text-2xs text-bad/90">
                {tr('Loading demo data')} <strong>{tr('erases everything')}</strong> — every patient, visit,
                prescription and earning — and replaces it with invented records. Only do
                this on a test system.
              </p>
              <p className="mt-1 text-2xs text-muted">
                Staff accounts are recreated, so you will be signed out and will need to
                sign back in as <span className="num">{tr('admin')}</span>.
              </p>
              <label className="mt-3 block">
                <span className="label">
                  {tr('Type')} <code className="text-bad">{PHRASE}</code> {tr('to enable')}
                </span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)}
                  placeholder={PHRASE} className="field" />
              </label>
              <button onClick={run} disabled={!ready}
                className="mt-3 rounded-lg bg-bad px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">
                {busy ? 'Replacing…' : 'Erase everything and load demo data'}
              </button>
            </div>
          )}

          <ErrorNote>{err}</ErrorNote>

          {result && (
            <div className="rounded-lg border border-ok/25 bg-ok/5 p-4">
              <p className="text-2xs font-medium text-ok">{tr('Demo data loaded')}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Stat label={tr('Patients')} value={String(result.patients)} />
                <Stat label={tr('Visits')} value={String(result.visits)} />
                <Stat label={tr('Doctor earnings')} value={`Rs ${rs(result.earningsPaisa)}`} tone="accent" />
              </div>
              {result.pharmacy && (
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Stat label={tr('Medicines')} value={String(result.pharmacy.products)} />
                  <Stat label={tr('Batches on the shelf')} value={String(result.pharmacy.batches)} />
                  <Stat label={tr('Pharmacy bills')} value={String(result.pharmacy.invoices)}
                    tone="ok" />
                </div>
              )}
              <p className="mt-3 text-2xs text-muted">
                {tr('Sign in as')} <span className="num">{tr('reception / 1234')}</span>,{' '}
                <span className="num">{tr('dr.yasir / 1234')}</span> or{' '}
                <span className="num">{tr('pharmacy / 1234')}</span> to see the other screens.
                Admin stays <span className="num">{tr('admin / admin-demo-1')}</span>.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------- settings */

const INFO_FIELDS: [string, string, string][] = [
  ['name', 'Hospital name', 'Al-Shifa General Hospital'],
  ['tagline', 'Tagline', 'Trusted care since 1994'],
  ['address', 'Address', 'GT Road, Gujrat, Punjab'],
  ['phone', 'Phone', '053-3512345'],
  ['email', 'Email', 'info@example.com'],
  ['ntn', 'NTN', '1234567-8'],
  ['licenceNo', 'Licence number', 'PHC-PB-00123']
]

/**
 * Hospital details and housekeeping.
 *
 * Everything here ends up on paper the patient carries out of the building,
 * so it is worth getting right once rather than editing a template later.
 */
/**
 * Which modules this hospital is using.
 *
 * Switching one off hides its sign-in cell and its screens. It deletes
 * nothing: a hospital that adds the doctor terminal in March must find its
 * January data exactly where it left it. Off means "not using this yet".
 */
function ModulesCard() {
  const [m, setM] = useState<Record<string, boolean> | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { api.modules().then(setM).catch((e: any) => setErr(e.message)) }, [])

  const ITEMS: [string, string, string][] = [
    ['opdCounter', 'OPD counter', 'Holds the queue and records vitals before the doctor'],
    ['doctor', 'Doctor terminal',
      'The consultation itself. The counter still books appointments and takes the fee either way'],
    ['pharmacy', 'Pharmacy', 'Counter, stock, ledgers and reports'],
    ['laboratory', 'Laboratory', 'Samples, results and lab reports'],
    ['radiology', 'Radiology', 'X-ray, ultrasound and imaging'],
    ['emergency', 'Emergency', 'Walk-in admissions and bedside medicines'],
    ['stores', 'Stores', 'Hospital consumables — gauze, gloves, IV sets']
  ]

  async function toggle(key: string, on: boolean) {
    setBusy(true); setErr(null); setSaved(false)
    try {
      setM(await api.saveModules({ [key]: on }))
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Card title={tr('Modules in use')}
      hint={tr('Hides what this hospital is not using yet. Nothing is deleted.')}>
      <ErrorNote>{err}</ErrorNote>
      {!m ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <ul className="divide-y divide-divide">
          {ITEMS.map(([key, label, blurb]) => (
            <li key={key} className="flex items-start justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm text-heading">{tr(label)}</span>
                <span className="block text-2xs text-muted">{tr(blurb)}</span>
              </span>
              <button disabled={busy} onClick={() => toggle(key, !m[key])}
                className={`shrink-0 rounded-xl border-2 px-3 py-1.5 text-2xs ${
                  m[key] ? 'border-ok bg-ok/10 font-medium text-ok'
                         : 'border-line bg-card text-muted'}`}>
                {m[key] ? tr('In use') : tr('Not in use')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-2xs text-muted">
        {tr('The main counter and administration are always on — without them nobody can register a patient or sign in.')}
      </p>
      {saved && <p className="mt-1 text-2xs text-ok">{tr('Saved')}</p>}
    </Card>
  )
}

/**
 * Discounts at the main counter.
 *
 * The same pair of rules the pharmacy has, kept separate on purpose: a
 * hospital that lets the chemist knock ten per cent off a strip of tablets
 * does not necessarily let the front desk do the same to a consultation
 * fee, and one shared setting would force that decision.
 *
 * Both are enforced on the server when the bill is completed, not just
 * here. This screen decides the rule; the till obeys it.
 */
function CounterDiscountCard() {
  const [s, setS] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.counterDiscount().then(setS).catch((e: any) => setErr(e.message))
  }, [])

  async function save() {
    setBusy(true); setErr(null); setSaved(false)
    try {
      setS(await api.saveCounterDiscount({
        discountEnabled: !!s.discountEnabled,
        discountMaxPct: Math.max(0, Math.min(100, Number(s.discountMaxPct) || 0))
      }))
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Card title={tr('Discounts at the main counter')}
      hint={tr('A rule about the counter, not about one cashier. The pharmacy has its own, under Pharmacy, Access.')}
      action={
        <button onClick={save} disabled={busy || !s} className="btn-primary">
          {busy ? tr('Saving…') : saved ? tr('Saved') : tr('Save')}
        </button>
      }>
      <ErrorNote>{err}</ErrorNote>
      {!s ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <div className="space-y-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={!!s.discountEnabled} className="mt-0.5"
              onChange={(e) => setS({ ...s, discountEnabled: e.target.checked })} />
            <span>
              <span className="block text-sm text-heading">
                {tr('Allow discounts on a counter bill')}
              </span>
              <span className="block text-2xs text-muted">
                {tr('Off, the box disappears from the till and the server refuses any discount.')}
              </span>
            </span>
          </label>

          {s.discountEnabled && (
            <Field label={tr('Most that may be taken off, as a percentage of the bill')}>
              <div className="flex items-center gap-2">
                <input inputMode="numeric" value={s.discountMaxPct ?? 0}
                  onChange={(e) => setS({
                    ...s,
                    discountMaxPct: Math.max(0, Math.min(100,
                      Number(e.target.value.replace(/[^0-9]/g, '')) || 0))
                  })}
                  className="field num w-20 text-right" />
                <span className="text-2xs text-muted">%</span>
                <span className="text-2xs text-muted">
                  {Number(s.discountMaxPct) > 0
                    ? `${tr('On a Rs 1,000 bill that is Rs')} ${
                        (Number(s.discountMaxPct) * 10).toLocaleString('en-PK')}.`
                    /* Zero is no ceiling, not "no discount". The switch
                     * above is what turns it off, and making zero mean
                     * both would be ambiguous. */
                    : tr('Zero means no limit. Use the switch above to stop discounts entirely.')}
                </span>
              </div>
            </Field>
          )}

          <p className="text-2xs text-muted">
            {tr('A discount does not change what a doctor earns. Their share is worked out on the fee, so the hospital absorbs it rather than the doctor.')}
          </p>
        </div>
      )}
    </Card>
  )
}

function SettingsTab() {
  const [f, setF] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [backups, setBackups] = useState<any[]>([])
  const [backingUp, setBackingUp] = useState(false)

  const loadBackups = useCallback(() => { api.backups().then(setBackups).catch(() => {}) }, [])
  useEffect(() => {
    api.hospital().then(setF).catch((e: any) => setErr(e.message))
    loadBackups()
  }, [loadBackups])

  async function save() {
    setBusy(true); setErr(null); setSaved(false)
    try { setF(await api.saveHospital(f)); setSaved(true); setTimeout(() => setSaved(false), 2500) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <ModulesCard />
      <CounterDiscountCard />

      <Card title={tr('Hospital details')}
        hint={tr('Printed at the top of every chit, receipt and prescription')}
        action={
          <button onClick={save} disabled={busy || !f} className="btn-primary">
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        }>
        <ErrorNote>{err}</ErrorNote>
        {!f ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {INFO_FIELDS.map(([key, label, placeholder]) => (
                <Field key={key} label={tr(label)} span={key === 'address'}>
                  <input value={f[key] ?? ''} onChange={(e) => setF({ ...f, [key]: e.target.value })}
                    placeholder={placeholder} className="field" />
                </Field>
              ))}
            </div>
            {/*
              The mark that prints on lab and radiology reports.
              Stored in the database rather than as a file on disk, so it
              survives a reinstall, travels with a backup, and is there for
              every machine on the network without anyone copying a file.
            */}
            <div className="mt-4 border-t border-divide pt-4">
              <p className="label">{tr('Logo on reports')}</p>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                {f.logoDataUri
                  ? <img src={f.logoDataUri} alt=""
                      className="h-16 w-auto rounded-lg bg-white p-1.5 ring-1 ring-line" />
                  : <span className="grid h-16 w-16 place-items-center rounded-lg border-2
                                     border-dashed border-line text-2xs text-muted">
                      {tr('none')}
                    </span>}

                <label className="btn-ghost inline-flex cursor-pointer items-center gap-1.5">
                  <Upload size={14} /> {tr('Choose an image')}
                  <input type="file" accept="image/png,image/jpeg" className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      /*
                       * Capped deliberately. A photograph straight off a phone
                       * is several megabytes, and it would be read on every
                       * report and carried in every backup.
                       */
                      if (file.size > 400_000) {
                        setErr(tr('That image is too large. Around 400 kB is plenty for a logo.'))
                        return
                      }
                      const r = new FileReader()
                      r.onload = () => setF({ ...f, logoDataUri: String(r.result) })
                      r.readAsDataURL(file)
                    }} />
                </label>

                {f.logoDataUri && (
                  <button onClick={() => setF({ ...f, logoDataUri: '' })}
                    className="btn-ghost text-2xs">{tr('Remove')}</button>
                )}

                <span className="text-2xs text-muted">
                  {tr('A PNG with a transparent background prints best. Where it sits on the report is set in the laboratory, under Report layout.')}
                </span>
              </div>
            </div>

            <div className="mt-4 grid gap-3 border-t border-divide pt-4 sm:grid-cols-2">
              <Field label={tr('Footer on chits')} hint={tr('Tells the patient what to do next')}>
                <input value={f.chitFooter ?? ''}
                  onChange={(e) => setF({ ...f, chitFooter: e.target.value })}
                  placeholder={tr('Pay at the cashier before proceeding.')} className="field" />
              </Field>
              <Field label={tr('Footer on receipts')}>
                <input value={f.receiptFooter ?? ''}
                  onChange={(e) => setF({ ...f, receiptFooter: e.target.value })}
                  placeholder={tr('Get well soon.')} className="field" />
              </Field>
            </div>
          </>
        )}
      </Card>

      <Card title={tr('Backups')}
        hint={tr('Taken automatically every 12 hours; the last 14 are kept')}
        action={
          <button disabled={backingUp} className="btn-ghost"
            onClick={async () => {
              setBackingUp(true)
              try { await api.runBackup(); loadBackups() }
              catch (e: any) { setErr(e.message) } finally { setBackingUp(false) }
            }}>
            {backingUp ? 'Working…' : 'Back up now'}
          </button>
        }>
        {backups.length === 0 ? (
          <Empty title={tr('No backups yet')}
            hint={tr('The first one is taken shortly after the server starts.')} />
        ) : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr><Th>{tr('File')}</Th><Th w="w-44">{tr('Taken')}</Th><Th w="w-28" right>{tr('Size')}</Th></tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {backups.map((b) => (
                <tr key={b.file}>
                  <td className="px-3 py-2 num text-2xs text-heading">{b.file}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">
                    {new Date(b.takenAt).toLocaleString('en-GB')}
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">
                    {(b.size / 1024).toFixed(0)} kB
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-2xs text-muted">
          {tr('Written to the server\'s')} <span className="num">{tr('backups')}</span> folder, or wherever
          BACKUP_DIR points. Copy them to a USB drive or another machine regularly: a backup
          sitting on the same disk as the database is not a backup.
        </p>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------ test setup */

/**
 * Two things a service needs beyond its price: what it reports, and what it
 * uses up.
 *
 * Reference ranges live here rather than being typed per patient, and the
 * recipe is what lets the store see consumption without anyone issuing by
 * hand against every test.
 */
export function TestSetup({ service, onClose }: { service: any; onClose: () => void }) {
  /*
   * The recipe section is hidden when the hospital is not using Stores.
   *
   * "What it uses up" issues gauze and cuvettes from a store that does not
   * exist for them, so it is noise on the screen and a save that does nothing.
   */
  const modules = useModules()
  const [layout, setLayout] =
    useState<'standard' | 'qualitative' | 'ranges'>('standard')
  const [params, setParams] = useState<any[]>([])
  const [recipe, setRecipe] = useState<any[]>([])
  const [items, setItems] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.serviceParameters(service.id)
      .then((p) => {
        /*
         * A section becomes a row of its own.
         *
         * It is stored against the first parameter of its block, which is
         * the right shape for the database and the wrong one for a person: a
         * Section box beside every single line, almost always empty, is a
         * column of noise. On screen a heading is a row, where it reads the
         * way it prints.
         */
        const rows: any[] = []
        for (const x of p as any[]) {
          if (x.section) rows.push({ key: newId(), kind: 'section', heading: x.section })
          rows.push({
            key: newId(), kind: 'param', name: x.name, unit: x.unit ?? '',
            refLow: x.ref_low ?? '', refHigh: x.ref_high ?? '', refText: x.ref_text ?? '',
            maleLow: x.male_low ?? '', maleHigh: x.male_high ?? '',
            femaleLow: x.female_low ?? '', femaleHigh: x.female_high ?? '',
            hasSexRanges: !!x.has_sex_ranges,
            refOp: x.ref_op ?? '<', refValue: x.ref_value ?? ''
          })
        }
        setParams(rows)
      }).catch(() => {})
    api.reportLayout(service.id)
      .then((r: any) => setLayout(
        ['qualitative', 'ranges'].includes(r.layout) ? r.layout : 'standard'))
      .catch(() => {})
    api.serviceConsumables(service.id)
      .then((c) => setRecipe(c.map((x: any) => ({
        key: newId(), itemId: x.item_id, name: x.item_name, unitLabel: x.unit_label,
        qty: String(x.qty), onHand: x.on_hand
      })))).catch(() => {})
    api.supplyItems({ filter: 'all' }).then(setItems).catch(() => {})
  }, [service.id])

  async function save() {
    setBusy(true); setErr(null); setSaved(false)
    try {
      /*
       * Each heading is carried by the parameter that follows it.
       *
       * A heading with no lines under it is dropped rather than saved: it
       * would print as a heading for nothing, and the row exists on screen
       * only as somewhere to type.
       */
      let pending: string | null = null
      const flat: any[] = []
      for (const row of params) {
        if (row.kind === 'section') {
          if (row.heading.trim()) pending = row.heading.trim()
          continue
        }
        if (!row.name.trim()) continue
        flat.push({
          name: row.name.trim(), unit: row.unit.trim() || null,
          refLow: row.refLow === '' ? null : Number(row.refLow),
          refHigh: row.refHigh === '' ? null : Number(row.refHigh),
          /*
           * One normal value per row, never three.
           *
           * A row used to offer a low and high, a free-text box AND two sex
           * boxes, with nothing saying which won. The layout now decides: a
           * numbers row says low and high (or a pair for each sex), a written
           * range says an operator and a number, and only the yes-or-no
           * layout keeps free text.
           */
          refText: layout === 'qualitative' ? (row.refText?.trim() || null) : null,
          maleLow: row.maleLow === '' ? null : Number(row.maleLow),
          maleHigh: row.maleHigh === '' ? null : Number(row.maleHigh),
          femaleLow: row.femaleLow === '' ? null : Number(row.femaleLow),
          femaleHigh: row.femaleHigh === '' ? null : Number(row.femaleHigh),
          hasSexRanges: !!row.hasSexRanges,
          /*
           * The operator is only meaningful on a written range, so it is sent
           * only for that layout. Sending it everywhere would flag a CBC line
           * against a limit nobody typed.
           */
          refOp: layout === 'ranges' && row.refValue !== '' ? (row.refOp || '<') : null,
          refValue: layout === 'ranges' && row.refValue !== ''
            ? Number(row.refValue) : null,
          section: pending
        })
        pending = null
      }
      await api.saveServiceParameters(service.id, flat)
      await api.saveReportLayout(service.id, layout)
      if (modules.stores) await api.saveServiceConsumables(service.id, recipe
        .filter((r) => r.itemId && Number(r.qty) > 0)
        .map((r) => ({ itemId: r.itemId, qty: Number(r.qty) })))
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${tr('Test setup')} — ${service.name}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={save} disabled={busy} className="btn-primary">
          {busy ? tr('Saving…') : saved ? tr('Saved') : tr('Save')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      <p className="label">{tr('What this test reports')}</p>
      <p className="mb-2 text-2xs text-muted">
        {tr('One row per line on the report. Leave the range blank for results that are words rather than numbers, and put the expected answer in Normal reading instead.')}
      </p>

      {/*
        How many columns the printed report has.

        A chemistry panel needs units and a numeric range. A test answering
        POSITIVE or NEGATIVE has neither, and two empty columns on the page
        read as missing information rather than as columns that do not apply.
      */}
      <div className="mb-3 flex flex-wrap gap-3 rounded-xl border-2 border-line p-3">
        {([
          ['standard', tr('Numbers'), tr('Test, result, normal values, units')],
          ['qualitative', tr('Positive or negative'), tr('Test, result, normal range')],
          ['ranges', tr('Written range'), tr('Test, result, normal value')]
        ] as const).map(([id, label, blurb]) => (
          <label key={id} className="flex flex-1 cursor-pointer items-start gap-2">
            <input type="radio" name="report-layout" checked={layout === id}
              onChange={() => setLayout(id)} className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block text-sm text-heading">{label}</span>
              <span className="block text-2xs text-muted">{blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {params.length > 0 && (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Name')}</Th>
              {/* Units and a numeric range mean nothing to a yes-or-no test. */}
              {layout === 'standard' && <>
                <Th w="w-20">{tr('Unit')}</Th>
                {/*
                  The sex ranges stand where the single pair stands: they are
                  the same thing said twice over. In the normal value column
                  the row appeared to claim two different ranges.
                */}
                <Th w="w-44" right>{tr('Low / High')}</Th>
              </>}
              {layout === 'ranges' && <Th w="w-20">{tr('Unit')}</Th>}
              <Th w="w-44">{tr('Normal value')}</Th>
              {layout === 'standard' && <Th w="w-10" right>{tr('M/F')}</Th>}
              <Th w="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide">
            {params.map((p, i) => p.kind === 'section' ? (
              /*
                A heading, spanning the row.
                Everything below it belongs to it until the next one, which is
                how it reads on the printed report.
              */
              <tr key={p.key} className="bg-raised">
                <td colSpan={layout === 'standard' ? 6 : 2} className="px-1 py-1">
                  <input value={p.heading} autoFocus={!p.heading}
                    onChange={(e) => setParams((ps) => ps.map((x, j) =>
                      j === i ? { ...x, heading: e.target.value } : x))}
                    placeholder={tr('Section heading, e.g. After 1hr')}
                    className="field py-1 text-2xs font-semibold" />
                </td>
                <td className="pr-1 text-right">
                  <button onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}
                    className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
                </td>
              </tr>
            ) : (
              <tr key={p.key}>
                {(layout === 'standard'
                  ? (['name', 'unit'] as const)
                  : layout === 'ranges'
                  ? (['name', 'unit'] as const)
                  : (['name'] as const)
                ).map((f) => (
                  <td key={f} className="px-1 py-1">
                    <input value={p[f]}
                      onChange={(e) => setParams((ps) => ps.map((x, j) =>
                        j === i ? { ...x, [f]: e.target.value } : x))}
                      className="field py-1 text-2xs" />
                  </td>
                ))}

                {/*
                  One normal value, or one for each sex.

                  Haemoglobin is 13.0 to 17.5 for a man and 11.5 to 15.0 for a
                  woman, and a single box could only ever hold one of them. The
                  switch is per row because it is true of two or three lines on
                  a CBC and of none on most other tests.

                  Free text throughout: a laboratory writes "< 0.50" and
                  "Upto 15 Years: < 345", neither of which is a number.
                */}
                {layout === 'standard' && (
                  <td className="px-1 py-1">
                    {p.hasSexRanges ? (
                      <div className="grid grid-cols-2 gap-1">
                        {([['maleLow', 'M low'], ['maleHigh', 'M high'],
                           ['femaleLow', 'F low'], ['femaleHigh', 'F high']] as const)
                          .map(([f, label]) => (
                          <input key={f} value={p[f] ?? ''} placeholder={tr(label)}
                            inputMode="decimal"
                            onChange={(e) => setParams((ps) => ps.map((x, k) =>
                              k === i ? { ...x, [f]: e.target.value } : x))}
                            className="field num py-1 text-2xs" />
                        ))}
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        {(['refLow', 'refHigh'] as const).map((f) => (
                          <input key={f} value={p[f] ?? ''} inputMode="decimal"
                            placeholder={tr(f === 'refLow' ? 'Low' : 'High')}
                            onChange={(e) => setParams((ps) => ps.map((x, k) =>
                              k === i ? { ...x, [f]: e.target.value } : x))}
                            className="field num py-1 text-2xs" />
                        ))}
                      </div>
                    )}
                  </td>
                )}

                <td className="px-1 py-1">
                  {layout === 'ranges' ? (
                    <div className="flex gap-1">
                      <select value={p.refOp ?? '<'}
                        onChange={(e) => setParams((ps) => ps.map((x, k) =>
                          k === i ? { ...x, refOp: e.target.value } : x))}
                        className="field w-16 py-1 text-2xs">
                        {['<', '<=', '>', '>=', '='].map((o) =>
                          <option key={o} value={o}>{o}</option>)}
                      </select>
                      <input value={p.refValue ?? ''} inputMode="decimal"
                        onChange={(e) => setParams((ps) => ps.map((x, k) =>
                          k === i ? { ...x, refValue: e.target.value } : x))}
                        placeholder="0.50" className="field num py-1 text-2xs" />
                    </div>
                  ) : layout === 'qualitative' ? (
                    <input value={p.refText}
                      onChange={(e) => setParams((ps) => ps.map((x, k) =>
                        k === i ? { ...x, refText: e.target.value } : x))}
                      placeholder={tr('Negative, Non reactive')}
                      className="field py-1 text-2xs" />
                  ) : (
                    /*
                      Numbers: the range is stated in the Low / High column
                      beside this one, so here it is only shown back.
                    */
                    <span className="text-2xs text-muted">
                      {p.hasSexRanges
                        ? [p.maleLow && p.maleHigh ? `M: ${p.maleLow} - ${p.maleHigh}` : null,
                           p.femaleLow && p.femaleHigh
                             ? `F: ${p.femaleLow} - ${p.femaleHigh}` : null]
                            .filter(Boolean).join('  ') || tr('from Low / High')
                        : p.refLow !== '' && p.refHigh !== ''
                          ? `${p.refLow} - ${p.refHigh}` : tr('from Low / High')}
                    </span>
                  )}
                </td>

                {layout === 'standard' && (
                  <td className="px-1 py-1 text-center">
                    <input type="checkbox" checked={!!p.hasSexRanges}
                      title={tr('Different normal values for men and women')}
                      onChange={(e) => setParams((ps) => ps.map((x, j) =>
                        j === i ? { ...x, hasSexRanges: e.target.checked } : x))}
                      className="h-4 w-4" />
                  </td>
                )}

                <td className="pr-1 text-right">
                  <button onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}
                    className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-2 flex gap-2">
        <button onClick={() => setParams((ps) => [...ps, {
          key: newId(), kind: 'param', name: '', unit: '',
          refLow: '', refHigh: '', refText: '',
          maleLow: '', maleHigh: '', femaleLow: '', femaleHigh: '',
          hasSexRanges: false, refOp: '<', refValue: '' }])}
          className="btn-ghost text-2xs">{tr('Add a line')}</button>
        {/*
          A heading goes on the end, and the lines typed after it fall under
          it. That is the order somebody builds a report in: type the block,
          name it, type the next block.
        */}
        <button onClick={() => setParams((ps) => [...ps, {
          key: newId(), kind: 'section', heading: '' }])}
          className="btn-ghost text-2xs">{tr('Add a section')}</button>
      </div>

      {modules.stores && (
      <div className="mt-5 border-t-2 border-divide pt-4">
        <p className="label">{tr('What it uses up')}</p>
        <p className="mb-2 text-2xs text-muted">
          {tr('Taken off the store automatically when the result is saved, so consumption is recorded without anyone issuing by hand.')}
        </p>

        {recipe.length > 0 && (
          <ul className="space-y-2">
            {recipe.map((r, i) => (
              <li key={r.key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-heading">
                  {r.name}
                  <span className="ml-2 text-2xs text-muted">
                    {r.onHand} {r.unitLabel} {tr('on hand')}
                  </span>
                </span>
                <input value={r.qty}
                  onChange={(e) => setRecipe((rs) => rs.map((x, j) =>
                    j === i ? { ...x, qty: e.target.value } : x))}
                  className="field w-20 py-1 text-right text-2xs num" />
                <button onClick={() => setRecipe((rs) => rs.filter((_, j) => j !== i))}
                  className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
              </li>
            ))}
          </ul>
        )}

        <select value={0} className="field mt-2"
          onChange={(e) => {
            const item = items.find((x) => x.id === Number(e.target.value))
            if (!item || recipe.some((r) => r.itemId === item.id)) return
            setRecipe((rs) => [...rs, { key: newId(), itemId: item.id, name: item.name,
              unitLabel: item.unit_label, qty: '1', onHand: item.on_hand }])
          }}>
          <option value={0}>{tr('Add something this test uses')}</option>
          {items.filter((i) => i.is_active).map((i) => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
      </div>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------ edit staff */

/**
 * Changing somebody's details after the account exists.
 *
 * Without this, a misspelled name meant creating a second account and retiring
 * the first, which leaves two rows for one person and splits everything
 * recorded against them.
 *
 * The username is not editable. It is written into printed slips and into the
 * stock ledger as plain text, and changing it would leave those records
 * pointing at a name that no longer exists.
 */
function EditStaff({ user, onClose, onDone }: {
  user: any; onClose: () => void; onDone: () => void
}) {
  /*
   * Everything the add form offers, so the two are the same dialog.
   *
   * This had four fields. A doctor's consultation fee, their share of it,
   * their share of tests, their qualification and their room could be set
   * once when the account was made and then never again — so correcting a
   * fee meant deleting the account and making a new one, which takes their
   * name off every slip they have ever signed.
   */
  const [f, setF] = useState({
    displayName: user.display_name ?? '',
    role: user.role,
    departmentId: user.department_id ? String(user.department_id) : '',
    phone: user.phone ?? '',
    shiftStart: (user.shift_start ?? '').slice(0, 5),
    shiftEnd: (user.shift_end ?? '').slice(0, 5),
    attendanceRequired: user.attendance_required !== false,
    deviceUserId: user.device_user_id ?? '',
    specialisation: user.specialisation ?? '',
    qualification: user.qualification ?? '',
    room: user.room ?? '',
    fee: user.consultation_fee_paisa != null
      ? (Number(user.consultation_fee_paisa) / 100).toFixed(2) : '',
    consultShare: user.consultation_share_bp != null
      ? String(bpToPct(user.consultation_share_bp)) : '100',
    serviceShare: user.default_service_share_bp != null
      ? String(bpToPct(user.default_service_share_bp)) : '0',
    pharmacyAdmin: false
  })
  const [depts, setDepts] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** What this person holds now, so the tick opens in the right position. */
  const [heldAdmin, setHeldAdmin] = useState<boolean | null>(null)

  const isDoctor = f.role === 'doctor'
  const isPharmacist = f.role === 'pharmacist'

  useEffect(() => { api.departments().then(setDepts).catch(() => {}) }, [])

  /*
   * A pharmacy administrator is a pharmacist holding every pharmacy
   * permission, including the one that sets other people's. It is stored as
   * permissions rather than a role, so the only way to know is to ask.
   */
  useEffect(() => {
    if (user.role !== 'pharmacist') { setHeldAdmin(false); return }
    Promise.all([api.pharmaPermissions(), api.permissionsFor(user.id)])
      .then(([all, mine]: any[]) => {
        const has = (all ?? []).every((p: any) => (mine.allowed ?? []).includes(p.key))
        setHeldAdmin(has)
        setF((prev) => ({ ...prev, pharmacyAdmin: has }))
      })
      .catch(() => setHeldAdmin(false))
  }, [user.id, user.role])

  return (
    <Modal title={`${tr('Edit')} ${user.username}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !f.displayName.trim()} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.updateStaff(user.id, {
                displayName: f.displayName.trim(),
                role: f.role,
                departmentId: f.departmentId ? Number(f.departmentId) : null,
                phone: f.phone.trim() || null,
                shiftStart: f.shiftStart || null,
                shiftEnd: f.shiftEnd || null,
                attendanceRequired: f.attendanceRequired,
                deviceUserId: f.deviceUserId.trim() || null
              })

              /*
               * The doctor's own record is a second call, because it is a
               * second table. Only when this account already has one: giving
               * a doctor's record to somebody whose role was just changed TO
               * doctor is a different job, and quietly inventing one here
               * would create a doctor with a zero fee that reception can
               * book against.
               */
              if (user.doctor_id) {
                await api.updateDoctor(Number(user.doctor_id), {
                  specialisation: f.specialisation.trim() || null,
                  qualification: f.qualification.trim() || null,
                  room: f.room.trim() || null,
                  consultationFeePaisa: toPaisa(f.fee),
                  consultationShareBp: pctToBp(f.consultShare),
                  defaultServiceShareBp: pctToBp(f.serviceShare)
                })
              }

              /*
               * The pharmacy administrator tick, only when it changed.
               *
               * Writing it every time would wipe a carefully tailored set of
               * per-person permissions on any save of this dialog, including
               * a save that only corrected a phone number.
               */
              if (isPharmacist && heldAdmin !== null
                  && f.pharmacyAdmin !== heldAdmin) {
                const all = await api.pharmaPermissions()
                await api.savePermissions(user.id,
                  f.pharmacyAdmin ? all.map((p: any) => p.key) : [])
              }

              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Username')} hint={tr('Cannot change — it is printed on past slips')}>
          <input value={user.username} disabled className="field mt-1 num opacity-60" />
        </Field>
        <Field label={tr('Name')} hint={tr('Printed on everything they do')}>
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })}
            className="field mt-1" />
        </Field>
        <Field label={tr('Role')}>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}
            className="field mt-1">
            <option value="main_counter">{tr('Main counter')}</option>
            <option value="receptionist">{tr('OPD counter')}</option>
            <option value="ipd_counter">{tr('Emergency')}</option>
            <option value="doctor">{tr('Doctor')}</option>
            <option value="ward">{tr('Ward')}</option>
            <option value="kiosk">{tr('Attendance board')}</option>
            <option value="lab_tech">{tr('Laboratory')}</option>
            <option value="radiology">{tr('Radiology')}</option>
            <option value="store_keeper">{tr('Stores')}</option>
            <option value="pharmacist">{tr('Pharmacy')}</option>
            <option value="reports">{tr('Reports')}</option>
            <option value="admin">{tr('Administration')}</option>
          </select>
        </Field>
        <Field label={tr('Department')}>
          <select value={f.departmentId}
            onChange={(e) => setF({ ...f, departmentId: e.target.value })}
            className="field mt-1">
            <option value="">{tr('None')}</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label={tr('Phone')} span>
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })}
            className="field mt-1 num" />
        </Field>

        {/*
          The shift, which decides whether a scan reads as late.
        
          Blank on both means no shift is recorded, which is different from
          a shift of 00:00 and has to stay tellable apart.
        */}
        <Field label={tr('Shift starts')} hint={tr('Blank if they have no fixed shift')}>
          <input type="time" value={f.shiftStart}
            onChange={(e) => setF({ ...f, shiftStart: e.target.value })}
            className="field mt-1 num" />
        </Field>
        <Field label={tr('Shift ends')}>
          <input type="time" value={f.shiftEnd}
            onChange={(e) => setF({ ...f, shiftEnd: e.target.value })}
            className="field mt-1 num" />
        </Field>

        {/*
          Their id on a standalone attendance terminal, where one is in use.
        
          Only needed when the terminal was already in service with its own
          numbering before HMS arrived. Left blank, the agent treats the
          device's user id as the staff id, which is right for a terminal
          enrolled alongside HMS.
        */}
        <Field label={tr('Id on the attendance terminal')}
          hint={tr('Blank unless the terminal numbers people its own way')} span>
          <input value={f.deviceUserId}
            onChange={(e) => setF({ ...f, deviceUserId: e.target.value })}
            placeholder={String(user.id)} className="field mt-1 num" />
        </Field>

        <label className="flex items-start gap-2 sm:col-span-2">
          <input type="checkbox" checked={f.attendanceRequired} className="mt-0.5"
            onChange={(e) => setF({ ...f, attendanceRequired: e.target.checked })} />
          <span>
            <span className="block text-2xs font-medium text-heading">
              {tr('Expected to mark attendance')}
            </span>
            <span className="block text-2xs text-muted">
              {tr('Untick for a visiting consultant who is not on a shift. They stay off the absentee list.')}
            </span>
          </span>
        </label>
      </div>

      {/*
        The doctor's own record.
      
        Shown when this account HAS one, not when the role happens to say
        doctor: changing somebody's role to doctor in this dialog does not
        create the record, and offering a fee box that saves nowhere is
        worse than not offering it.
      */}
      {user.doctor_id ? (
        <div className="mt-4 rounded-xl border-2 border-line bg-raised p-3">
          <p className="mb-3 text-2xs font-medium uppercase tracking-wide text-muted">
            {tr('Consultation and shares')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('Specialisation')}>
              <input value={f.specialisation}
                onChange={(e) => setF({ ...f, specialisation: e.target.value })}
                placeholder={tr('General Physician')} className="field mt-1" />
            </Field>
            <Field label={tr('Qualification')}>
              <input value={f.qualification}
                onChange={(e) => setF({ ...f, qualification: e.target.value })}
                placeholder={tr('MBBS, FCPS')} className="field mt-1" />
            </Field>
            <Field label={tr('Room')}>
              <input value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}
                placeholder="OPD-3" className="field mt-1 num" />
            </Field>
            <Field label={tr('Consultation fee')}
              hint={tr('What the counter charges for seeing them')}>
              <input value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })}
                placeholder="0.00" className="field mt-1 num text-right" />
            </Field>
            <Field label={tr('Keeps of the fee')} hint={tr('Per cent')}>
              <input value={f.consultShare}
                onChange={(e) => setF({ ...f, consultShare: e.target.value })}
                className="field mt-1 num text-right" />
            </Field>
            <Field label={tr('Default share of tests')} hint={tr('Per cent, before any override')}>
              <input value={f.serviceShare}
                onChange={(e) => setF({ ...f, serviceShare: e.target.value })}
                className="field mt-1 num text-right" />
            </Field>
          </div>
          <p className="mt-2 text-2xs text-muted">
            {tr('Changing a share does not touch what has already been earned. Past statements keep the share that was agreed at the time.')}
          </p>
        </div>
      ) : isDoctor && (
        <p className="mt-3 rounded-xl border border-warn/25 bg-warn/5 px-3 py-2 text-2xs text-warn">
          {tr('This account has no doctor record, so there is no fee or share to set. Saving the role as Doctor does not create one — add the account again as a doctor, or ask for this to be fixed.')}
        </p>
      )}

      {isPharmacist && (
        <label className="mt-4 flex items-start gap-2 rounded-xl border-2 border-line
                          bg-raised px-3 py-2">
          <input type="checkbox" checked={f.pharmacyAdmin} className="mt-0.5"
            disabled={heldAdmin === null}
            onChange={(e) => setF({ ...f, pharmacyAdmin: e.target.checked })} />
          <span>
            <span className="block text-2xs font-medium text-heading">
              {tr('Pharmacy administrator')}
            </span>
            <span className="block text-2xs text-muted">
              {tr('Every pharmacy permission, including setting what other counter staff can do. Unticking it removes all of them.')}
            </span>
          </span>
        </label>
      )}

      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/**
 * Deleting an account.
 *
 * The server refuses once the person has taken a bill, registered a patient or
 * reported a result, because those records carry their name and deleting the
 * account would leave a name on a printed slip with nothing behind it. This
 * dialog simply passes the refusal on, which reads better than a bare error.
 */
function DeleteStaff({ user, onClose, onDone }: {
  user: any; onClose: () => void; onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <Modal title={`${tr('Delete')} ${user.display_name}?`} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy}
          className="rounded-xl bg-bad px-4 py-2 text-sm font-medium text-white
                     transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { await api.deleteStaff(user.id); onDone() }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Deleting…') : tr('Yes, delete')}
        </button>
      </>}>
      <p className="text-sm text-body">
        {tr('This removes the account completely. They will not be able to sign in.')}
      </p>
      <p className="mt-2 text-2xs text-muted">
        {tr('If they have already taken a bill or reported a result, this is refused — those records carry their name. Archive the account instead.')}
      </p>
      {user.is_active && (
        <button
          onClick={() => api.archiveStaff(user.id).then(onDone).catch((e: any) => setErr(e.message))}
          className="btn-ghost mt-3 text-2xs">
          {tr('Archive instead')}
        </button>
      )}
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
