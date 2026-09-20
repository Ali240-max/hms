import { useCallback, useEffect, useState } from 'react'
import { api, rs, today, type SessionUser } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th } from '../components/ui'
import { NuskhaPreview } from '../components/Nuskha'
import { Sidebar, type NavItem } from '../components/Sidebar'
import { Stethoscope, Wallet } from 'lucide-react'
import { t as tr } from '../lib/prefs'

const DOCTOR_NAV: NavItem[] = [
  { id: 'queue', label: 'My patients', glyph: 'Q', icon: Stethoscope },
  { id: 'earnings', label: 'Earnings', glyph: 'E', icon: Wallet }
]

export function Doctor({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<'queue' | 'earnings'>('queue')
  const [openVisit, setOpenVisit] = useState<number | null>(null)

  if (openVisit) {
    return <Consultation visitId={openVisit} me={me} onBack={() => setOpenVisit(null)} />
  }

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={DOCTOR_NAV} active={tab} onSelect={(id: string) => setTab(id as 'queue' | 'earnings')}
        title="Consultation" subtitle={me.displayName} />
      <div key={tab} className="anim-fade min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'queue' ? <Queue onOpen={setOpenVisit} /> : <Earnings me={me} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ queue */

function Queue({ onOpen }: { onOpen: (id: number) => void }) {
  const [queue, setQueue] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [confirming, setConfirming] = useState<any | null>(null)

  const refresh = useCallback(() => { api.queue().then(setQueue).catch(() => {}) }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  /**
   * Two lists, not one.
   *
   * The doctor may only open a patient the OPD desk has actually sent in. The
   * rest are shown so the room knows how many are still to come, but without a
   * button — pulling someone forward while the desk is still measuring them
   * puts two people in charge of the same patient.
   */
  const ready = queue.filter((v) => v.status === 'ready' || v.status === 'in_consultation')
  const later = queue.filter((v) => v.status === 'waiting' || v.status === 'registered')
  const waiting = later.length

  // On a busy morning the list runs past a screenful, and the patient at the
  // door gives a name or a token, not a position in a queue.
  const term = q.trim().toLowerCase()
  const match = (list: any[]) => term
    ? list.filter((v) =>
        String(v.token_no) === term ||
        (v.patient_name ?? '').toLowerCase().includes(term) ||
        (v.mrn ?? '').toLowerCase().includes(term) ||
        (v.phone ?? '').includes(term))
    : list
  const shownReady = match(ready)
  const shownLater = match(later)
  const shown = term
    ? queue.filter((v) =>
        String(v.token_no) === term ||
        (v.patient_name ?? '').toLowerCase().includes(term) ||
        (v.mrn ?? '').toLowerCase().includes(term) ||
        (v.phone ?? '').includes(term))
    : queue

  function open(v: any) {
    api.setVisitStatus(v.id, 'in_consultation').catch(() => {})
    onOpen(v.id)
    setConfirming(null)
  }

  return (
    <div className="space-y-4">
      {/* Sent in by the OPD desk. The only list with a button on it. */}
      <Card title={tr('Ready for you')}
        hint={shownReady.length
          ? tr('Sent in by the OPD counter — details already taken')
          : tr('Nobody has been sent in yet')}
        action={
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Token, name, MRN or phone')}
            className="field w-64 py-1.5 text-2xs" />
        }>
        {shownReady.length === 0 ? (
          <Empty title={tr('Nobody sent in yet')}
            hint={tr('The OPD counter takes the patient\'s details first, then sends them in. They appear here.')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-16">{tr('Token')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Complaint and readings')}</Th>
                  <Th w="w-28">{tr('Status')}</Th><Th w="w-32" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {shownReady.map((v) => (
                  <tr key={v.id}>
                    <td className="px-3 py-2">
                      <span className="num text-lg font-semibold text-primary">{v.token_no}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-heading">{v.patient_name}</div>
                      <div className="num text-2xs text-muted">
                        {v.mrn}{v.age_years != null && ` · ${v.age_years}y`}
                        {v.gender && ` · ${tr(v.gender)}`}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-2xs text-body">{v.complaint ?? tr('No complaint recorded')}</span>
                      <QueueVitals v={v} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={v.status === 'in_consultation' ? 'primary' : 'ok'}>
                        {v.status === 'in_consultation' ? tr('with you') : tr('ready')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setConfirming(v)}
                        className="btn-primary px-3 py-1.5 text-2xs">
                        {v.has_prescription ? tr('Open') : tr('See patient')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        Everyone else today. No button: these patients are still with the
        cashier or the OPD desk, and are shown only so the room can see how
        many are coming.
      */}
      <Card title={tr('Still to come')}
        hint={`${waiting} ${tr('with the counters, not yet sent in')}`}>
        {shownLater.length === 0 ? (
          <Empty title={q ? `${tr('Nobody matching')} "${q}"` : tr('Nobody else waiting')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-16">{tr('Token')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Complaint')}</Th><Th w="w-40">{tr('Status')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {shownLater.map((v) => (
                  <tr key={v.id} className="opacity-80">
                    <td className="px-3 py-2">
                      <span className="num text-base font-medium text-muted">{v.token_no}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-body">{v.patient_name}</div>
                      <div className="num text-2xs text-muted">{v.mrn}</div>
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{v.complaint ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge tone="warn">
                        {v.status === 'registered' ? tr('at the main counter') : tr('at the OPD counter')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        Opening a patient marks them as with-you and moves the queue for
        everyone. A misclick on a crowded list otherwise pulls the wrong
        person out of the waiting order with nothing to undo it.
      */}
      {confirming && (
        <Modal title={tr('Start this consultation?')} onClose={() => setConfirming(null)}
          footer={<>
            <button onClick={() => setConfirming(null)} className="btn-ghost">{tr('Cancel')}</button>
            <button onClick={() => open(confirming)} className="btn-primary">
              {tr('Yes, see this patient')}
            </button>
          </>}>
          <div className="flex items-center gap-4">
            <span className="num text-4xl font-semibold text-primary">{confirming.token_no}</span>
            <div>
              <p className="text-base font-medium text-heading">{confirming.patient_name}</p>
              <p className="num text-2xs text-muted">
                {confirming.mrn}
                {confirming.age_years != null && ` · ${confirming.age_years}y`}
                {confirming.gender && ` · ${confirming.gender}`}
              </p>
              {confirming.complaint && (
                <p className="mt-1 text-2xs text-body">{confirming.complaint}</p>
              )}
            </div>
          </div>
          <p className="mt-3 text-2xs text-muted">
            {tr('They will be marked as with you, and the counters will see them leave the queue.')}
          </p>
        </Modal>
      )}
    </div>
  )
}

/** The readings the OPD desk took, inline in the ready list. */
function QueueVitals({ v }: { v: any }) {
  const bits: string[] = []
  if (v.bp_systolic && v.bp_diastolic) bits.push(`BP ${v.bp_systolic}/${v.bp_diastolic}`)
  if (v.pulse_bpm) bits.push(`${tr('Pulse')} ${v.pulse_bpm}`)
  if (v.temperature_f) bits.push(`${v.temperature_f}\u00B0F`)
  if (v.sugar_mg_dl) bits.push(`${tr('Blood sugar')} ${v.sugar_mg_dl}`)
  if (bits.length === 0) return null
  const high = v.bp_systolic >= 160 || v.bp_diastolic >= 100 ||
    v.sugar_mg_dl >= 250 || Number(v.temperature_f) >= 102
  return (
    <div className={`num mt-0.5 text-2xs ${high ? 'font-medium text-warn' : 'text-muted'}`}>
      {bits.join(' · ')}
    </div>
  )
}

/**
 * What the OPD counter measured before the patient walked in.
 *
 * Shown unprompted rather than behind a click: a blood pressure of 180/110
 * taken ten minutes ago changes the consultation, and the doctor should not
 * have to go looking for it. Values outside the usual range are marked, but
 * only marked — the judgement stays with the doctor.
 */
function ArrivalReadings({ v }: { v: any }) {
  if (!v.vitals_at) return null

  const items: { label: string; value: string; high: boolean }[] = []
  if (v.bp_systolic && v.bp_diastolic) {
    items.push({ label: 'BP', value: `${v.bp_systolic}/${v.bp_diastolic}`,
      high: v.bp_systolic >= 160 || v.bp_diastolic >= 100 })
  }
  if (v.pulse_bpm) {
    items.push({ label: 'Pulse', value: `${v.pulse_bpm}`, high: v.pulse_bpm >= 110 || v.pulse_bpm <= 50 })
  }
  if (v.temperature_f) {
    items.push({ label: 'Temp', value: `${v.temperature_f}\u00B0F`, high: Number(v.temperature_f) >= 100.4 })
  }
  if (v.sugar_mg_dl) {
    items.push({ label: 'Sugar', value: `${v.sugar_mg_dl}`, high: v.sugar_mg_dl >= 200 || v.sugar_mg_dl <= 70 })
  }
  if (v.weight_kg) items.push({ label: 'Weight', value: `${v.weight_kg} kg`, high: false })
  if (items.length === 0 && !v.vitals_note) return null

  return (
    <div className="card-tint mt-3 p-3">
      <p className="text-2xs uppercase tracking-wide text-muted">
        Taken at the OPD counter
        {v.vitals_by && ` by ${v.vitals_by}`}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        {items.map((i) => (
          <span key={i.label} className="num text-sm">
            <span className="text-2xs text-muted">{i.label} </span>
            <span className={i.high ? 'font-semibold text-warn' : 'text-heading'}>{i.value}</span>
          </span>
        ))}
      </div>
      {v.vitals_note && <p className="mt-1.5 text-2xs text-body">{v.vitals_note}</p>}
    </div>
  )
}

/* ----------------------------------------------------------- consultation */

type Med = {
  key: string; productId: number | null; drugName: string; dose: string
  slots: Record<SlotKey, boolean>
  durationDays: string; qtyPrescribed: string; instructions: string
  inStock?: number | null
}

/**
 * Dosing is picked as times of day, not Latin abbreviations.
 *
 * OD/BD/TDS are what a prescription is written in, but they are a poor thing
 * to click: the doctor has to translate "three times a day" into TDS, and the
 * patient gets a slip they cannot read. Ticking morning/noon/evening states
 * the intention directly, and the standard abbreviation is derived from the
 * ticks and still stored, so nothing downstream changes.
 */
const SLOTS = [
  { key: 'morning', label: 'Morning', hint: 'Subah' },
  { key: 'noon',    label: 'Noon',    hint: 'Dopahar' },
  { key: 'evening', label: 'Evening', hint: 'Shaam' }
] as const

type SlotKey = typeof SLOTS[number]['key']

/** Ticks in, prescription shorthand out. */
export function slotsToFrequency(slots: Record<SlotKey, boolean>): string {
  const on = SLOTS.filter((s) => slots[s.key])
  if (on.length === 3) return 'TDS'
  if (on.length === 2) return 'BD'
  if (on.length === 1) return 'OD'
  return 'SOS'
}

/** And back again, so reopening a saved prescription shows the right ticks. */
export function frequencyToSlots(freq: string | null | undefined): Record<SlotKey, boolean> {
  switch ((freq ?? '').toUpperCase()) {
    case 'TDS': case 'QID': return { morning: true, noon: true, evening: true }
    case 'BD':              return { morning: true, noon: false, evening: true }
    case 'OD':              return { morning: true, noon: false, evening: false }
    default:                return { morning: false, noon: false, evening: false }
  }
}

/** How many doses a day the ticks add up to, for working out the quantity. */
const perDay = (slots: Record<SlotKey, boolean>) =>
  SLOTS.filter((s) => slots[s.key]).length

function Consultation({ visitId, me, onBack }: {
  visitId: number; me: SessionUser; onBack: () => void
}) {
  const [visit, setVisit] = useState<any>(null)
  const [history, setHistory] = useState<any[]>([])
  const [diagnosis, setDiagnosis] = useState('')
  const [advice, setAdvice] = useState('')
  const [meds, setMeds] = useState<Med[]>([])
  const [services, setServices] = useState<any[]>([])
  const [chosen, setChosen] = useState<number[]>([])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [printing, setPrinting] = useState(false)
  void me

  useEffect(() => {
    api.visit(visitId).then((v) => {
      setVisit(v)
      api.patientHistory(v.patient_id).then((h) => setHistory(h.filter((x: any) => x.id !== visitId)))
    })
    api.services().then(setServices).catch(() => {})
    api.prescription(visitId).then((p) => {
      setDiagnosis(p.prescription.diagnosis ?? '')
      setAdvice(p.prescription.advice ?? '')
      setMeds(p.items.map((i: any) => ({
        key: `e${i.id}`, productId: i.product_id, drugName: i.drug_name,
        dose: i.dose ?? '', slots: frequencyToSlots(i.frequency),
        durationDays: i.duration_days ? String(i.duration_days) : '',
        qtyPrescribed: String(i.qty_prescribed), instructions: i.instructions ?? '',
        inStock: i.in_stock
      })))
      setChosen(p.services.map((s: any) => s.service_id))
    }).catch(() => {})
  }, [visitId])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => api.productSearch(q).then(setHits).catch(() => setHits([])), 180)
    return () => clearTimeout(t)
  }, [q])

  const addFromCatalogue = (p: any) => {
    setMeds((m) => [...m, {
      key: `${p.id}-${Date.now()}`, productId: p.id, drugName: p.name,
      dose: '', slots: { morning: true, noon: true, evening: true },
      durationDays: '3', qtyPrescribed: '1',
      instructions: '', inStock: p.total_qty
    }])
    setQ(''); setHits([])
  }

  const addFreeText = () => {
    setMeds((m) => [...m, {
      key: `f${Date.now()}`, productId: null, drugName: q.trim(),
      dose: '', slots: { morning: true, noon: true, evening: true },
      durationDays: '3', qtyPrescribed: '1',
      instructions: '', inStock: null
    }])
    setQ(''); setHits([])
  }

  const set = (key: string, patch: Partial<Med>) =>
    setMeds((m) => m.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const serviceTotal = chosen.reduce(
    (n, id) => n + Number(services.find((s) => s.id === id)?.price_paisa ?? 0), 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      await api.saveConsultation(visitId, {
        diagnosis: diagnosis.trim() || null,
        advice: advice.trim() || null,
        items: meds.filter((m) => m.drugName.trim()).map((m) => ({
          productId: m.productId,
          drugName: m.drugName.trim(),
          dose: m.dose || null,
          // Stored as the standard abbreviation so pharmacy, printouts and
          // old records all keep reading the same field.
          frequency: slotsToFrequency(m.slots),
          durationDays: m.durationDays ? Number(m.durationDays) : null,
          qtyPrescribed: Math.max(1, Number(m.qtyPrescribed) || 1),
          instructions: m.instructions || null
        })),
        services: chosen.map((serviceId) => ({ serviceId }))
      })
      setSaved(true)
      setTimeout(onBack, 900)
    } catch (e: any) { setErr(e.message ?? 'Could not save') }
    finally { setBusy(false) }
  }

  if (!visit) return <div className="p-8 text-sm text-muted">{tr('Loading…')}</div>

  return (
    <div className="space-y-5 p-5">
      <button onClick={onBack} className="text-2xs text-muted hover:text-primary">
        &larr; Back to my patients
      </button>

      <Card tint>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{visit.patient_name}</h2>
              <Badge tone="primary">{visit.mrn}</Badge>
              <Badge>Token {visit.token_no}</Badge>
            </div>
            <p className="mt-1 text-2xs text-muted num">
              {[visit.age_years != null && `${visit.age_years} years`, visit.gender,
                visit.phone, visit.blood_group].filter(Boolean).join(' · ')}
            </p>
            {visit.complaint && (
              <p className="mt-2 text-sm text-body">
                <span className="text-2xs uppercase tracking-wide text-muted">{tr('Complaint')} </span>
                {visit.complaint}
              </p>
            )}
            <ArrivalReadings v={visit} />
          </div>
          {visit.allergies && (
            <div className="rounded-lg border border-bad/25 bg-bad/5 px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-wide text-bad">{tr('Allergies')}</p>
              <p className="text-sm text-bad">{visit.allergies}</p>
            </div>
          )}
        </div>
      </Card>

      {history.length > 0 && (
        <Card title={tr('Previous visits')} hint={tr('Most recent first')}>
          <ul className="divide-y divide-divide">
            {history.slice(0, 5).map((h) => (
              <li key={h.id} className="flex items-baseline gap-3 py-2 text-2xs">
                <span className="num w-24 shrink-0 text-muted">
                  {new Date(h.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                </span>
                <span className="flex-1">
                  <span className="text-heading">{h.diagnosis ?? h.complaint ?? 'No diagnosis recorded'}</span>
                  <span className="text-muted"> · {h.doctor_name}</span>
                </span>
                <span className="num shrink-0 text-muted">
                  {h.medicine_count > 0 && `${h.medicine_count} medicine${h.medicine_count > 1 ? 's' : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title={tr('Prescription')}>
            <div className="relative">
              <input value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && hits.length === 0) addFreeText() }}
                placeholder={tr('Search a medicine, or type a name and press Enter')}
                className="field" />
              {hits.length > 0 && (
                <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border-2 border-line bg-card shadow-lg">
                  {hits.map((p) => (
                    <li key={p.id} onClick={() => addFromCatalogue(p)}
                      className="flex cursor-pointer items-center gap-3 border-b border-divide px-3 py-2 last:border-0 hover:bg-screen">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-heading">{p.name}</span>
                        <span className="block truncate text-2xs text-muted">
                          {[p.generic_name, p.strength, p.form].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {/* Stock is advice, never a restriction: a doctor prescribes
                          what is right, and the pharmacy sorts out supply. */}
                      <Badge tone={p.total_qty > 0 ? 'ok' : 'warn'}>
                        {p.total_qty > 0 ? `${p.total_qty} in stock` : 'out of stock'}
                      </Badge>
                    </li>
                  ))}
                  <li onClick={addFreeText}
                    className="cursor-pointer bg-screen px-3 py-2 text-2xs text-primary hover:bg-card">
                    Prescribe &ldquo;{q}&rdquo; anyway — not in the pharmacy catalogue
                  </li>
                </ul>
              )}
            </div>

            {meds.length === 0 ? (
              <p className="mt-4 text-2xs text-muted">
                {tr('Nothing prescribed yet. Anything not stocked can still be written.')}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {meds.map((m) => (
                  <li key={m.key} className="rounded-lg border border-line p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className="text-sm font-medium text-heading">{m.drugName}</span>
                        {m.productId === null
                          ? <Badge tone="warn">{tr('not in pharmacy')}</Badge>
                          : m.inStock === 0
                            ? <Badge tone="warn">{tr('out of stock')}</Badge>
                            : null}
                      </div>
                      <button onClick={() => setMeds((x) => x.filter((y) => y.key !== m.key))}
                        className="text-muted hover:text-bad">&times;</button>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                      <label className="block">
                        <span className="label">{tr('How much each time')}</span>
                        <input value={m.dose} onChange={(e) => set(m.key, { dose: e.target.value })}
                          placeholder={tr('1 tablet')} className="field py-1.5 text-2xs" />
                      </label>

                      <div>
                        <span className="label">{tr('When to take it')}</span>
                        <div className="flex gap-1">
                          {SLOTS.map((s) => {
                            const on = m.slots[s.key]
                            return (
                              <button key={s.key} type="button"
                                aria-pressed={on}
                                onClick={() => set(m.key, { slots: { ...m.slots, [s.key]: !on } })}
                                className={`rounded-xl border px-3 py-1.5 text-2xs transition-colors ${
                                  on
                                    ? 'border-primary bg-primary/10 font-medium text-primary'
                                    : 'border-line bg-card text-muted hover:border-primary/40'}`}>
                                <span className="mr-1">{on ? '\u2713' : '\u00A0'}</span>
                                {tr(s.label)}
                                <span className="block text-[0.6rem] font-normal opacity-70">{tr(s.hint)}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <label className="block">
                        <span className="label">{tr('For how many days')}</span>
                        <input value={m.durationDays}
                          onChange={(e) => set(m.key, { durationDays: e.target.value })}
                          placeholder="3" className="field num py-1.5 text-2xs" />
                      </label>
                      <label className="block">
                        <span className="label">
                          {m.productId ? 'Packs to dispense' : 'Quantity to dispense'}
                        </span>
                        <input value={m.qtyPrescribed}
                          onChange={(e) => set(m.key, { qtyPrescribed: e.target.value })}
                          placeholder="1" className="field num py-1.5 text-2xs" />
                      </label>
                      <label className="block">
                        <span className="label">{tr('Instructions')}</span>
                        <input value={m.instructions}
                          onChange={(e) => set(m.key, { instructions: e.target.value })}
                          placeholder={tr('After meals')} className="field py-1.5 text-2xs" />
                      </label>
                    </div>

                    <p className="mt-2 text-2xs text-muted">
                      {perDay(m.slots) === 0
                        ? 'No times ticked, so this will be written as "when required".'
                        : <>
                            {perDay(m.slots)} a day for {m.durationDays || '?'} days
                            {' '}&middot; written as <span className="font-medium">{slotsToFrequency(m.slots)}</span>
                            {m.dose.trim() && Number(m.durationDays) > 0 &&
                              ` · about ${perDay(m.slots) * Number(m.durationDays)} × ${m.dose.trim()} in total`}
                          </>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={tr('Diagnosis and advice')}>
            <div className="space-y-3">
              <Field label={tr('Diagnosis')}>
                <input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder={tr('Viral fever')} className="field" />
              </Field>
              <Field label={tr('Advice')}>
                <textarea value={advice} onChange={(e) => setAdvice(e.target.value)} rows={3}
                  placeholder={tr('Plenty of fluids, rest, return if fever persists past three days')}
                  className="field resize-none" />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={tr('Tests and scans')} hint={tr('Charged to the patient')}>
            <div className="max-h-80 space-y-1 overflow-auto">
              {services.length === 0 && (
                <p className="text-2xs text-muted">{tr('No services set up yet. An admin adds these.')}</p>
              )}
              {services.map((sv) => (
                <label key={sv.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2 ${
                    chosen.includes(sv.id) ? 'border-primary bg-primary/5' : 'border-line hover:bg-screen'}`}>
                  <input type="checkbox" checked={chosen.includes(sv.id)}
                    onChange={(e) => setChosen((c) =>
                      e.target.checked ? [...c, sv.id] : c.filter((x) => x !== sv.id))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs text-heading">{sv.name}</span>
                    <span className="block text-2xs capitalize text-muted">{sv.category}</span>
                  </span>
                  <span className="num shrink-0 text-2xs font-medium text-primary">
                    {rs(sv.price_paisa)}
                  </span>
                </label>
              ))}
            </div>
            {chosen.length > 0 && (
              <div className="mt-3 flex items-center justify-between border-t border-divide pt-3">
                <span className="text-2xs text-muted">{chosen.length} ordered</span>
                <span className="num text-base font-semibold text-primary">Rs {rs(serviceTotal)}</span>
              </div>
            )}
          </Card>

          <Card>
            <ErrorNote>{err}</ErrorNote>
            {saved && (
              <p className="mb-2 rounded-lg border border-ok/25 bg-ok/5 px-3 py-2 text-2xs text-ok">
                {tr('Saved. The pharmacy can see this prescription now.')}
              </p>
            )}
            <button onClick={save} disabled={busy} className="btn-primary w-full">
              {busy ? tr('Saving…') : tr('Save and finish')}
            </button>
            {/*
              Printed for a patient buying medicines elsewhere. Plenty of
              hospitals have no pharmacy of their own, and the doctor should
              not have to write the same list twice on paper.
            */}
            <button onClick={() => setPrinting(true)} disabled={meds.length === 0}
              className="btn-ghost mt-2 w-full">
              {tr('Print prescription')}
            </button>
            <p className="mt-2 text-2xs text-muted">
              {tr('Saving closes the visit and sends the prescription to the pharmacy. Print it as well if the patient is buying medicines outside.')}
            </p>
          </Card>
        </div>
      </div>

      {printing && (
        <NuskhaPreview onClose={() => setPrinting(false)}
          draft={{
            prescription: {
              patient_name: visit.patient_name, mrn: visit.mrn,
              age_years: visit.age_years, gender: visit.gender,
              allergies: visit.allergies, doctor_name: visit.doctor_name,
              specialisation: visit.specialisation, visit_at: visit.created_at,
              diagnosis, advice
            },
            items: meds.map((m) => ({
              drug_name: m.drugName, dose: m.dose,
              frequency: slotsToFrequency(m.slots),
              duration_days: m.durationDays, qty_prescribed: Number(m.qtyPrescribed) || 1,
              instructions: m.instructions
            }))
          }} />
      )}
    </div>
  )
}

/* --------------------------------------------------------------- earnings */

/** A money cell that stays quiet when there is nothing in it. */
function Money({ v }: { v: number | string }) {
  const n = Number(v)
  return (
    <td className={`px-3 py-2 text-right num text-2xs ${n > 0 ? 'text-body' : 'text-muted/40'}`}>
      {n > 0 ? rs(n) : '—'}
    </td>
  )
}

export function Earnings({ me }: { me: SessionUser }) {
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [data, setData] = useState<any>(null)

  useEffect(() => { api.myEarnings(from, to).then(setData).catch(() => setData(null)) }, [from, to])

  const totals = data?.totals
  const quick = (days: number) => {
    const d = new Date(); d.setDate(d.getDate() - days)
    setFrom(d.toISOString().slice(0, 10)); setTo(today())
  }

  return (
    <div className="space-y-5">
      <Card title={tr('My earnings')} hint={`${me.displayName}`}
        action={
          <div className="flex flex-wrap items-center gap-2 text-2xs">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="field w-36 py-1.5 num" />
            <span className="text-muted">{tr('to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="field w-36 py-1.5 num" />
            <button onClick={() => { setFrom(today()); setTo(today()) }} className="btn-ghost py-1.5">{tr('Today')}</button>
            <button onClick={() => quick(6)} className="btn-ghost py-1.5">7 days</button>
            <button onClick={() => quick(29)} className="btn-ghost py-1.5">30 days</button>
          </div>
        }>
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label={tr('Total earned')} value={`Rs ${rs(totals?.total_paisa)}`} />
          <Stat label={tr('From consultations')} value={`Rs ${rs(totals?.consultation_paisa)}`} tone="accent"
            sub={`${totals?.consultations ?? 0} patients`} />
          <Stat label={tr('From tests and scans')} value={`Rs ${rs(totals?.service_paisa)}`} tone="accent"
            sub={`${totals?.services ?? 0} ordered`} />
          <Stat label={tr('Billed to patients')} value={`Rs ${rs(totals?.gross_paisa)}`} tone="primary"
            sub={tr('Your share is a percentage of this')} />
        </div>
      </Card>

      <Card title={tr('By patient')} hint={tr('One row per patient, not one per transaction')}>
        {!data?.byPatient?.length ? (
          <Empty title={tr('Nothing earned in this period')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-28">{tr('MRN')}</Th><Th>{tr('Patient')}</Th>
                  <Th w="w-24" right>{tr('Consultation')}</Th>
                  <Th w="w-24" right>{tr('Radiology')}</Th>
                  <Th w="w-24" right>{tr('Lab')}</Th>
                  <Th w="w-24" right>{tr('Procedures')}</Th>
                  <Th w="w-24" right>{tr('Other')}</Th>
                  <Th w="w-28" right>{tr('Total')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {data.byPatient.map((r: any) => (
                  <tr key={r.patient_id}>
                    <td className="px-3 py-2 num text-2xs text-primary">{r.mrn}</td>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{r.patient_name}</span>
                      <span className="block num text-2xs text-muted">
                        {new Date(r.first_at).toLocaleDateString('en-GB',
                          { day: '2-digit', month: 'short' })}
                        {r.visits > 1 && ` · ${r.visits} visits`}
                      </span>
                    </td>
                    <Money v={r.consultation_paisa} />
                    <Money v={r.radiology_paisa} />
                    <Money v={r.lab_paisa} />
                    <Money v={r.procedure_paisa} />
                    <Money v={r.other_paisa} />
                    <td className="px-3 py-2 text-right num text-sm font-medium text-primary">
                      {rs(r.total_paisa)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line bg-screen/70">
                  <td className="px-3 py-2 text-2xs font-medium text-muted" colSpan={2}>
                    {data.byPatient.length} patients
                  </td>
                  {['consultation_paisa', 'radiology_paisa', 'lab_paisa',
                    'procedure_paisa', 'other_paisa', 'total_paisa'].map((k) => (
                    <td key={k} className={`px-3 py-2 text-right num text-2xs ${
                      k === 'total_paisa' ? 'font-semibold text-primary' : 'text-body'}`}>
                      {rs(data.byPatient.reduce((n: number, r: any) => n + Number(r[k]), 0))}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="mt-3 text-2xs text-muted">
          {tr('Amounts are your share, not what the patient was billed.')}
        </p>
      </Card>

    </div>
  )
}
