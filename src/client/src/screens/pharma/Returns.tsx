import { useCallback, useEffect, useState } from 'react'
import { api, rs, today, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Stat, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Taking medicines back.
 *
 * Always against the original invoice. A return with no bill behind it is how
 * a counter leaks money — a strip bought somewhere else, or bought here at a
 * discount and refunded at full price. Finding the invoice first also settles
 * the price argument before it starts, because the refund is whatever that
 * line was actually charged.
 *
 * Two decisions per line, kept separate on purpose: how many come back, and
 * whether they go back on the shelf. A sealed box does; a half-used bottle
 * does not, and the customer is still owed their money.
 */
export function Returns({ me }: { me: SessionUser }) {
  const [invoiceNo, setInvoiceNo] = useState('')
  const [found, setFound] = useState<any>(null)
  const [lines, setLines] = useState<Record<number, { qty: number; restock: boolean }>>({})
  const [reason, setReason] = useState('')
  const [method, setMethod] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [recent, setRecent] = useState<any[]>([])

  const loadRecent = useCallback(() => {
    api.listReturns({ from: today(), to: today() }).then(setRecent).catch(() => {})
  }, [])
  useEffect(loadRecent, [loadRecent])

  async function lookup() {
    if (!invoiceNo.trim()) return
    setErr(null); setFound(null); setDone(null); setLines({})
    try {
      const d = await api.lookupSaleForReturn(invoiceNo.trim())
      setFound(d)
      if (d.items.every((i: any) => i.returnable === 0)) {
        setErr(tr('Everything on this invoice has already been returned.'))
      }
    } catch (e: any) { setErr(e.message) }
  }

  const refund = found
    ? found.items.reduce((n: number, i: any) =>
        n + (lines[i.id]?.qty ?? 0) * Number(i.unit_refund_paisa), 0)
    : 0
  const picked = Object.values(lines).filter((l) => l.qty > 0).length

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.createReturn({
        saleId: found.sale.id,
        lines: Object.entries(lines)
          .filter(([, l]) => l.qty > 0)
          .map(([id, l]) => ({ saleItemId: Number(id), qty: l.qty, restock: l.restock })),
        reason: reason.trim() || null,
        refundMethod: method
      })
      setDone(r); setFound(null); setLines({}); setReason(''); setInvoiceNo('')
      loadRecent()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  /* ------------------------------------------------------------- done */

  if (done) {
    return (
      <div className="p-4">
        <Card title={tr('Return accepted')} hint={done.return_no}>
          <div className="card-tint p-4 text-center">
            <p className="text-2xs uppercase tracking-wide text-muted">
              {done.refund_to === 'ledger' ? tr('Credited to their account') : tr('Give back')}
            </p>
            <p className="num text-4xl font-semibold text-primary">Rs {rs(done.total_paisa)}</p>
            {done.refund_to === 'ledger' && (
              <p className="mt-1 text-2xs text-muted">
                {tr('This was a credit sale, so nothing comes out of the drawer.')}
              </p>
            )}
          </div>

          <ul className="mt-4 divide-y divide-divide">
            {done.items.map((i: any, k: number) => (
              <li key={k} className="flex items-center justify-between py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-heading">{i.product_name}</span>
                  <span className="block text-2xs text-muted">
                    {i.returned} {tr('returned')}
                    {' · '}
                    {i.restock ? tr('back on the shelf') : tr('written off, not resaleable')}
                  </span>
                </span>
                <span className="num text-sm text-primary">{rs(i.refund)}</span>
              </li>
            ))}
          </ul>

          <button onClick={() => setDone(null)} className="btn-primary mt-4 w-full">
            {tr('Take another return')}
          </button>
        </Card>
      </div>
    )
  }

  /* ------------------------------------------------------------ normal */

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Card title={tr('Find the invoice')}
          hint={tr('A return is always against the bill it was sold on')}>
          <div className="flex gap-2">
            <input autoFocus value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && lookup()}
              placeholder={tr('Invoice number, e.g. S-000412')}
              className="field num flex-1" />
            <button onClick={lookup} disabled={!invoiceNo.trim()} className="btn-primary">
              {tr('Find')}
            </button>
          </div>
          <ErrorNote>{err}</ErrorNote>
        </Card>

        {found && (
          <Card title={found.sale.invoice_no}
            hint={`${found.sale.party_name ?? found.sale.customer_name ?? tr('Walk-in')} · ${
              new Date(found.sale.sold_at).toLocaleString('en-GB',
                { day: '2-digit', month: 'short', year: 'numeric',
                  hour: '2-digit', minute: '2-digit' })}`}>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Badge tone={found.sale.sale_kind === 'credit' ? 'warn' : 'ok'}>
                {tr(found.sale.sale_kind)}
              </Badge>
              <span className="num text-2xs text-muted">
                {tr('Bill total')} Rs {rs(found.sale.total_paisa)}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="thead-strip">
                  <tr>
                    <Th>{tr('Medicine')}</Th>
                    <Th w="w-20" right>{tr('Sold')}</Th>
                    <Th w="w-24" right>{tr('Rate')}</Th>
                    <Th w="w-28" right>{tr('Bring back')}</Th>
                    <Th w="w-36">{tr('Condition')}</Th>
                    <Th w="w-24" right>{tr('Refund')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide rows-striped anim-rows">
                  {found.items.map((i: any) => {
                    const line = lines[i.id] ?? { qty: 0, restock: true }
                    const spent = Number(i.already_returned)
                    return (
                      <tr key={i.id} className={i.returnable === 0 ? 'opacity-45' : ''}>
                        <td className="px-3 py-2">
                          <span className="text-sm text-heading">{i.product_name}</span>
                          <span className="block num text-2xs text-muted">
                            {i.batch_no ?? '—'}
                            {i.expiry_date && ` · ${tr('exp')} ${String(i.expiry_date).slice(0, 7)}`}
                            {spent > 0 && ` · ${spent} ${tr('already returned')}`}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right num text-2xs">{i.display_qty}</td>
                        <td className="px-3 py-2 text-right num text-2xs text-muted">
                          {rs(i.unit_refund_paisa)}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <button disabled={line.qty <= 0}
                              onClick={() => setLines((l) => ({
                                ...l, [i.id]: { ...line, qty: Math.max(0, line.qty - 1) } }))}
                              className="rounded-lg border-2 border-line px-2 text-muted
                                         hover:bg-raised disabled:opacity-30">&minus;</button>
                            <input value={line.qty}
                              onChange={(e) => {
                                const v = Math.max(0,
                                  Math.min(i.returnable, Number(e.target.value) || 0))
                                setLines((l) => ({ ...l, [i.id]: { ...line, qty: v } }))
                              }}
                              disabled={i.returnable === 0}
                              className="field w-12 py-1 text-center text-2xs num" />
                            <button disabled={line.qty >= i.returnable}
                              onClick={() => setLines((l) => ({
                                ...l,
                                [i.id]: { ...line, qty: Math.min(i.returnable, line.qty + 1) } }))}
                              className="rounded-lg border-2 border-line px-2 text-muted
                                         hover:bg-raised disabled:opacity-30">+</button>
                          </div>
                          <span className="mt-0.5 block text-right text-2xs text-muted">
                            {tr('up to')} {i.returnable}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          {/*
                            Kept separate from the quantity. A half-used bottle
                            is still refunded but must not go back on a shelf,
                            and collapsing the two is how tampered stock
                            becomes saleable again.
                          */}
                          <div className="flex gap-1">
                            {([[true, 'Sealed'], [false, 'Damaged']] as const).map(([v, label]) => (
                              <button key={String(v)} disabled={line.qty === 0}
                                onClick={() => setLines((l) => ({
                                  ...l, [i.id]: { ...line, restock: v } }))}
                                className={`flex-1 rounded-lg border-2 px-1 py-1 text-2xs ${
                                  line.qty === 0 ? 'border-line text-muted opacity-40'
                                    : line.restock === v
                                      ? v ? 'border-ok bg-ok/10 font-medium text-ok'
                                          : 'border-bad bg-bad/10 font-medium text-bad'
                                      : 'border-line text-muted hover:bg-raised'}`}>
                                {tr(label)}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right num text-sm text-primary">
                          {line.qty > 0 ? rs(line.qty * Number(i.unit_refund_paisa)) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* -------------------------------------------------------- sidebar */}
      <div className="space-y-4">
        {found ? (
          <Card title={tr('Refund')}>
            <div className="card-tint p-4 text-center">
              <p className="text-2xs uppercase tracking-wide text-muted">
                {picked} {tr('of')} {found.items.length} {tr('lines')}
              </p>
              <p className="num text-3xl font-semibold text-primary">Rs {rs(refund)}</p>
            </div>

            {found.sale.sale_kind === 'credit' ? (
              <p className="mt-3 rounded-xl border-2 border-warn/40 bg-warn/5 p-3 text-2xs text-warn">
                {tr('This was sold on account, so the refund goes to their ledger rather than out of the drawer.')}
              </p>
            ) : (
              <>
                <label className="label mt-3">{tr('Give back as')}</label>
                <div className="grid grid-cols-3 gap-1">
                  {['cash', 'easypaisa', 'card'].map((m) => (
                    <button key={m} onClick={() => setMethod(m)}
                      className={`rounded-xl px-2 py-1.5 text-2xs capitalize ${
                        method === m ? 'bg-brand text-white'
                          : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
                      {tr(m)}
                    </button>
                  ))}
                </div>
              </>
            )}

            <Field label={tr('Why')} hint={tr('Printed on the return slip')} span>
              <input value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={tr('Wrong medicine, patient did not need it')}
                className="field mt-2" />
            </Field>

            <button onClick={save} disabled={busy || refund <= 0}
              className="btn-primary mt-4 w-full py-3">
              {busy ? tr('Saving…') : `${tr('Accept the return')} — Rs ${rs(refund)}`}
            </button>
            <p className="mt-2 text-center text-2xs text-muted">{me.displayName}</p>
          </Card>
        ) : (
          <Card title={tr('Today')}>
            <Stat label={tr('Returns today')} value={String(recent.length)}
              sub={`Rs ${rs(recent.reduce((n, r) => n + Number(r.total_paisa), 0))} ${tr('refunded')}`}
              tone={recent.length ? 'warn' : undefined} />
          </Card>
        )}

        <Card title={tr('Recent returns')}>
          {recent.length === 0 ? <Empty title={tr('Nothing returned today')} /> : (
            <ul className="divide-y divide-divide">
              {recent.slice(0, 10).map((r) => (
                <li key={r.id} className="py-2">
                  <div className="flex justify-between gap-2">
                    <span className="num text-2xs text-primary">{r.return_no}</span>
                    <span className="num text-sm text-heading">{rs(r.total_paisa)}</span>
                  </div>
                  <span className="block text-2xs text-muted">
                    {tr('against')} {r.invoice_no ?? '—'} · {r.lines} {tr('lines')}
                    {r.written_off > 0 && ` · ${r.written_off} ${tr('written off')}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
