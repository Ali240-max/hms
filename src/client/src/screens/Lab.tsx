import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, rs, openDocument, type SessionUser } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../components/ui'
import { t as tr } from '../lib/prefs'

const FILTERS: [string, string][] = [
  ['active', 'On the bench'], ['pending', 'Awaiting sample'],
  ['collected', 'Sample taken'], ['in_progress', 'Running'],
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
export function Lab({ me }: { me: SessionUser }) {
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
  const [category, setCategory] = useState('all')
  const [q, setQ] = useState('')
  const [entering, setEntering] = useState<any | null>(null)
  const [collecting, setCollecting] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.labQueue({ status, category, q }).then(setRows).finally(() => setLoading(false))
    api.labStats().then(setStats).catch(() => {})
  }, [status, category, q])

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
          {/* A radiographer has only one category, so the filter is noise. */}
          {!isRadiology && (
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="field ml-auto w-40 py-1.5 text-2xs">
              <option value="all">{tr('All departments')}</option>
              <option value="lab">{tr('Laboratory')}</option>
              <option value="procedure">{tr('Procedures')}</option>
            </select>
          )}
        </div>

        <ErrorNote>{err}</ErrorNote>

        {loading ? <SkeletonRows rows={6} cols={5} />
          : rows.length === 0 ? <Empty title={tr('Nothing here')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-32">{tr('Report')}</Th><Th>{tr('Patient')}</Th>
                  <Th>{tr('Test')}</Th><Th w="w-28">{tr('Stage')}</Th>
                  <Th w="w-56" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
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
                    x.lab_status === 'collected' || x.lab_status === 'in_progress')
                  const reported = g.tests.filter((x: any) => x.lab_status === 'resulted')
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
                      <td className="px-3 py-2">
                        {waiting.length > 0 && (
                          <Badge>{waiting.length} {tr('to collect')}</Badge>
                        )}
                        {onBench.length > 0 && (
                          <Badge tone="warn">{onBench.length} {tr('on the bench')}</Badge>
                        )}
                        {reported.length > 0 && (
                          <Badge tone="ok">{reported.length} {tr('reported')}</Badge>
                        )}
                        {unpaidCount > 0 && (
                          <Badge tone="bad">{unpaidCount} {tr('not paid')}</Badge>
                        )}
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
                            {reported.map((x: any) => (
                              <button key={x.service_order_id}
                                onClick={() => openDocument(`/lab/orders/${x.lab_order_id}/pdf`)
                                  .catch((e: any) => setErr(e.message))}
                                className="btn-ghost px-2 py-1 text-2xs"
                                title={x.service_name}>
                                {reported.length > 1
                                  ? x.service_name.slice(0, 10) : tr('Report')}
                              </button>
                            ))}
                            {/*
                              The second signature. Checking a result before it
                              is handed over is the point of it, and one press
                              covers every report on the visit.
                            */}
                            {reported.some((x: any) => !x.verified_at) && (
                              <button
                                onClick={() => act(Promise.all(
                                  reported.filter((x: any) => !x.verified_at)
                                    .map((x: any) => api.verifyResult(x.lab_order_id))))}
                                className="btn-primary px-2 py-1 text-2xs">
                                {tr('Verify')}
                              </button>
                            )}
                          </div>
                        )}
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
        {tr('Signed in as')} {me.displayName}. {tr('The laboratory takes no payments. A test appears here once it has been paid for at the main counter.')}
      </p>

      {collecting && (
        <CollectSample group={collecting} isRadiology={isRadiology}
          onClose={() => setCollecting(null)}
          onDone={() => { setCollecting(null); load() }} />
      )}
      {entering && (
        <EnterResults group={entering} onClose={() => setEntering(null)}
          onDone={() => { setEntering(null); load() }} />
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
 * Results for every test on the visit, in one place.
 *
 * Tests whose sample has not been taken are shown greyed out rather than
 * hidden: the technician can see the whole visit, type what they have, and
 * come back for the rest. What is typed stays typed — a half-finished panel
 * survives closing the screen, because a lab is interrupted constantly and
 * losing twenty typed values to a phone call is how people stop trusting the
 * system and go back to paper.
 */
function EnterResults({ group, onClose, onDone }: {
  group: any; onClose: () => void; onDone: () => void
}) {
  const [panels, setPanels] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)

  /**
   * Everything paid for on this visit, whether its sample is taken or not.
   *
   * The untaken ones are shown locked rather than left out, so the technician
   * can see the whole visit at once and knows what is still outstanding
   * instead of wondering whether they mis-clicked.
   */
  const workable = group.tests.filter((x: any) =>
    x.pay_status === 'paid' || x.pay_status === 'completed')
  const notTaken = workable.filter((x: any) => x.lab_status === 'pending')

  /**
   * Typed values survive closing the screen.
   *
   * Held in a module-level map keyed by lab order rather than in this
   * component, because the component unmounts the moment the dialog closes. A
   * lab is interrupted constantly; losing a half-typed panel to a phone call
   * is how people go back to writing on paper.
   */
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
          /*
           * No parameters configured means the test has no panel yet — common
           * for radiology and for any service added by hand. One free-text
           * finding is the right shape there, and the setup screen can add a
           * proper panel later.
           */
          values: params.length === 0
            ? [{ name: test.service_name, value:
                  draft?.values?.[test.service_name]
                    ?? (byName.get(test.service_name.toLowerCase()) as any)?.value ?? '',
                unit: null, refText: null, freeText: true }]
            : params.map((p: any) => ({
                name: p.name,
                value: draft?.values?.[p.name]
                  ?? (byName.get(String(p.name).toLowerCase()) as any)?.value ?? '',
                unit: p.unit,
                refLow: p.ref_low, refHigh: p.ref_high,
                refText: p.ref_text ?? (p.ref_low != null && p.ref_high != null
                  ? `${trim(p.ref_low)} – ${trim(p.ref_high)}` : null)
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

  const filled = (panels ?? []).reduce((n, p) =>
    n + (p.locked ? 0 : p.values.filter((v: any) => String(v.value).trim() !== '').length), 0)

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
      if (trouble.length) setProblems(trouble)
      else onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (problems) {
    return (
      <Modal title={tr('Results saved')} onClose={onDone}
        footer={<button onClick={onDone} className="btn-primary">{tr('Close')}</button>}>
        <p className="text-sm text-body">{tr('The report is ready to print.')}</p>
        <div className="mt-3 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
          <p className="text-2xs font-medium text-warn">
            {tr('The store could not be updated for everything this test uses')}
          </p>
          <ul className="mt-1 space-y-0.5">
            {problems.map((p, i) => <li key={i} className="text-2xs text-warn">{p}</li>)}
          </ul>
          <p className="mt-1 text-2xs text-muted">
            {tr('The test itself is unaffected. Tell the store so a count can put it right.')}
          </p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={tr('Enter results')}
      hint={`${group.patient_name} · ${group.mrn}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || filled === 0} className="btn-primary">
          {busy ? tr('Saving…') : `${tr('Save results')}${
            (panels?.length ?? 0) > 1 ? ` (${panels?.length})` : ''}`}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {notTaken.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
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

      {!panels ? <p className="text-2xs text-muted">{tr('Loading…')}</p>
        : panels.length === 0 ? <Empty title={tr('Nothing on the bench for this patient')} /> : (
        <div className="space-y-6">
          {panels.map((panel, pi) => (
            <section key={panel.test.service_order_id}
              className={panel.locked ? 'opacity-55' : ''}>
              <div className="flex items-baseline justify-between border-b-2 border-line pb-1.5">
                <h3 className="text-sm font-medium text-heading">
                  {panel.test.service_name}
                  {panel.locked && (
                    <span className="ml-2 rounded-lg border-2 border-warn/50 bg-warn/10 px-1.5
                                     py-0.5 text-2xs font-normal text-warn">
                      {tr('sample not taken')}
                    </span>
                  )}
                </h3>
                <span className="num text-2xs text-muted">
                  {panel.test.report_no ?? tr('new')}
                </span>
              </div>

              {panel.values[0]?.freeText && (
                <p className="mt-2 text-2xs text-muted">
                  {tr('No panel set up for this test, so write the finding in full. An administrator can add reference ranges under Services.')}
                </p>
              )}

              <table className="mt-2 w-full">
                <thead className="thead-strip">
                  <tr>
                    <Th>{tr('Test')}</Th><Th w="w-40">{tr('Result')}</Th>
                    <Th w="w-24">{tr('Unit')}</Th><Th w="w-40">{tr('Reference')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide">
                  {panel.values.map((v: any, i: number) => {
                    const flag = flagOf(v)
                    return (
                      <tr key={v.name}>
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
                            className={`field num py-1 text-right text-sm ${
                              flag === 'high' || flag === 'low' ? 'border-warn text-warn' : ''}`} />
                        </td>
                        <td className="px-2 py-1.5 text-2xs text-muted">{v.unit || '—'}</td>
                        <td className="px-2 py-1.5">
                          <span className="num text-2xs text-muted">{v.refText || '—'}</span>
                          {(flag === 'high' || flag === 'low') && (
                            <span className="ml-1 text-2xs font-medium text-warn">
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
                className="field mt-2 text-2xs" />
            </section>
          ))}
        </div>
      )}

      <p className="mt-4 text-2xs text-muted">
        {tr('Each test saves as its own report. Saving takes what they use off the store.')}
      </p>
    </Modal>
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
