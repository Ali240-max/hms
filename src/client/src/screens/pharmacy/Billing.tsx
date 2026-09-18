import { useCallback, useEffect, useRef, useState } from 'react'
import { api, rs, toPaisa, type SearchHit, type SessionUser } from '../../lib/api'
import { useCart, totals as cartTotals } from '../../lib/cart'
import { ExpiryPill } from '../../components/Expiry'
import { Badge, ErrorNote } from '../../components/ui'
import { ReceiptPreview } from '../../components/Chit'
import { LabelPreview } from '../../components/Labels'
import { t as tr } from '../../lib/prefs'

/**
 * The counter.
 *
 * Same flow as the standalone till: scan or search, FEFO picks the batch,
 * pack or loose per line, cash received gates the sale. What is new is that a
 * prescription can be loaded straight into the cart, and settling it marks
 * those lines dispensed.
 */
export function Billing({ me, pending, onConsumed }: {
  me: SessionUser
  pending: { visitId: number; patientId: number; patientName: string; doctorName: string; items: any[] } | null
  onConsumed: () => void
}) {
  const cart = useCart()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [cursor, setCursor] = useState(0)
  const [tendered, setTendered] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)
  const [receipt, setReceipt] = useState<number | null>(null)
  const [labels, setLabels] = useState<number | null>(null)
  const [linked, setLinked] = useState<typeof pending>(null)
  const [missing, setMissing] = useState<string[]>([])
  const box = useRef<HTMLInputElement>(null)

  /* ------------------------------------------- load a prescription in */
  useEffect(() => {
    if (!pending) return
    cart.clear()
    const notFound: string[] = []
    ;(async () => {
      for (const item of pending.items) {
        if (!item.product_id) { notFound.push(item.drug_name); continue }
        const found = await api.productSearch(item.drug_name).catch(() => [])
        const hit = found.find((h) => h.id === item.product_id)
        if (!hit || !hit.batch_id) { notFound.push(item.drug_name); continue }
        cart.add(hit, Math.max(1, item.qty_prescribed))
      }
      cart.set({ customerName: pending.patientName })
      cart.set({ doctorName: pending.doctorName })
      setLinked(pending)
      setMissing(notFound)
      onConsumed()
      box.current?.focus()
    })()
    // cart is a store; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  useEffect(() => { box.current?.focus() }, [])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      api.productSearch(q).then((r) => { setHits(r); setCursor(0) }).catch(() => setHits([]))
    }, 150)
    return () => clearTimeout(t)
  }, [q])

  const sums = cartTotals(cart.lines)
  const total = sums.total
  const change = toPaisa(tendered) - total
  const controlled = cart.lines.filter((l) => l.schedule === 'controlled')
  const needsPrescriber = controlled.length > 0 && !cart.doctorName.trim()
  const canSell = cart.lines.length > 0 && !needsPrescriber &&
    (cart.payMethod !== 'cash' || toPaisa(tendered) >= total)

  const complete = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.sell({
        lines: cart.lines.map((l) => ({
          productId: l.productId, qty: l.qty, soldAs: l.soldAs,
          discountPaisa: l.discountPaisa
        })),
        customerName: cart.customerName || undefined,
        doctorName: cart.doctorName || undefined,
        payMethod: cart.payMethod,
        paidPaisa: cart.payMethod === 'cash' ? toPaisa(tendered) : total,
        visitId: linked?.visitId,
        patientId: linked?.patientId
      })
      setDone({ ...r, change: (cart.payMethod === 'cash' ? toPaisa(tendered) : total) - total })
      cart.clear(); setTendered(''); setLinked(null); setMissing([])
    } catch (e: any) {
      setErr(e.message ?? 'Could not complete the sale')
    } finally { setBusy(false) }
    // tendered must be in here: without it the closure keeps the old value and
    // every sale records zero cash received.
  }, [cart, tendered, total, linked])

  if (done) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel w-full max-w-md p-6 text-center">
          <p className="text-2xs uppercase tracking-wide text-muted">{tr('Sale complete')}</p>
          <p className="num mt-1 text-4xl font-semibold text-primary">Rs {rs(done.sale.totalPaisa)}</p>
          <p className="num mt-1 text-sm text-muted">{done.sale.invoiceNo}</p>
          {done.change > 0 && (
            <div className="mt-4 rounded-2xl border border-ok/25 bg-ok/5 p-4">
              <p className="text-2xs uppercase tracking-wide text-ok">{tr('Change to give')}</p>
              <p className="num text-3xl font-semibold text-ok">Rs {rs(done.change)}</p>
            </div>
          )}
          <button onClick={() => setReceipt(done.sale.id)}
            className="btn-ghost mt-5 w-full">{tr('Preview receipt')}</button>
          {/*
            Offered on every sale, not just prescriptions: the patient reads
            the box, not the bill.
          */}
          <button onClick={() => setLabels(done.sale.id)}
            className="btn-ghost mt-2 w-full">{tr('Print medicine labels')}</button>
          <button onClick={() => { setDone(null); box.current?.focus() }}
            className="btn-primary mt-2 w-full">{tr('Next customer')}</button>
          {receipt && <ReceiptPreview saleId={receipt} onClose={() => setReceipt(null)} />}
          {labels && (
            <LabelPreview saleId={labels} visitId={done.sale.visitId ?? null}
              onClose={() => setLabels(null)} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 gap-4 p-4 lg:grid-cols-[1fr_360px]">
      {/* ------------------------------------------------------- left */}
      <div className="flex min-h-0 flex-col gap-4">
        {linked && (
          <div className="card-tint flex flex-wrap items-center justify-between gap-3 p-3">
            <div>
              <p className="text-2xs uppercase tracking-wide text-muted">{tr('Filling a prescription')}</p>
              <p className="text-sm font-medium text-heading">
                {linked.patientName}
                <span className="ml-2 text-2xs font-normal text-muted">
                  prescribed by {linked.doctorName}
                </span>
              </p>
            </div>
            <button onClick={() => { setLinked(null); cart.clear(); setMissing([]) }}
              className="btn-ghost py-1.5 text-2xs">{tr('Unlink')}</button>
          </div>
        )}

        {missing.length > 0 && (
          <div className="rounded-2xl border border-warn/25 bg-warn/5 p-3">
            <p className="text-2xs font-medium text-warn">
              {missing.length} prescribed item{missing.length > 1 ? 's are' : ' is'} not on the shelf
            </p>
            <p className="mt-0.5 text-2xs text-warn/90">{missing.join(', ')}</p>
            <p className="mt-1 text-2xs text-muted">
              Not added to the bill. They stay marked pending on the prescription so the
              record shows what was actually handed over.
            </p>
          </div>
        )}

        <div className="relative">
          <input ref={box} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
              if (e.key === 'Enter' && hits[cursor]) {
                e.preventDefault(); cart.add(hits[cursor]); setQ(''); setHits([])
              }
              if (e.key === 'Escape') { setQ(''); setHits([]) }
            }}
            placeholder={tr('Scan a barcode or search a medicine')}
            className="field text-base" />
          {hits.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-2xl border-2 border-line bg-card shadow-lg">
              {hits.map((h, i) => (
                <li key={h.id} onMouseEnter={() => setCursor(i)}
                  onClick={() => { cart.add(h); setQ(''); setHits([]); box.current?.focus() }}
                  className={`flex cursor-pointer items-center gap-3 border-b border-divide px-3 py-2 last:border-0 ${
                    i === cursor ? 'bg-primary/5' : ''}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-heading">{h.name}</span>
                    <span className="block truncate text-2xs text-muted">
                      {[h.generic_name, h.strength, h.form].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {h.expiry_date && <ExpiryPill date={h.expiry_date} />}
                  <span className="w-20 text-right text-2xs num text-muted">{h.total_qty} left</span>
                  <span className="w-20 text-right num font-medium text-primary">
                    {h.price_paisa != null ? rs(h.price_paisa) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel min-h-0 flex-1 overflow-auto">
          {cart.lines.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <p className="text-sm text-muted">{tr('Nothing on the bill yet.')}</p>
              <p className="mt-1 text-2xs text-muted/80">
                {tr('Scan an item, or open the Prescriptions tab to fill a doctor\'s list.')}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-screen text-2xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left font-medium">{tr('Medicine')}</th>
                  <th className="w-28 px-2 py-2 text-left font-medium">{tr('Sell as')}</th>
                  <th className="w-20 px-2 py-2 text-right font-medium">{tr('Qty')}</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">{tr('Price')}</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">{tr('Line')}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {cart.lines.map((l) => (
                  <tr key={l.key} className="border-b border-divide">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-heading">{l.name}</span>
                        {l.schedule === 'controlled' && <Badge tone="bad">{tr('controlled')}</Badge>}
                        {l.schedule === 'g' && <Badge tone="warn">{tr('schedule G')}</Badge>}
                      </div>
                      <div className="text-2xs text-muted num">
                        {l.batchNo && `Batch ${l.batchNo}`}
                        {l.expiryDate && <> · <ExpiryPill date={l.expiryDate} showDate={false} /></>}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      {l.allowLoose ? (
                        <div className="flex gap-px">
                          {(['pack', 'unit'] as const).map((mode) => (
                            <button key={mode} onClick={() => cart.setSoldAs(l.key, mode)}
                              className={`px-2 py-1 text-2xs first:rounded-l-lg last:rounded-r-lg ${
                                l.soldAs === mode ? 'bg-primary text-white' : 'bg-screen text-muted'}`}>
                              {mode === 'pack' ? l.unitLabel : (l.subUnitLabel ?? 'unit')}
                            </button>
                          ))}
                        </div>
                      ) : <span className="text-2xs text-muted">{l.unitLabel}</span>}
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.qty}
                        onChange={(e) => cart.setQty(l.key, Math.max(1, Number(e.target.value) || 1))}
                        className="field w-full py-1 text-right text-sm num" />
                    </td>
                    <td className="px-2 py-2 text-right num text-muted">{rs(l.unitPricePaisa)}</td>
                    <td className="px-2 py-2 text-right num font-medium text-primary">
                      {rs(l.unitPricePaisa * l.qty - l.discountPaisa)}
                    </td>
                    <td className="pr-2">
                      <button onClick={() => cart.remove(l.key)} aria-label={`Remove ${l.name}`}
                        className="rounded-lg px-1.5 py-0.5 text-muted hover:bg-bad/10 hover:text-bad">
                        &times;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ right */}
      <div className="flex min-h-0 flex-col gap-4">
        <div className="card p-4">
          <label className="label">{tr('Customer')}</label>
          <input value={cart.customerName} onChange={(e) => cart.set({ customerName: e.target.value })}
            placeholder={tr('Optional')} className="field" />
          <label className="label mt-3">
            Prescriber {needsPrescriber && <span className="text-bad">— required</span>}
          </label>
          <input value={cart.doctorName} onChange={(e) => cart.set({ doctorName: e.target.value })}
            placeholder={needsPrescriber ? 'Required for controlled medicines' : 'Optional'}
            className={`field ${needsPrescriber ? 'border-bad' : ''}`} />
          {needsPrescriber && (
            <p className="mt-1 text-2xs text-bad">
              {controlled.map((l) => l.name).join(', ')} cannot be sold without a prescriber's name.
            </p>
          )}
        </div>

        <div className="card p-4">
          <label className="label">{tr('Payment')}</label>
          <div className="grid grid-cols-3 gap-1">
            {(['cash', 'card', 'easypaisa', 'jazzcash', 'credit'] as const).map((m) => (
              <button key={m} onClick={() => cart.set({ payMethod: m })}
                className={`rounded-xl px-2 py-1.5 text-2xs capitalize ${
                  cart.payMethod === m ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted'}`}>
                {m}
              </button>
            ))}
          </div>
          {cart.payMethod === 'cash' && (
            <>
              <label className="label mt-3">{tr('Cash received')}</label>
              <input value={tendered} onChange={(e) => setTendered(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSell) complete() }}
                placeholder="0.00" className="field num text-right text-lg" />
              {toPaisa(tendered) > 0 && (
                <p className={`mt-1 text-right text-2xs num ${change >= 0 ? 'text-ok' : 'text-bad'}`}>
                  {change >= 0 ? `Change Rs ${rs(change)}` : `Short by Rs ${rs(-change)}`}
                </p>
              )}
            </>
          )}
        </div>

        <div className="panel mt-auto p-4">
          <dl className="space-y-1 text-sm">
            <Row k="Subtotal" v={rs(sums.gross)} />
            {sums.tax > 0 && <Row k="Tax" v={rs(sums.tax)} />}
            {sums.discount > 0 && <Row k="Discount" v={`-${rs(sums.discount)}`} />}
            <div className="flex justify-between border-t border-divide pt-2 text-lg font-semibold">
              <dt>{tr('Total')}</dt>
              <dd className="num text-primary">Rs {rs(total)}</dd>
            </div>
          </dl>
          <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
          <button onClick={complete} disabled={!canSell || busy} className="btn-primary mt-3 w-full py-3">
            {busy ? 'Saving…' : 'Complete sale'}
          </button>
          <p className="mt-2 text-center text-2xs text-muted">Signed in as {me.displayName}</p>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd className="num text-body">{v}</dd>
    </div>
  )
}
