import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Search, Plus, Download, MessageCircle, Droplet, AlertTriangle, CheckCircle2
} from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import {
  Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Th
} from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Cross match reports.
 *
 * Before a transfusion the laboratory checks that one particular bag of blood
 * is safe for one particular patient. Kept apart from the ordinary work list
 * because it is not a test somebody ordered and paid for at the counter: it
 * is a check the laboratory runs against a bag, with a donor on one side who
 * is not a patient of the hospital at all.
 */

const GROUPS = ['O', 'A', 'B', 'AB']
const RH = ['POSITIVE', 'NEGATIVE']
const SCREEN = ['NEGATIVE', 'POSITIVE', 'NOT DONE']
const PHASE = ['COMPATIBLE', 'INCOMPATIBLE']

/** The same rule the server applies, so the form can show it before saving. */
function conclusionFor(direct: string, albumin: string) {
  const both = [direct, albumin]
  if (both.some((v) => v === 'INCOMPATIBLE')) {
    return 'CROSS MATCH IS NOT COMPATIBLE WITH PATIENT BLOOD GROUP'
  }
  if (both.every((v) => v === 'COMPATIBLE')) {
    return 'CROSS MATCH IS COMPATIBLE WITH PATIENT BLOOD GROUP'
  }
  return ''
}

export function CrossMatch({ me }: { me: SessionUser }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.crossMatches(q).then(setRows).catch((e: any) => setErr(e.message))
  }, [q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  function download(r: any) {
    const path = `/lab/cross-matches/${r.id}/pdf`
    api.documentTicket(path).then(({ ticket }: any) => {
      const a = document.createElement('a')
      a.href = `/api${path}?download=1&ticket=${encodeURIComponent(ticket)}`
      a.download = `${clean(r.patient_name)} ${clean(r.report_no)}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
    }).catch((e: any) => setErr(e.message))
  }

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Cross match')}
        hint={tr('Checking a bag of blood against the patient it is meant for.')}
        action={
          <button onClick={() => setAdding(true)}
            className="btn-primary inline-flex items-center gap-1.5">
            <Plus size={14} /> {tr('New cross match')}
          </button>
        }>
        <ErrorNote>{err}</ErrorNote>

        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Patient, MRN, donor or blood bag number')}
            className="field pl-9" />
        </div>

        {!rows ? <SkeletonRows rows={5} cols={4} />
          : rows.length === 0 ? (
            <Empty title={tr('No cross match reports yet')}
              hint={tr('They are written here when blood is checked against a patient before a transfusion.')} />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-32">{tr('Report')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Donor')}</Th><Th w="w-32">{tr('Blood bag')}</Th>
                  <Th w="w-40">{tr('Result')}</Th><Th w="w-28" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped">
                {rows.map((r) => {
                  const bad = /NOT COMPATIBLE|INCOMPATIBLE/i.test(r.conclusion ?? '')
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2">
                        <span className="num text-2xs text-primary">{r.report_no}</span>
                        <span className="block num text-2xs text-muted">
                          {new Date(r.created_at).toLocaleString('en-GB',
                            { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{r.patient_name}</span>
                        <span className="block num text-2xs text-muted">{r.mrn}</span>
                      </td>
                      <td className="px-3 py-2 text-sm text-body">{r.donor_name}</td>
                      <td className="px-3 py-2 num text-2xs text-body">{r.blood_bag_no ?? '—'}</td>
                      <td className="px-3 py-2">
                        {/*
                          The one thing anybody scanning this list is looking
                          for. An incompatible result is red and carries a
                          warning mark, because it is the row that has to stop
                          somebody.
                        */}
                        {!r.conclusion ? <Badge tone="warn">{tr('not concluded')}</Badge>
                          : bad ? (
                            <Badge tone="bad">
                              <AlertTriangle size={10} className="mr-0.5 inline" />
                              {tr('Not compatible')}
                            </Badge>
                          ) : (
                            <Badge tone="ok">
                              <CheckCircle2 size={10} className="mr-0.5 inline" />
                              {tr('Compatible')}
                            </Badge>
                          )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => download(r)}
                          className="btn-ghost px-2 py-1 text-2xs">
                          <Download size={13} />
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

      {adding && (
        <NewCrossMatch me={me} onClose={() => setAdding(false)}
          onDone={(made: any) => { setAdding(false); load(); download(made) }} />
      )}
    </div>
  )
}

const clean = (s: any) => String(s ?? '')
  .replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()

/* ------------------------------------------------------- writing one */

function NewCrossMatch({ me, onClose, onDone }: {
  me: SessionUser; onClose: () => void; onDone: (made: any) => void
}) {
  const [patient, setPatient] = useState<any | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<any[]>([])
  const first = useRef<HTMLInputElement>(null)

  const [f, setF] = useState({
    patientGroup: 'O', patientRh: 'POSITIVE',
    donorName: '', donorAge: '', donorSex: 'MALE',
    donorGroup: 'O', donorRh: 'POSITIVE', donorHb: '', bloodBagNo: '',
    hbsag: 'NEGATIVE', antiHcv: 'NEGATIVE', hiv: 'NEGATIVE',
    vdrl: 'NEGATIVE', mp: 'NEGATIVE',
    directPhase: 'COMPATIBLE', albuminPhase: 'COMPATIBLE',
    notes: ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      api.searchPatients(q.trim()).then(setHits).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }))
  const conclusion = conclusionFor(f.directPhase, f.albuminPhase)
  const bad = conclusion.includes('NOT COMPATIBLE')

  /*
   * A mismatch between the two blood groups is worth saying out loud.
   *
   * It can be deliberate — O negative goes to anybody in an emergency — so it
   * is a warning and not a refusal. But a technologist who has typed the
   * wrong group by mistake should see it before they save, not after the bag
   * is hung.
   */
  const groupMismatch = patient && f.donorGroup !== f.patientGroup
  const rhMismatch = patient && f.donorRh !== f.patientRh

  async function save() {
    if (!patient) { setErr(tr('Choose the patient first')); return }
    setBusy(true); setErr(null)
    try {
      const made = await api.createCrossMatch({
        patientId: patient.id,
        patientGroup: f.patientGroup, patientRh: f.patientRh,
        donorName: f.donorName.trim(),
        donorAge: f.donorAge ? Number(f.donorAge) : null,
        donorSex: f.donorSex, donorGroup: f.donorGroup, donorRh: f.donorRh,
        donorHb: f.donorHb.trim() || null, bloodBagNo: f.bloodBagNo.trim() || null,
        hbsag: f.hbsag, antiHcv: f.antiHcv, hiv: f.hiv, vdrl: f.vdrl, mp: f.mp,
        directPhase: f.directPhase, albuminPhase: f.albuminPhase,
        notes: f.notes.trim() || null
      })
      onDone({ ...made, patient_name: patient.name })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const Pick = ({ label, value, options, onChange, hint }: any) => (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field mt-1">
        {options.map((o: string) => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  )

  return (
    <Modal title={tr('New cross match')} wide onClose={onClose}
      hint={tr('The report prints as soon as it is saved')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !patient || !f.donorName.trim()}
          className="btn-primary">
          {busy ? tr('Saving…') : tr('Save and print')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {/* ------------------------------------------------------- patient */}
      <p className="label">{tr('Patient')}</p>
      {patient ? (
        <div className="mt-1 flex items-center justify-between rounded-xl border-2 border-line p-3">
          <span>
            <span className="text-sm font-medium text-heading">{patient.name}</span>
            <span className="block num text-2xs text-muted">
              {patient.mrn}
              {patient.age_years != null && ` · ${patient.age_years}y`}
              {patient.gender && ` · ${tr(patient.gender)}`}
            </span>
          </span>
          <button onClick={() => { setPatient(null); setQ('') }}
            className="btn-ghost px-2 py-1 text-2xs">{tr('Change')}</button>
        </div>
      ) : (
        <div className="relative mt-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input ref={first} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search by name, MRN or phone')} className="field pl-9" />
          {hits.length > 0 && (
            <ul className="mt-1 max-h-48 overflow-auto rounded-xl border-2 border-line">
              {hits.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <button onClick={() => { setPatient(p); setHits([]) }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left
                               text-sm hover:bg-raised">
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
        <Pick label={tr('Patient blood group')} value={f.patientGroup} options={GROUPS}
          onChange={(v: string) => set('patientGroup', v)} />
        <Pick label={tr('Patient RH factor')} value={f.patientRh} options={RH}
          onChange={(v: string) => set('patientRh', v)} />
      </div>

      {/* --------------------------------------------------------- donor */}
      <p className="label mt-5">{tr('Donor')}</p>
      <div className="mt-1 grid gap-3 sm:grid-cols-2">
        <Field label={tr('Donor name')}>
          <input value={f.donorName} onChange={(e) => set('donorName', e.target.value)}
            className="field mt-1" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('Age')}>
            <input value={f.donorAge} onChange={(e) => set('donorAge', e.target.value)}
              inputMode="numeric" className="field num mt-1" />
          </Field>
          <Pick label={tr('Sex')} value={f.donorSex} options={['MALE', 'FEMALE']}
            onChange={(v: string) => set('donorSex', v)} />
        </div>
        <Pick label={tr('Donor blood group')} value={f.donorGroup} options={GROUPS}
          onChange={(v: string) => set('donorGroup', v)} />
        <Pick label={tr('Donor RH factor')} value={f.donorRh} options={RH}
          onChange={(v: string) => set('donorRh', v)} />
        <Field label="HB%">
          <input value={f.donorHb} onChange={(e) => set('donorHb', e.target.value)}
            placeholder="14.5" className="field num mt-1" />
        </Field>
        <Field label={tr('Blood bag number')}
          hint={tr('What ties this report to the bag on the trolley')}>
          <input value={f.bloodBagNo} onChange={(e) => set('bloodBagNo', e.target.value)}
            placeholder="X97398Z1" className="field num mt-1" />
        </Field>
      </div>

      {(groupMismatch || rhMismatch) && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border-2 border-warn/40
                        bg-warn/5 p-3">
          <Droplet size={15} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-2xs text-warn">
            {groupMismatch && `${tr('The donor group')} (${f.donorGroup}) ${
              tr('is not the same as the patient group')} (${f.patientGroup}). `}
            {rhMismatch && tr('The RH factors differ. ')}
            <span className="text-muted">
              {tr('That can be deliberate, so nothing is blocked — but check it is not a typing mistake.')}
            </span>
          </p>
        </div>
      )}

      {/* ----------------------------------------------------- screening */}
      <p className="label mt-5">{tr("Donor's screening")}</p>
      <div className="mt-1 grid gap-3 sm:grid-cols-3">
        <Pick label="HbsAg" value={f.hbsag} options={SCREEN}
          onChange={(v: string) => set('hbsag', v)} />
        <Pick label="Anti HCV" value={f.antiHcv} options={SCREEN}
          onChange={(v: string) => set('antiHcv', v)} />
        <Pick label="HIV" value={f.hiv} options={SCREEN}
          onChange={(v: string) => set('hiv', v)} />
        <Pick label="Syphilis (VDRL)" value={f.vdrl} options={SCREEN}
          onChange={(v: string) => set('vdrl', v)} />
        <Pick label="M.P" value={f.mp} options={SCREEN}
          onChange={(v: string) => set('mp', v)} />
      </div>

      {[f.hbsag, f.antiHcv, f.hiv, f.vdrl, f.mp].includes('POSITIVE') && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border-2 border-bad/40
                        bg-bad/5 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-bad" />
          <p className="text-2xs text-bad">
            {tr('A screening test came back positive. The report will say so, and this bag should not be issued.')}
          </p>
        </div>
      )}

      {/* -------------------------------------------------------- phases */}
      <p className="label mt-5">{tr('Cross match')}</p>
      <div className="mt-1 grid gap-3 sm:grid-cols-2">
        <Pick label={tr('Direct phase')} value={f.directPhase} options={PHASE}
          onChange={(v: string) => set('directPhase', v)} />
        <Pick label={tr('Albumin phase')} value={f.albuminPhase} options={PHASE}
          onChange={(v: string) => set('albuminPhase', v)} />
      </div>

      {/*
        The conclusion is shown, not typed.
        It follows from the two phases above, because somebody typing
        COMPATIBLE under two incompatible phases is a transfusion reaction.
      */}
      <div className={`mt-3 rounded-xl border-2 p-3 text-center ${
        bad ? 'border-bad/50 bg-bad/5' : 'border-ok/40 bg-ok/5'}`}>
        <p className={`text-sm font-semibold ${bad ? 'text-bad' : 'text-ok'}`}>
          {conclusion}
        </p>
        <p className="mt-0.5 text-2xs text-muted">
          {tr('Printed at the foot of the report. It follows the two phases above.')}
        </p>
      </div>

      <Field label={tr('Note')} span
        hint={tr('Optional. Printed under the conclusion.')}>
        <textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)}
          className="field mt-1 resize-y text-sm" />
      </Field>
    </Modal>
  )
}
