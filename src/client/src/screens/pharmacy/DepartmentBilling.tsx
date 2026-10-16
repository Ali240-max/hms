import { useCallback, useEffect, useRef, useState } from 'react'
import { Building2, Check } from 'lucide-react'
import { api, newId, rs, type SearchHit, type SessionUser } from '../../lib/api'
import { effectivePrice, maxFor, totals as cartTotals, type CartLine } from '../../lib/cart'
import { ExpiryPill } from '../../components/Expiry'
import { Badge, Card, Empty, ErrorNote, PrintButton, SkeletonRows } from '../../components/ui'
import { ReceiptPreview } from '../../components/Chit'
import { useToast } from '../../lib/toast'
import { t as tr } from '../../lib/prefs'

/**
 * Interdepartmental billing: medicines issued to a department of the
 * hospital — the OT, Emergency, a ward — against a bill of its own.
 *
 * Kept apart from the counter on purpose. Nobody pays at the window for
 * these, there is no customer, and a department bill must never be counted
 * as money collected. What it shares with the counter is everything that
 * protects the shelf: the server bills it through the same createSale, so
 * FEFO, the expiry cut-off, whole-pack rules and the stock locks are the
 * till's own, and the stock comes off exactly once.
 *
 * The departments are the hospital's own list from Administration. This
 * screen reads them and never adds, renames or removes one.
 *
 * Its own cart rather than the till's. The till's cart is one shared store;
 * using it here would let a half-built department bill turn up on the
 * counter, or a customer's medicines be issued to the OT.
 */

type Dept = { id: number; name: string; code: string; month_bills: number; month_paisa: number }

function lineFrom(hit: SearchHit, qty = 1): CartLine {
  const packSize = Math.max(1, hit.pack_size ?? 1)
  return {
    key: `${hit.id}-${newId()}`,
    productId: hit.id, name: hit.name, unitLabel: hit.unit_label,
    subUnitLabel: hit.sub_unit_label ?? null, packSize,
    allowLoose: !!hit.allow_loose && packSize > 1, soldAs: 'pack',
    schedule: hit.schedule, taxRateBp: hit.tax_rate_bp, qty,
    unitPricePaisa: Number(hit.price_paisa ?? 0), discountPaisa: 0,
    batchNo: hit.batch_no, expiryDate: hit.expiry_date, availableBase: hit.total_qty
  }
}

export function DepartmentBilling({ me }: { me: SessionUser }) {
  const [depts, setDepts] = useState<Dept[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Dept | null>(null)

  const loadDepts = useCallback(() => {
    setErr(null)
    api.ph.departments().then(setDepts)
      .catch((e: any) => { setErr(e.message ?? 'Could not load the departments'); setDepts([]) })
  }, [])
  useEffect(loadDepts, [loadDepts])

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Interdepartmental Billing')}
        hint={tr('Pick the department the medicines are going to. These bills are charged to the department and are not counted as money collected.')}>
        <ErrorNote>{err}</ErrorNote>
        {depts === null ? <SkeletonRows rows={2} cols={4} />
          : depts.length === 0 && !err ? (
            <Empty title={tr('No departments set up yet')}
              hint={tr('Departments are added by an administrator under Administration, Departments.')} />
          ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {depts.map((d) => {
              const on = picked?.id === d.id
              return (
                <button key={d.id} onClick={() => setPicked(d)} aria-pressed={on}
                  className={`lift relative rounded-2xl border-2 px-3 py-2.5 text-left transition-colors ${
                    on ? 'border-primary bg-primary/10'
                       : 'border-line bg-card hover:border-primary/50 hover:bg-raised'}`}>
                  <span className="flex items-center gap-2">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${
                      on ? 'bg-brand text-white' : 'bg-raised text-primary'}`}>
                      {on ? <Check size={14} /> : <Building2 size={14} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-heading">{d.name}</span>
                      <span className="block num text-2xs text-muted">{d.code}</span>
                    </span>
                  </span>
                  <span className="mt-1.5 block num text-2xs text-muted">
                    {d.month_bills > 0
                      ? `${d.month_bills} ${tr('this month')} · Rs ${rs(d.month_paisa)}`
                      : tr('No bills this month')}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </Card>

      {picked && (
        <DepartmentBill key={picked.id} dept={picked} me={me}
          onBilled={loadDepts} onClose={() => setPicked(null)} />
      )}
    </div>
  )
}

function DepartmentBill({ dept, me, onBilled, onClose }: {
  dept: Dept; me: SessionUser; onBilled: () => void; onClose: () => void
}) {
  const toast = useToast()
  const [lines, setLines] = useState<CartLine[]>([])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [cursor, setCursor] = useState(0)
  const [receivedBy, setReceivedBy] = useState('')
  const [doctorName, setDoctorName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)
  const [receipt, setReceipt] = useState<number | null>(null)
  const [recent, setRecent] = useState<any[] | null>(null)
  const box = useRef<HTMLInputElement>(null)
  /* One key per bill. See the till: a second press returns the same bill. */
  const requestKey = useRef(newId())

  useEffect(() => { box.current?.focus() }, [])
  const loadRecent = useCallback(() => {
    api.ph.departmentSales(dept.id).then(setRecent).catch(() => setRecent([]))
  }, [dept.id])
  useEffect(loadRecent, [loadRecent])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      api.productSearch(q).then((r) => { setHits(r); setCursor(0) }).catch(() => setHits([]))
    }, 150)
    return () => clearTimeout(t)
  }, [q])

  function add(hit: SearchHit) {
    setQ(''); setHits([]); box.current?.focus()
    if (!hit.batch_id || hit.total_qty <= 0) {
      setErr(`${hit.name} ${tr('is not in stock')}`); return
    }
    setErr(null)
    setLines((ls) => {
      const same = ls.find((l) => l.productId === hit.id && l.soldAs === 'pack')
      if (same) {
        return ls.map((l) => l.key === same.key
          ? { ...l, qty: Math.min(l.qty + 1, Math.max(1, maxFor(l))) } : l)
      }
      return [...ls, lineFrom(hit)]
    })
  }
  const patch = (key: string, p: Partial<CartLine>) => setLines((ls) => ls.map((l) => {
    if (l.key !== key) return l
    const next = { ...l, ...p }
    return { ...next, qty: Math.max(1, Math.min(next.qty, Math.max(1, maxFor(next)))) }
  }))

  const sums = cartTotals(lines)
  const controlled = lines.filter((l) => l.schedule === 'controlled')
  const needsPrescriber = controlled.length > 0 && !doctorName.trim()
  const short = lines.filter((l) => maxFor(l) < l.qty)
  const canBill = lines.length > 0 && !needsPrescriber && short.length === 0 && !busy

  async function bill() {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.billDepartment({
        departmentId: dept.id, requestKey: requestKey.current,
        receivedBy: receivedBy.trim() || undefined,
        doctorName: doctorName.trim() || undefined,
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, soldAs: l.soldAs }))
      })
      requestKey.current = newId()
      setDone(r)
      setLines([]); setReceivedBy(''); setDoctorName('')
      toast(`${r.sale.invoiceNo} ${tr('issued to')} ${dept.name}`, 'ok')
      onBilled(); loadRecent()
    } catch (e: any) {
      setErr(e.message ?? 'Could not make the bill')
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="panel anim-pop mx-auto max-w-md p-6 text-center">
        <p className="text-2xs uppercase tracking-wide text-muted">{tr('Issued to')} {dept.name}</p>
        <p className="num mt-1 text-4xl font-semibold text-primary">Rs {rs(done.sale.totalPaisa)}</p>
        <p className="num mt-1 text-sm text-muted">{done.sale.invoiceNo}</p>
        <p className="mt-2"><Badge tone="primary">{tr('Charged to department')}</Badge></p>
        <PrintButton label={tr('Print bill')} onPrint={() => api.printSale(done.sale.id)} />
        <button onClick={() => setReceipt(done.sale.id)} className="btn-ghost mt-2 w-full">
          {tr('Preview bill')}
        </button>
        <button onClick={() => { setDone(null); setTimeout(() => box.current?.focus(), 0) }}
          className="btn-primary mt-2 w-full">{tr('Next bill for')} {dept.name}</button>
        <button onClick={onClose} className="btn-ghost mt-2 w-full">{tr('Choose another department')}</button>
        {receipt && <ReceiptPreview saleId={receipt} onClose={() => setReceipt(null)} />}
      </div>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title={`${tr('New bill for')} ${dept.name}`}
        hint={tr('Search a medicine and add it. The batch is picked first-expiry-first, the same as the counter.')}
        action={<button onClick={onClose} className="btn-ghost px-3 py-1.5 text-2xs">{tr('Change department')}</button>}>
        <div className="relative">
          <input ref={box} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
              if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); add(hits[cursor]) }
              if (e.key === 'Escape') { setQ(''); setHits([]) }
            }}
            placeholder={tr('Scan a barcode or search a medicine')} className="field text-base" />
          {hits.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-2xl border-2 border-line bg-card shadow-lg">
              {hits.map((h, i) => (
                <li key={h.id} onMouseEnter={() => setCursor(i)} onClick={() => add(h)}
                  className={`flex cursor-pointer items-center gap-3 border-b border-divide px-3 py-2 last:border-0 ${
                    i === cursor ? 'bg-primary/5' : ''}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-heading">{h.name}</span>
                    <span className="block truncate text-2xs text-muted">
                      {[h.generic_name, h.strength, h.form].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {h.expiry_date && <ExpiryPill date={h.expiry_date} />}
                  <span className="w-20 text-right text-2xs num text-muted">{h.total_qty} {tr('left')}</span>
                  <span className="w-20 text-right num font-medium text-primary">
                    {h.price_paisa != null ? rs(h.price_paisa) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>

        {lines.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">{tr('Nothing on this bill yet.')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="thead-strip">
                <tr>
                  <th className="px-3 py-2 text-left text-2xs font-medium">{tr('Medicine')}</th>
                  <th className="w-28 px-2 py-2 text-left text-2xs font-medium">{tr('Issue as')}</th>
                  <th className="w-20 px-2 py-2 text-right text-2xs font-medium">{tr('Qty')}</th>
                  <th className="w-24 px-2 py-2 text-right text-2xs font-medium">{tr('Rate')}</th>
                  <th className="w-24 px-2 py-2 text-right text-2xs font-medium">{tr('Amount')}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide">
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-heading">{l.name}</span>
                        {l.schedule === 'controlled' && <Badge tone="bad">{tr('controlled')}</Badge>}
                      </span>
                      <span className="block text-2xs text-muted num">
                        {l.batchNo && `${tr('Batch')} ${l.batchNo}`}
                        {` · ${maxFor(l)} ${tr('available')}`}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      {l.allowLoose ? (
                        <div className="flex gap-px">
                          {(['pack', 'unit'] as const).map((mode) => (
                            <button key={mode} onClick={() => patch(l.key, { soldAs: mode })}
                              className={`px-2 py-1 text-2xs first:rounded-l-lg last:rounded-r-lg ${
                                l.soldAs === mode ? 'bg-primary text-white' : 'bg-screen text-muted'}`}>
                              {mode === 'pack' ? l.unitLabel : (l.subUnitLabel ?? 'unit')}
                            </button>
                          ))}
                        </div>
                      ) : <span className="text-2xs text-muted">{l.unitLabel}</span>}
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.qty} inputMode="numeric"
                        onChange={(e) => patch(l.key, { qty: Math.max(1, Number(e.target.value) || 1) })}
                        className="field w-full py-1 text-right text-sm num" />
                    </td>
                    <td className="px-2 py-2 text-right num text-muted">{rs(effectivePrice(l))}</td>
                    <td className="px-2 py-2 text-right num font-medium text-primary">
                      {rs(effectivePrice(l) * l.qty)}
                    </td>
                    <td className="pr-2">
                      <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        aria-label={`${tr('Remove')} ${l.name}`}
                        className="rounded-lg px-1.5 py-0.5 text-muted hover:bg-bad/10 hover:text-bad">
                        &times;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        <div className="card p-4">
          <label className="label">{tr('Received by (in the department)')}</label>
          <input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)}
            placeholder={tr('Optional. e.g. OT in-charge')} className="field" />
          <label className="label mt-3">
            {tr('Prescriber')} {needsPrescriber && <span className="text-bad">— {tr('required')}</span>}
          </label>
          <input value={doctorName} onChange={(e) => setDoctorName(e.target.value)}
            placeholder={needsPrescriber ? tr('Required for controlled medicines') : tr('Optional')}
            className={`field ${needsPrescriber ? 'border-bad' : ''}`} />
        </div>

        <div className="panel p-4">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted">{tr('Department')}</dt>
              <dd className="text-heading">{dept.name}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">{tr('Items')}</dt>
              <dd className="num">{lines.length}</dd></div>
            {sums.tax > 0 && (
              <div className="flex justify-between"><dt className="text-muted">{tr('Tax')}</dt>
                <dd className="num">{rs(sums.tax)}</dd></div>
            )}
            <div className="flex justify-between border-t border-divide pt-2 text-lg font-semibold">
              <dt>{tr('Total')}</dt><dd className="num text-primary">Rs {rs(sums.total)}</dd>
            </div>
          </dl>
          {short.length > 0 && (
            <p className="mt-2 text-2xs text-bad">
              {tr('Not enough in stock for')} {short.map((l) => l.name).join(', ')}
            </p>
          )}
          <button onClick={bill} disabled={!canBill} className="btn-primary mt-3 w-full py-3">
            {busy ? tr('Saving…') : `${tr('Issue to')} ${dept.name}`}
          </button>
          <p className="mt-2 text-center text-2xs text-muted">
            {tr('Charged to the department · signed in as')} {me.displayName}
          </p>
        </div>

        <Card title={tr('Recent bills')} hint={dept.name}>
          {recent === null ? <SkeletonRows rows={3} cols={2} />
            : recent.length === 0 ? <p className="text-2xs text-muted">{tr('None yet.')}</p> : (
            <ul className="divide-y divide-divide text-2xs">
              {recent.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="block num text-primary">{r.invoice_no}</span>
                    <span className="block text-muted">
                      {new Date(r.sold_at).toLocaleString('en-GB',
                        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {r.cashier && ` · ${r.cashier}`}
                    </span>
                  </span>
                  <span className="num text-sm text-heading">{rs(r.total_paisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
