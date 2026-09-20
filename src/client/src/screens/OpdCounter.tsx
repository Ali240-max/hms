import { useCallback, useEffect, useState } from 'react'
import { api, type SessionUser } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../components/ui'
import { useT } from '../lib/prefs'
import { t as tr } from '../lib/prefs'
import { Sidebar, type NavItem } from '../components/Sidebar'
import { Reports } from './pharma/Reports'
import { ListChecks, BarChart3 } from 'lucide-react'
import { useModules } from '../lib/modules'

/**
 * The OPD counter, outside the doctors' rooms.
 *
 * By the time a patient reaches this desk they have already registered and
 * paid at the main counter and are holding a token slip. All this desk does is
 * hold the queue, take a few readings if the complaint calls for it, and send
 * the patient in.
 *
 * It handles no money at all — no fees, no chits. That is deliberate: the
 * cash lives at one window so one person counts it at close of day. There is
 * nothing on this screen that can take a payment, and the server refuses even
 * if the endpoint is called directly.
 */
function OpdCounterWork({ me }: { me: SessionUser }) {
  const tr = useT()
  const modules = useModules()
  const [queue, setQueue] = useState<any[]>([])
  const [doctorId, setDoctorId] = useState(0)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<any | null>(null)
  const [sending, setSending] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    api.queue().then(setQueue).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  /** One tab per doctor, because that is how the physical queue is arranged. */
  const doctors = Array.from(
    queue.reduce((m, v) => {
      if (!v.doctor_id) return m
      const d = m.get(v.doctor_id) ?? { id: v.doctor_id, name: v.doctor_name, room: v.room, waiting: 0 }
      if (v.status === 'waiting') d.waiting++
      m.set(v.doctor_id, d)
      return m
    }, new Map<number, any>()).values()
  ).sort((a: any, b: any) => b.waiting - a.waiting)

  const term = q.trim().toLowerCase()
  const shown = queue.filter((v) => {
    if (doctorId && v.doctor_id !== doctorId) return false
    if (!term) return true
    return String(v.token_no) === term ||
      (v.patient_name ?? '').toLowerCase().includes(term) ||
      (v.mrn ?? '').toLowerCase().includes(term) ||
      (v.phone ?? '').includes(term)
  })

  const waiting = shown.filter((v) => v.status === 'waiting').length
  const sentIn = shown.filter((v) => v.status === 'ready').length
  const unpaid = shown.filter((v) => v.status === 'registered').length
  const withDoctor = shown.filter((v) => v.status === 'in_consultation').length
  const done = shown.filter((v) => v.status === 'completed').length
  const noVitals = shown.filter((v) => v.status === 'waiting' && !v.vitals_at).length

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={tr('Waiting')} value={String(waiting)} tone={waiting ? 'warn' : 'ok'}
          sub={unpaid ? `${unpaid} ${tr('still at the main counter')}` : undefined} />
        <Stat label={tr('With the doctor')} value={String(withDoctor)} tone="primary" />
        <Stat label={tr('Seen')} value={String(done)} tone="ok" />
        <Stat label={tr('Sent in')} value={String(sentIn)} tone={sentIn ? 'ok' : undefined}
          sub={tr('Waiting outside the doctor\'s door')} />
      </div>

      <Card title={tr('Queue')} hint={tr('Patients arrive here after paying at the main counter')}
        action={
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Token, name, MRN or phone')} className="field w-64 py-1.5 text-2xs" />
        }>
        <ErrorNote>{err}</ErrorNote>

        <div className="flex flex-wrap gap-1">
          <button onClick={() => setDoctorId(0)}
            className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
              doctorId === 0 ? 'bg-brand text-white'
                             : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            {tr('All doctors')} <span className="num opacity-70">{queue.length}</span>
          </button>
          {doctors.map((d: any) => (
            <button key={d.id} onClick={() => setDoctorId(d.id)}
              className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
                doctorId === d.id ? 'bg-brand text-white'
                                  : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
              {d.name}{d.room && ` · ${d.room}`} <span className="num opacity-70">{d.waiting}</span>
            </button>
          ))}
        </div>

        {loading ? <SkeletonRows rows={5} cols={4} />
          : shown.length === 0 ? (
            <Empty title={q ? `Nobody matching "${q}"` : 'Nobody in the queue'}
              hint={q ? 'Clear the search to see everyone.'
                      : 'Patients appear here once the main counter registers them.'} />
          ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-16">{tr('Token')}</Th><Th>{tr('Patient')}</Th>
                  <Th w="w-36">{tr('Doctor')}</Th><Th>{tr('Complaint and readings')}</Th>
                  <Th w="w-28">{tr('Status')}</Th><Th w="w-44" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {shown.map((v) => (
                  <tr key={v.id}>
                    <td className="px-3 py-2">
                      <span className="num text-lg font-semibold text-primary">{v.token_no}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-heading">{v.patient_name}</div>
                      <div className="num text-2xs text-muted">
                        {v.mrn}
                        {v.age_years != null && ` · ${v.age_years}y`}
                        {v.gender && ` · ${v.gender}`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-2xs text-body">
                      {v.doctor_name}{v.room && <span className="block text-muted">Room {v.room}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {v.complaint
                        ? <span className="text-2xs text-body">{v.complaint}</span>
                        : <span className="text-2xs text-muted">{tr('No complaint recorded')}</span>}
                      <Vitals v={v} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={v.status === 'completed' ? 'ok'
                        : v.status === 'in_consultation' ? 'primary'
                        : v.status === 'ready' ? 'ok'
                        : v.status === 'registered' ? 'bad' : 'warn'}>
                        {tr(v.status === 'in_consultation' ? 'with doctor'
                          : v.status === 'registered' ? 'not paid' : v.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEditing(v)} className="btn-ghost px-2 py-1 text-2xs">
                        {v.vitals_at ? tr('Update details') : tr('Add details')}
                      </button>
                      {/*
                        The hand-off. Until this is pressed the doctor can see
                        the patient in their queue but cannot open them, so the
                        desk keeps control of who goes in and when.
                      */}
                      {/*
                        With no doctor terminal there is nobody to send anyone
                        in to, so the desk records the details and the patient
                        goes straight on to whatever they are here for.
                      */}
                      {v.status === 'waiting' && modules.doctor && (
                        <button onClick={() => setConfirming(v)}
                          className="ml-1 btn-primary px-2 py-1 text-2xs">
                          {tr('Send in')}
                        </button>
                      )}
                      {v.status === 'ready' && (
                        <span className="ml-2 text-2xs font-medium text-ok">{tr('sent in')}</span>
                      )}
                      {v.status === 'registered' && (
                        <span className="ml-2 text-2xs text-muted">{tr('waiting to pay')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-2xs text-muted">
        Signed in as {me.displayName}. Fees and chit payments are handled at the main
        counter; this desk records the queue and the patient's condition only.
      </p>

      {editing && (
        <VitalsForm visit={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }} />
      )}

      {/*
        Sending a patient in is one-way from this desk: the doctor can open
        them straight afterwards, and there is no button here to pull them
        back. On a crowded list the rows are one line apart, so a misclick
        sends the wrong person to a consulting room.
      */}
      {confirming && (
        <Modal title={tr('Send this patient in?')} onClose={() => setConfirming(null)}
          footer={<>
            <button onClick={() => setConfirming(null)} className="btn-ghost">{tr('Cancel')}</button>
            <button disabled={sending === confirming.id} className="btn-primary"
              onClick={async () => {
                setSending(confirming.id); setErr(null)
                try { await api.sendIn(confirming.id); setConfirming(null); load() }
                catch (e: any) { setErr(e.message); setConfirming(null) }
                finally { setSending(null) }
              }}>
              {sending === confirming.id ? tr('Saving…') : tr('Yes, send them in')}
            </button>
          </>}>
          <div className="flex items-center gap-4">
            <span className="num text-4xl font-semibold text-primary">{confirming.token_no}</span>
            <div className="min-w-0">
              <p className="text-base font-medium text-heading">{confirming.patient_name}</p>
              <p className="num text-2xs text-muted">
                {confirming.mrn}
                {confirming.age_years != null && ` · ${confirming.age_years}y`}
                {confirming.gender && ` · ${tr(confirming.gender)}`}
              </p>
              <p className="mt-0.5 text-2xs text-body">{confirming.doctor_name}</p>
            </div>
          </div>

          {/*
            The desk exists to take details before the doctor sees the
            patient. Sending someone in with nothing recorded is allowed —
            a simple cough needs no blood pressure — but it should be a
            decision rather than an accident.
          */}
          {!confirming.vitals_at ? (
            <div className="mt-4 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
              <p className="text-2xs font-medium text-warn">
                {tr('No details have been recorded for this patient yet')}
              </p>
              <p className="mt-0.5 text-2xs text-muted">
                {tr('Fine if the complaint does not call for it. Otherwise add them first.')}
              </p>
              <button
                onClick={() => { setEditing(confirming); setConfirming(null) }}
                className="btn-ghost mt-2 text-2xs">
                {tr('Add details instead')}
              </button>
            </div>
          ) : (
            <div className="card-tint mt-4 p-3">
              <p className="text-2xs uppercase tracking-wide text-muted">{tr('Recorded')}</p>
              {confirming.complaint && (
                <p className="text-sm text-heading">{confirming.complaint}</p>
              )}
              <Vitals v={confirming} />
            </div>
          )}

          <p className="mt-3 text-2xs text-muted">
            {tr('They will appear in the doctor\'s Ready for you list straight away.')}
          </p>
        </Modal>
      )}
    </div>
  )
}

/** A compact readout, shown only for the fields that were actually filled. */
function Vitals({ v }: { v: any }) {
  const bits: string[] = []
  if (v.bp_systolic && v.bp_diastolic) bits.push(`BP ${v.bp_systolic}/${v.bp_diastolic}`)
  if (v.pulse_bpm) bits.push(`Pulse ${v.pulse_bpm}`)
  if (v.temperature_f) bits.push(`Temp ${v.temperature_f}\u00B0F`)
  if (v.sugar_mg_dl) bits.push(`Sugar ${v.sugar_mg_dl}`)
  if (v.weight_kg) bits.push(`${v.weight_kg} kg`)
  if (bits.length === 0) return null

  // A flag on the obvious ones, so the desk can move someone up the queue.
  const high = (v.bp_systolic >= 160 || v.bp_diastolic >= 100 ||
    v.sugar_mg_dl >= 250 || Number(v.temperature_f) >= 102)

  return (
    <div className={`num mt-0.5 text-2xs ${high ? 'font-medium text-warn' : 'text-muted'}`}>
      {bits.join(' · ')}
      {high && ' — worth flagging to the doctor'}
    </div>
  )
}

function VitalsForm({ visit, onClose, onDone }: {
  visit: any; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    complaint: visit.complaint ?? '',
    bpSystolic: visit.bp_systolic ? String(visit.bp_systolic) : '',
    bpDiastolic: visit.bp_diastolic ? String(visit.bp_diastolic) : '',
    pulseBpm: visit.pulse_bpm ? String(visit.pulse_bpm) : '',
    temperatureF: visit.temperature_f ? String(visit.temperature_f) : '',
    weightKg: visit.weight_kg ? String(visit.weight_kg) : '',
    sugarMgDl: visit.sugar_mg_dl ? String(visit.sugar_mg_dl) : '',
    vitalsNote: visit.vitals_note ?? ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const num = (s: string) => (s.trim() === '' ? null : Number(s))

  async function save() {
    setBusy(true); setErr(null)
    try {
      await api.saveVitals(visit.id, {
        complaint: f.complaint.trim() || null,
        bpSystolic: num(f.bpSystolic), bpDiastolic: num(f.bpDiastolic),
        pulseBpm: num(f.pulseBpm), temperatureF: num(f.temperatureF),
        weightKg: num(f.weightKg), sugarMgDl: num(f.sugarMgDl),
        vitalsNote: f.vitalsNote.trim() || null
      })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={visit.patient_name} hint={`${visit.mrn} · token ${visit.token_no}`} wide
      onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : 'Save and send in'}
        </button>
      </>}>
      <Field label={tr('What they have come in with')} span>
        <input autoFocus value={f.complaint} onChange={(e) => setF({ ...f, complaint: e.target.value })}
          placeholder={tr('Fever for three days, headache')} className="field" />
      </Field>

      <p className="label mt-4">{tr('Readings')}</p>
      <p className="mb-2 text-2xs text-muted">
        All optional. Fill in what you actually measured and leave the rest blank —
        a guessed number is worse than no number.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={tr('BP systolic')} hint={tr('Upper')}>
          <input value={f.bpSystolic} onChange={(e) => setF({ ...f, bpSystolic: e.target.value })}
            placeholder="120" className="field num" />
        </Field>
        <Field label={tr('BP diastolic')} hint={tr('Lower')}>
          <input value={f.bpDiastolic} onChange={(e) => setF({ ...f, bpDiastolic: e.target.value })}
            placeholder="80" className="field num" />
        </Field>
        <Field label={tr('Pulse')} hint={tr('Beats per minute')}>
          <input value={f.pulseBpm} onChange={(e) => setF({ ...f, pulseBpm: e.target.value })}
            placeholder="76" className="field num" />
        </Field>
        <Field label={tr('Temperature')} hint={tr('&deg;F')}>
          <input value={f.temperatureF} onChange={(e) => setF({ ...f, temperatureF: e.target.value })}
            placeholder="98.6" className="field num" />
        </Field>
        <Field label={tr('Blood sugar')} hint={tr('mg/dL')}>
          <input value={f.sugarMgDl} onChange={(e) => setF({ ...f, sugarMgDl: e.target.value })}
            placeholder="110" className="field num" />
        </Field>
        <Field label={tr('Weight')} hint={tr('kg')}>
          <input value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })}
            placeholder="68" className="field num" />
        </Field>
      </div>

      <Field label={tr('Anything else the doctor should know')} span>
        <input value={f.vitalsNote} onChange={(e) => setF({ ...f, vitalsNote: e.target.value })}
          placeholder={tr('Came with attendant, cannot walk unaided')} className="field mt-3" />
      </Field>

      {visit.vitals_at && (
        <p className="mt-3 text-2xs text-muted">
          Last recorded by {visit.vitals_by} at{' '}
          {new Date(visit.vitals_at).toLocaleString('en-GB',
            { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
      )}
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- shell */

/**
 * The rail, so this desk looks like the rest of the system.
 *
 * Only two places to be — the work in front of them, and the figures someone
 * asks for at the end of a day — but the shape is the same everywhere, and a
 * person moved between counters should not have to relearn where things are.
 */
const NAV: NavItem[] = [
  { id: 'work', label: 'Queue and vitals', glyph: 'W', icon: ListChecks },
  { id: 'reports', label: 'Reports', glyph: 'R', icon: BarChart3 }
]

export function OpdCounter({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<'work' | 'reports'>('work')
  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={NAV} active={tab} onSelect={(id: string) => setTab(id as 'work' | 'reports')}
        title="OPD counter" subtitle={me.displayName} />
      <div key={tab} className="anim-fade min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'work' ? <OpdCounterWork me={me} /> : <Reports me={me} />}
      </div>
    </div>
  )
}
