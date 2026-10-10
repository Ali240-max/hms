import { useCallback, useEffect, useState } from 'react'
import { Inbox, ClipboardList } from 'lucide-react'
import { api, rs, toPaisa, today, stockLabel, type SearchHit, newId} from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Tabs, Th } from '../../components/ui'
import { ExpiryPill } from '../../components/Expiry'
import { t as tr } from '../../lib/prefs'

type Line = {
  key: string; productId: number; name: string; packSize: number; unitLabel: string
  batchNo: string; expiryDate: string; qty: string; bonusQty: string
  cost: string; retailPaisa: number
  /** Sales tax this medicine carries on this delivery, as a percentage. */
  tax: string
  /** Packs asked for on the order this line came from, where it came from one. */
  orderedPacks?: number
}

const blank = (p: SearchHit): Line => ({
  key: newId(), productId: p.id, name: p.name,
  packSize: p.pack_size, unitLabel: p.unit_label,
  batchNo: '', expiryDate: '', qty: '1', bonusQty: '0',
  // Cost is prefilled from the medicine and can be corrected per delivery,
  // because what a supplier charges does move. The sale price cannot.
  cost: p.purchase_paisa ? (p.purchase_paisa / 100).toFixed(2) : '',
  retailPaisa: p.retail_paisa ?? 0,
  /*
   * The medicine's own rate, offered as the default.
   *
   * Tax lives on the line rather than being read off the product at save
   * time, because what a distributor charged tax at is a fact about the
   * invoice in front of you — and it does vary between deliveries.
   */
  tax: p.tax_rate_bp ? String(Number(p.tax_rate_bp) / 100) : '0'
})

/**
 * Goods receipt: one supplier invoice, many medicines, each with its own batch,
 * expiry and prices. The whole note commits in one transaction, so a delivery
 * either lands completely or not at all.
 */
export function Receive() {
  const [tab, setTab] = useState<'receive' | 'orders'>('receive')
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [supplierId, setSupplierId] = useState(0)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(today())
  const [lines, setLines] = useState<Line[]>([])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)
  const [managing, setManaging] = useState(false)
  const [recent, setRecent] = useState<any[]>([])

  /** The order this delivery is answering, once one has been picked. */
  const [fromOrder, setFromOrder] = useState<any>(null)
  /** Whatever the distributor adds at the bottom of the invoice, as a %. */
  const [extra, setExtra] = useState('0')

  const loadSuppliers = useCallback(() => { api.ph.suppliers().then(setSuppliers).catch(() => {}) }, [])
  useEffect(() => { loadSuppliers(); api.ph.purchases().then(setRecent).catch(() => {}) }, [loadSuppliers])

  /**
   * Turn an order into delivery lines.
   *
   * The order is written in units and this screen counts packs, so the
   * conversion happens here rather than in somebody's head. It is rounded,
   * not floored: 95 units of a 10-pack is ten packs, because a depot ships
   * whole packs and shorting the shop by one is the wrong way to guess.
   *
   * Batch, expiry and cost are deliberately left empty. Those come off the
   * delivery note in the box, not off the order — prefilling them with
   * anything would be inventing a batch number, which is the one field here
   * that must never be guessed.
   */
  function fillFromOrder(order: any) {
    setFromOrder(order)
    setSupplierId(Number(order.supplier_id))
    setLines((order.items ?? []).map((i: any) => {
      const packSize = Math.max(1, Number(i.pack_size ?? 1))
      const packs = Number(i.order_packs ?? 0)
      return {
        key: newId(),
        productId: Number(i.product_id),
        name: String(i.product_name),
        packSize,
        unitLabel: 'pack',
        batchNo: '', expiryDate: '',
        /*
         * Straight across, no conversion.
         *
         * The order is placed in packs and this screen counts packs, so there
         * is nothing to divide. It used to hold units and this line rounded
         * them into packs, which meant the figure on the screen could differ
         * from the figure on the order sheet the rep was holding.
         */
        qty: String(Math.max(1, packs)),
        bonusQty: '0',
        cost: '',
        retailPaisa: 0,
        tax: '0',
        orderedPacks: packs
      } as Line
    }))
    setTab('receive')
  }

  function clearOrder() {
    setFromOrder(null)
    setLines([])
  }

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => api.productSearch(q).then(setHits).catch(() => setHits([])), 150)
    return () => clearTimeout(t)
  }, [q])

  const patch = (key: string, p: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))

  /*
   * Goods, then the tax on each line, then whatever the invoice adds at the
   * bottom.
   *
   * Bonus packs are excluded throughout: they are free, so they are neither
   * charged nor taxed. Tax is rounded once per line so the sum of the lines
   * agrees with the total printed on the distributor's paper, which is the
   * figure somebody will check this against.
   */
  const lineNet = (l: Line) => toPaisa(l.cost) * (Number(l.qty) || 0)
  const lineTax = (l: Line) =>
    Math.round(lineNet(l) * (Number(l.tax) || 0)) / 100
  const goodsTotal = lines.reduce((n, l) => n + lineNet(l), 0)
  const taxTotal = lines.reduce((n, l) => n + lineTax(l), 0)
  const extraTax = Math.round((goodsTotal + taxTotal) * (Number(extra) || 0)) / 100
  const invoiceTotal = goodsTotal + taxTotal + extraTax
  const ready = supplierId > 0 && invoiceNo.trim() && lines.length > 0 &&
    lines.every((l) => l.batchNo.trim() && l.expiryDate && Number(l.qty) > 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.receiveGoods({
        supplierId, supplierInvoiceNo: invoiceNo.trim(), invoiceDate,
        /*
         * Sent so the delivery and the order keep their link, and so the
         * order closes in the same transaction as the stock. Closing it in a
         * second call would leave a window where the stock is in and the
         * order still looks open — and if that call failed, forever.
         */
        purchaseOrderId: fromOrder ? Number(fromOrder.id) : undefined,
        extraTaxBp: Math.round((Number(extra) || 0) * 100),
        lines: lines.map((l) => ({
          productId: l.productId, batchNo: l.batchNo.trim(), expiryDate: l.expiryDate,
          qty: Number(l.qty), bonusQty: Number(l.bonusQty) || 0,
          costPaisa: toPaisa(l.cost),
          taxRateBp: Math.round((Number(l.tax) || 0) * 100)
        }))
      })
      setDone({ ...r, order: fromOrder })
      setLines([]); setInvoiceNo(''); setFromOrder(null); setExtra('0')
      api.ph.purchases().then(setRecent).catch(() => {})
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="p-4">
        <Card title={tr('Delivery received')}>
          <p className="num text-3xl font-semibold text-primary">Rs {rs(done.purchase.totalPaisa)}</p>
          <p className="mt-1 text-2xs text-muted">
            Invoice {done.purchase.supplierInvoiceNo} · {done.purchase.grnNo ?? ''} ·{' '}
            {done.lines ?? 0} {tr('lines added to the shelf')}
          </p>
          {done.order && (
            <p className="mt-2 text-2xs text-body">
              {tr('Order')} {done.order.order_no} {tr('is now closed.')}
            </p>
          )}
          <button onClick={() => setDone(null)} className="btn-primary mt-4">{tr('Receive another')}</button>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <Tabs id="pharmacy-receive" value={tab} onChange={(v) => setTab(v as any)}
        className="w-fit"
        tabs={[
          { value: 'receive', label: tr('Receive stock'), icon: Inbox },
          { value: 'orders', label: tr('Waiting orders'), icon: ClipboardList }
        ]} />

      {tab === 'orders' && <OpenOrders onPick={fillFromOrder} />}

      {tab === 'receive' && (<>
      <Card title={tr('Receive stock')} hint={tr('One supplier invoice, as many medicines as it covers')}
        action={<button onClick={() => setManaging(true)} className="btn-ghost">{tr('Manage suppliers')}</button>}>
        {fromOrder && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl
                          border-2 border-primary/40 bg-primary/10 px-3 py-2">
            <span className="text-2xs text-body">
              {tr('Against order')}{' '}
              <span className="num font-semibold">{fromOrder.order_no}</span>
              {' · '}{(fromOrder.items ?? []).length} {tr('medicines')}
              {' · '}
              {/*
                Quantities are prefilled in packs from an order written in
                units. Saying so here is the difference between somebody
                checking the figures and somebody trusting them.
              */}
              {tr('quantities are the packs that were ordered — check them against the delivery note')}
            </span>
            <button onClick={clearOrder} className="btn-ghost px-2 py-1 text-2xs">
              {tr('Not against an order')}
            </button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr('Supplier')}>
            <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))} className="field">
              <option value={0}>{tr('Choose a supplier')}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={tr('Their invoice number')}>
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder={tr('INV-4471')} className="field num" />
          </Field>
          <Field label={tr('Invoice date')}>
            <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)}
              className="field num" />
          </Field>
        </div>

        <div className="relative mt-4">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search a medicine to add to this delivery')} className="field" />
          {hits.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-2xl border-2 border-line bg-card shadow-lg">
              {hits.map((h) => (
                <li key={h.id} onClick={() => { setLines((ls) => [...ls, blank(h)]); setQ(''); setHits([]) }}
                  className="flex cursor-pointer items-center justify-between border-b border-divide px-3 py-2 last:border-0 hover:bg-primary/5">
                  <span>
                    <span className="block text-sm text-heading">{h.name}</span>
                    <span className="block text-2xs text-muted">
                      {[h.generic_name, h.manufacturer].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="num text-2xs text-muted">{h.total_qty} in stock</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lines.length === 0 ? (
          <Empty title={tr('No items on this delivery note yet')}
            hint={tr('Search above to add the medicines this invoice covers.')} />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Medicine')}</Th><Th w="w-28">{tr('Batch')}</Th><Th w="w-32">{tr('Expiry')}</Th>
                  <Th w="w-20" right>{tr('Packs')}</Th><Th w="w-20" right>{tr('Bonus')}</Th>
                  <Th w="w-24" right>{tr('Cost')}</Th><Th w="w-28" right>{tr('Sells at')}</Th>
                  <Th w="w-24" right>{tr('Line')}</Th><Th w="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{l.name}</span>
                      <span className="block text-2xs text-muted">
                        {l.packSize > 1 ? `${l.packSize} per ${l.unitLabel}` : l.unitLabel}
                        {l.orderedPacks != null &&
                          ` · ${tr('ordered')} ${l.orderedPacks} ${tr('packs')}`}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.batchNo} onChange={(e) => patch(l.key, { batchNo: e.target.value })}
                        placeholder={tr('Batch')} className="field py-1 text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      <input type="date" value={l.expiryDate}
                        onChange={(e) => patch(l.key, { expiryDate: e.target.value })}
                        className="field py-1 text-2xs num" />
                      {l.expiryDate && <div className="mt-0.5"><ExpiryPill date={l.expiryDate} showDate={false} /></div>}
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })}
                        className="field py-1 text-right text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.bonusQty} onChange={(e) => patch(l.key, { bonusQty: e.target.value })}
                        className="field py-1 text-right text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.cost} onChange={(e) => patch(l.key, { cost: e.target.value })}
                        placeholder="0.00" className="field py-1 text-right text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      {/*
                        Per line, defaulted from the medicine and correctable.
                        What a distributor charged tax at is a fact about the
                        invoice in front of you, and it does vary between
                        deliveries of the same medicine.
                      */}
                      <input value={l.tax} onChange={(e) => patch(l.key, { tax: e.target.value })}
                        placeholder="0" className="field py-1 text-right text-2xs num" />
                    </td>
                    <td className="px-2 py-2 text-right">
                      {/*
                        Read-only. The sale price belongs to the medicine, set
                        once when it is added, not decided again on every
                        delivery — that is how the same tablet ends up with
                        three prices on three shelves and the counter has to be
                        told which one to use.
                      */}
                      <span className="num text-2xs text-muted">{rs(l.retailPaisa ?? 0)}</span>
                    </td>
                    <td className="px-2 py-2 text-right num text-2xs text-primary">
                      {rs(lineNet(l) + lineTax(l))}
                      {lineTax(l) > 0 && (
                        <span className="block num text-[0.6rem] text-muted">
                          +{rs(lineTax(l))} {tr('tax')}
                        </span>
                      )}
                    </td>
                    <td className="pr-2 text-right">
                      <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">&times;</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-2xs text-muted">
              Bonus packs are the free ones on a deal like 10+1. They reach the shelf but
              are not charged, so the average cost falls.
            </p>
          </div>
        )}

        <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>

        <div className="mt-3 grid gap-3 border-t border-divide pt-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-6 text-2xs">
              <span className="text-muted">{tr('Goods')}</span>
              <span className="num text-body">Rs {rs(goodsTotal)}</span>
            </div>
            {taxTotal > 0 && (
              <div className="flex items-center justify-between gap-6 text-2xs">
                <span className="text-muted">{tr('Sales tax on the lines')}</span>
                <span className="num text-body">Rs {rs(taxTotal)}</span>
              </div>
            )}
            {/*
              The invoice-level tax.

              Applied to goods plus the per-line tax, which is what the
              distributors here do: the levy at the bottom is computed on the
              invoice as it stands. Taking it off the goods alone would
              under-state every delivery by a few rupees and leave the ledger
              disagreeing with the paper.
            */}
            <div className="flex items-center justify-between gap-6 text-2xs">
              <span className="text-muted">{tr('Advance Income Tax US 236-H')}</span>
              <span className="flex items-center gap-1.5">
                <input value={extra} onChange={(e) => setExtra(e.target.value)}
                  placeholder="0" className="field num w-16 py-0.5 text-right text-2xs" />
                <span className="text-muted">%</span>
                <span className="num w-20 text-right text-body">Rs {rs(extraTax)}</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-6 border-t
                            border-divide pt-1">
              <span className="text-2xs uppercase tracking-wide text-muted">
                {tr('Invoice total')}
              </span>
              <span className="num text-2xl font-semibold text-primary">
                Rs {rs(invoiceTotal)}
              </span>
            </div>
          </div>
          <button onClick={save} disabled={!ready || busy}
            className="btn-primary self-end px-6 py-2.5">
            {busy ? tr('Saving…') : tr('Receive delivery')}
          </button>
        </div>
      </Card>

      <Card title={tr('Recent deliveries')}
        hint={tr('The last twelve. The full record, with who booked each one in, is the Goods Received Register under Reports.')}
        action={<button onClick={printReceipts}
          className="btn-ghost px-2.5 py-1 text-2xs">
          {tr('Print the register')}
        </button>}>
        {recent.length === 0 ? <Empty title={tr('No deliveries recorded yet')} /> : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr><Th>{tr('Supplier')}</Th><Th w="w-32">{tr('Invoice')}</Th><Th w="w-28">{tr('Date')}</Th>
                <Th w="w-20" right>{tr('Items')}</Th><Th w="w-28" right>{tr('Total')}</Th></tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {recent.slice(0, 12).map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 text-sm text-heading">{p.supplier_name}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">{p.supplier_invoice_no}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">{p.invoice_date}</td>
                  <td className="px-3 py-2 text-right num text-2xs">{p.line_count}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-primary">{rs(p.total_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      </>)}

      {managing && <Suppliers onClose={() => { setManaging(false); loadSuppliers() }} />}
    </div>
  )

  /**
   * The goods received register, printed from here.
   *
   * The report lives in the Reports tab like every other report, which is
   * where it belongs — but somebody standing at the delivery door checking
   * what came in this month should not have to go and find it. Same report,
   * same format, reachable from the screen where the question comes up.
   */
  function printReceipts() {
    const to = today()
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const path = '/reports/print/purchase-grn-register/pdf'
    api.documentTicket(path).then(({ ticket }: any) => {
      window.open(
        `/api${path}?from=${from}&to=${to}&ticket=${encodeURIComponent(ticket)}`, '_blank')
    }).catch((e: any) => setErr(e.message))
  }
}

/* ----------------------------------------------------------- open orders */

/**
 * Orders still waiting on a supplier.
 *
 * Picking one fills the delivery form with its medicines, which is the whole
 * point: a rep turns up with a box and a delivery note, and typing forty
 * medicines back in by hand when the shop already said what it wanted is
 * where mistakes come from.
 */
function OpenOrders({ onPick }: { onPick: (order: any) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.ph.orders({ status: 'open' }).then(setRows).catch((e: any) => setErr(e.message))
  }, [])

  return (
    <Card title={tr('Orders waiting on a supplier')}
      hint={tr('Pick one to start a delivery against it. Receiving closes the order.')}>
      <ErrorNote>{err}</ErrorNote>
      {rows.length === 0 ? (
        <Empty title={tr('No orders waiting')}
          hint={tr('Raise one under Order, in the Stock group.')} />
      ) : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Order')}</Th>
              <Th w="w-44">{tr('Supplier')}</Th>
              <Th w="w-28">{tr('Raised')}</Th>
              <Th w="w-20" right>{tr('Lines')}</Th>
              <Th w="w-24" right>{tr('Packs')}</Th>
              <Th w="w-32" />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <span className="num text-sm text-heading">{r.order_no}</span>
                  <span className="block text-2xs text-muted">{r.created_by}</span>
                </td>
                <td className="px-3 py-2 text-sm text-heading">{r.supplier_name}</td>
                <td className="px-3 py-2 num text-2xs text-muted">
                  {new Date(r.created_at).toLocaleDateString('en-GB',
                    { day: '2-digit', month: 'short', year: '2-digit' })}
                </td>
                <td className="px-3 py-2 text-right num text-2xs text-muted">{r.lines}</td>
                <td className="px-3 py-2 text-right num text-sm text-heading">{r.packs}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => api.ph.order(r.id).then(onPick)
                      .catch((e: any) => setErr(e.message))}
                    className="btn-primary px-2.5 py-1 text-2xs">
                    {tr('Receive this')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-2xs text-muted">
        <Badge tone="warn">{rows.length}</Badge>{' '}
        {tr('waiting. An order that never arrives stays here until you delete it under Order.')}
      </p>
    </Card>
  )
}

/* --------------------------------------------------------------- suppliers */

function Suppliers({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [f, setF] = useState({ name: '', phone: '', address: '', ntn: '' })
  const [editId, setEditId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => { api.ph.suppliers(true).then(setRows).catch(() => {}) }, [])
  useEffect(load, [load])

  async function save() {
    setErr(null)
    try {
      editId ? await api.ph.updateSupplier(editId, f) : await api.ph.createSupplier(f)
      setF({ name: '', phone: '', address: '', ntn: '' }); setEditId(null); load()
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <Modal title={tr('Suppliers')} wide onClose={onClose}
      footer={<button onClick={onClose} className="btn-ghost">{tr('Done')}</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Name')}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
          placeholder={tr('Muslim Distributors')} className="field" /></Field>
        <Field label={tr('Phone')}><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })}
          className="field num" /></Field>
        <Field label={tr('Address')}><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })}
          className="field" /></Field>
        <Field label={tr('NTN')}><input value={f.ntn} onChange={(e) => setF({ ...f, ntn: e.target.value })}
          className="field num" /></Field>
      </div>
      <div className="mt-2 flex gap-2">
        <button onClick={save} disabled={!f.name.trim()} className="btn-primary">
          {editId ? 'Save changes' : 'Add supplier'}
        </button>
        {editId && (
          <button onClick={() => { setEditId(null); setF({ name: '', phone: '', address: '', ntn: '' }) }}
            className="btn-ghost">{tr('Cancel')}</button>
        )}
      </div>
      <ErrorNote>{err}</ErrorNote>
      {note && <p className="mt-2 rounded-xl border border-warn/25 bg-warn/5 px-3 py-2 text-2xs text-warn">{note}</p>}

      <table className="mt-4 w-full">
        <thead className="thead-strip">
          <tr><Th>{tr('Supplier')}</Th><Th w="w-28">{tr('Phone')}</Th><Th w="w-24" right>{tr('Deliveries')}</Th><Th w="w-32" right /></tr>
        </thead>
        <tbody className="divide-y divide-divide rows-striped anim-rows">
          {rows.map((s) => (
            <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
              <td className="px-3 py-2 text-sm text-heading">
                {s.name}{!s.is_active && <span className="ml-2 text-2xs text-muted">{tr('archived')}</span>}
              </td>
              <td className="px-3 py-2 num text-2xs text-muted">{s.phone ?? '—'}</td>
              <td className="px-3 py-2 text-right num text-2xs">{s.deliveries}</td>
              <td className="px-3 py-2 text-right">
                <button className="btn-ghost px-2 py-1 text-2xs"
                  onClick={() => { setEditId(s.id); setF({ name: s.name, phone: s.phone ?? '', address: s.address ?? '', ntn: s.ntn ?? '' }) }}>
                  {tr('Edit')}
                </button>
                {s.is_active ? (
                  <button className="btn-ghost ml-1 px-2 py-1 text-2xs"
                    onClick={async () => {
                      setNote(null); setErr(null)
                      try {
                        const r = await api.ph.deleteSupplier(s.id)
                        if (r.action === 'archived') setNote(r.reason ?? null)
                        load()
                      } catch (e: any) { setErr(e.message) }
                    }}>{tr('Remove')}</button>
                ) : (
                  <button className="btn-ghost ml-1 px-2 py-1 text-2xs"
                    onClick={async () => { await api.ph.restoreSupplier(s.id); load() }}>{tr('Restore')}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
