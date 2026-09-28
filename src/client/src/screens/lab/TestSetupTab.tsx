import { useCallback, useEffect, useState } from 'react'
import { Search, Sliders, AlertTriangle, ListOrdered, Plus, Trash2 } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Th } from '../../components/ui'
import { TestSetup } from '../Admin'
import { t as tr } from '../../lib/prefs'

/**
 * Reference ranges, set by the people who run the tests.
 *
 * An administrator decides what a test is called and what it costs. What it
 * reports, in what units and against which ranges, belongs here: the
 * laboratory knows what its own analyser produces, and a range that has to go
 * through an administrator stays wrong until somebody gets round to it.
 *
 * The same dialog the administrator has, in the department that uses it, so
 * there is no second implementation to drift out of step.
 */
export function TestSetupTab({ me }: { me: SessionUser }) {
  const isRadiology = me.role === 'radiology'
  const [rows, setRows] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<any | null>(null)
  const [bands, setBands] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.services(true)
      .then((all: any[]) => setRows(all.filter((s) =>
        s.category === (isRadiology ? 'radiology' : 'lab'))))
      .catch((e: any) => setErr(e.message))
  }, [isRadiology])
  useEffect(() => { load() }, [load])

  const shown = (rows ?? []).filter((s) =>
    !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()))
  const bare = (rows ?? []).filter((s) => s.is_active && !s.parameter_count)

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Test setup')}
        hint={tr('What each test reports, in what units, against which ranges. Names and prices are set by an administrator.')}>
        <ErrorNote>{err}</ErrorNote>

        {bare.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-warn/40
                          bg-warn/5 p-3">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-2xs text-warn">
              {bare.length} {tr('have no parameters yet.')}{' '}
              <span className="text-muted">
                {tr('Results for those are typed as one free-text finding until ranges are added.')}
              </span>
            </p>
          </div>
        )}

        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search tests')} className="field pl-9" />
        </div>

        {!rows ? <SkeletonRows rows={6} cols={3} />
          : shown.length === 0 ? <Empty title={tr('Nothing matches that')} /> : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Test')}</Th><Th w="w-32" right>{tr('Parameters')}</Th>
                <Th w="w-32" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped">
              {shown.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{s.name}</span>
                    {!s.is_active && <Badge>{tr('hidden')}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s.parameter_count
                      ? <span className="num text-2xs text-primary">{s.parameter_count}</span>
                      : <Badge tone="warn">{tr('none')}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(s)}
                      className="btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-2xs">
                      <Sliders size={13} /> {tr('Ranges')}
                    </button>
                    {/*
                      The bands printed under the result: deficiency,
                      sufficiency, desirable. Separate from the reference
                      ranges because they describe what a figure means rather
                      than what counts as normal, and a test can have one
                      without the other.
                    */}
                    <button onClick={() => setBands(s)}
                      className="ml-1 btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-2xs">
                      <ListOrdered size={13} /> {tr('Interpretation')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && <TestSetup service={editing} onClose={() => { setEditing(null); load() }} />}
      {bands && <Interpretations service={bands} onClose={() => setBands(null)} />}
    </div>
  )
}

/* ----------------------------------------------- what the figure means */

/**
 * The interpretation bands printed under a result.
 *
 *   Vitamin D Deficiency    < 20 ng/ml
 *   Vitamin D Sufficiency   21 - 30 ng/ml
 *
 * Kept apart from the reference ranges because they answer a different
 * question. A range says what counts as normal and drives the high and low
 * arrows; these say what a figure means, are printed as prose under the
 * table, and a test can perfectly well have one without the other.
 *
 * The range is free text on purpose. A laboratory writes "Adults: 30 - 115"
 * and "Upto 15 Years: < 345" on the same report, and a pair of number boxes
 * would lose both.
 */
function Interpretations({ service, onClose }: { service: any; onClose: () => void }) {
  const [rows, setRows] = useState<{ title: string; rangeText: string }[] | null>(null)
  const [note, setNote] = useState<{ noteHeading: string; noteText: string }>(
    { noteHeading: '', noteText: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.interpretations(service.id)
      .then((r: any[]) => setRows(r.map((x) => ({ title: x.title, rangeText: x.range_text }))))
      .catch((e: any) => setErr(e.message))
    api.reportNote(service.id)
      .then((n: any) => setNote({ noteHeading: n.noteHeading ?? '', noteText: n.noteText ?? '' }))
      .catch(() => {})
  }, [service.id])

  const set = (i: number, field: string, value: string) =>
    setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, [field]: value } : r)))

  return (
    <Modal title={`${tr('Interpretation')} — ${service.name}`} wide onClose={onClose}
      hint={tr('Printed under the result, as written here')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !rows} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.saveInterpretations(service.id, rows ?? [])
              await api.saveReportNote(service.id, note)
              onClose()
            }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {!rows ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <>
          <table className="w-full">
            <thead className="thead-strip">
              <tr><Th>{tr('Title')}</Th><Th>{tr('Range')}</Th><Th w="w-16" right /></tr>
            </thead>
            <tbody className="divide-y divide-divide">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <input value={r.title} onChange={(e) => set(i, 'title', e.target.value)}
                      placeholder="Vitamin D Deficiency" className="field py-1 text-sm" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input value={r.rangeText} onChange={(e) => set(i, 'rangeText', e.target.value)}
                      placeholder="< 20 ng/ml" className="field py-1 text-sm" />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      className="btn-ghost px-2 py-1 text-2xs text-bad">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button onClick={() => setRows([...rows, { title: '', rangeText: '' }])}
            className="btn-ghost mt-3 inline-flex items-center gap-1.5 text-2xs">
            <Plus size={14} /> {tr('Add a band')}
          </button>

          {rows.length === 0 && (
            <p className="mt-3 text-2xs text-muted">
              {tr('Nothing set, so nothing is printed under this test. Most tests need none; the ones that do are vitamins, hormones and anything reported against bands rather than a single range.')}
            </p>
          )}

          {/*
            The note that goes under this test, worded per test.
            It was one setting for the whole hospital, which is wrong: a
            Vitamin D report ends with a line about seasonal variation and a
            CBC with one about slide review, so a single note was right for
            neither.
          */}
          <div className="mt-6 border-t-2 border-line pt-4">
            <p className="label">{tr('Note printed under this test')}</p>

            <div className="mt-2 grid gap-3 sm:grid-cols-[200px_1fr]">
              <Field label={tr('Heading')} hint={tr('Left blank it prints "Note"')}>
                <input value={note.noteHeading}
                  onChange={(e) => setNote({ ...note, noteHeading: e.target.value })}
                  placeholder="NOTE" className="field mt-1" />
              </Field>
              <Field label={tr('Text')}
                hint={tr('Printed on every report for this test, above anything the technician types')}>
                <textarea rows={4} value={note.noteText}
                  onChange={(e) => setNote({ ...note, noteText: e.target.value })}
                  placeholder={tr('e.g. Test performed on Getein 1100 immunofluorescence quantitative analyzer.')}
                  className="field mt-1 resize-y text-sm leading-relaxed" />
              </Field>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
