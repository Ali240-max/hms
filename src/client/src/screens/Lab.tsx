import { motion } from 'framer-motion'
import { DUR, EASE } from '../lib/motion'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, rs, type SessionUser } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../components/ui'
import { t as tr } from '../lib/prefs'
import { Sidebar, type NavItem } from '../components/Sidebar'

import { Reports } from './pharma/Reports'
import {
  ClipboardList, FlaskConical, BarChart3, ScanLine, CheckCircle2,
  Clock, AlertTriangle, FileText, ArrowLeft, Save
} from 'lucide-react'

const FILTERS: [string, string][] = [
  ['active', 'On the bench'], ['pending', 'Awaiting sample'],
  ['collected', 'Sample taken'], ['in_progress', 'Running'],
  // Half-filled reports have their own list. They are not finished work and
  // must not sit in the finished pile where they can be printed by mistake.
  ['partial', 'Partly filled'],
  ['resulted', 'Reported'], ['all', 'All']
]

/**
 * The laboratory.
 *
 * No money here at all. A test reaches this screen because a doctor ordered it
 * and the patient paid at the main counter; everything after that is work.
 *
 * The one rule the screen enforces visibly is that an unpaid test cannot be
 * started. The server refuses it too, but showing why on the row saves the
 * technician walking to the counter to ask.
 */
function LabQueue({ me }: { me: SessionUser }) {
  /**
   * Entering results takes over the screen.
   *
   * A dialog was the wrong shape for it: a full panel of a CBC is twenty
   * fields, and typing them inside a box that scrolls independently of the
   * page, over a queue the technician cannot see, made a long job feel
   * cramped. It is its own page, with a way back.
   */
  /**
   * One screen, two departments.
   *
   * The work is the same shape — ordered, paid, performed, reported — so the
   * screen is shared and the server decides which rows each role can see.
   * Only the wording changes, because "sample" means a blood tube in the lab
   * and nothing at all in an x-ray room.
   */
  const isRadiology = me.role === 'radiology'
  const [rows, setRows] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [status, setStatus] = useState('active')
  const [q, setQ] = useState('')
  const [entering, setEntering] = useState<any | null>(null)
  /**
   * The report, as a file.
   *
   * No preview step. A browser with its PDF viewer switched off showed an
   * empty frame, and printing that frame printed the viewer rather than the
   * report. The file itself has neither problem.
   */
  async function downloadReport(g: any) {
    try {
      const path = `/lab/visits/${g.visit_id}/pdf`
      const { ticket } = await api.documentTicket(path)
      const a = document.createElement('a')
      a.href = `/api${path}?download=1&ticket=${encodeURIComponent(ticket)}`
      a.download = `${g.mrn}-lab-report.pdf`
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e: any) { setErr(e.message) }
  }
  const [collecting, setCollecting] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.labQueue({ status, q }).then(setRows).finally(() => setLoading(false))
    api.labStats().then(setStats).catch(() => {})
  }, [status, q])

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => {
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  /**
   * One entry per visit, carrying every test on it.
   *
   * Grouped here rather than in SQL because the queue query already returns
   * one row per test and the lab needs both views — the flat list for search,
   * the grouped list for work.
   */
  const grouped = useMemo(() => {
    const m = new Map<number, any>()
    for (const r of rows) {
      const g = m.get(r.visit_id) ?? { key: r.visit_id, visit_id: r.visit_id, ...r, tests: [] }
      g.tests.push(r)
      m.set(r.visit_id, g)
    }
    return [...m.values()]
  }, [rows])

  async function act(p: Promise<any>) {
    setErr(null)
    try { await p; load() } catch (e: any) { setErr(e.message) }
  }

  if (entering) {
    return (
      isRadiology
        ? <ReportFindings group={entering}
            onBack={() => { setEntering(null); load() }}
            onDone={() => { setEntering(null); load() }} />
        : <EnterResults group={entering} isRadiology={isRadiology}
            onBack={() => { setEntering(null); load() }}
            onDone={() => { setEntering(null); load() }} />
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={isRadiology ? tr('Waiting') : tr('Awaiting sample')}
          value={String(stats?.waiting ?? 0)}
          tone={stats?.waiting ? 'warn' : 'ok'} />
        <Stat label={tr('On the bench')} value={String((stats?.collected ?? 0) + (stats?.in_progress ?? 0))}
          tone="primary" />
        <Stat label={tr('Reported today')} value={String(stats?.resulted_today ?? 0)} tone="ok" />
        <Stat label={tr('Not paid yet')} value={String(stats?.unpaid ?? 0)}
          sub={tr('Cannot be started')} tone={stats?.unpaid ? 'bad' : undefined} />
      </div>

      <Card title={isRadiology ? tr('Radiology') : tr('Laboratory')}
        hint={tr('Ordered by a doctor, paid at the main counter')}
        action={
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Patient, MRN, test or report number')}
            className="field w-72 py-1.5 text-2xs" />
        }>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setStatus(id)}
              className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                status === id ? 'bg-brand text-white'
                              : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
              {tr(label)}
            </button>
          ))}

        </div>

        <ErrorNote>{err}</ErrorNote>

        {loading ? <SkeletonRows rows={6} cols={5} />
          : rows.length === 0 ? <Empty title={tr('Nothing here')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-32">{tr('Report')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Test')}</Th><Th w="w-44">{tr('Stage')}</Th>
                  <Th w="w-56" right />
                </tr>
              </thead>
              {/*
                The whole list fades and lifts when the filter changes.
                Keyed on the filter, so switching between Awaiting sample and
                Reported reads as a new list arriving rather than rows
                silently swapping underneath the cursor.

                One movement for the table, not one per row: a technician
                looking for a patient should see every row at the same moment,
                and a staggered queue puts the one they want last.
              */}
              <motion.tbody key={status}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DUR.page, ease: EASE }}
                className="divide-y divide-divide rows-striped">
                {grouped.map((g) => {
                  /**
                   * One row per patient, not per test.
                   *
                   * A doctor ordering CBC, LFT and RFT is ordering one blood
                   * draw. Three rows with three Take sample buttons invites a
                   * second needle and makes the counts disagree with what
                   * actually happened at the bench.
                   */
                  const r = g.tests[0]
                  const paid = g.tests.some((x: any) =>
                    x.pay_status === 'paid' || x.pay_status === 'completed')
                  const unpaidCount = g.tests.filter((x: any) =>
                    x.pay_status !== 'paid' && x.pay_status !== 'completed').length
                  const waiting = g.tests.filter((x: any) =>
                    x.lab_status === 'pending' &&
                    (x.pay_status === 'paid' || x.pay_status === 'completed'))
                  const onBench = g.tests.filter((x: any) =>
                    ['collected', 'in_progress', 'partial'].includes(x.lab_status))
                  const reported = g.tests.filter((x: any) => x.lab_status === 'resulted')
                  const partial = g.tests.filter((x: any) => x.lab_status === 'partial')
                  return (
                    <tr key={g.key}>
                      <td className="px-3 py-2">
                        <span className="num text-2xs text-primary">
                          {reported[0]?.report_no ?? onBench[0]?.report_no ?? '—'}
                        </span>
                        <span className="block num text-2xs text-muted">
                          {tr('token')} {r.token_no}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{r.patient_name}</span>
                        <span className="block num text-2xs text-muted">
                          {r.mrn}
                          {r.age_years != null && ` · ${r.age_years}y`}
                          {r.gender && ` · ${tr(r.gender)}`}
                        </span>
                        {r.visit_type === 'emergency' && (
                          <Badge tone="bad">{tr('Emergency')}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {/* Every test on the one visit, listed together. */}
                        <ul className="space-y-0.5">
                          {g.tests.map((x: any) => (
                            <li key={x.service_order_id} className="flex items-center gap-1.5">
                              <span className={`text-sm ${
                                x.pay_status === 'paid' || x.pay_status === 'completed'
                                  ? 'text-body' : 'text-muted line-through'}`}>
                                {x.service_name}
                              </span>
                              {x.lab_status === 'resulted' && (
                                <span className="text-2xs text-ok">{tr('done')}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                        <span className="block text-2xs text-muted">
                          {g.tests.length} {g.tests.length === 1 ? tr('test') : tr('tests')}
                          {r.doctor_name && ` · ${r.doctor_name}`}
                          {onBench[0]?.sample_type && ` · ${onBench[0].sample_type}`}
                        </span>
                      </td>
                      {/*
                        A visit can be waiting on one test, part-way through a
                        second and finished with a third, so this cell holds
                        several badges at once. They used to sit on one line
                        and the later ones were clipped by the column. Wrapped,
                        with room to wrap into.
                      */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex flex-wrap items-center gap-1">
                        {waiting.length > 0 && (
                          <Badge>{waiting.length} {tr('to collect')}</Badge>
                        )}
                        {onBench.length > 0 && (
                          <Badge tone="warn">{onBench.length} {tr('on the bench')}</Badge>
                        )}
                        {partial.length > 0 && (
                          <Badge tone="warn">{partial.length} {tr('partly filled')}</Badge>
                        )}
                        {reported.length > 0 && (
                          <Badge tone="ok">{reported.length} {tr('reported')}</Badge>
                        )}
                        {unpaidCount > 0 && (
                          <Badge tone="bad">{unpaidCount} {tr('not paid')}</Badge>
                        )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!paid ? (
                          <span className="text-2xs text-muted">
                            {tr('Send them to the main counter')}
                          </span>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            {/*
                              One button per test, named after the test.
                              Blood for a CBC and blood for an LFT may go into
                              different tubes and may not be drawn at the same
                              moment, so the technician says which is done.
                            */}
                            {waiting.map((x: any) => (
                              <button key={x.service_order_id}
                                onClick={() => setCollecting({ ...g, only: x })}
                                className="btn-primary w-full px-2 py-1 text-2xs">
                                {x.service_name} — {isRadiology ? tr('Begin') : tr('Take sample')}
                              </button>
                            ))}
                            {waiting.length > 0 &&
                              (onBench.length > 0 || reported.length > 0) && (
                              <span className="my-0.5 h-px w-full bg-line" />
                            )}
                            {/*
                              Always offered once anything is on the bench,
                              even if other tests on the visit are still
                              waiting — those simply arrive greyed out.
                            */}
                            {(onBench.length > 0 || reported.length > 0) && (
                              <button onClick={() => setEntering(g)}
                                className={`w-full px-2 py-1 text-2xs ${
                                  onBench.length > 0 ? 'btn-primary' : 'btn-ghost'}`}>
                                {onBench.length > 0 ? tr('Enter results') : tr('Edit results')}
                              </button>
                            )}
                            {/*
                              One document for the whole visit, a page per
                              test. Three tests used to mean three separate
                              downloads, which is three things for a patient
                              to lose on the way to their doctor.
                            */}
                            {reported.length > 0 && (
                              <button
                                onClick={() => downloadReport(g)}
                                className="btn-ghost w-full px-2 py-1 text-2xs">
                                {reported.length > 1
                                  ? `${tr('Report')} (${reported.length} ${tr('tests')})`
                                  : tr('Report')}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </motion.tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-2xs text-muted">
        {tr('Signed in as')} {me.displayName}. {tr('The laboratory takes no payments. A test appears here once it has been paid for at the main counter.')}
      </p>

      {collecting && (
        <CollectSample group={collecting} isRadiology={isRadiology}
          onClose={() => setCollecting(null)}
          onDone={() => { setCollecting(null); load() }} />
      )}

    </div>
  )
}

/* ---------------------------------------------------------------- sample */

const SAMPLES = ['Blood (EDTA)', 'Blood (Plain)', 'Serum', 'Urine', 'Stool', 'Swab', 'Not applicable']
/** What an x-ray room records instead of a sample: which view was taken. */
const VIEWS = ['X-ray', 'PA view', 'AP view', 'Lateral', 'Oblique', 'Ultrasound', 'Portable']

/**
 * Confirming a sample.
 *
 * No dropdown. The technician standing at the bench knows what a CBC is drawn
 * into far better than a list does, and making them pick from one every time
 * added a decision to a step that has none — the answer was always the same
 * for a given test.
 *
 * What the dialog is for instead is saying plainly what else happens: the
 * store is charged for the syringe and the gloves at this moment, because
 * this is when they are used.
 */
function CollectSample({ group, isRadiology, onClose, onDone }: {
  group: any; isRadiology?: boolean; onClose: () => void; onDone: () => void
}) {
  const test = group.only
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [recipe, setRecipe] = useState<any[]>([])

  useEffect(() => {
    api.serviceConsumables(test.service_id).then(setRecipe).catch(() => setRecipe([]))
  }, [test.service_id])

  return (
    <Modal title={isRadiology ? tr('Start this procedure?') : tr('Sample taken?')}
      hint={`${group.patient_name} · ${group.mrn}`} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { await api.collectSample(test.service_order_id, null); onDone() }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Yes, confirm')}
        </button>
      </>}>
      <div className="card-tint p-4 text-center">
        <p className="text-2xs uppercase tracking-wide text-muted">{tr('Test')}</p>
        <p className="text-lg font-semibold text-heading">{test.service_name}</p>
        <p className="num text-2xs text-muted">{tr('token')} {group.token_no}</p>
      </div>

      {recipe.length > 0 && (
        <div className="mt-3 rounded-xl border-2 border-line p-3">
          <p className="text-2xs uppercase tracking-wide text-muted">
            {tr('Comes off the store now')}
          </p>
          <ul className="mt-1 space-y-0.5">
            {recipe.map((c: any) => (
              <li key={c.id} className="flex justify-between text-2xs">
                <span className="text-body">{c.item_name}</span>
                <span className={`num ${c.on_hand < c.qty ? 'text-bad' : 'text-muted'}`}>
                  {c.qty} {c.unit_label}
                  {c.on_hand < c.qty && ` · ${tr('only')} ${c.on_hand} ${tr('on the shelf')}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-2xs text-muted">
        {tr('This records who took it and when. Both print on the report.')}
      </p>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/* --------------------------------------------------------------- results */

/**
 * Results for every test on the visit, in one form.
 *
 * A patient who had CBC, LFT and RFT gave one sample and expects one visit to
 * the bench. Three separate dialogs means three chances to close the wrong
 * one, and a technician re-reading the same analyser printout three times.
 *
 * Each test still saves as its own lab order with its own report, because that
 * is what leaves the building — the grouping is for the person doing the work,
 * not for the record.
 */
/**
 * Entering results, as its own screen.
 *
 * A dialog was the wrong shape. A CBC is twenty fields; typing them inside a
 * box that scrolls separately from the page, on top of a queue the technician
 * cannot see, made a long job feel cramped and made mistakes easy.
 *
 * Tests whose sample has not been taken appear locked rather than hidden, so
 * the whole visit is visible and nobody wonders whether they mis-clicked. What
 * is typed stays typed: a lab is interrupted constantly, and losing twenty
 * values to a phone call is how people go back to paper.
 */
function EnterResults({ group, isRadiology, onBack, onDone }: {
  group: any; isRadiology?: boolean; onBack: () => void; onDone: () => void
}) {
  const [panels, setPanels] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const workable = group.tests.filter((x: any) =>
    x.pay_status === 'paid' || x.pay_status === 'completed')
  const notTaken = workable.filter((x: any) => x.lab_status === 'pending')

  useEffect(() => {
    async function build() {
      const out: any[] = []
      for (const test of workable) {
        const params = await api.serviceParameters(test.service_id)
        const existing = test.lab_order_id
          ? (await api.labReport(test.lab_order_id).catch(() => null))?.values ?? []
          : []
        const byName = new Map(existing.map((e: any) => [String(e.name).toLowerCase(), e]))
        const draft = DRAFTS.get(draftKey(test))

        out.push({
          test,
          locked: test.lab_status === 'pending',
          notes: draft?.notes ?? test.notes ?? '',
          values: params.length === 0
            ? [{ name: test.service_name,
                 value: draft?.values?.[test.service_name]
                   ?? (byName.get(test.service_name.toLowerCase()) as any)?.value ?? '',
                 unit: null, refText: null, freeText: true }]
            : params.map((p: any) => ({
                name: p.name,
                value: draft?.values?.[p.name]
                  ?? (byName.get(String(p.name).toLowerCase()) as any)?.value ?? '',
                unit: p.unit,
                refLow: p.ref_low, refHigh: p.ref_high,
                refText: p.ref_text ?? (p.ref_low != null && p.ref_high != null
                  ? `${trim(p.ref_low)} - ${trim(p.ref_high)}` : null)
              }))
        })
      }
      setPanels(out)
    }
    build().catch((e: any) => setErr(e.message))
  }, [group])

  function flagOf(v: any): string | null {
    if (v.refLow == null || v.refHigh == null) return null
    const n = Number(v.value)
    if (v.value === '' || Number.isNaN(n)) return null
    if (n < Number(v.refLow)) return 'low'
    if (n > Number(v.refHigh)) return 'high'
    return 'normal'
  }

  const open = (panels ?? []).filter((p) => !p.locked)
  const totalFields = open.reduce((n, p) => n + p.values.length, 0)
  const filled = open.reduce((n, p) =>
    n + p.values.filter((v: any) => String(v.value).trim() !== '').length, 0)
  const complete = totalFields > 0 && filled === totalFields
  const abnormal = open.reduce((n, p) =>
    n + p.values.filter((v: any) => ['high', 'low'].includes(flagOf(v) ?? '')).length, 0)

  async function save() {
    setBusy(true); setErr(null)
    const trouble: string[] = []
    try {
      for (const panel of panels ?? []) {
        if (panel.locked) continue
        if (panel.values.every((v: any) => String(v.value).trim() === '')) continue
        let id = panel.test.lab_order_id
        if (!id) {
          const lo = await api.collectSample(panel.test.service_order_id, null)
          id = lo.id
        }
        const r = await api.saveLabResults(id, panel.values.map((v: any) => ({
          name: v.name, value: String(v.value ?? ''), unit: v.unit, refText: v.refText
        })), panel.notes.trim() || null)
        if (r.problems?.length) trouble.push(...r.problems)
        DRAFTS.delete(draftKey(panel.test))
      }
      setSavedAt(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
      if (trouble.length) setProblems(trouble)
      else onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-screen">
      {/* ------------------------------------------------------- header */}
      <header className="anim-in sticky top-0 z-10 border-b-2 border-line bg-card px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="btn-ghost px-3 py-1.5 text-2xs">
              &larr; {tr('Back to the list')}
            </button>
            <div>
              <h2 className="text-base font-semibold text-heading">{group.patient_name}</h2>
              <p className="num text-2xs text-muted">
                {group.mrn}
                {group.age_years != null && ` · ${group.age_years}y`}
                {group.gender && ` · ${tr(group.gender)}`}
                {` · ${tr('token')} ${group.token_no}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-2xs uppercase tracking-wide text-muted">{tr('Filled')}</p>
              <p className="num text-lg font-semibold text-primary">
                {filled}<span className="text-2xs font-normal text-muted">/{totalFields}</span>
              </p>
            </div>
            {abnormal > 0 && (
              <div className="text-right">
                <p className="text-2xs uppercase tracking-wide text-muted">
                  {tr('Out of range')}
                </p>
                <p className="num text-lg font-semibold text-warn">{abnormal}</p>
              </div>
            )}
            <button onClick={save} disabled={busy || filled === 0} className="btn-primary">
              {busy ? tr('Saving…')
                : complete ? tr('Save and finish') : tr('Save what is filled')}
            </button>
          </div>
        </div>

        {/* A bar rather than a number: it is read at a glance, mid-task. */}
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line/40">
          <div className="h-full rounded-full bg-brand transition-all duration-300"
            style={{ width: `${totalFields ? (filled / totalFields) * 100 : 0}%` }} />
        </div>
        {savedAt && (
          <p className="mt-1 text-2xs text-ok">{tr('Saved at')} {savedAt}</p>
        )}
      </header>

      {/* --------------------------------------------------------- body */}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <ErrorNote>{err}</ErrorNote>

        {problems && (
          <div className="anim-in mb-4 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
            <p className="text-2xs font-medium text-warn">
              {tr('The store could not be updated for everything this test uses')}
            </p>
            <ul className="mt-1 space-y-0.5">
              {problems.map((p, i) => <li key={i} className="text-2xs text-warn">{p}</li>)}
            </ul>
            <button onClick={onDone} className="btn-ghost mt-2 text-2xs">{tr('Close')}</button>
          </div>
        )}

        {notTaken.length > 0 && (
          <div className="anim-in mb-5 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
            <p className="text-2xs font-medium text-warn">
              {notTaken.length === 1
                ? tr('One test on this visit has no sample yet')
                : `${notTaken.length} ${tr('tests on this visit have no sample yet')}`}
            </p>
            <p className="mt-0.5 text-2xs text-muted">
              {notTaken.map((x: any) => x.service_name).join(', ')} — {
                tr('shown below but locked. Take the sample first, then come back; anything you type here is kept.')}
            </p>
          </div>
        )}

        {!panels ? <SkeletonRows rows={8} cols={4} />
          : panels.length === 0
            ? <Empty title={tr('Nothing on the bench for this patient')} />
            : (
          <div className="space-y-5">
            {panels.map((panel, pi) => (
              <Card key={panel.test.service_order_id}
                className={panel.locked ? 'opacity-60' : ''}
                title={panel.test.service_name}
                hint={panel.locked
                  ? tr('Sample not taken — take it from the list, then come back')
                  : `${panel.test.report_no ?? tr('new')} · ${
                      panel.values.filter((v: any) => String(v.value).trim() !== '').length}/${
                      panel.values.length} ${tr('filled')}`}
                action={panel.locked
                  ? <span className="rounded-lg border-2 border-warn/50 bg-warn/10 px-2 py-1
                                     text-2xs text-warn">{tr('locked')}</span>
                  : undefined}>

                {panel.values[0]?.freeText && !panel.locked && (
                  <p className="mb-2 text-2xs text-muted">
                    {tr('No panel set up for this test, so write the finding in full. An administrator can add reference ranges under Services.')}
                  </p>
                )}

                <table className="w-full">
                  <thead className="thead-strip">
                    <tr>
                      <Th>{tr('Test')}</Th><Th w="w-44">{tr('Result')}</Th>
                      <Th w="w-24">{tr('Unit')}</Th><Th w="w-44">{tr('Reference')}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divide">
                    {panel.values.map((v: any, i: number) => {
                      const flag = flagOf(v)
                      return (
                        <tr key={v.name}
                          className={`transition-colors ${
                            flag === 'high' || flag === 'low' ? 'bg-warn/5' : ''}`}>
                          <td className="px-3 py-1.5 text-sm text-heading">{v.name}</td>
                          <td className="px-2 py-1.5">
                            <input value={v.value} disabled={panel.locked}
                              onChange={(e) => setPanels((ps) => {
                                const next = ps!.map((p, j) =>
                                  j === pi
                                    ? { ...p, values: p.values.map((x: any, k: number) =>
                                        k === i ? { ...x, value: e.target.value } : x) }
                                    : p)
                                remember(next[pi])
                                return next
                              })}
                              className={`field num py-1.5 text-right text-sm ${
                                flag === 'high' || flag === 'low'
                                  ? 'border-warn font-medium text-warn' : ''}`} />
                          </td>
                          <td className="px-2 py-1.5 text-2xs text-muted">{v.unit || '—'}</td>
                          <td className="px-2 py-1.5">
                            <span className="num text-2xs text-muted">{v.refText || '—'}</span>
                            {(flag === 'high' || flag === 'low') && (
                              <span className="ml-1 rounded px-1 text-2xs font-medium text-warn">
                                {flag === 'high' ? tr('high') : tr('low')}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <input value={panel.notes} disabled={panel.locked}
                  onChange={(e) => setPanels((ps) => {
                    const next = ps!.map((p, j) =>
                      j === pi ? { ...p, notes: e.target.value } : p)
                    remember(next[pi])
                    return next
                  })}
                  placeholder={tr('Comment on this test, printed under its results')}
                  className="field mt-3 text-2xs" />
              </Card>
            ))}
          </div>
        )}

        <p className="mt-5 text-2xs text-muted">
          {tr('Each test saves as its own report. Once every field is filled, the whole visit prints as one document with a page per test.')}
        </p>
      </div>
    </div>
  )
}


/**
 * Half-typed panels, kept outside React.
 *
 * The dialog unmounts when it closes, so component state cannot hold this.
 * Keyed by service order because a lab order may not exist yet for a test
 * whose sample was taken a moment ago. Cleared once the panel is saved.
 */
const DRAFTS = new Map<string, { values: Record<string, string>; notes: string }>()

const draftKey = (test: any) => `so:${test.service_order_id}`

function remember(panel: any) {
  if (!panel || panel.locked) return
  const values: Record<string, string> = {}
  for (const v of panel.values) values[v.name] = String(v.value ?? '')
  DRAFTS.set(draftKey(panel.test), { values, notes: panel.notes ?? '' })
}

/** 12.000 reads badly on a report; 12 does not. */
function trim(v: any) {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : String(v)
}

/* ---------------------------------------------------------------- shell */

/**
 * The laboratory, and the x-ray room, which run the same screens.
 *
 * A rail rather than tabs, the same as everywhere else. The work list is what
 * the department opens on; reports are what the in-charge opens at the end of
 * a day, and putting them behind a second click keeps the bench screen clear.
 */
export function Lab({ me }: { me: SessionUser }) {
  const isRadiology = me.role === 'radiology'
  const [tab, setTab] = useState<'queue' | 'reports'>('queue')

  const items: NavItem[] = [
    { id: 'queue', label: isRadiology ? 'Imaging list' : 'Work list',
      glyph: isRadiology ? 'X' : 'L', icon: isRadiology ? ScanLine : FlaskConical },
    { id: 'reports', label: 'Reports', glyph: 'R', icon: BarChart3 }
  ]

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={items} active={tab} onSelect={(id) => setTab(id as any)}
        title={isRadiology ? 'Radiology' : 'Laboratory'} subtitle={me.displayName} />
      <div className="min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'queue' ? <LabQueue me={me} /> : <Reports me={me} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------- radiology report */

/**
 * Reporting a scan.
 *
 * A radiology report has no rows, no units and no reference ranges. Forcing
 * it through the laboratory screen gave a radiographer one field called
 * "X-Ray Chest PA" with a dash where the unit should be and another dash for
 * the range, which is three columns of nothing around a box.
 *
 * What a scan actually produces is prose in a fixed order, the way it is
 * dictated: how it was taken, what can be seen, and what that means. Written
 * separately because a referring doctor reads the impression first and the
 * findings only if the impression surprises them.
 *
 * Findings alone is enough to finish a report. Technique is optional, and an
 * impression is expected but not demanded: a technologist describing an
 * unremarkable film should not be blocked because a radiologist has not yet
 * written the conclusion.
 */
function ReportFindings({ group, onBack, onDone }: {
  group: any; onBack: () => void; onDone: () => void
}) {
  const [panels, setPanels] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const workable = group.tests.filter((x: any) =>
    x.pay_status === 'paid' || x.pay_status === 'completed')
  const notTaken = workable.filter((x: any) => x.lab_status === 'pending')

  useEffect(() => {
    async function build() {
      const out: any[] = []
      for (const test of workable) {
        const existing = test.lab_order_id
          ? (await api.labReport(test.lab_order_id).catch(() => null))?.values ?? []
          : []
        const find = (name: string) =>
          existing.find((e: any) => String(e.name).toLowerCase() === name)?.value ?? ''
        const draft = DRAFTS.get(draftKey(test))
        out.push({
          test,
          locked: test.lab_status === 'pending',
          technique: draft?.values?.Technique ?? find('technique'),
          findings: draft?.values?.Findings ?? find('findings'),
          impression: draft?.values?.Impression ?? find('impression'),
          notes: draft?.notes ?? test.notes ?? ''
        })
      }
      setPanels(out)
    }
    build().catch((e: any) => setErr(e.message))
  }, [group])

  function edit(i: number, field: string, value: string) {
    setPanels((ps) => {
      const next = ps!.map((p, j) => (j === i ? { ...p, [field]: value } : p))
      const panel = next[i]
      // Kept outside React so a half-dictated report survives the phone ringing.
      DRAFTS.set(draftKey(panel.test), {
        values: {
          Technique: panel.technique, Findings: panel.findings, Impression: panel.impression
        },
        notes: panel.notes ?? ''
      })
      return next
    })
  }

  const ready = (panels ?? []).some((p) => !p.locked && p.findings.trim())

  async function save() {
    setBusy(true); setErr(null)
    try {
      for (const panel of panels ?? []) {
        if (panel.locked || !panel.findings.trim()) continue
        let id = panel.test.lab_order_id
        if (!id) id = (await api.collectSample(panel.test.service_order_id, null)).id

        /*
         * Written as three named lines rather than free text in one blob, so
         * the printed report can lay them out with headings and a later
         * search can look inside findings specifically.
         */
        const values = [
          { name: 'Technique', value: panel.technique.trim() },
          { name: 'Findings', value: panel.findings.trim() },
          { name: 'Impression', value: panel.impression.trim() }
        ].filter((v) => v.value !== '')

        await api.saveLabResults(id, values, panel.notes.trim() || null)
        DRAFTS.delete(draftKey(panel.test))
      }
      setSavedAt(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-screen">
      <header className="sticky top-0 z-10 border-b-2 border-line bg-card px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="btn-ghost px-3 py-1.5 text-2xs">
              &larr; {tr('Back to the list')}
            </button>
            <div>
              <h2 className="text-base font-semibold text-heading">{group.patient_name}</h2>
              <p className="num text-2xs text-muted">
                {group.mrn}
                {group.age_years != null && ` · ${group.age_years}y`}
                {group.gender && ` · ${tr(group.gender)}`}
              </p>
            </div>
          </div>
          <button onClick={save} disabled={busy || !ready} className="btn-primary">
            {busy ? tr('Saving…') : tr('Save report')}
          </button>
        </div>
        {savedAt && <p className="mt-1 text-2xs text-ok">{tr('Saved at')} {savedAt}</p>}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <ErrorNote>{err}</ErrorNote>

        {notTaken.length > 0 && (
          <div className="mb-4 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
            <p className="text-2xs text-warn">
              {notTaken.map((x: any) => x.service_name).join(', ')} — {
                tr('not started yet. Begin the procedure from the list first.')}
            </p>
          </div>
        )}

        {!panels ? <SkeletonRows rows={4} cols={1} /> : (
          <div className="space-y-5">
            {panels.map((panel, i) => (
              <Card key={panel.test.service_order_id}
                className={panel.locked ? 'opacity-60' : ''}
                title={panel.test.service_name}
                hint={panel.locked ? tr('Not started yet')
                  : `${panel.test.report_no ?? tr('new')}${
                      panel.test.collected_by ? ` · ${panel.test.collected_by}` : ''}`}>

                <Field label={tr('Technique')} hint={tr('Optional. Views taken, contrast, position.')} span>
                  <input value={panel.technique} disabled={panel.locked}
                    onChange={(e) => edit(i, 'technique', e.target.value)}
                    placeholder={tr('e.g. PA view, erect')}
                    className="field mt-1 text-sm" />
                </Field>

                <Field label={tr('Findings')} hint={tr('What is on the film. This is the report.')} span>
                  <textarea value={panel.findings} disabled={panel.locked} rows={7}
                    onChange={(e) => edit(i, 'findings', e.target.value)}
                    placeholder={tr('Describe what is seen, in the order you would dictate it.')}
                    className="field mt-1 resize-y text-sm leading-relaxed" />
                </Field>

                <Field label={tr('Impression')}
                  hint={tr('The conclusion. A referring doctor reads this first.')} span>
                  <textarea value={panel.impression} disabled={panel.locked} rows={3}
                    onChange={(e) => edit(i, 'impression', e.target.value)}
                    placeholder={tr('e.g. No active pulmonary disease.')}
                    className="field mt-1 resize-y text-sm leading-relaxed" />
                </Field>

                <input value={panel.notes} disabled={panel.locked}
                  onChange={(e) => edit(i, 'notes', e.target.value)}
                  placeholder={tr('Comment printed under the report')}
                  className="field mt-3 text-2xs" />
              </Card>
            ))}
          </div>
        )}

        <p className="mt-5 text-2xs text-muted">
          {tr('Findings are enough to finish a report. Anything you type is kept if you go back.')}
        </p>
      </div>
    </div>
  )
}
