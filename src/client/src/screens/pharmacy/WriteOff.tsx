import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CalendarX, History, Printer, Search, Trash2
} from 'lucide-react'
import { api, rs, stockLabel, type SessionUser } from '../../lib/api'
import {
  Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Stat, Tabs, Th
} from '../../components/ui'
import { ExpiryPill } from '../../components/Expiry'
import { t as tr } from '../../lib/prefs'

/**
 * Taking stock off the shelf without selling it.
 *
 * ONE COMPONENT, TWO SCREENS. Damage and expiry are the same act and differ
 * in three things: the word on the button, which batches are offered first,
 * and what gets typed in the reason box. Two copies of this file would drift
 * within a month, and the drift would be in the arithmetic.
 *
 * The expiry screen opens on what has ALREADY expired, because that is the
 * stock that must not be sold tomorrow. Damage opens on everything, because
 * a dropped carton is a carton with any date on it.
 *
 * NOTHING IS DELETED. A write-off adds a record and moves stock; there is no
 * way to unmake one from this screen. Reversing a mistake is a stock
 * adjustment, which goes through a count sheet and leaves both the error and
 * the correction on the record — which is the whole point.
 */

type Picked = {
  key: string
  batchId: number
  productId: number
  name: string
  batchNo: string
  expiryDate: string
  available: number
  costPaisa: number
  qty: string
  reason: string
}

type Kind = 'damage' | 'expiry'

const WORDS: Record<Kind, {
  title: string; hint: string; verb: string; reasonHint: string
  prefix: string
}> = {
  damage: {
    title: 'Damaged stock',
    hint: 'Broken, spilled, crushed or otherwise unsellable. It comes off the shelf and the loss is recorded.',
    verb: 'Remove damaged stock',
    reasonHint: 'carton dropped, seal broken, water damage',
    prefix: 'DMG'
  },
  expiry: {
    title: 'Expired stock',
    hint: 'Out of date, or about to be. It comes off the shelf and the loss is recorded.',
    verb: 'Remove expired stock',
    reasonHint: 'past expiry, short dated, returned by customer',
    prefix: 'EXP'
  }
}

export function WriteOff({ kind, me, onWrittenOff }: {
  kind: Kind; me: SessionUser
  /** Told after stock comes off, so the rail's expired count can fall. */
  onWrittenOff?: () => void
}) {
  const [tab, setTab] = useState<'new' | 'past'>('new')
  const w = WORDS[kind]

  /*
   * Whether this person may actually take stock off, as opposed to read
   * what has already gone.
   *
   * The tab is open to anybody who can see stock, because a tab that is
   * simply absent teaches nobody anything. The button is what is gated, and
   * it says which tick is missing rather than just sitting there greyed.
   */
  const [mayWrite, setMayWrite] = useState<boolean | null>(null)
  useEffect(() => {
    api.permissionsFor(me.id)
      .then((d: any) => setMayWrite(me.role === 'admin'
        || (d.allowed ?? []).includes(kind === 'damage' ? 'stock.damage' : 'stock.expiry')))
      .catch(() => setMayWrite(me.role === 'admin'))
  }, [me.id, me.role, kind])

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs id={`writeoff-${kind}`} value={tab} onChange={(v) => setTab(v as any)}
          className="w-fit"
          tabs={[
            { value: 'new', label: tr(w.verb),
              icon: kind === 'damage' ? AlertTriangle : CalendarX },
            { value: 'past', label: tr('Previous reports'), icon: History }
          ]} />
        {/*
          The expired-batch count that sat here moved to the rail, beside
          Expiry (Pharmacy.tsx), so it is seen without opening this screen.
        */}
      </div>
      {tab === 'new'
        ? <NewWriteOff kind={kind} mayWrite={mayWrite !== false} onSaved={onWrittenOff} />
        : <PastWriteOffs kind={kind} />}
    </div>
  )
}

/* ------------------------------------------------------------ making one */

function NewWriteOff({ kind, mayWrite, onSaved }: {
  kind: Kind; mayWrite: boolean; onSaved?: () => void
}) {
  const w = WORDS[kind]
  const [q, setQ] = useState('')
  /*
   * The expiry window, in days.
   *
   * Zero is "already out of date" and is where the expiry screen starts.
   * `null` is no window at all, which is what the damage screen wants: a
   * carton that hit the floor this morning has a year left on it.
   */
  const [days, setDays] = useState<number | null>(kind === 'expiry' ? 0 : null)
  const [rows, setRows] = useState<any[] | null>(null)
  const [picked, setPicked] = useState<Picked[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)

  const load = useCallback(() => {
    setRows(null)
    api.writeOffShelf(q, days ?? undefined)
      .then(setRows).catch((e: any) => { setErr(e.message); setRows([]) })
  }, [q, days])

  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load])

  const add = (r: any) => {
    if (picked.some((p) => p.batchId === Number(r.batch_id))) return
    setPicked((ps) => [...ps, {
      key: `${r.batch_id}`,
      batchId: Number(r.batch_id),
      productId: Number(r.product_id),
      name: String(r.product_name),
      batchNo: String(r.batch_no ?? ''),
      expiryDate: String(r.expiry_date ?? '').slice(0, 10),
      available: Number(r.qty_on_hand),
      costPaisa: Number(r.cost_paisa),
      /*
       * Expired stock is prefilled with the whole batch, damage with one
       * unit. An expired batch comes off entirely, every time; a damaged one
       * is however many were in the box that fell.
       */
      qty: kind === 'expiry' ? String(r.qty_on_hand) : '1',
      reason: ''
    }])
  }

  const patch = (key: string, p: Partial<Picked>) =>
    setPicked((ps) => ps.map((x) => (x.key === key ? { ...x, ...p } : x)))

  const lineValue = (p: Picked) =>
    (Math.max(0, Number(p.qty) || 0)) * p.costPaisa
  const total = picked.reduce((n, p) => n + lineValue(p), 0)
  const units = picked.reduce((n, p) => n + (Number(p.qty) || 0), 0)

  /* Over-asking is caught here as well as on the server, because the server
   * refuses the whole form and this says which line is wrong. */
  const overdrawn = picked.filter((p) => (Number(p.qty) || 0) > p.available)
  const ready = mayWrite && picked.length > 0 && overdrawn.length === 0
    && picked.every((p) => (Number(p.qty) || 0) > 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.createWriteOff({
        kind, note: note.trim() || null,
        lines: picked.map((p) => ({
          productId: p.productId, batchId: p.batchId,
          qty: Number(p.qty), reason: p.reason.trim() || null
        }))
      })
      setDone(r)
      setPicked([]); setNote(''); load(); onSaved?.()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (done) {
    return (
      <Card title={tr('Stock removed')}>
        <p className="num text-3xl font-semibold text-primary">
          {done.write_off_no}
        </p>
        <p className="mt-1 text-2xs text-muted">
          {done.lines} {tr('lines')} · {done.units} {tr('units')} ·{' '}
          Rs {rs(done.value_paisa)} {tr('off the shelf')}
        </p>
        <div className="mt-4 flex gap-2">
          <button onClick={() => print(done.id)} className="btn-primary">
            <Printer size={14} className="mr-1.5 inline" />
            {tr('Print the report')}
          </button>
          <button onClick={() => setDone(null)} className="btn-ghost">
            {tr('Record another')}
          </button>
        </div>
      </Card>
    )
  }

  return (
    <>
      <Card title={tr(w.title)} hint={tr(w.hint)}>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="relative">
            <Search size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Medicine name, batch number or company')}
              className="field pl-9" />
          </div>
          {/*
            The window is on both screens, not just expiry.

            A storekeeper clearing breakage often finds the short-dated boxes
            in the same sweep, and making them leave the screen to deal with
            those is how the short-dated ones stay on the shelf.
          */}
          <select value={days === null ? 'all' : String(days)}
            onChange={(e) => setDays(e.target.value === 'all' ? null : Number(e.target.value))}
            className="field w-full sm:w-52">
            <option value="all">{tr('Everything on the shelf')}</option>
            <option value="0">{tr('Expired or expiring today')}</option>
            <option value="30">{tr('Expired or within 30 days')}</option>
            <option value="60">{tr('Expired or within 60 days')}</option>
            <option value="90">{tr('Expired or within 90 days')}</option>
          </select>
        </div>

        <div className="mt-3 max-h-80 overflow-auto rounded-2xl border-2 border-line">
          {rows === null ? <SkeletonRows rows={5} cols={5} />
            : rows.length === 0 ? (
              <Empty title={tr('Nothing matches')}
                hint={tr('Only batches with stock left on them can be removed.')} />
            ) : (
              <table className="w-full">
                <thead className="thead-strip sticky top-0 z-10 bg-card">
                  <tr>
                    <Th>{tr('Medicine')}</Th><Th w="w-28">{tr('Batch')}</Th>
                    <Th w="w-32">{tr('Expiry')}</Th>
                    <Th w="w-24" right>{tr('On shelf')}</Th>
                    <Th w="w-24" right>{tr('Cost')}</Th><Th w="w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide rows-striped">
                  {rows.map((r) => {
                    const already = picked.some((p) => p.batchId === Number(r.batch_id))
                    return (
                      <tr key={r.batch_id} className={already ? 'opacity-40' : ''}>
                        <td className="px-3 py-2">
                          <span className="text-sm text-heading">{r.product_name}</span>
                          <span className="block text-2xs text-muted">
                            {[r.manufacturer, r.rack_location].filter(Boolean).join(' · ')}
                          </span>
                        </td>
                        <td className="px-3 py-2 num text-2xs text-muted">{r.batch_no}</td>
                        <td className="px-3 py-2">
                          <ExpiryPill date={String(r.expiry_date).slice(0, 10)} />
                        </td>
                        <td className="px-3 py-2 text-right num text-2xs">
                          {stockLabel(Number(r.qty_on_hand), r.pack_label, r.pack_size)}
                        </td>
                        <td className="px-3 py-2 text-right num text-2xs text-muted">
                          {rs(r.cost_paisa)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button onClick={() => add(r)} disabled={already}
                            className="btn-ghost px-2.5 py-1 text-2xs disabled:opacity-40">
                            {already ? tr('Added') : tr('Add')}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
        </div>
      </Card>

      <Card title={tr('On this report')}
        hint={tr('Each line names the batch it comes off, so the loss is valued at what that stock actually cost.')}>
        {picked.length === 0 ? (
          <Empty title={tr('Nothing added yet')}
            hint={tr('Pick the batches above. Nothing moves until you save.')} />
        ) : (
          <>
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Medicine')}</Th><Th w="w-28">{tr('Batch')}</Th>
                  <Th w="w-24" right>{tr('On shelf')}</Th>
                  <Th w="w-24" right>{tr('Remove')}</Th>
                  <Th>{tr('Reason')}</Th>
                  <Th w="w-28" right>{tr('Value')}</Th><Th w="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {picked.map((p) => {
                  const over = (Number(p.qty) || 0) > p.available
                  return (
                    <tr key={p.key}>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{p.name}</span>
                        <span className="block text-2xs text-muted">
                          {tr('expires')} {p.expiryDate}
                        </span>
                      </td>
                      <td className="px-3 py-2 num text-2xs text-muted">{p.batchNo}</td>
                      <td className="px-3 py-2 text-right num text-2xs text-muted">
                        {p.available}
                      </td>
                      <td className="px-2 py-2">
                        <input value={p.qty}
                          onChange={(e) => patch(p.key, { qty: e.target.value })}
                          className={`field py-1 text-right text-2xs num
                            ${over ? 'border-bad text-bad' : ''}`} />
                      </td>
                      <td className="px-2 py-2">
                        <input value={p.reason}
                          onChange={(e) => patch(p.key, { reason: e.target.value })}
                          placeholder={tr(w.reasonHint)}
                          className="field py-1 text-2xs" />
                      </td>
                      <td className="px-3 py-2 text-right num text-2xs text-primary">
                        {rs(lineValue(p))}
                      </td>
                      <td className="pr-2 text-right">
                        <button
                          onClick={() => setPicked((ps) => ps.filter((x) => x.key !== p.key))}
                          className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {overdrawn.length > 0 && (
              <p className="mt-2 rounded-xl border border-bad/25 bg-bad/5 px-3 py-2 text-2xs text-bad">
                {overdrawn.map((p) => p.name).join(', ')}:{' '}
                {tr('more than the batch holds. Nothing will be saved until this is corrected.')}
              </p>
            )}

            <div className="mt-3">
              <Field label={tr('Note on the whole report')}
                hint={tr('Optional. A sweep of the racks, a flood in the store, whatever explains the lot.')}>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder={tr('Monthly expiry sweep')} className="field" />
              </Field>
            </div>

            <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>

            <div className="mt-3 grid gap-3 border-t border-divide pt-3 sm:grid-cols-3">
              <Stat label={tr('Lines')} value={String(picked.length)} tone="primary" />
              <Stat label={tr('Units off the shelf')} value={String(units)} tone="warn" />
              <Stat label={tr('Value removed')} value={'Rs ' + rs(total)} tone="bad" />
            </div>

            <div className="mt-3 flex justify-end">
              <button onClick={save} disabled={!ready || busy}
                className="btn-primary px-6 py-2.5">
                {busy ? tr('Saving…') : tr(w.verb)}
              </button>
            </div>
            <p className="mt-2 text-right text-2xs text-muted">
              {mayWrite
                ? tr('This cannot be undone. Correcting a mistake means a stock count and an adjustment.')
                : tr('Your account cannot write stock off. Ask a pharmacy administrator to tick it under Access.')}
            </p>
          </>
        )}
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ the record */

function PastWriteOffs({ kind }: { kind: Kind }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<any[] | null>(null)
  const [open, setOpen] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setRows(null)
      api.writeOffs(kind, q).then(setRows)
        .catch((e: any) => { setErr(e.message); setRows([]) })
    }, 200)
    return () => clearTimeout(t)
  }, [kind, q])

  const lost = (rows ?? []).reduce((n, r) => n + Number(r.value_paisa), 0)

  return (
    <Card title={tr('Previous reports')}
      hint={tr('Every one ever made, searchable by its tracking number, the medicine or a word in the note.')}>
      <ErrorNote>{err}</ErrorNote>
      <div className="relative mb-3">
        <Search size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={`${tr('Search')} ${WORDS[kind].prefix}-…`}
          className="field pl-9" />
      </div>

      {rows === null ? <SkeletonRows rows={6} cols={5} />
        : rows.length === 0 ? (
          <Empty title={tr('Nothing recorded yet')} />
        ) : (
          <>
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-40">{tr('Tracking number')}</Th>
                  <Th w="w-36">{tr('When')}</Th>
                  <Th>{tr('Note')}</Th>
                  <Th w="w-28">{tr('By')}</Th>
                  <Th w="w-20" right>{tr('Lines')}</Th>
                  <Th w="w-20" right>{tr('Units')}</Th>
                  <Th w="w-28" right>{tr('Value')}</Th>
                  <Th w="w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-primary/5"
                    onClick={() => api.writeOff(r.id).then(setOpen)
                      .catch((e: any) => setErr(e.message))}>
                    <td className="px-3 py-2 num text-sm text-heading">{r.write_off_no}</td>
                    <td className="px-3 py-2 num text-2xs text-muted">
                      {new Date(r.created_at).toLocaleString('en-GB',
                        { day: '2-digit', month: 'short', year: '2-digit',
                          hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-2xs text-body">{r.note ?? '—'}</td>
                    <td className="px-3 py-2 text-2xs text-muted">{r.created_by}</td>
                    <td className="px-3 py-2 text-right num text-2xs">{r.lines}</td>
                    <td className="px-3 py-2 text-right num text-2xs">{r.units}</td>
                    <td className="px-3 py-2 text-right num text-2xs text-bad">
                      {rs(r.value_paisa)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button onClick={(e) => { e.stopPropagation(); print(r.id) }}
                        className="btn-ghost px-2 py-1 text-2xs">
                        <Printer size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-2xs text-muted">
              <Badge tone="bad">Rs {rs(lost)}</Badge>{' '}
              {tr('lost across the reports shown. The full history by medicine is under Reports.')}
            </p>
          </>
        )}

      {open && <Detail w={open} onClose={() => setOpen(null)} />}
    </Card>
  )
}

function Detail({ w, onClose }: { w: any; onClose: () => void }) {
  return (
    <Modal title={String(w.write_off_no)} wide onClose={onClose}
      hint={`${w.kind === 'damage' ? 'Damage' : 'Expiry'} · ${w.created_by} · ` +
        new Date(w.created_at).toLocaleString('en-GB')}
      footer={<>
        <button onClick={() => print(w.id)} className="btn-primary">
          <Printer size={14} className="mr-1.5 inline" />{tr('Print')}
        </button>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
      </>}>
      {w.note && <p className="mb-3 text-2xs text-body">{w.note}</p>}
      <table className="w-full">
        <thead className="thead-strip">
          <tr>
            <Th>{tr('Medicine')}</Th><Th w="w-28">{tr('Batch')}</Th>
            <Th w="w-28">{tr('Expiry')}</Th>
            <Th w="w-20" right>{tr('Units')}</Th>
            <Th w="w-24" right>{tr('Rate')}</Th>
            <Th w="w-28" right>{tr('Value')}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-divide rows-striped">
          {(w.items ?? []).map((i: any) => (
            <tr key={i.id}>
              <td className="px-3 py-2">
                <span className="text-sm text-heading">{i.product_name}</span>
                {i.reason && (
                  <span className="block text-2xs text-muted">{i.reason}</span>
                )}
              </td>
              <td className="px-3 py-2 num text-2xs text-muted">{i.batch_no ?? '—'}</td>
              <td className="px-3 py-2 num text-2xs text-muted">
                {i.expiry_date ? String(i.expiry_date).slice(0, 10) : '—'}
              </td>
              <td className="px-3 py-2 text-right num text-2xs">{i.qty}</td>
              <td className="px-3 py-2 text-right num text-2xs text-muted">
                {rs(i.unit_cost_paisa)}
              </td>
              <td className="px-3 py-2 text-right num text-2xs text-bad">
                {rs(i.value_paisa)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center justify-between border-t border-divide pt-3">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {tr('Total removed')}
        </span>
        <span className="num text-2xl font-semibold text-bad">Rs {rs(w.value_paisa)}</span>
      </div>
    </Modal>
  )
}

/**
 * The slip, opened in a new tab.
 *
 * Through a document ticket like every other PDF here, so the file is served
 * against the person's own session rather than a URL anybody could paste.
 */
function print(id: number) {
  const path = `/pharma/write-offs/${id}/pdf`
  api.documentTicket(path).then(({ ticket }: any) =>
    window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank'))
}
