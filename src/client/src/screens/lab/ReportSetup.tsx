import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Upload, Info } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Card, ErrorNote, Field, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * How a printed report looks, set by the laboratory.
 *
 * Three things live here rather than in the administrator's panel, for the
 * same reason the reference ranges do: they are the laboratory's own wording
 * and its own people, changed when a method or a member of staff changes, and
 * routing that through an administrator means it is out of date until somebody
 * gets round to it.
 */
export function LabReportSetup({ me }: { me: SessionUser }) {
  const [settings, setSettings] = useState<any>(null)
  const [signers, setSigners] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.labReportSettings().then(setSettings).catch((e: any) => setErr(e.message))
    api.labSignatories().then(setSigners).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  function flash(what: string) {
    setSaved(what); setTimeout(() => setSaved(null), 2500)
  }

  /** A scanned signature, read straight into a data URI. */
  function readImage(file: File, onDone: (uri: string) => void) {
    if (file.size > 300_000) {
      setErr(tr('That image is too large. A signature should be well under 300 kB.'))
      return
    }
    const r = new FileReader()
    r.onload = () => onDone(String(r.result))
    r.readAsDataURL(file)
  }

  return (
    <div className="space-y-4 p-4">
      <ErrorNote>{err}</ErrorNote>

      <Card title={tr('The printed page')}
        hint={tr('Where the hospital mark sits. The note under each test is set per test, under Test setup.')}
        action={
          <button disabled={busy || !settings} className="btn-primary"
            onClick={async () => {
              setBusy(true); setErr(null)
              try { setSettings(await api.saveLabReportSettings(settings)); flash('settings') }
              catch (e: any) { setErr(e.message) } finally { setBusy(false) }
            }}>
            {busy ? tr('Saving…') : saved === 'settings' ? tr('Saved') : tr('Save')}
          </button>
        }>
        {!settings ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('Hospital mark')}
              hint={tr('The logo is uploaded by an administrator under Settings')}>
              <select value={settings.logoPosition}
                onChange={(e) => setSettings({ ...settings, logoPosition: e.target.value })}
                className="field mt-1">
                <option value="right">{tr('Top right')}</option>
                <option value="left">{tr('Top left')}</option>
                <option value="none">{tr('Do not print it')}</option>
              </select>
            </Field>
            <Field label={tr('Fallback note heading')} span
              hint={tr('Used only for a test that has no heading of its own')}>
              <input value={settings.noteHeading}
                onChange={(e) => setSettings({ ...settings, noteHeading: e.target.value })}
                className="field mt-1" />
            </Field>
          </div>
        )}
      </Card>

      <Card title={tr('Who signs the reports')}
        hint={tr('Printed along the foot, left to right, on every report.')}
        action={<>
          <button onClick={() => setSigners([...signers, { name: '' }])}
            className="btn-ghost mr-2 inline-flex items-center gap-1.5">
            <Plus size={14} /> {tr('Add')}
          </button>
          <button disabled={busy} className="btn-primary"
            onClick={async () => {
              setBusy(true); setErr(null)
              try { setSigners(await api.saveLabSignatories(signers)); flash('signers') }
              catch (e: any) { setErr(e.message) } finally { setBusy(false) }
            }}>
            {busy ? tr('Saving…') : saved === 'signers' ? tr('Saved') : tr('Save')}
          </button>
        </>}>

        {signers.length === 0 ? (
          <p className="text-2xs text-muted">
            {tr('Nobody set. Reports fall back to naming whoever took the sample and reported it.')}
          </p>
        ) : (
          <div className="space-y-3">
            {signers.map((s, i) => (
              <div key={i} className="rounded-xl border-2 border-line p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={tr('Name')}>
                    <input value={s.name ?? ''}
                      onChange={(e) => setSigners(signers.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x))}
                      placeholder="Dr Ch Usman Ali" className="field mt-1" />
                  </Field>
                  <Field label={tr('Qualification')}>
                    <input value={s.qualification ?? ''}
                      onChange={(e) => setSigners(signers.map((x, j) =>
                        j === i ? { ...x, qualification: e.target.value } : x))}
                      placeholder="MBBS, MPhil Microbiology" className="field mt-1" />
                  </Field>
                  <Field label={tr('Designation')}>
                    <input value={s.designation ?? ''}
                      onChange={(e) => setSigners(signers.map((x, j) =>
                        j === i ? { ...x, designation: e.target.value } : x))}
                      placeholder="Consultant Pathologist" className="field mt-1" />
                  </Field>
                  <Field label={tr('Registration')}>
                    <input value={s.registration ?? ''}
                      onChange={(e) => setSigners(signers.map((x, j) =>
                        j === i ? { ...x, registration: e.target.value } : x))}
                      placeholder="PMDC 54763-P" className="field mt-1 num" />
                  </Field>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {s.signature
                    ? <img src={s.signature} alt="" className="h-10 w-auto bg-white p-1" />
                    : <span className="text-2xs text-muted">{tr('No signature attached')}</span>}

                  <label className="btn-ghost inline-flex cursor-pointer items-center gap-1.5
                                    px-2 py-1 text-2xs">
                    <Upload size={13} /> {tr('Attach signature')}
                    <input type="file" accept="image/png,image/jpeg" className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) readImage(f, (uri) => setSigners(signers.map((x, j) =>
                          j === i ? { ...x, signature: uri } : x)))
                      }} />
                  </label>

                  {s.signature && (
                    <button onClick={() => setSigners(signers.map((x, j) =>
                      j === i ? { ...x, signature: null } : x))}
                      className="btn-ghost px-2 py-1 text-2xs">{tr('Remove signature')}</button>
                  )}

                  <button onClick={() => setSigners(signers.filter((_, j) => j !== i))}
                    className="btn-ghost ml-auto inline-flex items-center gap-1.5 px-2 py-1
                               text-2xs text-bad">
                    <Trash2 size={13} /> {tr('Remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-3 flex items-start gap-1.5 text-2xs text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          {tr('A scan on white paper, cropped close and saved as PNG, prints best. Four is the most that fits across the foot.')}
        </p>
      </Card>
    </div>
  )
}
