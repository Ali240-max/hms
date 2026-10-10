import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ClipboardList, Plus, Printer, Search, Trash2, AlertTriangle, Scale, X
} from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import {
  Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Stat, Tabs, Th
} from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Stock audits.
 *
 * An audit is a count sheet: what the system thinks is on the shelf, printed
 * with blank columns for somebody to walk the racks with a pen. It changes
 * nothing. Typing the numbers back in is a separate, deliberate act, and that
 * one is recorded forever.
 */

const today = () => new Date().toISOString().slice(0, 10)
const monthAgo = () => {
  const d = new Date(); d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export function Audits({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState('sheets')
  const [counting, setCounting] = useState<number | null>(null)

  if (counting) {
    return <CountBack auditId={counting} onClose={() => setCounting(null)} />
  }

  return (
    <div className="space-y-4 p-4">
      <Tabs id="audit-tabs" value={tab} onChange={setTab} className="w-fit"
        tabs={[
          { value: 'sheets', label: tr('Count sheets'), icon: ClipboardList },
          { value: 'adjustments', label: tr('Adjustments'), icon: Scale }
        ]} />
      {tab === 'sheets'
        ? <Sheets onCount={setCounting} />
        : <Adjustments />}
    </div>
  )
}

/* -------------------------------------------------------- count sheets */

function Sheets({ onCount }: { onCount: (id: number) => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [making, setMaking] = useState(false)
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.audits(q).then(setRows).catch((e: any) => setErr(e.message))
  }, [q])
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) },
    [load, q])

  function print(a: any) {
    const path = `/pharma/audits/${a.id}/pdf`
    api.documentTicket(path).then(({ ticket }: any) => {
      window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank')
    }).catch((e: any) => setErr(e.message))
  }

  return (
    <Card title={tr('Count sheets')}
      hint={tr('Print a sheet, count the shelf, then type the numbers back in.')}
      action={<button onClick={() => setMaking(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('New count sheet')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>

      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={tr('Audit number, company or rack')} className="field pl-9" />
      </div>

      {!rows ? <SkeletonRows rows={5} cols={5} />
        : rows.length === 0 ? (
          <Empty title={tr('No count sheets yet')}
            hint={tr('A sheet lists what the system thinks is on the shelf, with blank columns to write what is really there.')} />
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th w="w-32">{tr('Audit')}</Th><Th>{tr('What it covers')}</Th>
                <Th w="w-20" right>{tr('Lines')}</Th>
                <Th w="w-28">{tr('Status')}</Th><Th w="w-44" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped">
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">
                    <span className="num text-2xs text-primary">{a.audit_no}</span>
                    <span className="block num text-2xs text-muted">
                      {new Date(a.created_at).toLocaleString('en-GB',
                        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">
                      {a.scope === 'manufacturer' ? a.scope_ref
                        : a.scope === 'rack' ? `${tr('Rack')} ${a.scope_ref}`
                        : a.title || tr('Chosen medicines')}
                    </span>
                    <span className="block text-2xs text-muted">
                      {tr('by')} {a.created_by}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs">{a.lines}</td>
                  <td className="px-3 py-2">
                    <Badge tone={a.status === 'open' ? 'warn'
                      : a.status === 'counted' ? 'ok' : 'muted'}>
                      {tr(a.status === 'open' ? 'Out for counting'
                        : a.status === 'counted' ? 'Counted' : 'Closed')}
                    </Badge>
                    {Number(a.adjustments) > 0 && (
                      <span className="block text-2xs text-muted">
                        {a.adjustments} {tr('adjustment(s)')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => print(a)}
                      className="btn-ghost px-2 py-1 text-2xs">
                      <Printer size={13} className="mr-1 inline" />{tr('Print')}
                    </button>
                    {a.status !== 'closed' && (
                      <button onClick={() => onCount(a.id)}
                        className="ml-1 btn-primary px-2 py-1 text-2xs">
                        {tr('Enter counts')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {making && <NewSheet onClose={() => setMaking(false)}
        onDone={(a: any) => { setMaking(false); load(); print(a) }} />}
    </Card>
  )
}

/* ----------------------------------------------------- building a sheet */

function NewSheet({ onClose, onDone }: {
  onClose: () => void; onDone: (a: any) => void
}) {
  const [scope, setScope] = useState<'product' | 'manufacturer' | 'rack'>('product')
  const [ref, setRef] = useState('')
  const [picked, setPicked] = useState<any[]>([])
  const [preview, setPreview] = useState<any[] | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /* ------------------------------------------- picking medicines by name */
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<any[]>([])
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => { box.current?.focus() }, [scope])
  useEffect(() => {
    if (scope !== 'product' || q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      api.productSearch(q.trim()).then(setHits).catch(() => {})
    }, 200)
    return () => clearTimeout(t)
  }, [q, scope])

  function add(p: any) {
    /*
     * Added once. Scanning the same box twice while building a sheet is
     * ordinary, and two identical lines on a count sheet means somebody
     * counts it twice and writes two different numbers.
     */
    setPicked((old) => old.some((x) => x.id === p.id) ? old : [...old, p])
    setQ(''); setHits([])
    box.current?.focus()
  }

  async function look() {
    setErr(null)
    try {
      setPreview(await api.previewAuditScope({ scope, ref: ref.trim() || null }))
    } catch (e: any) { setErr(e.message) }
  }

  async function save() {
    setBusy(true); setErr(null)
    try {
      onDone(await api.createAudit({
        scope,
        ref: scope === 'product' ? null : ref.trim(),
        productIds: scope === 'product' ? picked.map((p) => p.id) : undefined,
        title: title.trim() || null
      }))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const count = scope === 'product' ? picked.length : (preview?.length ?? 0)

  return (
    <Modal title={tr('New count sheet')} wide onClose={onClose}
      hint={tr('Nothing here changes stock. It only decides what gets printed.')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || count === 0} className="btn-primary">
          {busy ? tr('Saving…') : `${tr('Save and print')} (${count})`}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      <div className="mb-3 flex flex-wrap gap-2">
        {([['product', tr('Pick medicines')],
           ['manufacturer', tr('A whole company')],
           ['rack', tr('A rack')]] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setScope(id); setPreview(null) }}
            className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
              scope === id ? 'bg-brand text-white'
                : 'border-2 border-line bg-card text-body hover:bg-raised'}`}>
            {label}
          </button>
        ))}
      </div>

      {scope === 'product' ? (
        <>
          {/*
            Typed like the billing screen, because that is the screen whoever
            builds this sheet uses all day. Same box, same behaviour, nothing
            new to learn.
          */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input ref={box} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Type a medicine name and press it to add')}
              className="field pl-9" />
            {hits.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl
                             border-2 border-line bg-card shadow-lift">
                {hits.slice(0, 8).map((p) => (
                  <li key={p.id}>
                    <button onClick={() => add(p)}
                      className="flex w-full items-center justify-between px-3 py-2
                                 text-left text-sm hover:bg-raised">
                      <span>{p.name}</span>
                      <span className="num text-2xs text-muted">
                        {p.on_hand ?? p.qty ?? ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {picked.length > 0 && (
            <ul className="mt-3 max-h-64 divide-y divide-divide overflow-auto
                           rounded-xl border-2 border-line">
              {picked.map((p, i) => (
                <li key={p.id} className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm text-heading">
                    <span className="num mr-2 text-2xs text-muted">{i + 1}</span>
                    {p.name}
                  </span>
                  <button onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                    className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <input value={ref} onChange={(e) => setRef(e.target.value)}
              placeholder={scope === 'manufacturer'
                ? tr('Company name, e.g. Getz Pharma') : tr('Rack, e.g. A')}
              className="field" />
            <button onClick={look} disabled={!ref.trim()} className="btn-ghost shrink-0">
              {tr('Look')}
            </button>
          </div>
          {scope === 'rack' && (
            <p className="mt-1 text-2xs text-muted">
              {tr('Rack A finds A, A-1 and A3 — whatever starts with it.')}
            </p>
          )}

          {preview && (
            preview.length === 0 ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl border-2
                              border-warn/40 bg-warn/5 p-3">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
                <p className="text-2xs text-warn">{tr('Nothing matches that.')}</p>
              </div>
            ) : (
              <ul className="mt-3 max-h-64 divide-y divide-divide overflow-auto
                             rounded-xl border-2 border-line">
                {preview.map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between px-3 py-1.5">
                    <span className="text-sm text-heading">{p.name}</span>
                    <span className="num text-2xs text-muted">
                      {p.rack_location ?? ''} · {p.on_hand}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </>
      )}

      <Field label={tr('Note on the sheet')} span
        hint={tr('Optional. Printed at the top, so a sheet found on a desk explains itself.')}>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={tr('Monthly count, A rack')} className="field mt-1" />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------- typing the counts back */

/**
 * Entering what was actually on the shelf.
 *
 * Two quantities are shown for every line: what the sheet said when it
 * printed, and what the system says now. They differ by whatever sold while
 * the sheet was out on the floor, and showing only one of them is how a day
 * of trading gets silently reversed.
 */
function CountBack({ auditId, onClose }: { auditId: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any | null>(null)

  useEffect(() => {
    api.audit(auditId).then(setData).catch((e: any) => setErr(e.message))
  }, [auditId])

  if (!data) {
    return <div className="p-6"><ErrorNote>{err}</ErrorNote><SkeletonRows rows={6} cols={4} /></div>
  }

  const { audit: a, items } = data
  const filled = items.filter((i: any) => String(counts[i.product_id] ?? '').trim() !== '')
  const changing = filled.filter((i: any) =>
    Number(counts[i.product_id]) !== Number(i.on_hand_now))

  async function save() {
    setBusy(true); setErr(null)
    try {
      const made = await api.createAdjustment({
        auditId,
        counts: filled.map((i: any) => ({
          productId: i.product_id, countedQty: Number(counts[i.product_id])
        })),
        note: note.trim() || null
      })
      setDone(made)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="p-6">
        <Card title={tr('Stock adjusted')}
          hint={`${done.adjustment_no} · ${done.changed} ${tr('medicines changed')}`}>
          <p className="text-sm text-body">
            {tr('The adjustment is saved and the stock has moved. It can be printed and looked up at any time.')}
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={onClose} className="btn-primary">{tr('Done')}</button>
            <button className="btn-ghost"
              onClick={() => {
                const path = `/pharma/adjustments/${done.id}/pdf`
                api.documentTicket(path).then(({ ticket }: any) =>
                  window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank'))
              }}>
              <Printer size={14} className="mr-1 inline" />{tr('Print it')}
            </button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-screen">
      <header className="sticky top-0 z-10 border-b-2 border-line bg-card px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="btn-ghost px-3 py-1.5 text-2xs">
              &larr; {tr('Back')}
            </button>
            <div>
              <h2 className="text-base font-semibold text-heading">
                {tr('Enter counts')} — {a.audit_no}
              </h2>
              <p className="text-2xs text-muted">
                {tr('Printed')} {new Date(a.created_at).toLocaleString('en-GB')} · {a.created_by}
              </p>
            </div>
          </div>
          <button onClick={save} disabled={busy || filled.length === 0}
            className="btn-primary">
            {busy ? tr('Saving…')
              : `${tr('Adjust stock')} (${changing.length})`}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ErrorNote>{err}</ErrorNote>

        {/*
          Said plainly, because it is the one thing somebody typing these
          numbers has to understand: the sheet is a snapshot, the shelf is now.
        */}
        <div className="mb-4 flex items-start gap-2 rounded-xl border-2 border-line
                        bg-raised p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-muted" />
          <p className="text-2xs text-muted">
            {tr('Stock is adjusted against the CURRENT figure, not the one on the sheet. Anything sold while the sheet was out stays sold.')}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={tr('On the sheet')} value={String(items.length)} />
          <Stat label={tr('Counted')} value={String(filled.length)} tone="ok" />
          <Stat label={tr('Will change')} value={String(changing.length)}
            tone={changing.length ? 'warn' : undefined} />
        </div>

        <Card className="mt-4" title={tr('Counts')}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Medicine')}</Th>
                  <Th w="w-24" right>{tr('On sheet')}</Th>
                  <Th w="w-24" right>{tr('Now')}</Th>
                  <Th w="w-28">{tr('Counted')}</Th>
                  <Th w="w-24" right>{tr('Change')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped">
                {items.map((i: any) => {
                  const typed = String(counts[i.product_id] ?? '')
                  const n = typed.trim() === '' ? null : Number(typed)
                  const delta = n == null ? null : n - Number(i.on_hand_now)
                  return (
                    <tr key={i.product_id}>
                      <td className="px-3 py-1.5">
                        <span className="text-sm text-heading">{i.product_name}</span>
                        <span className="block text-2xs text-muted">
                          {i.manufacturer ?? ''}
                          {i.rack_location ? ` · ${i.rack_location}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right num text-2xs text-muted">
                        {i.expected_qty}
                      </td>
                      <td className="px-3 py-1.5 text-right num text-sm">{i.on_hand_now}</td>
                      <td className="px-3 py-1.5">
                        <input value={typed} inputMode="numeric"
                          onChange={(e) => setCounts({
                            ...counts, [i.product_id]: e.target.value.replace(/[^0-9]/g, '')
                          })}
                          className="field num py-1 text-right text-2xs" />
                      </td>
                      <td className="px-3 py-1.5 text-right num text-sm">
                        {delta == null ? <span className="text-muted">—</span>
                          : delta === 0 ? <span className="text-muted">0</span>
                          : <span className={delta > 0 ? 'text-ok' : 'text-bad'}>
                              {delta > 0 ? '+' : ''}{delta}
                            </span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <Field label={tr('Note')} span
            hint={tr('Why the stock was out. Printed on the adjustment.')}>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              className="field mt-1" />
          </Field>
        </Card>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- the adjustments */

function Adjustments() {
  const [view, setView] = useState('list')
  const [from, setFrom] = useState(monthAgo())
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    const get = view === 'list' ? api.adjustments(from, to)
      : view === 'history' ? api.adjustmentHistory(from, to)
      : api.adjustmentsByCompany(from, to)
    get.then(setRows).catch((e: any) => setErr(e.message))
  }, [view, from, to])
  useEffect(() => { load() }, [load])

  return (
    <Card title={tr('Stock adjustments')}
      hint={tr('Every change, with who made it and when.')}
      action={
        <div className="flex gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="field num w-auto py-1.5 text-2xs" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="field num w-auto py-1.5 text-2xs" />
        </div>
      }>
      <ErrorNote>{err}</ErrorNote>

      <div className="mb-3 flex flex-wrap gap-2">
        {([['list', tr('Each adjustment')],
           ['history', tr('Every medicine, every time')],
           ['company', tr('By company')]] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setView(id); setRows(null) }}
            className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
              view === id ? 'bg-brand text-white'
                : 'border-2 border-line bg-card text-body hover:bg-raised'}`}>
            {label}
          </button>
        ))}
      </div>

      {!rows ? <SkeletonRows rows={6} cols={5} />
        : rows.length === 0 ? <Empty title={tr('Nothing in this period')} />
        : view === 'list' ? (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th w="w-32">{tr('Adjustment')}</Th><Th w="w-32">{tr('Against sheet')}</Th>
              <Th>{tr('By')}</Th><Th w="w-20" right>{tr('Lines')}</Th>
              <Th w="w-20" right>{tr('Added')}</Th><Th w="w-20" right>{tr('Removed')}</Th>
              <Th w="w-20" right />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <span className="num text-2xs text-primary">{r.adjustment_no}</span>
                  <span className="block num text-2xs text-muted">
                    {new Date(r.created_at).toLocaleString('en-GB',
                      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </td>
                <td className="px-3 py-2 num text-2xs text-muted">{r.audit_no}</td>
                <td className="px-3 py-2 text-sm text-body">{r.created_by}</td>
                <td className="px-3 py-2 text-right num text-2xs">{r.lines}</td>
                <td className="px-3 py-2 text-right num text-2xs text-ok">
                  {Number(r.added) > 0 ? `+${r.added}` : '—'}
                </td>
                <td className="px-3 py-2 text-right num text-2xs text-bad">
                  {Number(r.removed) > 0 ? `−${r.removed}` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button className="btn-ghost px-2 py-1 text-2xs"
                    onClick={() => {
                      const path = `/pharma/adjustments/${r.id}/pdf`
                      api.documentTicket(path).then(({ ticket }: any) =>
                        window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank'))
                    }}>
                    <Printer size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : view === 'history' ? (
        /*
         * One row per instance, never a net figure. Panadol adjusted five
         * times is five rows: a single "net −12" hides the pattern that makes
         * somebody look twice.
         */
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Medicine')}</Th><Th w="w-28">{tr('When')}</Th>
              <Th w="w-24" right>{tr('Before')}</Th><Th w="w-24" right>{tr('Counted')}</Th>
              <Th w="w-20" right>{tr('Change')}</Th><Th w="w-32">{tr('By')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5">
                  <span className="text-sm text-heading">{r.product_name}</span>
                  <span className="block text-2xs text-muted">{r.manufacturer ?? ''}</span>
                </td>
                <td className="px-3 py-1.5 num text-2xs text-muted">
                  {new Date(r.created_at).toLocaleString('en-GB',
                    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-3 py-1.5 text-right num text-2xs">{r.before_qty}</td>
                <td className="px-3 py-1.5 text-right num text-2xs">{r.counted_qty}</td>
                <td className="px-3 py-1.5 text-right num text-sm">
                  <span className={Number(r.delta_qty) > 0 ? 'text-ok' : 'text-bad'}>
                    {Number(r.delta_qty) > 0 ? '+' : ''}{r.delta_qty}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-2xs text-muted">
                  {r.created_by}
                  <span className="block num">{r.adjustment_no}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Company')}</Th>
              <Th w="w-24" right>{tr('Medicines')}</Th>
              <Th w="w-20" right>{tr('Times')}</Th>
              <Th w="w-20" right>{tr('Added')}</Th>
              <Th w="w-20" right>{tr('Removed')}</Th>
              <Th w="w-20" right>{tr('Net')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {rows.map((r) => (
              <tr key={r.manufacturer}>
                <td className="px-3 py-2 text-sm text-heading">{r.manufacturer}</td>
                <td className="px-3 py-2 text-right num text-2xs">{r.products}</td>
                <td className="px-3 py-2 text-right num text-2xs">{r.lines}</td>
                <td className="px-3 py-2 text-right num text-2xs text-ok">{r.added}</td>
                <td className="px-3 py-2 text-right num text-2xs text-bad">{r.removed}</td>
                <td className="px-3 py-2 text-right num text-sm">
                  <span className={Number(r.net) >= 0 ? 'text-ok' : 'text-bad'}>
                    {Number(r.net) > 0 ? '+' : ''}{r.net}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
