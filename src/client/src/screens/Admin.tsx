import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa, bpToPct, pctToBp, today, type SessionUser , newId} from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th } from '../components/ui'
import { useT } from '../lib/prefs'
import { t as tr } from '../lib/prefs'

const TABS = ['Overview', 'Staff', 'Services', 'Doctor shares', 'Departments', 'Demo data', 'Settings'] as const
type Tab = typeof TABS[number]

export function Admin({ me }: { me: SessionUser }) {
  const tr = useT()
  const [tab, setTab] = useState<Tab>('Overview')
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
              tab === t ? 'bg-brand text-white shadow-card'
                        : 'border-2 border-line bg-card text-body hover:border-primary/40 hover:bg-screen'}`}>
            {tr(t)}
          </button>
        ))}
      </div>
      {tab === 'Overview' && <Overview />}
      {tab === 'Staff' && <StaffTab me={me} />}
      {tab === 'Services' && <ServicesTab />}
      {tab === 'Doctor shares' && <SharesTab />}
      {tab === 'Departments' && <DepartmentsTab />}
      {tab === 'Demo data' && <DemoTab />}
      {tab === 'Settings' && <SettingsTab />}
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
        <Stat label={tr('Patients today')} value={String(stats?.visits ?? 0)}
          sub={`${stats?.new_patients ?? 0} newly registered`} />
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
                  <button onClick={() => setResetting(u)} className="btn-ghost mr-1 px-2 py-1 text-2xs">
                    {tr('Password')}
                  </button>
                  <button disabled={u.id === me.id}
                    onClick={() => (u.is_active ? api.archiveStaff(u.id) : api.restoreStaff(u.id))
                      .then(load).catch((e) => setErr(e.message))}
                    className="btn-ghost px-2 py-1 text-2xs">
                    {u.is_active ? 'Retire' : 'Restore'}
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
    </Card>
  )
}

function AddStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    username: '', displayName: '', password: '', role: 'main_counter',
    departmentId: '', phone: '', specialisation: '', qualification: '', room: '',
    fee: '', consultShare: '100', serviceShare: '0', pharmacyAdmin: false
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
            <option value="lab_tech">{tr('Laboratory — samples and results')}</option>
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

function ServicesTab() {
  const [rows, setRows] = useState<any[]>([])
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [setup, setSetup] = useState<any | null>(null)
  const load = useCallback(() => { api.services(true).then(setRows).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  return (
    <Card title={tr('Tests, scans and procedures')}
      hint={tr('What a doctor can order, what it costs, and the default cut the ordering doctor gets')}
      action={<button onClick={() => setEditing('new')} className="btn-primary">{tr('Add service')}</button>}>
      {rows.length === 0 ? (
        <Empty title={tr('No services yet')}
          hint={tr('Add the tests and scans this hospital offers, with their prices.')}
          action={<button onClick={() => setEditing('new')} className="btn-primary">{tr('Add the first one')}</button>} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Service')}</Th><Th w="w-28">{tr('Category')}</Th><Th w="w-28" right>{tr('Price')}</Th>
                <Th w="w-28" right>{tr('Doctor gets')}</Th><Th w="w-24" right>{tr('Ordered')}</Th><Th w="w-40" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {rows.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{s.name}</span>
                    {!s.is_active && <Badge>{tr('hidden')}</Badge>}
                    {s.code && <div className="text-2xs text-muted">{s.code}</div>}
                  </td>
                  <td className="px-3 py-2"><Badge>{s.category}</Badge></td>
                  <td className="px-3 py-2 text-right num font-medium text-primary">{rs(s.price_paisa)}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-accent">
                    {bpToPct(s.default_share_bp)}%
                    <div className="text-muted">
                      {rs(Math.round(Number(s.price_paisa) * s.default_share_bp / 10000))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{s.times_ordered}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(s)} className="btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                    {/*
                      What the test reports and what it uses up. Kept behind
                      its own button because most services never need it and
                      the ones that do need a lot of rows.
                    */}
                    <button onClick={() => setSetup(s)} className="ml-1 btn-ghost px-2 py-1 text-2xs">
                      {tr('Test setup')}
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
        <ServiceForm initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />
      )}
    </Card>
  )
}

function ServiceForm({ initial, onClose, onDone }: {
  initial: any | null; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', code: initial?.code ?? '',
    category: initial?.category ?? 'lab',
    price: initial ? rs(initial.price_paisa) : '',
    share: initial ? bpToPct(initial.default_share_bp) : '0',
    isActive: initial ? initial.is_active : true
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
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
                  defaultShareBp: pctToBp(f.share), isActive: f.isActive
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
          <li key={d.id} className="flex items-center justify-between py-2">
            <span>
              <span className="text-sm text-heading">{d.name}</span>
              <Badge tone="primary">{d.code}</Badge>
            </span>
            <span className="num text-2xs text-muted">{d.staff_count} staff</span>
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
      const r = await api.loadDemoData(needsConfirm, Math.max(1, Number(days) || 45))
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
function TestSetup({ service, onClose }: { service: any; onClose: () => void }) {
  const [params, setParams] = useState<any[]>([])
  const [recipe, setRecipe] = useState<any[]>([])
  const [items, setItems] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.serviceParameters(service.id)
      .then((p) => setParams(p.map((x: any) => ({
        key: newId(), name: x.name, unit: x.unit ?? '',
        refLow: x.ref_low ?? '', refHigh: x.ref_high ?? '', refText: x.ref_text ?? ''
      })))).catch(() => {})
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
      await api.saveServiceParameters(service.id, params
        .filter((p) => p.name.trim())
        .map((p) => ({
          name: p.name.trim(), unit: p.unit.trim() || null,
          refLow: p.refLow === '' ? null : Number(p.refLow),
          refHigh: p.refHigh === '' ? null : Number(p.refHigh),
          refText: p.refText.trim() || null
        })))
      await api.saveServiceConsumables(service.id, recipe
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

      {params.length > 0 && (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Name')}</Th><Th w="w-20">{tr('Unit')}</Th>
              <Th w="w-20" right>{tr('Low')}</Th><Th w="w-20" right>{tr('High')}</Th>
              <Th w="w-32">{tr('Normal reading')}</Th><Th w="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide">
            {params.map((p, i) => (
              <tr key={p.key}>
                {(['name', 'unit', 'refLow', 'refHigh', 'refText'] as const).map((f) => (
                  <td key={f} className="px-1 py-1">
                    <input value={p[f]}
                      onChange={(e) => setParams((ps) => ps.map((x, j) =>
                        j === i ? { ...x, [f]: e.target.value } : x))}
                      className={`field py-1 text-2xs ${
                        f === 'refLow' || f === 'refHigh' ? 'num text-right' : ''}`} />
                  </td>
                ))}
                <td className="pr-1 text-right">
                  <button onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}
                    className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button onClick={() => setParams((ps) => [...ps, {
        key: newId(), name: '', unit: '', refLow: '', refHigh: '', refText: '' }])}
        className="btn-ghost mt-2 text-2xs">{tr('Add a line')}</button>

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
    </Modal>
  )
}
