import { useCallback, useEffect, useState } from 'react'
import { api, rs, type SessionUser, type SearchHit, newId} from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../components/ui'
import { t as tr } from '../lib/prefs'

const TRIAGE: [string, string, string][] = [
  ['critical', 'Critical', 'bad'],
  ['urgent', 'Urgent', 'warn'],
  ['standard', 'Standard', 'ok']
]

/**
 * The emergency desk.
 *
 * Emergency runs backwards compared with OPD: the patient is treated first and
 * the money is sorted out afterwards. So nothing on this screen takes a
 * payment. It registers arrivals, records what was given at the bedside, and
 * shows what is owed so the family can be pointed at the right window.
 *
 * The two tills collect: the main counter for the consultation and any tests,
 * the pharmacy for the medicines. Keeping collection off this screen is what
 * stops cash being handled on a trolley.
 */
export function IpdCounter({ me }: { me: SessionUser }) {
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [admitting, setAdmitting] = useState(false)
  const [meds, setMeds] = useState<any | null>(null)
  const [closing, setClosing] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    api.ipdQueue().then(setRows).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  const term = q.trim().toLowerCase()
  const shown = term
    ? rows.filter((v) =>
        (v.patient_name ?? '').toLowerCase().includes(term) ||
        (v.mrn ?? '').toLowerCase().includes(term) ||
        (v.phone ?? '').includes(term))
    : rows

  const critical = rows.filter((v) => v.triage === 'critical').length
  const owed = rows.reduce((n, v) =>
    n + (v.fee_paid ? 0 : Number(v.consultation_fee_paisa)) + Number(v.chits_due_paisa), 0)

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={tr('On the floor')} value={String(rows.length)} tone="primary" />
        <Stat label={tr('Critical')} value={String(critical)} tone={critical ? 'bad' : undefined} />
        <Stat label={tr('Medicines to collect')}
          value={String(rows.reduce((n, v) => n + Number(v.med_pending), 0))}
          sub={tr('Paid for at the pharmacy')} />
        <Stat label={tr('Outstanding')} value={`Rs ${rs(owed)}`}
          tone={owed ? 'warn' : 'ok'} sub={tr('Collected at the main counter')} />
      </div>

      <Card title={tr('Emergency floor')}
        hint={tr('Sickest first, then longest waiting')}
        action={<>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Name, MRN or phone')} className="field mr-2 w-56 py-1.5 text-2xs" />
          <button onClick={() => setAdmitting(true)} className="btn-primary">
            {tr('New arrival')}
          </button>
        </>}>
        {loading ? <SkeletonRows rows={5} cols={5} />
          : shown.length === 0 ? (
            <Empty title={tr('Nobody in emergency')}
              hint={tr('Press New arrival as soon as someone comes through the door.')} />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-24">{tr('Triage')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Brought in with')}</Th><Th w="w-36">{tr('Doctor')}</Th>
                  <Th w="w-28" right>{tr('Owed')}</Th><Th w="w-52" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {shown.map((v) => {
                  const due = (v.fee_paid ? 0 : Number(v.consultation_fee_paisa)) +
                    Number(v.chits_due_paisa)
                  const tone = TRIAGE.find(([id]) => id === v.triage)?.[2] ?? 'ok'
                  return (
                    <tr key={v.id}>
                      <td className="px-3 py-2">
                        <Badge tone={tone as any}>{tr(v.triage ?? 'standard')}</Badge>
                        <span className="mt-0.5 block num text-2xs text-muted">
                          {new Date(v.created_at).toLocaleTimeString('en-GB',
                            { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{v.patient_name}</span>
                        <span className="block num text-2xs text-muted">
                          {v.mrn}
                          {v.age_years != null && ` · ${v.age_years}y`}
                          {v.gender && ` · ${tr(v.gender)}`}
                        </span>
                        {v.allergies && (
                          <span className="mt-0.5 block text-2xs font-medium text-bad">
                            {tr('Allergies')}: {v.allergies}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-2xs text-body">{v.arrival_note ?? '—'}</span>
                        {v.brought_by && (
                          <span className="block text-2xs text-muted">{tr('With')} {v.brought_by}</span>
                        )}
                        {Number(v.med_pending) > 0 && (
                          <span className="mt-0.5 block text-2xs text-warn">
                            {v.med_pending} {tr('medicines not yet collected')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-2xs text-muted">{v.doctor_name}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`num text-sm font-medium ${due ? 'text-warn' : 'text-ok'}`}>
                          {due ? rs(due) : tr('clear')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setMeds(v)} className="btn-ghost px-2 py-1 text-2xs">
                          {tr('Medicines')}
                        </button>
                        <button onClick={() => setClosing(v)}
                          className="ml-1 btn-ghost px-2 py-1 text-2xs">
                          {tr('Close')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-2xs text-muted">
        {tr('Signed in as')} {me.displayName}. {tr('No money is taken here: the consultation and any tests are paid at the main counter, and medicines at the pharmacy.')}
      </p>

      {admitting && <NewArrival onClose={() => setAdmitting(false)}
        onDone={() => { setAdmitting(false); load() }} />}
      {meds && <BedsideMedicines visit={meds} onClose={() => setMeds(null)}
        onDone={() => { setMeds(null); load() }} />}
      {closing && <CloseVisit visit={closing} onClose={() => setClosing(null)}
        onDone={() => { setClosing(null); load() }} />}
    </div>
  )
}

/* ------------------------------------------------------------ new arrival */

function NewArrival({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [patient, setPatient] = useState<any | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [age, setAge] = useState('')
  const [gender, setGender] = useState('')
  const [doctors, setDoctors] = useState<any[]>([])
  const [doctorId, setDoctorId] = useState(0)
  const [triage, setTriage] = useState('urgent')
  const [note, setNote] = useState('')
  const [broughtBy, setBroughtBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { api.doctors().then(setDoctors).catch(() => {}) }, [])
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const timer = setTimeout(() => api.searchPatients(q).then(setResults).catch(() => {}), 200)
    return () => clearTimeout(timer)
  }, [q])

  /**
   * What this arrival will actually be filed under.
   *
   * The search box and the name box both take a name, and staff type into
   * whichever one their eye lands on first — which produced records called
   * "Unknown — 23:10" for patients whose name had been typed a few
   * centimetres higher up. So the search text is used as the name when the
   * name box is empty, and the result is shown on screen before saving.
   */
  const typedName = name.trim() || q.trim()
  const placeholder = `Unknown — ${new Date().toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' })}`
  const effectiveName = patient ? patient.name : (typedName || placeholder)

  async function save() {
    setBusy(true); setErr(null)
    try {
      /**
       * An unconscious patient with no attendant has no name to give. A
       * placeholder record is better than no record: it can be renamed later,
       * and everything done for them is already attached to it.
       */
      const p = patient ?? await api.registerPatient({
        name: effectiveName,
        phone: phone.trim() || null,
        ageYears: age ? Number(age) : null,
        gender: gender || null
      })
      await api.createEmergencyVisit({
        patientId: p.id, doctorId, triage,
        arrivalNote: note.trim() || null,
        broughtBy: broughtBy.trim() || null
      })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={tr('New arrival')} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !doctorId} className="btn-primary">
          {busy ? tr('Saving…') : tr('Admit to emergency')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      <Field label={tr('Name, or search for an existing patient')}
        hint={tr('Type the name here — if they have been before, pick them from the list')}>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPatient(null) }}
          placeholder={tr('Name, phone number, MRN or CNIC')} className="field" />
      </Field>

      {results.length > 0 && !patient && (
        <ul className="mt-1 max-h-40 overflow-auto rounded-xl border-2 border-line">
          {results.map((p) => (
            <li key={p.id} onClick={() => { setPatient(p); setResults([]); setQ('') }}
              className="cursor-pointer border-b border-divide px-3 py-2 last:border-0 hover:bg-raised">
              <span className="text-sm text-heading">{p.name}</span>
              <span className="ml-2 num text-2xs text-muted">{p.mrn} {p.phone ?? ''}</span>
            </li>
          ))}
        </ul>
      )}

      {patient ? (
        <div className="card-tint mt-3 flex items-center justify-between p-3">
          <div>
            <p className="text-sm font-medium text-heading">{patient.name}</p>
            <p className="num text-2xs text-muted">{patient.mrn}</p>
          </div>
          <button onClick={() => setPatient(null)} className="btn-ghost py-1 text-2xs">
            {tr('Change')}
          </button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label={tr('Name')} span
            hint={q.trim() && !name.trim() ? tr('Leave blank to use what you typed above') : undefined}>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={q.trim() || tr('Leave blank if unknown')} className="field" />
          </Field>
          <Field label={tr('Phone')}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="field num" />
          </Field>
          <Field label={tr('Age')}>
            <input value={age} onChange={(e) => setAge(e.target.value)} className="field num" />
          </Field>
          <Field label={tr('Sex')}>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className="field">
              <option value="">{tr('Not recorded')}</option>
              <option value="male">{tr('Male')}</option>
              <option value="female">{tr('Female')}</option>
            </select>
          </Field>
        </div>
      )}

      {!patient && (
        <div className={`mt-3 rounded-xl border-2 p-3 ${
          typedName ? 'border-line bg-raised' : 'border-warn/40 bg-warn/5'}`}>
          <p className="text-2xs uppercase tracking-wide text-muted">
            {tr('Will be registered as')}
          </p>
          <p className={`text-sm font-medium ${typedName ? 'text-heading' : 'text-warn'}`}>
            {effectiveName}
          </p>
          {!typedName && (
            <p className="mt-0.5 text-2xs text-warn">
              {tr('No name given. Fine for an unconscious patient — the record can be renamed later.')}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-divide pt-3">
        <label className="label">{tr('How sick are they?')}</label>
        <div className="grid grid-cols-3 gap-1">
          {TRIAGE.map(([id, label, tone]) => (
            <button key={id} onClick={() => setTriage(id)}
              className={`rounded-xl border-2 px-2 py-2 text-2xs ${
                triage === id
                  ? tone === 'bad' ? 'border-bad bg-bad/10 font-medium text-bad'
                    : tone === 'warn' ? 'border-warn bg-warn/10 font-medium text-warn'
                    : 'border-ok bg-ok/10 font-medium text-ok'
                  : 'border-line bg-card text-muted hover:bg-raised'}`}>
              {tr(label)}
            </button>
          ))}
        </div>
        <p className="mt-1 text-2xs text-muted">
          {tr('This sets the order on the floor list, so put it in honestly.')}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={tr('Duty doctor')}>
          <select value={doctorId} onChange={(e) => setDoctorId(Number(e.target.value))} className="field">
            <option value={0}>{tr('Choose a doctor')}</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}{d.specialisation ? ` — ${d.specialisation}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr('Brought in by')} hint={tr('Relative, rescue, police')}>
          <input value={broughtBy} onChange={(e) => setBroughtBy(e.target.value)} className="field" />
        </Field>
        <Field label={tr('What happened')} span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={tr('Road accident, fell from height, chest pain since morning')}
            className="field" />
        </Field>
      </div>

      <p className="mt-3 text-2xs text-muted">
        {tr('The patient is live on the floor straight away. The consultation fee appears at the main counter to be collected when someone can get to the window.')}
      </p>
    </Modal>
  )
}

/* ----------------------------------------------------- bedside medicines */

function BedsideMedicines({ visit, onClose, onDone }: {
  visit: any; onClose: () => void; onDone: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [lines, setLines] = useState<any[]>([])
  const [given, setGiven] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadGiven = useCallback(() => {
    api.prescription(visit.id).then((p: any) => setGiven(p?.items ?? [])).catch(() => setGiven([]))
  }, [visit.id])
  useEffect(loadGiven, [loadGiven])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const timer = setTimeout(() => api.productSearch(q).then(setHits).catch(() => {}), 150)
    return () => clearTimeout(timer)
  }, [q])

  async function save() {
    setBusy(true); setErr(null)
    try {
      await api.addEmergencyMedicines(visit.id, lines.map((l) => ({
        productId: l.productId, drugName: l.drugName,
        dose: l.dose || null, qtyPrescribed: Math.max(1, Number(l.qty) || 1)
      })))
      setLines([]); loadGiven(); onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={`${tr('Medicines')} — ${visit.patient_name}`} hint={visit.mrn} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={save} disabled={busy || lines.length === 0} className="btn-primary">
          {busy ? tr('Saving…') : tr('Add to the patient\'s account')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {given.length > 0 && (
        <div className="mb-4">
          <p className="label">{tr('Already recorded')}</p>
          <ul className="divide-y divide-divide rounded-xl border-2 border-line">
            {given.map((g: any) => (
              <li key={g.id} className="flex items-center justify-between px-3 py-1.5">
                <span className="text-2xs text-body">
                  {g.drug_name}{g.dose ? ` · ${g.dose}` : ''} × {g.qty_prescribed}
                </span>
                <Badge tone={g.status === 'dispensed' ? 'ok' : g.status === 'partial' ? 'warn' : undefined}>
                  {tr(g.status === 'pending' ? 'not collected' : g.status)}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs text-muted">
            {tr('Anything not collected is waiting at the pharmacy counter to be paid for.')}
          </p>
        </div>
      )}

      <div className="relative">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim() && hits.length === 0) {
              setLines((l) => [...l, { key: newId(), productId: null,
                drugName: q.trim(), dose: '', qty: '1' }])
              setQ('')
            }
          }}
          placeholder={tr('Search a medicine, or type a name and press Enter')} className="field" />
        {hits.length > 0 && (
          <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-2xl border-2 border-line bg-card shadow-pop">
            {hits.map((h) => (
              <li key={h.id}
                onClick={() => {
                  setLines((l) => [...l, { key: newId(), productId: h.id,
                    drugName: h.name, dose: '', qty: '1' }])
                  setQ(''); setHits([])
                }}
                className="flex cursor-pointer items-center justify-between border-b border-divide px-3 py-2 last:border-0 hover:bg-raised">
                <span className="text-sm text-heading">{h.name}</span>
                <span className="num text-2xs text-muted">{h.total_qty} {tr('in stock')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="mt-3 text-2xs text-muted">
          {tr('Add what was actually used at the bedside. The pharmacy collects for it afterwards.')}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {lines.map((l) => (
            <li key={l.key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-heading">
                {l.drugName}
                {!l.productId && (
                  <span className="ml-2 text-2xs text-warn">{tr('not in pharmacy')}</span>
                )}
              </span>
              <input value={l.dose}
                onChange={(e) => setLines((ls) => ls.map((x) =>
                  x.key === l.key ? { ...x, dose: e.target.value } : x))}
                placeholder={tr('1 amp IV')} className="field w-32 py-1 text-2xs" />
              <input value={l.qty}
                onChange={(e) => setLines((ls) => ls.map((x) =>
                  x.key === l.key ? { ...x, qty: e.target.value } : x))}
                className="field w-16 py-1 text-right text-2xs num" />
              <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------ close visit */

const OUTCOMES = ['Discharged', 'Admitted to ward', 'Referred out', 'Left against advice', 'Died']

function CloseVisit({ visit, onClose, onDone }: {
  visit: any; onClose: () => void; onDone: () => void
}) {
  const [outcome, setOutcome] = useState('Discharged')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const due = (visit.fee_paid ? 0 : Number(visit.consultation_fee_paisa)) +
    Number(visit.chits_due_paisa)

  return (
    <Modal title={tr('Close this emergency visit?')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { await api.closeEmergencyVisit(visit.id, outcome); onDone() }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Close visit')}
        </button>
      </>}>
      <p className="text-sm text-heading">{visit.patient_name}</p>
      <p className="num text-2xs text-muted">{visit.mrn}</p>

      <label className="label mt-4">{tr('What happened to them')}</label>
      <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="field">
        {OUTCOMES.map((o) => <option key={o} value={o}>{tr(o)}</option>)}
      </select>

      {/*
        Closing does not write off what is owed. The bill stays collectable at
        the counters afterwards, which is what actually happens when a family
        leaves and settles later.
      */}
      {(due > 0 || Number(visit.med_pending) > 0) && (
        <div className="mt-4 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
          <p className="text-2xs font-medium text-warn">{tr('Still owed')}</p>
          {due > 0 && (
            <p className="num text-sm text-warn">Rs {rs(due)} {tr('at the main counter')}</p>
          )}
          {Number(visit.med_pending) > 0 && (
            <p className="text-2xs text-warn">
              {visit.med_pending} {tr('medicines not collected from the pharmacy')}
            </p>
          )}
          <p className="mt-1 text-2xs text-muted">
            {tr('Closing the visit does not cancel this. It stays collectable.')}
          </p>
        </div>
      )}
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
