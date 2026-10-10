import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Search, Trash2, Printer, ClipboardList, Wand2 } from 'lucide-react'
import { api, stockLabel, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Modal, Stat, Tabs, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

type Tab = 'new' | 'list'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 19:00 -> "7:00 pm". Nobody at this counter reads a 24-hour clock aloud. */
function slotLabel(weekday: number, atTime: string) {
  const [h, m] = String(atTime).split(':').map(Number)
  const hour12 = ((h ?? 0) % 12) || 12
  return `${tr(DAYS[weekday] ?? '')} ${hour12}:${String(m ?? 0).padStart(2, '0')} ` +
    `${(h ?? 0) < 12 ? tr('am') : tr('pm')}`
}

/**
 * Deciding what to buy.
 *
 * The screen is built around one number per row — how many units to order —
 * and everything else on the row exists to help somebody fill that number in
 * or decide to override it.
 *
 * The suggestion is what sold in the window, flat. Not scaled, and not
 * reduced by what is still on the shelf: a formula that quietly subtracts
 * stock produces numbers nobody can check by eye, and the pharmacist asked
 * for the sales figure itself. Stock is shown beside it anyway, because that
 * is the figure that makes somebody override the suggestion.
 */
export function Ordering({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<Tab>('new')

  return (
    <div className="space-y-4 p-4">
      <Tabs id="pharmacy-ordering" value={tab} onChange={(v) => setTab(v as Tab)}
        className="w-fit"
        tabs={[
          { value: 'new', label: tr('New order'), icon: Plus },
          { value: 'list', label: tr('Orders'), icon: ClipboardList }
        ]} />

      {tab === 'new' && <NewOrder me={me} onDone={() => setTab('list')} />}
      {tab === 'list' && <OrderList />}
    </div>
  )
}

/* ========================================================== the order sheet */

const WINDOWS: [number, string][] = [
  [7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days']
]

function NewOrder({ me, onDone }: { me: SessionUser; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [supplierId, setSupplierId] = useState<number>(0)
  const [days, setDays] = useState(7)
  const [rows, setRows] = useState<any[]>([])
  const [qty, setQty] = useState<Record<number, string>>({})
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)

  useEffect(() => {
    api.ph.supplierTerms().then(setSuppliers).catch((e: any) => setErr(e.message))
  }, [])

  const supplier = suppliers.find((s) => s.id === supplierId)

  /*
   * Changing the window rebuilds the suggestions but keeps anything typed.
   *
   * Somebody sets 30 days, types over four rows, then switches to 7 to
   * compare. Wiping their four corrections would make the timeframe selector
   * dangerous to touch, which is the opposite of what it is for — so typed
   * values are held in `qty` and the suggestion is only ever a default.
   */
  const load = useCallback(() => {
    if (!supplierId) { setRows([]); return }
    setLoading(true); setErr(null)
    api.ph.orderSheet(supplierId, days)
      .then((d) => setRows(d.rows))
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [supplierId, days])
  useEffect(load, [load])

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((r) =>
      String(r.product_name).toLowerCase().includes(term) ||
      String(r.manufacturer ?? '').toLowerCase().includes(term))
  }, [rows, q])

  /** Packs on the order: whatever was typed, or nothing if it was left alone. */
  const effective = (r: any) => {
    const typed = qty[r.product_id]
    if (typed === undefined) return 0
    const n = Number(typed)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }

  const picked = rows.filter((r) => effective(r) > 0)
  const totalPacks = picked.reduce((n, r) => n + effective(r), 0)
  const totalUnits = picked.reduce(
    (n, r) => n + effective(r) * Math.max(1, Number(r.pack_size ?? 1)), 0)

  function fillAll() {
    /*
     * Fills every row that sold something, leaving the rest empty.
     *
     * Filling zeros too would put nine hundred rows on the order and make
     * clearing them the job. A medicine that sold nothing in the window is
     * exactly the one not to reorder.
     */
    const next: Record<number, string> = { ...qty }
    for (const r of rows) {
      if (Number(r.suggest_packs) > 0 && next[r.product_id] === undefined) {
        next[r.product_id] = String(r.suggest_packs)
      }
    }
    setQty(next)
  }

  async function save() {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.createOrder({
        supplierId, windowDays: days, note: note.trim() || null,
        lines: picked.map((p) => ({
          productId: p.product_id,
          orderPacks: effective(p),
          soldUnits: Number(p.sold_units ?? 0),
          stockUnits: Number(p.stock_units ?? 0)
        }))
      })
      setDone(r); setQty({}); setNote('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  function print(id: number) {
    const path = `/pharma/orders/${id}/pdf`
    api.documentTicket(path).then(({ ticket }: any) => {
      window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank')
    }).catch((e: any) => setErr(e.message))
  }

  /* ------------------------------------------------------------- saved */

  if (done) {
    return (
      <Card title={tr('Order raised')} hint={done.order_no}>
        <div className="card-tint p-4 text-center">
          <p className="text-2xs uppercase tracking-wide text-muted">{tr('Order number')}</p>
          <p className="num text-3xl font-semibold text-primary">{done.order_no}</p>
          <p className="mt-1 text-2xs text-muted">
            {done.supplier_name} · {(done.items ?? []).length} {tr('medicines')} ·{' '}
            {(done.items ?? []).reduce((n: number, i: any) => n + Number(i.order_packs), 0)}{' '}
            {tr('packs')}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => print(done.id)}
            className="btn-primary inline-flex items-center gap-1.5">
            <Printer size={14} /> {tr('Print the order')}
          </button>
          <button onClick={() => setDone(null)} className="btn-ghost">
            {tr('Raise another')}
          </button>
          <button onClick={onDone} className="btn-ghost">{tr('See all orders')}</button>
        </div>
      </Card>
    )
  }

  /* ------------------------------------------------------------ normal */

  return (
    <div className="space-y-4">
      <Card title={tr('Who are you ordering from?')}
        hint={tr('Choosing a supplier narrows the list to the companies they carry.')}>
        <ErrorNote>{err}</ErrorNote>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}
            className="field">
            <option value={0}>{tr('Pick a supplier')}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {(s.companies ?? []).length > 0 && ` — ${(s.companies ?? []).length} ${tr('companies')}`}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-muted">{tr('Suggest from')}</span>
            {WINDOWS.map(([d, label]) => (
              <button key={d} onClick={() => setDays(d)}
                className={d === days ? 'btn-primary px-2.5 py-1 text-2xs'
                  : 'btn-ghost px-2.5 py-1 text-2xs'}>
                {tr(label)}
              </button>
            ))}
          </div>
        </div>

        {supplier && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(supplier.slots ?? []).length > 0 ? (
              (supplier.slots ?? []).map((s: any) => (
                <Badge key={s.id} tone="ok">
                  {tr('Books')} {slotLabel(Number(s.weekday), String(s.at_time))}
                </Badge>
              ))
            ) : (
              <span className="text-2xs text-muted">
                {tr('No booking time recorded for this supplier yet — set it under Suppliers & formulas.')}
              </span>
            )}
            {(supplier.companies ?? []).length === 0 && (
              <span className="text-2xs text-muted">
                {tr('No companies recorded, so every medicine is listed.')}
              </span>
            )}
          </div>
        )}
      </Card>

      {supplierId > 0 && (
        <Card title={tr('What to order')}
          hint={tr('Quantities are in PACKS, which is what the distributor ships. The suggestion is what sold in the chosen period, rounded up to whole packs.')}
          action={<button onClick={fillAll} disabled={!rows.length}
            className="btn-ghost inline-flex items-center gap-1.5">
            <Wand2 size={14} /> {tr('Fill from sales')}
          </button>}>

          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Search this list')} className="field pl-9" />
          </div>

          {loading ? (
            <p className="py-6 text-center text-2xs text-muted">{tr('Working out what sold…')}</p>
          ) : shown.length === 0 ? (
            <Empty title={tr('Nothing to show')}
              hint={tr('This supplier carries no medicines that match.')} />
          ) : (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full">
                <thead className="thead-strip sticky top-0 z-10">
                  <tr>
                    <Th>{tr('Medicine')}</Th>
                    <Th w="w-40">{tr('Company')}</Th>
                    <Th w="w-20">{tr('Pack')}</Th>
                    <Th w="w-24" right>{tr('Sold')}</Th>
                    <Th w="w-32" right>{tr('In stock')}</Th>
                    <Th w="w-28" right>{tr('Order packs')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide rows-striped anim-rows">
                  {shown.map((r) => {
                    const packSize = Math.max(1, Number(r.pack_size ?? 1))
                    /* `units` here is the number of PACKS typed into the box. */
                    const units = effective(r)
                    return (
                      <tr key={r.product_id} className={units > 0 ? 'bg-primary/5' : ''}>
                        <td className="px-3 py-2">
                          <span className="text-sm text-heading">{r.product_name}</span>
                          {Number(r.stock_units) === 0 && Number(r.sold_units) > 0 && (
                            <span className="ml-1.5 text-2xs text-amber-600">
                              {tr('out of stock')}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-2xs text-muted">{r.manufacturer ?? '—'}</td>
                        <td className="px-3 py-2 num text-2xs text-muted">
                          {r.pack_label ?? `${packSize}'s`}
                        </td>
                        <td className="px-3 py-2 text-right num text-sm text-primary">
                          {r.sold_units}
                        </td>
                        {/*
                          Pack and total units together. "250" alone does not
                          say whether that is twenty-five strips or two boxes,
                          and "25 packs" does not say what is left to sell.
                        */}
                        <td className="px-3 py-2 text-right num text-2xs text-muted">
                          {stockLabel(r.stock_units, r.pack_label, r.pack_size)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input inputMode="numeric" value={qty[r.product_id] ?? ''}
                            onChange={(e) => setQty({
                              ...qty,
                              [r.product_id]: e.target.value.replace(/[^\d]/g, '')
                            })}
                            placeholder={String(r.suggest_packs ?? 0)}
                            className="field num w-20 py-1 text-right" />
                          {units > 0 && (
                            <span className="mt-0.5 block num text-[0.6rem] text-muted">
                              {units * packSize} {tr('units')}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={tr('Note for the supplier (optional)')} className="field" />
              <p className="mt-1.5 text-2xs text-muted">
                {picked.length} {tr('medicines')} · {totalPacks} {tr('packs')} ·{' '}
                {totalUnits} {tr('units')} · {me.displayName}
              </p>
            </div>
            <button onClick={save} disabled={busy || picked.length === 0}
              className="btn-primary px-6 py-2.5">
              {busy ? tr('Saving…') : tr('Raise the order')}
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

/* ============================================================ past orders */

function OrderList() {
  const [rows, setRows] = useState<any[]>([])
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<any>(null)
  const [killing, setKilling] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    api.ph.orders(status ? { status } : {})
      .then(setRows).catch((e: any) => setErr(e.message))
  }, [status])
  useEffect(load, [load])

  function print(id: number) {
    const path = `/pharma/orders/${id}/pdf`
    api.documentTicket(path).then(({ ticket }: any) => {
      window.open(`/api${path}?ticket=${encodeURIComponent(ticket)}`, '_blank')
    }).catch((e: any) => setErr(e.message))
  }

  async function remove() {
    const a = killing
    setKilling(null); setErr(null); setNotice(null)
    try {
      const r = await api.ph.deleteOrder(a.id)
      setNotice(r.deleted
        ? `${a.order_no} ${tr('was deleted.')}`
        : (r.reason ?? `${a.order_no} ${tr('was cancelled.')}`))
      load()
    } catch (e: any) { setErr(e.message) }
  }

  const waiting = rows.filter((r) => r.status === 'open')

  return (
    <Card title={tr('Purchase orders')}
      hint={tr('An order stays open until a delivery is booked against it.')}>
      <ErrorNote>{err}</ErrorNote>
      {notice && (
        <p className="mb-3 rounded-lg border-2 border-line bg-primary/10 px-3 py-2
                      text-2xs text-body">{notice}</p>
      )}

      <div className="mb-3 grid gap-3 sm:grid-cols-[auto_1fr]">
        <div className="flex items-center gap-1.5">
          {[['', 'All'], ['open', 'Waiting'], ['received', 'Received'],
            ['cancelled', 'Cancelled']].map(([v, label]) => (
            <button key={v} onClick={() => setStatus(v)}
              className={v === status ? 'btn-primary px-2.5 py-1 text-2xs'
                : 'btn-ghost px-2.5 py-1 text-2xs'}>
              {tr(label)}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Stat label={tr('Waiting on suppliers')} value={String(waiting.length)} />
        </div>
      </div>

      {rows.length === 0 ? <Empty title={tr('No orders yet')} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Order')}</Th>
              <Th w="w-44">{tr('Supplier')}</Th>
              <Th w="w-28">{tr('Raised')}</Th>
              <Th w="w-20" right>{tr('Lines')}</Th>
              <Th w="w-24" right>{tr('Packs')}</Th>
              <Th w="w-28">{tr('Status')}</Th>
              <Th w="w-32" />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <button onClick={() => api.ph.order(r.id).then(setOpen).catch(() => {})}
                    className="num text-sm text-primary hover:underline">
                    {r.order_no}
                  </button>
                  <span className="block text-2xs text-muted">{r.created_by}</span>
                </td>
                <td className="px-3 py-2 text-sm text-heading">{r.supplier_name}</td>
                <td className="px-3 py-2 num text-2xs text-muted">
                  {new Date(r.created_at).toLocaleDateString('en-GB',
                    { day: '2-digit', month: 'short', year: '2-digit' })}
                </td>
                <td className="px-3 py-2 text-right num text-2xs text-muted">{r.lines}</td>
                <td className="px-3 py-2 text-right num text-sm text-heading">{r.packs}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.status === 'open' ? 'warn'
                    : r.status === 'received' ? 'ok' : 'muted'}>
                    {tr(r.status)}
                  </Badge>
                  {r.grn_no && (
                    <span className="block num text-[0.6rem] text-muted">{r.grn_no}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => print(r.id)} title={tr('Print')}
                      className="btn-ghost px-2 py-1"><Printer size={13} /></button>
                    <button onClick={() => setKilling(r)} title={tr('Delete')}
                      className="btn-ghost px-2 py-1 text-rose-600"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <Modal title={open.order_no} wide
          hint={`${open.supplier_name} · ${open.window_days} ${tr('days of sales')}`}
          onClose={() => setOpen(null)}
          footer={<button onClick={() => setOpen(null)} className="btn-ghost">
            {tr('Close')}
          </button>}>
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Medicine')}</Th>
                <Th w="w-24" right>{tr('Sold then')}</Th>
                <Th w="w-24" right>{tr('Stock then')}</Th>
                <Th w="w-32" right>{tr('Stock now')}</Th>
                <Th w="w-24" right>{tr('Ordered')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divide">
              {(open.items ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{i.product_name}</span>
                    <span className="block text-2xs text-muted">{i.manufacturer ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{i.sold_units}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{i.stock_units}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-primary">
                    {stockLabel(i.stock_now, i.pack_label, i.pack_size)}
                  </td>
                  <td className="px-3 py-2 text-right num text-sm text-heading">
                    {i.order_packs}
                    <span className="block num text-[0.6rem] text-muted">
                      {i.order_units} {tr('units')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {killing && (
        <Modal title={tr('Delete this order?')} onClose={() => setKilling(null)}
          footer={<>
            <button onClick={() => setKilling(null)} className="btn-ghost">{tr('Keep it')}</button>
            <button onClick={remove} className="btn-primary bg-rose-600">{tr('Delete')}</button>
          </>}>
          <p className="text-sm text-body">
            {killing.order_no} — {killing.supplier_name}, {killing.packs} {tr('packs')}.
          </p>
          <p className="mt-2 text-2xs text-muted">
            {tr('If a delivery has already been booked against this order it will be marked cancelled instead of removed, so the stock and the delivery keep their link.')}
          </p>
        </Modal>
      )}
    </Card>
  )
}
