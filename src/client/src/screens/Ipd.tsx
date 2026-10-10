import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BedDouble, ClipboardList, BarChart3, Search, Plus, ArrowRightLeft,
  LogOut, Banknote, AlertTriangle, Sparkles
} from 'lucide-react'
import { api, rs, toPaisa, type SessionUser } from '../lib/api'
import { Sidebar, type NavItem } from '../components/Sidebar'
import {
  Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Stat, Th
} from '../components/ui'
import { Reports } from './pharma/Reports'
import { t as tr } from '../lib/prefs'
import { DUR, EASE } from '../lib/motion'

/**
 * The ward.
 *
 * Its own login rather than a tab inside the counter, because it is a
 * different room, a different shift and a different person. A nurse at the
 * nursing station wants the board and the admission in front of her; a
 * cashier should not be scrolling past twenty beds to reach the till.
 */

const NAV: NavItem[] = [
  { id: 'board', label: 'Bed board', glyph: 'B', icon: BedDouble },
  { id: 'admissions', label: 'Admissions', glyph: 'A', icon: ClipboardList },
  { id: 'reports', label: 'Reports', glyph: 'R', icon: BarChart3 }
]

type Tab = 'board' | 'admissions' | 'reports'

export function Ipd({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<Tab>('board')
  const [open, setOpen] = useState<number | null>(null)

  if (open) {
    return <AdmissionSheet id={open} me={me} onClose={() => setOpen(null)} />
  }

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={NAV} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Ward" subtitle={me.displayName} />
      <motion.div key={tab}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DUR.page, ease: EASE }}
        className="min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'board' ? <BedBoard me={me} onOpen={setOpen} />
          : tab === 'admissions' ? <Admissions onOpen={setOpen} />
          : <Reports me={me} />}
      </motion.div>
    </div>
  )
}

/* -------------------------------------------------------------- the board */

const TONE: Record<string, string> = {
  free: 'border-ok/40 bg-ok/5',
  occupied: 'border-primary/40 bg-primary/5',
  cleaning: 'border-warn/40 bg-warn/5',
  reserved: 'border-line bg-raised',
  out_of_service: 'border-bad/30 bg-bad/5 opacity-60'
}

/**
 * The whole hospital on one screen.
 *
 * This is the question asked twenty times a day, by the counter, by a doctor
 * and by a family at the door: is there a bed. Grouped by ward, because that
 * is how somebody looking for one thinks about it.
 */
function BedBoard({ me, onOpen }: { me: SessionUser; onOpen: (id: number) => void }) {
  const [beds, setBeds] = useState<any[] | null>(null)
  const [admitting, setAdmitting] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.bedBoard().then(setBeds).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  const rows = beds ?? []
  const wards = [...new Set(rows.map((b) => b.ward_name))]
  const free = rows.filter((b) => b.status === 'free').length
  const occupied = rows.filter((b) => b.status === 'occupied').length

  async function freeUp(bed: any) {
    try { await api.setBedStatus(bed.id, 'free'); load() }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tr('Beds free')} value={String(free)} tone="ok" count={free} />
        <Stat label={tr('Occupied')} value={String(occupied)} tone="accent" />
        <Stat label={tr('Beds in all')} value={String(rows.length)} />
      </div>

      <ErrorNote>{err}</ErrorNote>

      {!beds ? <SkeletonRows rows={6} cols={4} />
        : rows.length === 0 ? (
          <Card title={tr('No beds yet')}>
            <Empty title={tr('No wards have been set up')}
              hint={tr('An administrator adds wards and beds under Administration, Wards and beds.')} />
          </Card>
        ) : wards.map((ward) => {
          const inWard = rows.filter((b) => b.ward_name === ward)
          const wardFree = inWard.filter((b) => b.status === 'free').length
          return (
            <Card key={ward} title={ward}
              hint={`${inWard.length} ${tr('beds')} · ${wardFree} ${tr('free')} · Rs ${
                rs(inWard[0]?.charge_paisa ?? 0)} ${tr('a night')}`}>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {inWard.map((b) => (
                  <div key={b.id}
                    className={`rounded-xl border-2 p-3 ${TONE[b.status] ?? 'border-line'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="num text-sm font-semibold text-heading">{b.name}</span>
                      <span className="num text-2xs text-muted">Rs {rs(b.charge_paisa)}</span>
                    </div>

                    {b.status === 'occupied' ? (
                      <button onClick={() => onOpen(b.admission_id)}
                        className="mt-2 block w-full text-left">
                        <span className="block truncate text-sm text-heading">
                          {b.patient_name}
                        </span>
                        <span className="block truncate num text-2xs text-muted">
                          {b.mrn}
                          {b.age_years != null && ` · ${b.age_years}y`}
                        </span>
                        <span className="mt-1 block truncate text-2xs text-primary">
                          {b.admission_no}
                        </span>
                      </button>
                    ) : (
                      <div className="mt-2">
                        <Badge tone={b.status === 'free' ? 'ok'
                          : b.status === 'cleaning' ? 'warn' : 'muted'}>
                          {tr(b.status.replace('_', ' '))}
                        </Badge>
                        {b.status === 'free' && (
                          <button onClick={() => setAdmitting(b)}
                            className="btn-ghost mt-2 w-full px-2 py-1 text-2xs">
                            <Plus size={12} className="mr-1 inline" />{tr('Admit')}
                          </button>
                        )}
                        {/*
                          A bed goes to cleaning when it is vacated, not
                          straight to free, so somebody has to say it has been
                          stripped. That somebody is on the ward, which is why
                          the button is here and not in Administration.
                        */}
                        {b.status === 'cleaning' && (
                          <button onClick={() => freeUp(b)}
                            className="btn-ghost mt-2 w-full px-2 py-1 text-2xs">
                            <Sparkles size={12} className="mr-1 inline" />{tr('Ready')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )
        })}

      {admitting && (
        <AdmitPatient bed={admitting} onClose={() => setAdmitting(null)}
          onDone={(adm: any) => { setAdmitting(null); load(); onOpen(adm.id) }} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- admitting */

function AdmitPatient({ bed, onClose, onDone }: {
  bed: any; onClose: () => void; onDone: (adm: any) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<any[]>([])
  const [patient, setPatient] = useState<any | null>(null)
  const [doctors, setDoctors] = useState<any[]>([])
  const [f, setF] = useState({
    doctorId: '', admissionType: 'planned', diagnosis: '',
    attendantName: '', attendantPhone: '', attendantRelation: '', advance: ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { api.doctors().then(setDoctors).catch(() => {}) }, [])
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      api.searchPatients(q.trim()).then(setHits).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }))

  async function save() {
    if (!patient) { setErr(tr('Find the patient first')); return }
    setBusy(true); setErr(null)
    try {
      onDone(await api.admit({
        patientId: patient.id, bedId: bed.id,
        doctorId: f.doctorId ? Number(f.doctorId) : null,
        admissionType: f.admissionType,
        diagnosis: f.diagnosis.trim() || null,
        attendantName: f.attendantName.trim() || null,
        attendantPhone: f.attendantPhone.trim() || null,
        attendantRelation: f.attendantRelation.trim() || null,
        advancePaisa: f.advance ? toPaisa(f.advance) : null
      }))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${tr('Admit to')} ${bed.ward_name} · ${bed.name}`} wide onClose={onClose}
      hint={`Rs ${rs(bed.charge_paisa)} ${tr('a night')}`}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !patient} className="btn-primary">
          {busy ? tr('Admitting…') : tr('Admit')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      <p className="label">{tr('Patient')}</p>
      {patient ? (
        <div className="mt-1 flex items-center justify-between rounded-xl border-2 border-line p-3">
          <span>
            <span className="text-sm font-medium text-heading">{patient.name}</span>
            <span className="block num text-2xs text-muted">
              {patient.mrn}
              {patient.age_years != null && ` · ${patient.age_years}y`}
            </span>
          </span>
          <button onClick={() => { setPatient(null); setQ('') }}
            className="btn-ghost px-2 py-1 text-2xs">{tr('Change')}</button>
        </div>
      ) : (
        <div className="relative mt-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder={tr('Search by name, MRN or phone')} className="field pl-9" />
          {hits.length > 0 && (
            <ul className="mt-1 max-h-44 overflow-auto rounded-xl border-2 border-line">
              {hits.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <button onClick={() => { setPatient(p); setHits([]) }}
                    className="flex w-full items-center justify-between px-3 py-2
                               text-left text-sm hover:bg-raised">
                    <span>{p.name}</span>
                    <span className="num text-2xs text-muted">{p.mrn}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={tr('Under which doctor')}>
          <select value={f.doctorId} onChange={(e) => set('doctorId', e.target.value)}
            className="field mt-1">
            <option value="">{tr('Not set yet')}</option>
            {doctors.map((d: any) => (
              <option key={d.id} value={d.id}>{d.display_name ?? d.name}</option>
            ))}
          </select>
        </Field>
        <Field label={tr('Kind of admission')}>
          <select value={f.admissionType}
            onChange={(e) => set('admissionType', e.target.value)} className="field mt-1">
            <option value="planned">{tr('Planned')}</option>
            <option value="emergency">{tr('Emergency')}</option>
            <option value="day_case">{tr('Day case')}</option>
            <option value="delivery">{tr('Delivery')}</option>
          </select>
        </Field>
        <Field label={tr('Diagnosis on admission')} span>
          <input value={f.diagnosis} onChange={(e) => set('diagnosis', e.target.value)}
            className="field mt-1" />
        </Field>
      </div>

      {/*
        Who the ward telephones at two in the morning. It is the field most
        often left blank and the one most often needed.
      */}
      <p className="label mt-4">{tr('Attendant')}</p>
      <div className="mt-1 grid gap-3 sm:grid-cols-3">
        <Field label={tr('Name')}>
          <input value={f.attendantName} onChange={(e) => set('attendantName', e.target.value)}
            className="field mt-1" />
        </Field>
        <Field label={tr('Phone')}>
          <input value={f.attendantPhone} onChange={(e) => set('attendantPhone', e.target.value)}
            className="field num mt-1" />
        </Field>
        <Field label={tr('Relation')}>
          <input value={f.attendantRelation}
            onChange={(e) => set('attendantRelation', e.target.value)}
            placeholder={tr('Brother, husband, son')} className="field mt-1" />
        </Field>
      </div>

      <Field label={tr('Advance taken')} span
        hint={tr('Held against the final bill. Anything left over comes back at discharge.')}>
        <input value={f.advance} onChange={(e) => set('advance', e.target.value)}
          inputMode="decimal" placeholder="0.00" className="field num mt-1" />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------- the admission */

/**
 * One admission: what it has cost so far, and what can be done to it.
 *
 * The running bill is the centre of this screen rather than a tab behind it,
 * because it is what the family asks about on day three and what the ward is
 * asked to read out.
 */
function AdmissionSheet({ id, me, onClose }: {
  id: number; me: SessionUser; onClose: () => void
}) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [charging, setCharging] = useState(false)
  const [paying, setPaying] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const load = useCallback(() => {
    api.admission(id).then(setData).catch((e: any) => setErr(e.message))
  }, [id])
  useEffect(() => { load() }, [load])

  if (!data) {
    return <div className="p-6"><ErrorNote>{err}</ErrorNote><SkeletonRows rows={6} cols={3} /></div>
  }

  const { admission: a, charges, payments, totals } = data
  const owes = totals.balance_paisa > 0
  const credit = totals.refund_due_paisa > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-screen">
      <header className="sticky top-0 z-10 border-b-2 border-line bg-card px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="btn-ghost px-3 py-1.5 text-2xs">
              &larr; {tr('Back to the board')}
            </button>
            <div>
              <h2 className="text-base font-semibold text-heading">{a.patient_name}</h2>
              <p className="num text-2xs text-muted">
                {a.mrn} · {a.admission_no}
                {a.ward_name && ` · ${a.ward_name} ${a.bed_name}`}
                {` · ${totals.nights} ${totals.nights === 1 ? tr('night') : tr('nights')}`}
              </p>
            </div>
          </div>

          {a.status === 'open' && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setMoving(true)}
                className="btn-ghost inline-flex items-center gap-1.5">
                <ArrowRightLeft size={14} /> {tr('Move bed')}
              </button>
              <button onClick={() => setCharging(true)}
                className="btn-ghost inline-flex items-center gap-1.5">
                <Plus size={14} /> {tr('Add charge')}
              </button>
              <button onClick={() => setPaying(true)}
                className="btn-ghost inline-flex items-center gap-1.5">
                <Banknote size={14} /> {tr('Take payment')}
              </button>
              <button onClick={() => setLeaving(true)}
                className="btn-primary inline-flex items-center gap-1.5">
                <LogOut size={14} /> {tr('Discharge')}
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ErrorNote>{err}</ErrorNote>

        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label={tr('Billed')} value={`Rs ${rs(totals.billed_paisa)}`} />
          <Stat label={tr('Paid')} value={`Rs ${rs(totals.paid_paisa)}`} tone="ok" />
          <Stat label={tr('Discount')} value={`Rs ${rs(totals.relieved_paisa)}`} />
          <Stat label={credit ? tr('To refund') : tr('Balance')}
            value={`Rs ${rs(credit ? totals.refund_due_paisa : totals.balance_paisa)}`}
            tone={owes ? 'bad' : credit ? 'warn' : 'ok'} />
        </div>

        {a.status !== 'open' && (
          <div className="mt-3 rounded-xl border-2 border-line bg-raised p-3">
            <p className="text-2xs text-muted">
              {tr('Discharged')} {new Date(a.discharged_at).toLocaleString('en-GB')}
              {a.outcome && ` · ${tr(a.outcome)}`}
              {a.final_diagnosis && ` · ${a.final_diagnosis}`}
            </p>
          </div>
        )}

        <Card title={tr('The bill so far')} className="mt-4"
          hint={tr('Bed nights are added by themselves. Everything else is put on as it happens.')}>
          {charges.length === 0 ? <Empty title={tr('Nothing on it yet')} /> : (
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-28">{tr('Kind')}</Th><Th>{tr('What')}</Th>
                  <Th w="w-16" right>{tr('Qty')}</Th>
                  <Th w="w-28" right>{tr('Amount')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped">
                {charges.map((c: any) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2"><Badge>{tr(c.kind)}</Badge></td>
                    <td className="px-3 py-2 text-sm text-body">
                      {c.description}
                      {c.charged_for && (
                        <span className="block num text-2xs text-muted">
                          {new Date(c.charged_for).toLocaleDateString('en-GB',
                            { day: '2-digit', month: 'short' })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right num text-2xs">{Number(c.qty)}</td>
                    <td className="px-3 py-2 text-right num text-sm text-primary">
                      {rs(c.total_paisa)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {payments.length > 0 && (
          <Card title={tr('Money')} className="mt-4">
            <table className="w-full">
              <tbody className="divide-y divide-divide">
                {payments.map((p: any) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2"><Badge
                      tone={p.kind === 'refund' ? 'warn'
                        : p.kind === 'discount' || p.kind === 'waived' ? 'muted' : 'ok'}>
                      {tr(p.kind)}
                    </Badge></td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {p.note ?? p.method ?? ''}
                      {p.approved_by && ` · ${tr('allowed by')} ${p.approved_by}`}
                    </td>
                    <td className="px-3 py-2 text-right num text-sm">{rs(p.amount_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {moving && <MoveBed admission={a} onClose={() => setMoving(false)}
        onDone={() => { setMoving(false); load() }} />}
      {charging && <AddCharge id={id} onClose={() => setCharging(false)}
        onDone={() => { setCharging(false); load() }} />}
      {paying && <TakePayment id={id} owed={totals.balance_paisa}
        onClose={() => setPaying(false)} onDone={() => { setPaying(false); load() }} />}
      {leaving && <Discharge id={id} totals={totals} onClose={() => setLeaving(false)}
        onDone={() => { setLeaving(false); onClose() }} />}
    </div>
  )
}

function MoveBed({ admission, onClose, onDone }: {
  admission: any; onClose: () => void; onDone: () => void
}) {
  const [beds, setBeds] = useState<any[]>([])
  const [bedId, setBedId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.bedBoard().then((b: any[]) => setBeds(b.filter((x) => x.status === 'free')))
      .catch(() => {})
  }, [])

  return (
    <Modal title={tr('Move to another bed')} onClose={onClose}
      hint={tr('The nights already slept keep the rate they were charged at.')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !bedId} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { await api.transferBed(admission.id, Number(bedId), reason.trim() || null); onDone() }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Moving…') : tr('Move')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      {beds.length === 0 ? <Empty title={tr('No free beds')} /> : (
        <>
          <Field label={tr('Bed')} span>
            <select value={bedId} onChange={(e) => setBedId(e.target.value)}
              className="field mt-1">
              <option value="">{tr('Choose a bed')}</option>
              {beds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.ward_name} · {b.name} — Rs {rs(b.charge_paisa)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr('Why')} span>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={tr('Family asked for a private room')} className="field mt-1" />
          </Field>
        </>
      )}
    </Modal>
  )
}

function AddCharge({ id, onClose, onDone }: {
  id: number; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({ kind: 'doctor', description: '', qty: '1', amount: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <Modal title={tr('Add a charge')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !f.description.trim() || !f.amount} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.addAdmissionCharge(id, {
                kind: f.kind, description: f.description.trim(),
                qty: Number(f.qty) || 1, unitPaisa: toPaisa(f.amount)
              })
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Add')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Kind')}>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
            className="field mt-1">
            <option value="doctor">{tr('Doctor visit')}</option>
            <option value="procedure">{tr('Procedure')}</option>
            <option value="supplies">{tr('Supplies')}</option>
            <option value="other">{tr('Other')}</option>
          </select>
        </Field>
        <Field label={tr('Amount each')}>
          <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })}
            inputMode="decimal" className="field num mt-1" />
        </Field>
        <Field label={tr('What for')} span>
          <input value={f.description} autoFocus
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={tr('Daily round, dressing, oxygen')} className="field mt-1" />
        </Field>
        <Field label={tr('How many')}>
          <input value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })}
            inputMode="numeric" className="field num mt-1" />
        </Field>
      </div>
    </Modal>
  )
}

function TakePayment({ id, owed, onClose, onDone }: {
  id: number; owed: number; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    kind: 'payment', amount: owed > 0 ? (owed / 100).toFixed(2) : '',
    method: 'cash', note: ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const needsReason = f.kind === 'discount' || f.kind === 'waived'

  return (
    <Modal title={tr('Take payment')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !f.amount} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.addAdmissionPayment(id, {
                kind: f.kind, amountPaisa: toPaisa(f.amount),
                method: f.method, note: f.note.trim() || null
              })
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Kind')}>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
            className="field mt-1">
            <option value="payment">{tr('Payment')}</option>
            <option value="advance">{tr('Advance')}</option>
            <option value="discount">{tr('Discount')}</option>
            <option value="waived">{tr('Waived')}</option>
            <option value="refund">{tr('Refund')}</option>
          </select>
        </Field>
        <Field label={tr('Amount')}>
          <input value={f.amount} autoFocus
            onChange={(e) => setF({ ...f, amount: e.target.value })}
            inputMode="decimal" className="field num mt-1" />
        </Field>
        <Field label={needsReason ? tr('Why') : tr('Note')} span
          hint={needsReason
            ? tr('Your name is recorded against it. A discount costs the hospital money with nothing arriving.')
            : undefined}>
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })}
            className="field mt-1" />
        </Field>
      </div>
    </Modal>
  )
}

function Discharge({ id, totals, onClose, onDone }: {
  id: number; totals: any; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({ outcome: 'discharged', note: '', finalDiagnosis: '' })
  const [allowBalance, setAllowBalance] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const owes = totals.balance_paisa > 0

  return (
    <Modal title={tr('Discharge')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || (owes && !allowBalance)} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.dischargeAdmission(id, {
                outcome: f.outcome, outcomeNote: f.note.trim() || null,
                finalDiagnosis: f.finalDiagnosis.trim() || null,
                allowBalance
              })
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Discharging…') : tr('Discharge')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {owes && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-bad/40
                        bg-bad/5 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-bad" />
          <div>
            <p className="text-2xs text-bad">
              Rs {rs(totals.balance_paisa)} {tr('is still owed.')}
            </p>
            {/*
              The override exists for the cases that matter: a death, a
              transfer out, a bill the hospital has decided to let go. The bed
              frees the moment this runs and the account is rarely looked at
              again, so it is a deliberate tick rather than a quiet default.
            */}
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input type="checkbox" checked={allowBalance}
                onChange={(e) => setAllowBalance(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="text-2xs text-muted">
                {tr('Discharge anyway and leave the balance standing. Your name is recorded against it.')}
              </span>
            </label>
          </div>
        </div>
      )}

      {totals.refund_due_paisa > 0 && (
        <div className="mb-3 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
          <p className="text-2xs text-warn">
            Rs {rs(totals.refund_due_paisa)} {tr('of the advance is unused and comes back to the family.')}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Outcome')}>
          <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}
            className="field mt-1">
            <option value="discharged">{tr('Discharged')}</option>
            <option value="referred">{tr('Referred out')}</option>
            <option value="lama">{tr('Left against medical advice')}</option>
            <option value="death">{tr('Death')}</option>
          </select>
        </Field>
        <Field label={tr('Final diagnosis')}>
          <input value={f.finalDiagnosis}
            onChange={(e) => setF({ ...f, finalDiagnosis: e.target.value })}
            className="field mt-1" />
        </Field>
        <Field label={tr('Note')} span>
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })}
            className="field mt-1" />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------ the list */

function Admissions({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [status, setStatus] = useState('open')
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.admissions(status, q).then(setRows).catch((e: any) => setErr(e.message))
  }, [status, q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) },
    [load, q])

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Admissions')}
        hint={tr('Everyone admitted, and everyone who has been.')}>
        <ErrorNote>{err}</ErrorNote>

        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Name, MRN, admission number or phone')} className="field pl-9" />
          </div>
          {[['open', tr('In hospital')], ['discharged', tr('Discharged')],
            ['all', tr('All')]].map(([id, label]) => (
            <button key={id} onClick={() => setStatus(id)}
              className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
                status === id ? 'bg-brand text-white'
                  : 'border-2 border-line bg-card text-body hover:bg-raised'}`}>
              {label}
            </button>
          ))}
        </div>

        {!rows ? <SkeletonRows rows={6} cols={5} />
          : rows.length === 0 ? <Empty title={tr('Nobody here')} /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-32">{tr('Admission')}</Th><Th>{tr('Patient')}</Th>
                  <Th w="w-32">{tr('Bed')}</Th><Th w="w-28">{tr('Doctor')}</Th>
                  <Th w="w-28" right>{tr('Balance')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped">
                {rows.map((a) => {
                  const bal = Number(a.billed_paisa) - Number(a.paid_paisa)
                  return (
                    <tr key={a.id} onClick={() => onOpen(a.id)} className="cursor-pointer">
                      <td className="px-3 py-2">
                        <span className="num text-2xs text-primary">{a.admission_no}</span>
                        <span className="block num text-2xs text-muted">
                          {new Date(a.admitted_at).toLocaleDateString('en-GB',
                            { day: '2-digit', month: 'short' })}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{a.patient_name}</span>
                        <span className="block num text-2xs text-muted">{a.mrn}</span>
                      </td>
                      <td className="px-3 py-2 text-2xs text-body">
                        {a.ward_name ? `${a.ward_name} · ${a.bed_name}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-2xs text-muted">{a.doctor_name ?? '—'}</td>
                      <td className="px-3 py-2 text-right num text-sm">
                        <span className={bal > 0 ? 'text-bad' : 'text-ok'}>{rs(bal)}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
