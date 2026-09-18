import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa, today, type SearchHit, newId} from '../../lib/api'
import { Card, Empty, ErrorNote, Field, Modal, Th } from '../../components/ui'
import { ExpiryPill } from '../../components/Expiry'
import { t as tr } from '../../lib/prefs'

type Line = {
  key: string; productId: number; name: string; packSize: number; unitLabel: string
  batchNo: string; expiryDate: string; qty: string; bonusQty: string
  cost: string; retailPaisa: number
}

const blank = (p: SearchHit): Line => ({
  key: newId(), productId: p.id, name: p.name,
  packSize: p.pack_size, unitLabel: p.unit_label,
  batchNo: '', expiryDate: '', qty: '1', bonusQty: '0',
  // Cost is prefilled from the medicine and can be corrected per delivery,
  // because what a supplier charges does move. The sale price cannot.
  cost: p.purchase_paisa ? (p.purchase_paisa / 100).toFixed(2) : '',
  retailPaisa: p.retail_paisa ?? 0
})

/**
 * Goods receipt: one supplier invoice, many medicines, each with its own batch,
 * expiry and prices. The whole note commits in one transaction, so a delivery
 * either lands completely or not at all.
 */
export function Receive() {
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

  const loadSuppliers = useCallback(() => { api.ph.suppliers().then(setSuppliers).catch(() => {}) }, [])
  useEffect(() => { loadSuppliers(); api.ph.purchases().then(setRecent).catch(() => {}) }, [loadSuppliers])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => api.productSearch(q).then(setHits).catch(() => setHits([])), 150)
    return () => clearTimeout(t)
  }, [q])

  const patch = (key: string, p: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))

  const invoiceTotal = lines.reduce((n, l) => n + toPaisa(l.cost) * (Number(l.qty) || 0), 0)
  const ready = supplierId > 0 && invoiceNo.trim() && lines.length > 0 &&
    lines.every((l) => l.batchNo.trim() && l.expiryDate && Number(l.qty) > 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.receiveGoods({
        supplierId, supplierInvoiceNo: invoiceNo.trim(), invoiceDate,
        lines: lines.map((l) => ({
          productId: l.productId, batchNo: l.batchNo.trim(), expiryDate: l.expiryDate,
          qty: Number(l.qty), bonusQty: Number(l.bonusQty) || 0,
          costPaisa: toPaisa(l.cost)
        }))
      })
      setDone(r)
      setLines([]); setInvoiceNo('')
      api.ph.purchases().then(setRecent).catch(() => {})
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="p-4">
        <Card title={tr('Delivery received')}>
          <p className="num text-3xl font-semibold text-primary">Rs {rs(done.purchase.totalPaisa)}</p>
          <p className="mt-1 text-2xs text-muted">
            Invoice {done.purchase.supplierInvoiceNo} · {done.batches?.length ?? 0} batches added to the shelf
          </p>
          <button onClick={() => setDone(null)} className="btn-primary mt-4">{tr('Receive another')}</button>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Receive stock')} hint={tr('One supplier invoice, as many medicines as it covers')}
        action={<button onClick={() => setManaging(true)} className="btn-ghost">{tr('Manage suppliers')}</button>}>
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
                      {rs(toPaisa(l.cost) * (Number(l.qty) || 0))}
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

        <div className="mt-3 flex items-center justify-between border-t border-divide pt-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-muted">{tr('Invoice total')}</p>
            <p className="num text-2xl font-semibold text-primary">Rs {rs(invoiceTotal)}</p>
          </div>
          <button onClick={save} disabled={!ready || busy} className="btn-primary">
            {busy ? 'Saving…' : 'Receive delivery'}
          </button>
        </div>
      </Card>

      <Card title={tr('Recent deliveries')}>
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

      {managing && <Suppliers onClose={() => { setManaging(false); loadSuppliers() }} />}
    </div>
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
