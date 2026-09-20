import { useCallback, useEffect, useRef, useState } from 'react'
import { api, rs, type SessionUser } from '../lib/api'
import { useT } from '../lib/prefs'
import { Badge, Card, ErrorNote, Field, Modal, Stat, Th, Empty } from '../components/ui'
import { ChitPreview } from '../components/Chit'
import { CounterBilling, type BillTarget } from './counter/Billing'
import { PrinterSettingsCard } from '../components/PrinterSettings'
import { t as tr } from '../lib/prefs'
import { Sidebar, type NavItem } from '../components/Sidebar'
import { Reports } from './pharma/Reports'
import {
  UserPlus, Banknote, Receipt, Users, LayoutDashboard, BarChart3, Printer,
  Stethoscope, FlaskConical, Search, AlertTriangle
} from 'lucide-react'

type Tab = 'overview' | 'desk' | 'billing' | 'patients' | 'chits' | 'reports' | 'printing'

const NAV: (NavItem & { id: Tab })[] = [
  { id: 'desk', label: 'Registration', glyph: 'R', icon: UserPlus, section: 'Front desk' },
  { id: 'billing', label: 'Billing', glyph: 'B', icon: Banknote },
  { id: 'chits', label: 'Chits and payments', glyph: 'C', icon: Receipt },

  { id: 'patients', label: 'All patients', glyph: 'P', icon: Users, section: 'Records' },
  { id: 'overview', label: 'Overview', glyph: 'O', icon: LayoutDashboard },
  { id: 'reports', label: 'Reports', glyph: 'Rp', icon: BarChart3 },

  { id: 'printing', label: 'Printing', glyph: 'Pr', icon: Printer, section: 'Setup' }
]

/**
 * The main counter: the cash window at the front of the hospital.
 *
 * Everything money passes through here. A patient registers, pays the
 * consultation fee and takes a token slip; later, if the doctor orders an
 * x-ray or blood work, they come back to this same window with the chit, pay,
 * and carry the stamped slip to the department. One till, one person
 * accountable at close of day.
 *
 * The OPD desk upstairs holds the queue and takes vitals, and handles no cash
 * at all. That separation is the whole point of having two counters.
 */
export function MainCounter({ me }: { me: SessionUser }) {
  const tr = useT()
  const [tab, setTab] = useState<Tab>('desk')

  /**
   * What the till is currently ringing up.
   *
   * Held here rather than inside the billing tab because both the registration
   * desk and the chits list hand work to it, and the tab has to survive the
   * user clicking away and back.
   */
  const [billing, setBilling] = useState<BillTarget | null>(null)

  function sendToTill(target: BillTarget) {
    setBilling(target)
    setTab('billing')
  }
  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={NAV} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Main counter" subtitle={me.displayName} />
      <div key={tab} className="anim-fade min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'desk' && <Desk me={me} onBill={sendToTill} />}
        {tab === 'billing' && (
          <CounterBilling me={me} target={billing}
            onDone={() => { setBilling(null); setTab('desk') }}
            onCancel={() => { setBilling(null); setTab('desk') }} />
        )}
        {tab === 'overview' && <CounterOverview />}
        {tab === 'printing' && (
          <div className="p-5">
            <PrinterSettingsCard module="counter" label={tr('Main counter window')} />
          </div>
        )}
        {tab === 'patients' && <PatientDirectory />}
        {tab === 'chits' && <ChitCounter onBill={sendToTill} />}
        {tab === 'reports' && <Reports me={me} />}
      </div>
    </div>
  )
}

function Desk({ me, onBill }: { me: SessionUser; onBill: (t: BillTarget) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [queue, setQueue] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [registering, setRegistering] = useState(false)
  const [booking, setBooking] = useState<any | null>(null)
  const [editing, setEditing] = useState<any | null>(null)
  const [direct, setDirect] = useState<any | null>(null)
  const [next, setNext] = useState<any | null>(null)
  const search = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    api.queue().then(setQueue).catch(() => {})
    api.statsToday().then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 20_000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => api.searchPatients(q).then(setResults).catch(() => setResults([])), 200)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={tr('Patients today')} value={String(stats?.visits ?? 0)} />
        <Stat label={tr('Waiting')} value={String(stats?.waiting ?? 0)} tone="warn" />
        <Stat label={tr('Seen')} value={String(stats?.completed ?? 0)} tone="ok" />
        <Stat label={tr('Fees collected')} value={`Rs ${rs(stats?.fees_paisa)}`} tone="accent" />
      </div>

      <Card
        title={tr('Find or register a patient')}
        hint={tr('Search by name, phone, MRN or CNIC before registering. It is the same person more often than it looks.')}
        action={
          <button onClick={() => setRegistering(true)} className="btn-primary">{tr('New patient')}</button>
        }
      >
        <input ref={search} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={tr('Name, phone number, MRN or CNIC')} className="field" />

        {results.length > 0 && (
          <ul className="mt-3 divide-y divide-divide rounded-lg border border-line">
            {results.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-heading">{p.name}</span>
                    <Badge tone="primary">{p.mrn}</Badge>
                    {p.age_years != null && <span className="text-2xs text-muted">{p.age_years}y</span>}
                    {p.gender && <span className="text-2xs capitalize text-muted">{p.gender}</span>}
                  </div>
                  <div className="text-2xs text-muted num">
                    {[p.phone, p.father_name && `s/o ${p.father_name}`].filter(Boolean).join(' · ')}
                    {p.visit_count > 0 && ` · ${p.visit_count} previous visit${p.visit_count > 1 ? 's' : ''}`}
                  </div>
                </div>
                <button onClick={() => setEditing(p)} className="btn-ghost shrink-0">{tr('Edit')}</button>
                {/*
                  Not everyone at the window needs a doctor. Somebody with a
                  form from another hospital just wants the test.
                */}
                <button onClick={() => setDirect(p)} className="btn-ghost shrink-0">
                  {tr('Test only')}
                </button>
                {/*
                  Always available, even with the doctor terminal switched off.
                  The counter still books an appointment against a doctor and
                  still takes the fee; what is switched off is the consultation
                  itself, which the hospital has not started using yet. Hiding
                  this would have stopped them selling the appointment.
                */}
                <button onClick={() => setBooking(p)} className="btn-ghost shrink-0">
                  {tr('Send to doctor')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.trim().length >= 2 && results.length === 0 && (
          <p className="mt-3 text-2xs text-muted">
            {tr('Nobody matches that. Register them as a new patient if you are sure.')}
          </p>
        )}
      </Card>

      <Card title={tr('Today\'s queue')} hint={tr('Refreshes on its own')}>
        {queue.length === 0 ? (
          <Empty title={tr('Nobody waiting')} hint={tr('Patients appear here as you send them to a doctor.')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-16">{tr('Token')}</Th><Th>{tr('Patient')}</Th><Th w="w-40">{tr('Doctor')}</Th>
                  <Th w="w-28">{tr('Status')}</Th><Th w="w-24">{tr('Fee')}</Th><Th w="w-28" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {queue.map((v) => (
                  <tr key={v.id}>
                    <td className="px-3 py-2">
                      <span className="num text-lg font-semibold text-primary">{v.token_no}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-heading">{v.patient_name}</div>
                      <div className="text-2xs text-muted num">{v.mrn} · {v.phone ?? 'no phone'}</div>
                    </td>
                    <td className="px-3 py-2 text-2xs">{v.doctor_name}{v.room && ` · Room ${v.room}`}</td>
                    <td className="px-3 py-2">
                      <Badge tone={v.status === 'completed' ? 'ok' : v.status === 'in_consultation' ? 'primary' : 'warn'}>
                        {tr(v.status === 'in_consultation' ? 'with doctor' : v.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {/*
                        No "mark paid" shortcut. Money goes through the till so
                        there is an invoice behind every rupee; the old
                        shortcut also left the visit stuck at `registered`,
                        paid but invisible to the OPD desk.
                      */}
                      {v.fee_paid
                        ? <Badge tone="ok">{tr('paid')}</Badge>
                        : <button onClick={() => onBill({ kind: 'consultation', visitId: v.id })}
                            className="btn-primary px-2 py-1 text-2xs">
                            {tr('Take payment')}
                          </button>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEditing({ id: v.patient_id, name: v.patient_name })}
                        className="ml-1 btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                      {v.status === 'registered' && (
                        <button onClick={() => api.abandonVisit(v.id).then(refresh).catch(() => {})}
                          className="ml-1 text-2xs text-muted hover:text-bad">{tr('Drop')}</button>
                      )}
                      {v.status === 'waiting' && (
                        <button onClick={() => api.setVisitStatus(v.id, 'cancelled').then(refresh)}
                          className="ml-1 text-2xs text-muted hover:text-bad">{tr('Cancel')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {registering && (
        <RegisterPatient
          onClose={() => setRegistering(false)}
          /*
            Registration used to go straight to "choose a doctor", which is
            wrong for a hospital whose patients mostly arrive holding a test
            form. Now it asks what they are here for — and when the doctor
            terminal is switched off it does not ask at all, it goes to tests.
          */
          onDone={(p) => { setRegistering(false); setQ(''); setNext(p) }}
        />
      )}
      {booking && (
        <SendToDoctor patient={booking} me={me}
          onClose={() => setBooking(null)}
          onDone={(visit: any) => {
            setBooking(null); setQ(''); setResults([]); refresh()
            // Straight to the till: the visit exists but is not in the queue
            // until the bill is completed.
            if (visit?.id) onBill({ kind: 'consultation', visitId: visit.id })
          }} />
      )}
      {editing && (
        <EditPatient patientId={editing.id} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); setQ(q); refresh() }} />
      )}
      {/*
        One question, asked once, immediately after the details are taken.
      */}
      {next && (
        <WhatFor patient={next}
          onClose={() => setNext(null)}
          onDoctor={() => { const p = next; setNext(null); setBooking(p) }}
          onTests={() => { const p = next; setNext(null); setDirect(p) }} />
      )}
      {direct && (
        <DirectTests patient={direct} onClose={() => setDirect(null)}
          onDone={(chit: any) => {
            setDirect(null); setQ(''); setResults([]); refresh()
            if (chit) onBill({ kind: 'chit', chitId: chit.id })
          }} />
      )}
    </div>
  )
}

/* --------------------------------------------------------------- register */

function RegisterPatient({ onClose, onDone }: { onClose: () => void; onDone: (p: any) => void }) {
  const [f, setF] = useState({
    name: '', fatherName: '', phone: '', gender: '', ageYears: '',
    cnic: '', address: '', bloodGroup: '', allergies: ''
  })
  const [dupes, setDupes] = useState<any[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /**
   * Look for the same person while the name is still being typed.
   *
   * Two letters and 150ms, not four hundred. The old delay meant the warning
   * arrived after the clerk had already moved to the phone field and stopped
   * looking at the top of the form, so the same patient got registered twice
   * and every visit, chit and result afterwards was split across two records.
   * Cleaning that up later is far harder than showing the list early.
   */
  useEffect(() => {
    const name = f.name.trim()
    const phone = f.phone.trim()
    if (name.length < 2 && phone.length < 4 && !f.cnic.trim()) { setDupes([]); return }
    const timer = setTimeout(() => {
      api.checkDuplicates({ name: name || 'x', phone: phone || null, cnic: f.cnic || null })
        .then(setDupes).catch(() => setDupes([]))
    }, 150)
    return () => clearTimeout(timer)
  }, [f.name, f.phone, f.cnic, f.fatherName])

  async function save() {
    if (!f.name.trim()) { setErr('The patient needs a name'); return }
    setBusy(true); setErr(null)
    try {
      onDone(await api.registerPatient({
        name: f.name.trim(),
        fatherName: f.fatherName.trim() || null,
        phone: f.phone.trim() || null,
        gender: f.gender || null,
        ageYears: f.ageYears ? Number(f.ageYears) : null,
        cnic: f.cnic.trim() || null,
        address: f.address.trim() || null,
        bloodGroup: f.bloodGroup.trim() || null,
        allergies: f.allergies.trim() || null
      }))
    } catch (e: any) { setErr(e.message ?? 'Could not register') }
    finally { setBusy(false) }
  }

  return (
    <Modal title={tr('Register a patient')} wide onClose={onClose}
      hint={tr('A hospital number is generated automatically.')}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button onClick={save} disabled={busy || !f.name.trim()} className="btn-primary">
            {busy ? 'Saving…' : 'Register'}
          </button>
        </>
      }>
      {/*
        Sits directly under the name, where the clerk is already looking,
        rather than in a panel above the form they have scrolled past.
      */}
      {dupes.length > 0 && !dismissed && (
        <div className="anim-in mb-4 overflow-hidden rounded-xl border-2 border-warn/45
                        bg-warn/5">
          <div className="flex items-center gap-2 border-b border-warn/30 px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 text-warn" />
            <p className="flex-1 text-2xs font-medium text-warn">
              {dupes.length === 1
                ? tr('Someone already registered looks like this person')
                : `${dupes.length} ${tr('people already registered look like this person')}`}
            </p>
            <button onClick={() => setDismissed(true)}
              className="shrink-0 rounded-lg px-1.5 text-warn/70 hover:bg-warn/10">
              &times;
            </button>
          </div>

          <ul className="divide-y divide-warn/20">
            {dupes.map((d) => (
              <li key={d.id}>
                <button onClick={() => onDone(d)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left
                             transition-colors hover:bg-warn/10">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full
                                   bg-warn/15 text-2xs font-semibold text-warn">
                    {String(d.name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-heading">
                      {d.name}
                      {d.father_name && (
                        <span className="ml-1 text-2xs font-normal text-muted">
                          s/o {d.father_name}
                        </span>
                      )}
                    </span>
                    <span className="block num text-2xs text-muted">
                      {d.mrn}
                      {d.phone ? ` · ${d.phone}` : ''}
                      {d.age_years != null ? ` · ${d.age_years}y` : ''}
                      {d.last_visit ? ` · ${tr('last seen')} ${String(d.last_visit).slice(0, 10)}` : ''}
                    </span>
                  </span>
                  <Badge tone="warn">{d.why}</Badge>
                  <span className="shrink-0 text-2xs font-medium text-primary">
                    {tr('Use this')}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <p className="border-t border-warn/20 px-3 py-2 text-2xs text-muted">
            {tr('Registering again is fine if it really is a different person — families share a phone. Picking one above avoids splitting their history across two records.')}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Full name')} span>
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('Asif Mahmood')} className="field" />
        </Field>
        <Field label={tr('Father\'s or husband\'s name')}>
          <input value={f.fatherName} onChange={(e) => setF({ ...f, fatherName: e.target.value })}
            className="field" />
        </Field>
        <Field label={tr('Phone')} hint={tr('The most reliable way to find them again')}>
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })}
            placeholder="0300-1234567" className="field num" />
        </Field>
        <Field label={tr('Gender')}>
          <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} className="field">
            <option value="">{tr('Not recorded')}</option>
            <option value="male">{tr('Male')}</option>
            <option value="female">{tr('Female')}</option>
            <option value="other">{tr('Other')}</option>
          </select>
        </Field>
        <Field label={tr('Age in years')}>
          <input value={f.ageYears} onChange={(e) => setF({ ...f, ageYears: e.target.value })}
            className="field num" />
        </Field>
        <Field label={tr('CNIC')}>
          <input value={f.cnic} onChange={(e) => setF({ ...f, cnic: e.target.value })}
            placeholder="34101-1234567-1" className="field num" />
        </Field>
        <Field label={tr('Blood group')}>
          <input value={f.bloodGroup} onChange={(e) => setF({ ...f, bloodGroup: e.target.value })}
            placeholder={tr('B+')} className="field" />
        </Field>
        <Field label={tr('Address')} span>
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="field" />
        </Field>
        <Field label={tr('Known allergies')} span hint={tr('Shown to the doctor on every visit')}>
          <input value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })}
            placeholder={tr('Penicillin')} className="field" />
        </Field>
      </div>
      <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/* --------------------------------------------------------- send to doctor */

function SendToDoctor({ patient, me, onClose, onDone }: {
  patient: any; me: SessionUser; onClose: () => void; onDone: (visit?: any) => void
}) {
  const [doctors, setDoctors] = useState<any[]>([])
  const [doctorId, setDoctorId] = useState(0)
  const [complaint, setComplaint] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  void me

  useEffect(() => {
    api.doctors().then((d) => { setDoctors(d); setDoctorId(d[0]?.id ?? 0) }).catch(() => {})
  }, [])

  const doctor = doctors.find((d) => d.id === doctorId)

  async function save() {
    setBusy(true); setErr(null)
    try {
      /**
       * Created unpaid, always. The cashier's bill is what puts the patient in
       * the queue, so there is no "mark as paid" shortcut here — a fee marked
       * paid with no invoice behind it is money that cannot be reconciled.
       */
      const v = await api.createVisit({
        patientId: patient.id, doctorId,
        complaint: complaint.trim() || null, feePaid: false
      })
      onDone(v)
    } catch (e: any) { setErr(e.message ?? 'Could not create the visit'); setBusy(false) }
  }


  return (
    <Modal title={`Send ${patient.name} to a doctor`} onClose={onClose}
      hint={`${patient.mrn}${patient.phone ? ` · ${patient.phone}` : ''}`}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button onClick={save} disabled={busy || !doctorId} className="btn-primary">
            {busy ? 'Creating…' : 'Create visit'}
          </button>
        </>
      }>
      <div className="space-y-3">
        <Field label={tr('Doctor')}>
          <select value={doctorId} onChange={(e) => setDoctorId(Number(e.target.value))} className="field">
            {doctors.length === 0 && <option value={0}>{tr('No doctors set up yet')}</option>}
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}{d.specialisation ? ` — ${d.specialisation}` : ''}
                {d.waiting > 0 ? ` (${d.waiting} waiting)` : ''}
              </option>
            ))}
          </select>
        </Field>

        {doctor && (
          <div className="rounded-lg border border-line bg-tint p-3">
            <div className="flex items-center justify-between text-2xs">
              <span className="text-muted">{tr('Consultation fee')}</span>
              <span className="num text-base font-semibold text-primary">
                Rs {rs(doctor.consultation_fee_paisa)}
              </span>
            </div>
            <p className="mt-2 text-2xs text-muted">
              {tr('Payment is taken on the next screen. The patient joins the queue once the bill is complete.')}
            </p>
          </div>
        )}

        <Field label={tr('Complaint')} hint={tr('What they have come in for, in their words')}>
          <input value={complaint} onChange={(e) => setComplaint(e.target.value)}
            placeholder={tr('Fever for three days')} className="field" />
        </Field>

        {patient.allergies && (
          <p className="rounded-lg border border-bad/25 bg-bad/5 px-3 py-2 text-2xs text-bad">
            Allergies on file: {patient.allergies}
          </p>
        )}
        <ErrorNote>{err}</ErrorNote>
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------- edit a patient */

/**
 * Details get corrected constantly: a phone taken down wrong, an age guessed
 * at first contact, an address that has changed. The MRN is deliberately not
 * editable — it is the key every other record points at.
 */
function EditPatient({ patientId, onClose, onDone }: {
  patientId: number; onClose: () => void; onDone: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [f, setF] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.patient(patientId).then((r: any) => {
      const p = r.patient ?? r
      setF({
        mrn: p.mrn, name: p.name ?? '', fatherName: p.father_name ?? '',
        phone: p.phone ?? '', gender: p.gender ?? '',
        ageYears: p.age_years != null ? String(p.age_years) : '',
        cnic: p.cnic ?? '', address: p.address ?? '',
        bloodGroup: p.blood_group ?? '', allergies: p.allergies ?? '', notes: p.notes ?? ''
      })
    }).catch((e: any) => setErr(e.message))
  }, [patientId])

  async function save() {
    setBusy(true); setErr(null)
    try {
      await api.updatePatient(patientId, {
        name: f.name.trim(), fatherName: f.fatherName.trim() || null,
        phone: f.phone.trim() || null, gender: f.gender || null,
        ageYears: f.ageYears ? Number(f.ageYears) : null,
        cnic: f.cnic.trim() || null, address: f.address.trim() || null,
        bloodGroup: f.bloodGroup.trim() || null, allergies: f.allergies.trim() || null,
        notes: f.notes.trim() || null
      })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={tr('Edit patient')} hint={f?.mrn} wide onClose={onClose}
      footer={<>
        {/*
          Deleting sits on the far left, away from Save. The server refuses if
          the patient has any history, so the only records this can remove are
          duplicates created minutes ago.
        */}
        <button onClick={() => setConfirmDelete(true)} disabled={busy || deleting}
          className="btn-ghost mr-auto border-bad/40 text-bad hover:border-bad hover:bg-bad/5">
          {tr('Delete patient')}
        </button>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !f?.name?.trim()} className="btn-primary">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </>}>
      {!f ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr('Name')}><input value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })} className="field" /></Field>
          <Field label={tr('Father or husband')}><input value={f.fatherName}
            onChange={(e) => setF({ ...f, fatherName: e.target.value })} className="field" /></Field>
          <Field label={tr('Phone')}><input value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })} className="field num" /></Field>
          <Field label={tr('CNIC')}><input value={f.cnic}
            onChange={(e) => setF({ ...f, cnic: e.target.value })} className="field num" /></Field>
          <Field label={tr('Age')}><input value={f.ageYears}
            onChange={(e) => setF({ ...f, ageYears: e.target.value })} className="field num" /></Field>
          <Field label={tr('Sex')}>
            <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} className="field">
              <option value="">{tr('Not recorded')}</option>
              <option value="male">{tr('Male')}</option><option value="female">{tr('Female')}</option>
              <option value="other">{tr('Other')}</option>
            </select>
          </Field>
          <Field label={tr('Blood group')}><input value={f.bloodGroup}
            onChange={(e) => setF({ ...f, bloodGroup: e.target.value })} className="field" /></Field>
          <Field label={tr('Address')}><input value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })} className="field" /></Field>
          <Field label={tr('Allergies')} span>
            <input value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })}
              placeholder={tr('Penicillin')} className="field" />
          </Field>
          <Field label={tr('Notes')} span>
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="field" />
          </Field>
        </div>
      )}
      <p className="mt-3 text-2xs text-muted">
        {tr('The MRN cannot be changed. Every visit, prescription and chit points at it.')}
      </p>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>

      {confirmDelete && (
        <Modal title={tr('Delete this patient?')} onClose={() => setConfirmDelete(false)}
          footer={<>
            <button onClick={() => setConfirmDelete(false)} className="btn-ghost">
              {tr('Keep the record')}
            </button>
            <button disabled={deleting}
              onClick={async () => {
                setDeleting(true); setErr(null)
                try { await api.deletePatient(patientId); onDone() }
                catch (e: any) { setErr(e.message); setConfirmDelete(false) }
                finally { setDeleting(false) }
              }}
              className="btn-primary bg-bad bg-none hover:opacity-90">
              {deleting ? tr('Deleting…') : tr('Delete permanently')}
            </button>
          </>}>
          <p className="text-sm text-body">
            {tr('This removes')} <span className="font-medium text-heading">{f?.name}</span> ({f?.mrn}){' '}
            {tr('from the system for good.')}
          </p>
          <p className="mt-2 text-2xs text-muted">
            {tr('Only possible while the record has no history. If this patient has ever been seen, billed or prescribed for, the system will refuse and you should correct the details instead.')}
          </p>
        </Modal>
      )}
    </Modal>
  )
}

/* ----------------------------------------------------- patient directory */

const BUCKETS: [string, string][] = [
  ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'Everyone']
]

function PatientDirectory() {
  const [bucket, setBucket] = useState('today')
  const [q, setQ] = useState('')
  const [data, setData] = useState<{ rows: any[]; counts: any }>({ rows: [], counts: {} })
  const [editing, setEditing] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.patients(bucket, q).then(setData).finally(() => setLoading(false))
  }, [bucket, q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  return (
    <div className="space-y-4 p-5">
      <Card title={tr('All patients')} hint={tr('Everyone ever registered, most recently seen first')}>
        <div className="flex flex-wrap items-center gap-2">
          {BUCKETS.map(([id, label]) => (
            <button key={id} onClick={() => setBucket(id)}
              className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
                bucket === id ? 'bg-brand text-white'
                              : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
              {tr(label)} <span className="num opacity-70">{data.counts?.[id] ?? 0}</span>
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Name, MRN, phone or CNIC')} className="field ml-auto w-64" />
        </div>

        {loading ? <p className="py-8 text-sm text-muted">{tr('Loading…')}</p>
          : data.rows.length === 0 ? <Empty title={tr('Nobody in this window')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-28">{tr('MRN')}</Th><Th>{tr('Patient')}</Th><Th w="w-36">{tr('Phone')}</Th>
                  <Th w="w-40">{tr('Last seen')}</Th><Th w="w-20" right>{tr('Visits')}</Th><Th w="w-24" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {data.rows.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 num text-2xs text-primary">{p.mrn}</td>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{p.name}</span>
                      <span className="block text-2xs text-muted">
                        {[p.age_years != null && `${p.age_years}y`, p.gender,
                          p.father_name && `s/o ${p.father_name}`].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 num text-2xs text-muted">{p.phone ?? '—'}</td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {p.last_visit
                        ? <>
                            {new Date(p.last_visit).toLocaleDateString('en-GB',
                              { day: '2-digit', month: 'short', year: '2-digit' })}
                            {p.last_doctor && <span className="block">{p.last_doctor}</span>}
                          </>
                        : 'Never seen'}
                    </td>
                    <td className="px-3 py-2 text-right num text-2xs">{p.visits ?? 0}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEditing(p)} className="btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <EditPatient patientId={editing.id} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------ chit counter */

const CHIT_STATUS: [string, string][] = [
  ['ordered', 'Awaiting payment'], ['paid', 'Paid, not yet done'],
  ['completed', 'Finished'], ['all', 'All']
]

/**
 * The cashier's view, and the department's.
 *
 * Same list serves both: the counter finds a chit and marks it paid; the x-ray
 * room finds the patient, sees paid, and marks it done afterwards. Neither can
 * skip the other's step — the server refuses.
 */
function ChitCounter({ onBill }: { onBill: (t: BillTarget) => void }) {
  const [status, setStatus] = useState('ordered')
  const [category, setCategory] = useState('all')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [preview, setPreview] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.chits({ status, category, q }).then(setRows).finally(() => setLoading(false))
  }, [status, category, q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => {
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const total = rows.reduce((n, c) => n + Number(c.total_paisa), 0)

  async function act(fn: Promise<any>) {
    setErr(null)
    try { await fn; load() } catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="space-y-4 p-5">
      <Card title={tr('Chits and payments')}
        hint={tr('Print the chit, take the money, then the patient carries it to the department')}>
        <div className="flex flex-wrap items-center gap-2">
          {CHIT_STATUS.map(([id, label]) => (
            <button key={id} onClick={() => setStatus(id)}
              className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
                status === id ? 'bg-brand text-white'
                              : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
              {tr(label)}
            </button>
          ))}
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="field w-40 py-1.5 text-2xs">
            <option value="all">{tr('All departments')}</option>
            <option value="radiology">{tr('Radiology')}</option>
            <option value="lab">{tr('Laboratory')}</option>
            <option value="procedure">{tr('Procedures')}</option>
            <option value="other">{tr('Other')}</option>
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Chit no, MRN, name, phone or token')}
            className="field ml-auto w-72" />
        </div>

        <ErrorNote>{err}</ErrorNote>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Stat label={tr('Chits shown')} value={String(rows.length)} />
          <Stat label={tr('Value')} value={`Rs ${rs(total)}`} tone="accent" />
        </div>

        {loading ? <p className="py-8 text-sm text-muted">{tr('Loading…')}</p>
          : rows.length === 0 ? <Empty title={tr('Nothing here')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-32">{tr('Chit')}</Th><Th>{tr('Patient')}</Th><Th w="w-28">{tr('Department')}</Th>
                  <Th w="w-36">{tr('Referred by')}</Th><Th w="w-28" right>{tr('Amount')}</Th>
                  <Th w="w-24">{tr('Status')}</Th><Th w="w-52" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2">
                      <span className="num text-2xs text-primary">{c.chit_no}</span>
                      <span className="block num text-2xs text-muted">token {c.token_no}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{c.patient_name}</span>
                      <span className="block num text-2xs text-muted">{c.mrn}</span>
                    </td>
                    <td className="px-3 py-2 text-2xs capitalize text-body">{tr(c.category)}</td>
                    <td className="px-3 py-2 text-2xs text-muted">{c.doctor_name ?? '—'}</td>
                    <td className="px-3 py-2 text-right num text-sm font-medium text-primary">
                      {rs(c.total_paisa)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.status === 'completed' ? 'ok' : c.status === 'paid' ? 'primary' : 'warn'}>
                        {tr(c.status === 'ordered' ? 'unpaid' : c.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setPreview(c.id)} className="btn-ghost px-2 py-1 text-2xs">
                        {tr('View')}
                      </button>
                      {/*
                        Straight to the till, the same way a new registration
                        goes. The cashier keys in what the patient handed over
                        there; nothing is settled or printed from this list.
                      */}
                      {c.status === 'ordered' && (
                        <button onClick={() => onBill({ kind: 'chit', chitId: c.id })}
                          className="ml-1 btn-primary px-2 py-1 text-2xs">{tr('Take payment')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {preview && <ChitPreview chitId={preview} onClose={() => setPreview(null)} />}

    </div>
  )
}

/* ---------------------------------------------------------------- overview */

const WINDOWS: [number, string][] = [[8, 'Last 8 hours'], [24, 'Last 24 hours'], [72, 'Last 3 days']]

/**
 * The desk's own view of its day, built for counting the cash box.
 *
 * Consultation fees only. Money for tests and scans is taken at the pharmacy
 * counter and reported there, so the two tills never double count — the chit
 * figures below are for handover, not for the drawer.
 */
function CounterOverview() {
  const [hours, setHours] = useState(24)
  const [d, setD] = useState<any>(null)

  useEffect(() => {
    const load = () => api.receptionOverview(hours).then(setD).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [hours])

  if (!d) return <p className="p-6 text-sm text-muted">{tr('Loading…')}</p>

  const k = d.kpi
  const prevFees = Number(d.prev.collected_paisa)
  const change = prevFees > 0
    ? ((Number(k.collected_paisa) - prevFees) / prevFees) * 100
    : null
  const peakVisits = Math.max(...d.hourly.map((h: any) => h.visits), 1)
  const peakFees = Math.max(...d.hourly.map((h: any) => Number(h.fees_paisa)), 1)
  const busiest = d.hourly.reduce(
    (a: any, b: any) => (b.visits > (a?.visits ?? -1) ? b : a), null as any)
  const maxDoctor = Math.max(...d.byDoctor.map((x: any) => Number(x.fees_paisa)), 1)

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap gap-1">
        {WINDOWS.map(([n, label]) => (
          <button key={n} onClick={() => setHours(n)}
            className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
              hours === n ? 'bg-brand text-white'
                          : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            {tr(label)}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={tr('Consultation fees collected')} value={`Rs ${rs(k.collected_paisa)}`} tone="ok"
          sub={change === null
            ? `${k.paid_visits} paid`
            : `${change >= 0 ? '+' : ''}${change.toFixed(0)}% on the previous ${hours}h`} />
        <Stat label={tr('Still to collect')} value={`Rs ${rs(k.outstanding_paisa)}`}
          tone={Number(k.outstanding_paisa) > 0 ? 'warn' : undefined}
          sub={`${k.unpaid_visits} visit${k.unpaid_visits === 1 ? '' : 's'} unpaid`} />
        <Stat label={tr('Patients seen')} value={String(k.visits)} tone="accent"
          sub={`${k.new_patients} new · ${k.returning_patients} returning`} />
        <Stat label={tr('Still waiting')} value={String(k.waiting)}
          tone={k.waiting > 0 ? 'warn' : 'ok'} sub={`${k.completed} finished`} />
      </div>

      <Card title={tr('Cash box')} hint={tr('What should be in the drawer at handover')}>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <p className="text-2xs uppercase tracking-wide text-muted">
              Consultation fees, last {hours} hours
            </p>
            <p className="num text-4xl font-semibold text-primary">Rs {rs(k.collected_paisa)}</p>
            <p className="mt-1 text-2xs text-muted">
              From {k.paid_visits} paid consultation{k.paid_visits === 1 ? '' : 's'}.
              {Number(k.outstanding_paisa) > 0 &&
                ` Rs ${rs(k.outstanding_paisa)} is still owed on ${k.unpaid_visits} visit${
                  k.unpaid_visits === 1 ? '' : 's'} — settle these before closing.`}
            </p>
          </div>
          <div className="rounded-2xl border-2 border-line bg-raised p-4 text-2xs">
            <p className="font-medium text-heading">{tr('Not in this drawer')}</p>
            <p className="mt-1 text-muted">
              {d.chits.printed} chit{d.chits.printed === 1 ? '' : 's'} printed here,
              worth Rs {rs(Number(d.chits.unpaid_paisa) + Number(d.chits.settled_paisa))}.
              That money is taken at the pharmacy counter.
            </p>
            {d.chits.unpaid > 0 && (
              <p className="mt-2 text-warn">
                {d.chits.unpaid} still unpaid (Rs {rs(d.chits.unpaid_paisa)}) — patients may
                not have reached the counter yet.
              </p>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={tr('Through the day')}
          hint={busiest ? `Busiest around ${busiest.hour}` : 'Hour by hour'}>
          <div className="flex h-44 items-end gap-1">
            {d.hourly.map((h: any) => (
              <div key={h.at} className="group relative flex flex-1 flex-col justify-end gap-0.5"
                title={`${h.hour} — ${h.visits} patients, Rs ${rs(h.fees_paisa)}`}>
                <div className="w-full rounded-t bg-accent/70 transition-colors group-hover:bg-accent"
                  style={{ height: `${(Number(h.fees_paisa) / peakFees) * 70}px` }} />
                <div className="w-full rounded-t bg-primary/80 transition-colors group-hover:bg-primary"
                  style={{ height: `${Math.max((h.visits / peakVisits) * 70, h.visits ? 3 : 0)}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-2xs text-muted">
            <span>{d.hourly[0]?.hour}</span>
            <span className="flex gap-3">
              <Key className="bg-primary/80" label={tr('patients')} />
              <Key className="bg-accent/70" label={tr('fees')} />
            </span>
            <span>{d.hourly[d.hourly.length - 1]?.hour}</span>
          </div>
        </Card>

        <Card title={tr('By doctor')} hint={tr('Fees collected against each')}>
          {d.byDoctor.length === 0 ? <Empty title={tr('No consultations yet')} /> : (
            <ul className="space-y-2.5">
              {d.byDoctor.map((x: any) => (
                <li key={x.doctor_name}>
                  <div className="flex items-baseline justify-between gap-2 text-2xs">
                    <span className="truncate text-body">
                      {x.doctor_name}
                      {x.department && <span className="text-muted"> · {x.department}</span>}
                    </span>
                    <span className="num shrink-0 text-muted">
                      {x.visits} · Rs {rs(x.fees_paisa)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-brand"
                      style={{ width: `${Math.max((Number(x.fees_paisa) / maxDoctor) * 100, 2)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${className}`} />
      {tr(label)}
    </span>
  )
}

/* ------------------------------------------------------- tests, no doctor */

/**
 * Selling a test to a walk-in.
 *
 * Creates a visit with no doctor and no consultation fee, raises the chits,
 * and hands the first one to the till. Everything downstream — the lab work
 * list, the report, the day's takings — reads it exactly like any other chit,
 * because it is one.
 */
function DirectTests({ patient, onClose, onDone }: {
  patient: any; onClose: () => void; onDone: (chit: any) => void
}) {
  const [services, setServices] = useState<any[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { api.services().then(setServices).catch(() => {}) }, [])

  const term = q.trim().toLowerCase()
  const shown = services.filter((s) =>
    s.category !== 'other' &&
    (!term || s.name.toLowerCase().includes(term)))

  const total = services
    .filter((s) => picked.includes(s.id))
    .reduce((n, s) => n + Number(s.price_paisa), 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.directServiceVisit(patient.id, picked)
      onDone(r.chits[0] ?? null)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={tr('Tests without a consultation')} hint={`${patient.name} · ${patient.mrn}`}
      wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || picked.length === 0} className="btn-primary">
          {busy ? tr('Saving…') : `${tr('Take payment')} — Rs ${rs(total)}`}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      <p className="text-2xs text-muted">
        {tr('No doctor and no consultation fee. The patient pays for the tests only, and the department sees them as soon as the bill is completed.')}
      </p>

      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={tr('Search a test')} className="field mt-3" />

      <div className="mt-3 max-h-72 overflow-auto rounded-2xl border-2 border-line">
        {shown.length === 0 ? (
          <p className="p-4 text-center text-2xs text-muted">{tr('Nothing matches that')}</p>
        ) : (
          <ul className="divide-y divide-divide">
            {shown.map((s) => {
              const on = picked.includes(s.id)
              return (
                <li key={s.id}
                  onClick={() => setPicked((p) =>
                    on ? p.filter((x) => x !== s.id) : [...p, s.id])}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ${
                    on ? 'bg-primary/10' : 'hover:bg-raised'}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded
                                      border-2 text-2xs ${
                      on ? 'border-primary bg-primary text-white' : 'border-line'}`}>
                      {on ? '\u2713' : ''}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-heading">{s.name}</span>
                      <span className="block text-2xs capitalize text-muted">{tr(s.category)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 num text-sm text-primary">{rs(s.price_paisa)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {picked.length > 0 && (
        <div className="mt-3 flex items-center justify-between border-t-2 border-divide pt-3">
          <span className="text-2xs text-muted">
            {picked.length} {tr('selected')}
          </span>
          <span className="num text-2xl font-semibold text-primary">Rs {rs(total)}</span>
        </div>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------- what are they here for */

/**
 * Asked straight after a patient is registered.
 *
 * A hospital that runs a laboratory and an x-ray room sees plenty of people
 * who arrive with a form from somewhere else and never need a consultation.
 * Sending every registration to "choose a doctor" made those visits into a
 * fiction — a doctor was picked, a fee was charged, and nobody was seen.
 */
function WhatFor({ patient, onClose, onDoctor, onTests }: {
  patient: any
  onClose: () => void
  onDoctor: () => void
  onTests: () => void
}) {
  return (
    <Modal title={tr('What are they here for?')}
      hint={`${patient.name} · ${patient.mrn}`} onClose={onClose}
      footer={<button onClick={onClose} className="btn-ghost">{tr('Decide later')}</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={onDoctor}
          className="card-tint p-4 text-left transition-transform hover:-translate-y-0.5
                     hover:shadow-md">
          <span className="tile mb-2 inline-flex">D</span>
          <span className="block text-sm font-medium text-heading">{tr('See a doctor')}</span>
          <span className="block text-2xs text-muted">
            {tr('Consultation fee, then the queue. The doctor can order tests afterwards.')}
          </span>
        </button>

        <button onClick={onTests}
          className="card-tint p-4 text-left transition-transform hover:-translate-y-0.5
                     hover:shadow-md">
          <span className="tile mb-2 inline-flex">T</span>
          <span className="block text-sm font-medium text-heading">
            {tr('Tests only — lab or x-ray')}
          </span>
          <span className="block text-2xs text-muted">
            {tr('No doctor and no consultation fee. They pay for the tests and go straight to the department.')}
          </span>
        </button>
      </div>

      <p className="mt-3 text-2xs text-muted">
        {tr('Decide later leaves them registered with nothing owing. You can find them again by name or MRN.')}
      </p>
    </Modal>
  )
}
