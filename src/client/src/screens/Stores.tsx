import { motion } from 'framer-motion'
import { DUR, EASE } from '../lib/motion'
import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa, today, newId, type SessionUser } from '../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../components/ui'
import { t as tr } from '../lib/prefs'
import { Sidebar, type NavItem } from '../components/Sidebar'

type Tab = 'stock' | 'issue' | 'receive' | 'movements' | 'reports'

const NAV: (NavItem & { id: Tab })[] = [
  { id: 'stock', label: 'Stock', glyph: 'S' },
  { id: 'issue', label: 'Issue', glyph: 'out' },
  { id: 'receive', label: 'Receive', glyph: 'in' },
  { id: 'movements', label: 'Movements', glyph: 'M' },
  { id: 'reports', label: 'Reports', glyph: 'Rp' }
]

const FILTERS: [string, string][] = [
  ['all', 'All'], ['low', 'Low'], ['out', 'Out of stock'],
  ['expiring', 'Expiring'], ['archived', 'Archived']
]

/**
 * The hospital store.
 *
 * Not the pharmacy. This is gauze, cannulas, gloves, IV sets and linen —
 * things that get used rather than sold, issued to a department rather than
 * billed to a patient. Kept as its own module for that reason: none of the
 * pharmacy's machinery around prices, tax and invoices applies, and mixing
 * them would produce a stock figure that means two different things.
 */
export function Stores({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<Tab>('stock')
  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={NAV} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Stores" subtitle={me.displayName} />
      {/*
        A keyed panel that animates in, with no exit and no AnimatePresence.

        This was `AnimatePresence mode="wait"`, which holds the incoming tab
        until the outgoing one has finished animating away. When that exit
        never completed — an interrupted transition, a child unmounting with
        its own exit animation partway through — the new tab was never mounted
        and every screen in the module stayed blank until the whole app was
        remounted by signing in again.

        Waiting buys a slightly tidier crossfade and costs a module that can
        wedge itself. Not a trade worth making on a counter.
      */}
        <motion.div key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.page, ease: EASE }}
          className="min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'stock' && <StockTab />}
        {tab === 'issue' && <IssueTab me={me} />}
        {tab === 'receive' && <ReceiveTab onAddItem={() => setTab('stock')} />}
        {tab === 'movements' && <MovementsTab />}
        {tab === 'reports' && <ReportsTab />}
      </motion.div>
    </div>
  )
}

/* ----------------------------------------------------------------- stock */

function StockTab() {
  const [rows, setRows] = useState<any[]>([])
  const [sum, setSum] = useState<any>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [category, setCategory] = useState('all')
  const [categories, setCategories] = useState<string[]>([])
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [counting, setCounting] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.supplyItems({ q, filter, category }).then(setRows).finally(() => setLoading(false))
    api.supplySummary().then(setSum).catch(() => {})
  }, [q, filter, category])

  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => { api.supplyCategories().then(setCategories).catch(() => {}) }, [])

  const counts: Record<string, number> = {
    all: sum?.all_count ?? 0, low: sum?.low_count ?? 0, out: sum?.out_count ?? 0,
    expiring: sum?.expiring_count ?? 0, archived: sum?.archived_count ?? 0
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={tr('Items')} value={String(counts.all)} />
        <Stat label={tr('Low')} value={String(counts.low)} tone={counts.low ? 'warn' : 'ok'} />
        <Stat label={tr('Out of stock')} value={String(counts.out)} tone={counts.out ? 'bad' : 'ok'} />
        <Stat label={tr('Value on the shelf')} value={`Rs ${rs(sum?.total_value_paisa)}`} tone="accent" />
      </div>

      <Card title={tr('Store stock')} hint={tr('Consumables used by the hospital, not sold to patients')}
        action={<button onClick={() => setEditing('new')} className="btn-primary">{tr('Add item')}</button>}>
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Name or code')} className="field w-60" />
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)}
                className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                  filter === id ? 'bg-brand text-white'
                                : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
                {tr(label)} <span className="num opacity-70">{counts[id]}</span>
              </button>
            ))}
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="field w-40 py-1.5 text-2xs">
            <option value="all">{tr('All categories')}</option>
            {categories.map((c) => <option key={c} value={c}>{tr(c)}</option>)}
          </select>
        </div>

        <ErrorNote>{err}</ErrorNote>

        {loading ? <SkeletonRows rows={6} cols={6} />
          : rows.length === 0 ? <Empty title={tr('Nothing matches that')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Item')}</Th><Th w="w-28">{tr('Category')}</Th>
                  <Th w="w-24" right>{tr('On hand')}</Th><Th w="w-28">{tr('Cover')}</Th>
                  <Th w="w-28">{tr('Nearest expiry')}</Th>
                  <Th w="w-28" right>{tr('Value')}</Th><Th w="w-32" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((i) => {
                  const low = i.reorder_level > 0 && i.on_hand <= i.reorder_level
                  return (
                    <tr key={i.id} className={i.is_active ? '' : 'opacity-50'}>
                      <td className="px-3 py-2">
                        <span className="text-sm text-heading">{i.name}</span>
                        <span className="block text-2xs text-muted">
                          {[i.code, i.storage_note].filter(Boolean).join(' · ')}
                          {i.reorder_level > 0 && ` · ${tr('reorder at')} ${i.reorder_level}`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-2xs capitalize text-muted">{tr(i.category)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`num text-sm font-medium ${
                          i.on_hand === 0 ? 'text-bad' : low ? 'text-warn' : 'text-primary'}`}>
                          {i.on_hand}
                        </span>
                        <span className="block text-2xs text-muted">{i.unit_label}</span>
                      </td>
                      <td className="px-3 py-2">
                        {/*
                          Days of cover beats a bare count: 200 gloves is a
                          fortnight in Emergency and two months in a clinic.
                        */}
                        {i.days_left != null
                          ? <span className={`num text-2xs ${
                              i.days_left <= 7 ? 'font-medium text-bad'
                              : i.days_left <= 21 ? 'text-warn' : 'text-muted'}`}>
                              {i.days_left} {tr('days')}
                            </span>
                          : <span className="text-2xs text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 num text-2xs text-muted">
                        {i.nearest_expiry ?? (i.tracks_expiry ? '—' : tr('n/a'))}
                        {i.expired_qty > 0 && (
                          <span className="block text-2xs font-medium text-bad">
                            {i.expired_qty} {tr('expired')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right num text-2xs text-muted">{rs(i.value_paisa)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setCounting(i)} className="btn-ghost px-2 py-1 text-2xs">
                          {tr('Count')}
                        </button>
                        <button onClick={() => setEditing(i)} className="ml-1 btn-ghost px-2 py-1 text-2xs">
                          {tr('Edit')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <ItemForm initial={editing === 'new' ? null : editing} categories={categories}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />
      )}
      {counting && (
        <CountForm item={counting} onClose={() => setCounting(null)}
          onDone={() => { setCounting(null); load() }} />
      )}
    </div>
  )
}

function ItemForm({ initial, categories, onClose, onDone }: {
  initial: any | null; categories: string[]; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', code: initial?.code ?? '',
    category: initial?.category ?? 'consumable',
    unitLabel: initial?.unit_label ?? 'piece',
    packSize: String(initial?.pack_size ?? 1),
    reorderLevel: String(initial?.reorder_level ?? 0),
    tracksExpiry: initial?.tracks_expiry ?? true,
    storageNote: initial?.storage_note ?? ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true); setErr(null)
    const body = {
      name: f.name.trim(), code: f.code.trim() || null, category: f.category,
      unitLabel: f.unitLabel.trim() || 'piece',
      packSize: Math.max(1, Number(f.packSize) || 1),
      reorderLevel: Math.max(0, Number(f.reorderLevel) || 0),
      tracksExpiry: f.tracksExpiry, storageNote: f.storageNote.trim() || null
    }
    try {
      initial ? await api.updateSupplyItem(initial.id, body) : await api.createSupplyItem(body)
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={initial ? `${tr('Edit')} ${initial.name}` : tr('Add item')} wide onClose={onClose}
      footer={<>
        {initial && (
          <button className="btn-ghost mr-auto text-bad"
            onClick={async () => {
              try { await api.archiveSupplyItem(initial.id); onDone() }
              catch (e: any) { setErr(e.message) }
            }}>{tr('Archive')}</button>
        )}
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !f.name.trim()} className="btn-primary">
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Name')} span>
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('Sterile gauze 10x10cm')} className="field" />
        </Field>
        <Field label={tr('Code')} hint={tr('Your own reference, if you use one')}>
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="field" />
        </Field>
        <Field label={tr('Category')}>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}
            className="field">
            {categories.map((c) => <option key={c} value={c}>{tr(c)}</option>)}
          </select>
        </Field>
        <Field label={tr('Issued in')} hint={tr('piece, roll, box, pair')}>
          <input value={f.unitLabel} onChange={(e) => setF({ ...f, unitLabel: e.target.value })}
            className="field" />
        </Field>
        <Field label={tr('Units per purchase pack')} hint={tr('A carton of 100 gloves = 100')}>
          <input value={f.packSize} onChange={(e) => setF({ ...f, packSize: e.target.value })}
            className="field num" />
        </Field>
        <Field label={tr('Reorder level')} hint={tr('Warn when the shelf drops to this')}>
          <input value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })}
            className="field num" />
        </Field>
        <Field label={tr('Storage')} hint={tr('Where it lives')}>
          <input value={f.storageNote} onChange={(e) => setF({ ...f, storageNote: e.target.value })}
            placeholder={tr('Store room, shelf B')} className="field" />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-2xs">
        <input type="checkbox" checked={f.tracksExpiry}
          onChange={(e) => setF({ ...f, tracksExpiry: e.target.checked })} />
        {tr('This expires — ask for an expiry date when receiving it')}
      </label>
      <p className="mt-1 text-2xs text-muted">
        {tr('Sutures and IV fluids do. Gloves, linen and instruments do not.')}
      </p>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/**
 * A physical count.
 *
 * Recorded as its own movement with a reason rather than by editing the
 * number quietly. A stock figure that changes with no explanation is how a
 * store stops being believed.
 */
function CountForm({ item, onClose, onDone }: {
  item: any; onClose: () => void; onDone: () => void
}) {
  const [counted, setCounted] = useState(String(item.on_hand))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const diff = (Number(counted) || 0) - item.on_hand

  return (
    <Modal title={`${tr('Count')} — ${item.name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || diff === 0 || !reason.trim()} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.adjustSupply(item.id, Number(counted) || 0, reason.trim())
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Record the count')}
        </button>
      </>}>
      <div className="flex items-baseline justify-between">
        <span className="text-2xs text-muted">{tr('System says')}</span>
        <span className="num text-lg text-heading">{item.on_hand} {item.unit_label}</span>
      </div>
      <Field label={tr('Actually on the shelf')} span>
        <input autoFocus value={counted} onChange={(e) => setCounted(e.target.value)}
          className="field num mt-2 text-right text-lg" />
      </Field>
      {diff !== 0 && (
        <p className={`mt-2 text-right num text-sm font-medium ${diff > 0 ? 'text-ok' : 'text-bad'}`}>
          {diff > 0 ? `+${diff} ${tr('more than expected')}` : `${diff} ${tr('missing')}`}
        </p>
      )}
      <Field label={tr('Why')} hint={tr('Required — this is a permanent record')} span>
        <input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder={tr('Monthly count, boxes found behind the shelf')} className="field mt-2" />
      </Field>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/* ----------------------------------------------------------------- issue */

function IssueTab({ me }: { me: SessionUser }) {
  const [items, setItems] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [itemId, setItemId] = useState(0)
  const [qty, setQty] = useState('1')
  const [departmentId, setDepartmentId] = useState(0)
  const [issuedTo, setIssuedTo] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)
  const [recent, setRecent] = useState<any[]>([])

  const load = useCallback(() => {
    api.supplyItems({ filter: 'all' }).then(setItems).catch(() => {})
    api.supplyMovements({ kind: 'issue' }).then((m) => setRecent(m.slice(0, 10))).catch(() => {})
  }, [])
  useEffect(() => { load(); api.departments().then(setDepartments).catch(() => {}) }, [load])

  const item = items.find((i) => i.id === itemId)
  const enough = !item || Number(qty) <= item.on_hand

  async function issue() {
    setBusy(true); setErr(null)
    try {
      const r = await api.issueSupply({
        itemId, qty: Number(qty) || 1,
        departmentId: departmentId || null,
        issuedTo: issuedTo.trim() || null,
        reason: reason.trim() || null
      })
      setDone(r); setQty('1'); setIssuedTo(''); setReason(''); load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_380px]">
      <Card title={tr('Issue to a department')}
        hint={tr('Nearest expiry goes out first, automatically')}>
        <ErrorNote>{err}</ErrorNote>

        {done && (
          <div className="card-tint mb-4 p-3">
            <p className="text-sm font-medium text-heading">
              {tr('Issued')} {done.qty} {done.item.unit_label} — {done.item.name}
            </p>
            <ul className="mt-1 space-y-0.5">
              {done.taken.map((t: any, i: number) => (
                <li key={i} className="num text-2xs text-muted">
                  {t.qty} {tr('from batch')} {t.batchNo ?? '—'}
                  {t.expiry && ` (${tr('expires')} ${t.expiry})`}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr('Item')} span>
            <select value={itemId} onChange={(e) => setItemId(Number(e.target.value))} className="field">
              <option value={0}>{tr('Choose an item')}</option>
              {items.filter((i) => i.is_active).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} — {i.on_hand} {i.unit_label} {tr('on hand')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr('How many')}>
            <input value={qty} onChange={(e) => setQty(e.target.value)}
              className={`field num ${enough ? '' : 'border-bad'}`} />
          </Field>
          <Field label={tr('Department')}>
            <select value={departmentId} onChange={(e) => setDepartmentId(Number(e.target.value))}
              className="field">
              <option value={0}>{tr('Not recorded')}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={tr('Given to')} hint={tr('The person who collected it')}>
            <input value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} className="field" />
          </Field>
          <Field label={tr('What for')}>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={tr('Dressing trolley restock')} className="field" />
          </Field>
        </div>

        {item && !enough && (
          <p className="mt-2 text-2xs text-bad">
            {tr('Only')} {item.on_hand} {item.unit_label} {tr('on the shelf')}
          </p>
        )}

        <button onClick={issue} disabled={busy || !itemId || !enough || Number(qty) < 1}
          className="btn-primary mt-4 w-full py-3">
          {busy ? tr('Saving…') : tr('Issue')}
        </button>
        <p className="mt-2 text-center text-2xs text-muted">{me.displayName}</p>
      </Card>

      <Card title={tr('Recently issued')}>
        {recent.length === 0 ? <Empty title={tr('Nothing issued yet')} /> : (
          <ul className="divide-y divide-divide">
            {recent.map((m) => (
              <li key={m.id} className="py-2">
                <div className="flex justify-between gap-2">
                  <span className="truncate text-sm text-heading">{m.item_name}</span>
                  <span className="num shrink-0 text-sm text-primary">{-m.qty}</span>
                </div>
                <span className="block text-2xs text-muted">
                  {m.department_name ?? tr('Not recorded')}
                  {m.issued_to && ` · ${m.issued_to}`}
                  {' · '}
                  {new Date(m.moved_at).toLocaleString('en-GB',
                    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------------------- receive */

function ReceiveTab({ onAddItem }: { onAddItem: () => void }) {
  const [items, setItems] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [supplierId, setSupplierId] = useState(0)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [lines, setLines] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    api.supplyItems({ filter: 'all' }).then(setItems).catch(() => {})
    api.ph.suppliers().then(setSuppliers).catch(() => {})
  }, [])

  const term = q.trim().toLowerCase()
  const matches = term
    ? items.filter((i) => i.is_active && (
        i.name.toLowerCase().includes(term) ||
        (i.code ?? '').toLowerCase().includes(term))).slice(0, 12)
    : []

  const total = lines.reduce((n, l) => n + toPaisa(l.cost) * (Number(l.qty) || 0), 0)
  const ready = lines.length > 0 && lines.every((l) => l.itemId && Number(l.qty) > 0)

  async function save() {
    setBusy(true); setErr(null)
    try {
      await api.receiveSupplies({
        supplierId: supplierId || null,
        invoiceNo: invoiceNo.trim() || null,
        lines: lines.map((l) => ({
          itemId: l.itemId, batchNo: l.batchNo.trim() || null,
          expiryDate: l.expiryDate || null,
          qty: Number(l.qty), costPaisa: toPaisa(l.cost)
        }))
      })
      setDone(true); setLines([]); setInvoiceNo('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="p-4">
        <Card title={tr('Delivery received')}>
          <p className="text-sm text-body">{tr('The stock is on the shelf.')}</p>
          <button onClick={() => setDone(false)} className="btn-primary mt-4">
            {tr('Receive another')}
          </button>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Receive stock')} hint={tr('One delivery note, as many items as it covers')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr('Supplier')}>
            <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}
              className="field">
              <option value={0}>{tr('Not recorded')}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={tr('Invoice number')}>
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="field num" />
          </Field>
        </div>

        {/*
          Search rather than a long dropdown, the same way the pharmacy
          receives goods. A store carries a few hundred lines and scrolling a
          select to find "Syringe 10cc" is slower than typing three letters.

          Stock can only be received against an item that already exists. That
          is the point of registering it first: the unit, the reorder level and
          whether it expires are properties of the thing, not of one delivery,
          and letting a delivery invent them produces four spellings of gauze.
        */}
        <div className="relative mt-4">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search an item to add to this delivery')} className="field" />
          {q.trim().length > 0 && (
            <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto
                           rounded-2xl border-2 border-line bg-card shadow-pop">
              {matches.length === 0 ? (
                <li className="px-3 py-3 text-center">
                  <p className="text-2xs text-muted">
                    {tr('No item called that. Register it first, then receive stock against it.')}
                  </p>
                  <button onClick={() => { setQ(''); onAddItem() }}
                    className="btn-ghost mt-2 text-2xs">{tr('Add item')}</button>
                </li>
              ) : matches.map((i) => (
                <li key={i.id}
                  onClick={() => {
                    setLines((l) => [...l, { key: newId(), itemId: i.id, name: i.name,
                      unitLabel: i.unit_label, tracksExpiry: i.tracks_expiry,
                      batchNo: '', expiryDate: '', qty: '1', cost: '' }])
                    setQ('')
                  }}
                  className="flex cursor-pointer items-center justify-between gap-3 border-b
                             border-divide px-3 py-2 last:border-0 hover:bg-raised">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-heading">{i.name}</span>
                    <span className="block text-2xs text-muted">
                      {tr(i.category)}
                      {i.code && ` · ${i.code}`}
                      {!i.tracks_expiry && ` · ${tr('no expiry')}`}
                    </span>
                  </span>
                  <span className="shrink-0 num text-2xs text-muted">
                    {i.on_hand} {i.unit_label} {tr('on hand')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lines.length === 0 ? (
          <Empty title={tr('Nothing on this delivery note yet')}
            hint={tr('Search above for an item you have already registered.')} />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Item')}</Th><Th w="w-28">{tr('Batch')}</Th>
                  <Th w="w-36">{tr('Expiry')}</Th><Th w="w-20" right>{tr('Qty')}</Th>
                  <Th w="w-24" right>{tr('Cost each')}</Th><Th w="w-24" right>{tr('Line')}</Th><Th w="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide">
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td className="px-3 py-2 text-sm text-heading">{l.name}</td>
                    <td className="px-2 py-2">
                      <input value={l.batchNo}
                        onChange={(e) => setLines((ls) => ls.map((x) =>
                          x.key === l.key ? { ...x, batchNo: e.target.value } : x))}
                        className="field py-1 text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      {l.tracksExpiry ? (
                        <input type="date" value={l.expiryDate}
                          onChange={(e) => setLines((ls) => ls.map((x) =>
                            x.key === l.key ? { ...x, expiryDate: e.target.value } : x))}
                          className="field py-1 text-2xs num" />
                      ) : <span className="text-2xs text-muted">{tr('n/a')}</span>}
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.qty}
                        onChange={(e) => setLines((ls) => ls.map((x) =>
                          x.key === l.key ? { ...x, qty: e.target.value } : x))}
                        className="field py-1 text-right text-2xs num" />
                    </td>
                    <td className="px-2 py-2">
                      <input value={l.cost} placeholder="0.00"
                        onChange={(e) => setLines((ls) => ls.map((x) =>
                          x.key === l.key ? { ...x, cost: e.target.value } : x))}
                        className="field py-1 text-right text-2xs num" />
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
          </div>
        )}

        <ErrorNote>{err}</ErrorNote>

        <div className="mt-3 flex items-center justify-between border-t-2 border-divide pt-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-muted">{tr('Delivery total')}</p>
            <p className="num text-2xl font-semibold text-primary">Rs {rs(total)}</p>
          </div>
          <button onClick={save} disabled={!ready || busy} className="btn-primary">
            {busy ? tr('Saving…') : tr('Receive delivery')}
          </button>
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------- movements */

const KINDS: [string, string][] = [
  ['all', 'All'], ['receive', 'Received'], ['issue', 'Issued'],
  ['waste', 'Written off'], ['adjust', 'Counts']
]

function MovementsTab() {
  const [kind, setKind] = useState('all')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.supplyMovements({ kind }).then(setRows).finally(() => setLoading(false))
  }, [kind])

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Movements')} hint={tr('Everything in and out, oldest kept for good')}>
        <div className="flex flex-wrap gap-1">
          {KINDS.map(([id, label]) => (
            <button key={id} onClick={() => setKind(id)}
              className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                kind === id ? 'bg-brand text-white'
                            : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
              {tr(label)}
            </button>
          ))}
        </div>

        {loading ? <SkeletonRows rows={6} cols={6} />
          : rows.length === 0 ? <Empty title={tr('Nothing here')} /> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-36">{tr('When')}</Th><Th>{tr('Item')}</Th>
                  <Th w="w-24">{tr('Type')}</Th><Th w="w-20" right>{tr('Qty')}</Th>
                  <Th w="w-32">{tr('Department')}</Th><Th>{tr('Note')}</Th>
                  <Th w="w-28">{tr('By')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2 num text-2xs text-muted">
                      {new Date(m.moved_at).toLocaleString('en-GB',
                        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-sm text-heading">{m.item_name}</td>
                    <td className="px-3 py-2">
                      <Badge tone={m.kind === 'receive' ? 'ok'
                        : m.kind === 'waste' ? 'bad' : m.kind === 'adjust' ? 'warn' : 'primary'}>
                        {tr(m.kind)}
                      </Badge>
                    </td>
                    <td className={`px-3 py-2 text-right num text-sm font-medium ${
                      m.qty > 0 ? 'text-ok' : 'text-bad'}`}>
                      {m.qty > 0 ? `+${m.qty}` : m.qty}
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{m.department_name ?? '—'}</td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {[m.issued_to, m.reason].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{m.moved_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------------------- reports */

function ReportsTab() {
  const [days, setDays] = useState(30)
  const [d, setD] = useState<any>(null)

  useEffect(() => { api.supplyReports(days).then(setD).catch(() => {}) }, [days])
  if (!d) return <p className="p-6 text-sm text-muted">{tr('Loading…')}</p>

  const maxDept = Math.max(...d.byDepartment.map((x: any) => Number(x.value_paisa)), 1)
  const expiredValue = d.expiring
    .filter((b: any) => b.days_left <= 0)
    .reduce((n: number, b: any) => n + Number(b.value_paisa), 0)

  return (
    <div className="space-y-4 p-4">
      <div className="flex gap-1">
        {[7, 30, 90].map((n) => (
          <button key={n} onClick={() => setDays(n)}
            className={`rounded-xl px-3 py-1.5 text-sm ${
              days === n ? 'bg-brand text-white'
                         : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            {n} {tr('days')}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={tr('Used by department')} hint={tr('What each one got through')}>
          {d.byDepartment.length === 0 ? <Empty title={tr('Nothing issued yet')} /> : (
            <ul className="space-y-2.5">
              {d.byDepartment.map((x: any) => (
                <li key={x.department}>
                  <div className="flex justify-between text-2xs">
                    <span className="text-body">{x.department}</span>
                    <span className="num text-muted">
                      {x.units} {tr('units')} · Rs {rs(x.value_paisa)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-brand"
                      style={{ width: `${Math.max((Number(x.value_paisa) / maxDept) * 100, 2)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={tr('Most used items')}>
          {d.topConsumed.length === 0 ? <Empty title={tr('Nothing issued yet')} /> : (
            <ul className="divide-y divide-divide">
              {d.topConsumed.map((x: any, i: number) => (
                <li key={x.name} className="flex items-center justify-between py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="num w-4 text-2xs text-muted">{i + 1}</span>
                    <span className="truncate text-sm text-heading">{x.name}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num text-sm text-primary">{x.units}</span>
                    <span className="block num text-2xs text-muted">Rs {rs(x.value_paisa)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={tr('Expiring stock')} hint={tr('Next 90 days')}>
        {expiredValue > 0 && (
          <div className="mb-3 rounded-xl border-2 border-bad/40 bg-bad/5 p-3">
            <p className="text-2xs font-medium text-bad">
              Rs {rs(expiredValue)} {tr('has already expired and is still on the shelf')}
            </p>
          </div>
        )}
        {d.expiring.length === 0 ? <Empty title={tr('Nothing expiring soon')} /> : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Item')}</Th><Th w="w-28">{tr('Batch')}</Th>
                <Th w="w-32">{tr('Expires')}</Th><Th w="w-20" right>{tr('Qty')}</Th>
                <Th w="w-28" right>{tr('Value')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {d.expiring.map((b: any) => (
                <tr key={b.id}>
                  <td className="px-3 py-2 text-sm text-heading">{b.item_name}</td>
                  <td className="px-3 py-2 num text-2xs text-muted">{b.batch_no ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`num text-2xs ${
                      b.days_left <= 0 ? 'font-medium text-bad'
                      : b.days_left <= 30 ? 'text-warn' : 'text-muted'}`}>
                      {b.expiry_date}
                      {b.days_left <= 0 ? ` · ${tr('expired')}` : ` · ${b.days_left} ${tr('days')}`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right num text-2xs">{b.qty_on_hand}</td>
                  <td className="px-3 py-2 text-right num text-2xs text-muted">{rs(b.value_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
