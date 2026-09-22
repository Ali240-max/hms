import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Th } from '../../components/ui'
import { ExpiryPill } from '../../components/Expiry'
import { t as tr } from '../../lib/prefs'
import { Combobox } from '../../components/Combobox'

const FILTERS = [
  ['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock'],
  ['expiring', 'Expiring'], ['archived', 'Archived']
] as const

/** The catalogue: register a medicine, set its pack size, price and reorder level. */
export function Medicines() {
  const [rows, setRows] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [filters, setFilters] = useState<{ manufacturers: any[]; suppliers: any[] }>({ manufacturers: [], suppliers: [] })
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [mfr, setMfr] = useState('')
  const [supplierId, setSupplierId] = useState(0)
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.ph.inventory({ q, filter, manufacturer: mfr, supplierId }).then(setRows).finally(() => setLoading(false))
    api.ph.summary().then(setSummary).catch(() => {})
  }, [q, filter, mfr, supplierId])

  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => { api.ph.filters().then(setFilters).catch(() => {}) }, [])

  const counts: Record<string, number> = {
    all: summary?.all_count ?? 0, low: summary?.low_count ?? 0, out: summary?.out_count ?? 0,
    expiring: summary?.expiring_count ?? 0, archived: summary?.archived_count ?? 0
  }

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Medicines')} hint={`Stock worth Rs ${rs(summary?.total_value_paisa)} on the shelf`}
        action={<button onClick={() => setEditing('new')} className="btn-primary">{tr('Add medicine')}</button>}>
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Name, generic, company or barcode')} className="field w-72" />
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)}
                className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                  filter === id ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
                {tr(label)} <span className="num opacity-70">{counts[id]}</span>
              </button>
            ))}
          </div>
          <select value={mfr} onChange={(e) => setMfr(e.target.value)} className="field w-44 py-1.5 text-2xs">
            <option value="">{tr('All companies')}</option>
            {filters.manufacturers.map((m) => <option key={m.name} value={m.name}>{m.name} ({m.n})</option>)}
          </select>
          <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}
            className="field w-44 py-1.5 text-2xs">
            <option value={0}>{tr('All suppliers')}</option>
            {filters.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.n})</option>)}
          </select>
        </div>

        <ErrorNote>{err}</ErrorNote>

        {loading ? <p className="py-8 text-sm text-muted">{tr('Loading…')}</p>
          : rows.length === 0 ? <Empty title={tr('Nothing matches that')} />
          : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Medicine')}</Th><Th w="w-32">{tr('Company')}</Th><Th w="w-24" right>{tr('In stock')}</Th>
                  <Th w="w-28">{tr('Nearest expiry')}</Th><Th w="w-24" right>{tr('Price')}</Th>
                  <Th w="w-28" right>{tr('Stock value')}</Th><Th w="w-24" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((p) => {
                  const packs = p.pack_size > 1 ? Math.floor(p.in_stock / p.pack_size) : p.in_stock
                  const loose = p.pack_size > 1 ? p.in_stock % p.pack_size : 0
                  const low = p.reorder_level > 0 && p.in_stock <= p.reorder_level
                  return (
                    <tr key={p.id} className={p.is_active ? '' : 'opacity-50'}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-heading">{p.name}</span>
                          {p.schedule === 'controlled' && <Badge tone="bad">{tr('controlled')}</Badge>}
                          {p.schedule === 'g' && <Badge tone="warn">{tr('sched G')}</Badge>}
                          {!p.is_active && <Badge>{tr('archived')}</Badge>}
                        </div>
                        <div className="text-2xs text-muted">
                          {[p.generic_name, p.strength, p.product_code].filter(Boolean).join(' · ')}
                          {p.pack_size > 1 && ` · ${p.pack_size} ${p.sub_unit_label ?? 'units'} per ${p.unit_label}`}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-2xs text-muted">{p.manufacturer ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`num text-sm font-medium ${
                          p.in_stock === 0 ? 'text-bad' : low ? 'text-warn' : 'text-primary'}`}>
                          {p.pack_size > 1 ? (loose ? `${packs} + ${loose}` : packs) : p.in_stock}
                        </span>
                        <div className="text-2xs text-muted">
                          {p.pack_size > 1 ? p.unit_label + (packs === 1 ? '' : 's') : p.unit_label}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {p.nearest_expiry ? <ExpiryPill date={p.nearest_expiry} /> : <span className="text-2xs text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right num text-2xs">{p.price_paisa ? rs(p.price_paisa) : '—'}</td>
                      <td className="px-3 py-2 text-right num text-2xs text-muted">{rs(p.stock_value_paisa)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setEditing(p)} className="btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                        <button className="btn-ghost ml-1 px-2 py-1 text-2xs"
                          onClick={async () => {
                            setErr(null)
                            try {
                              p.is_active ? await api.ph.archiveProduct(p.id) : await api.ph.restoreProduct(p.id)
                              load()
                            } catch (e: any) { setErr(e.message) }
                          }}>
                          {p.is_active ? 'Archive' : 'Restore'}
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
        <MedicineForm initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}

function MedicineForm({ initial, onClose, onDone }: {
  initial: any | null; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', genericName: initial?.generic_name ?? '',
    manufacturer: initial?.manufacturer ?? '', barcode: initial?.barcode ?? '',
    productCode: initial?.product_code ?? '', form: initial?.form ?? '',
    strength: initial?.strength ?? '', unitLabel: initial?.unit_label ?? 'strip',
    subUnitLabel: initial?.sub_unit_label ?? 'tablet',
    packSize: String(initial?.pack_size ?? 1), allowLoose: initial?.allow_loose ?? false,
    schedule: initial?.schedule ?? 'otc', taxRate: String((initial?.tax_rate_bp ?? 0) / 100),
    reorderLevel: String(initial?.reorder_level ?? 0), rackLocation: initial?.rack_location ?? '',
    // Pricing, per single unit. A pack price is that times the pack size and
    // is shown rather than typed, because the two disagreeing is the classic
    // way a counter ends up charging the wrong amount for a half strip.
    purchase: initial?.purchase_paisa ? (initial.purchase_paisa / 100).toFixed(2) : '',
    retail: initial?.retail_paisa ? (initial.retail_paisa / 100).toFixed(2) : '',
    saltId: initial?.salt_id ?? 0,
    manufacturerId: initial?.manufacturer_id ?? 0,
    groupId: initial?.group_id ?? 0
  })
  const [groups, setGroups] = useState<any[]>([])
  const [saltLabel, setSaltLabel] = useState<string>(initial?.salt_name ?? '')
  const [makerLabel, setMakerLabel] = useState<string>(initial?.manufacturer_name ?? '')

  /**
   * Prices are typed one way or the other, never both.
   *
   * A pharmacy thinks in whichever unit its supplier quotes: a distributor
   * invoices by the pack, the counter sells by the strip. Asking for the
   * per-unit figure when the invoice says 1,620 for a box of ten means the
   * clerk does the division in their head, and a wrong division is a wrong
   * price on every sale until somebody notices.
   *
   * Only one of the two is stored — per unit, because it is the smallest
   * thing that can be sold. The other is always derived, so they cannot
   * disagree.
   */
  const [priceBy, setPriceBy] = useState<'unit' | 'pack'>(
    Number(initial?.pack_size ?? 1) > 1 ? 'pack' : 'unit')

  useEffect(() => { api.pharmaGroups().then(setGroups).catch(() => {}) }, [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const packSize = Math.max(1, Number(f.packSize) || 1)

  /** What goes in the box: the stored per-unit figure, scaled if needed. */
  const shown = (perUnit: string) => {
    if (priceBy === 'unit' || packSize === 1) return perUnit
    const n = toPaisa(perUnit)
    return n ? (n * packSize / 100).toFixed(2) : ''
  }

  /** Always stored per unit, whichever way it was typed. */
  const setPrice = (which: 'purchase' | 'retail', typed: string) => {
    if (priceBy === 'unit' || packSize === 1) {
      setF({ ...f, [which]: typed })
      return
    }
    const perPack = toPaisa(typed)
    // Rounded to the paisa: a pack of 3 at Rs 10 is 333 per unit, and the
    // third of a paisa has to go somewhere. Losing it on the unit price is
    // the only option that keeps the pack price exactly what was typed.
    const perUnit = perPack ? (Math.round(perPack / packSize) / 100).toFixed(2) : ''
    setF({ ...f, [which]: perUnit })
  }

  async function save() {
    setBusy(true); setErr(null)
    const body = {
      name: f.name.trim(), genericName: f.genericName.trim() || null,
      manufacturer: f.manufacturer.trim() || null, barcode: f.barcode.trim() || null,
      productCode: f.productCode.trim() || null, form: f.form.trim() || null,
      strength: f.strength.trim() || null, unitLabel: f.unitLabel.trim() || 'unit',
      subUnitLabel: f.subUnitLabel.trim() || null,
      packSize: Math.max(1, Number(f.packSize) || 1), allowLoose: f.allowLoose,
      schedule: f.schedule, taxRateBp: Math.round((Number(f.taxRate) || 0) * 100),
      reorderLevel: Math.max(0, Number(f.reorderLevel) || 0),
      rackLocation: f.rackLocation.trim() || null,
      purchasePaisa: toPaisa(f.purchase),
      // Trade rate is gone: nobody here priced from it, and a third number
      // that has to agree with the other two is a third number to get wrong.
      retailPaisa: toPaisa(f.retail),
      saltId: f.saltId || null, groupId: f.groupId || null,
      manufacturerId: f.manufacturerId || null
    }
    try {
      initial ? await api.ph.updateProduct(initial.id, body) : await api.ph.createProduct(body)
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add a medicine'} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy || !f.name.trim()} className="btn-primary">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Name')} span>
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('Panadol 500mg')} className="field" />
        </Field>
        <Field label={tr('Generic name')}>
          <input value={f.genericName} onChange={(e) => setF({ ...f, genericName: e.target.value })}
            placeholder={tr('Paracetamol')} className="field" />
        </Field>
        <Field label={tr('Company')}>
          <input value={f.manufacturer} onChange={(e) => setF({ ...f, manufacturer: e.target.value })}
            className="field" />
        </Field>
        <Field label={tr('Barcode')}>
          <input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} className="field num" />
        </Field>
        <Field label={tr('Your own code')}>
          <input value={f.productCode} onChange={(e) => setF({ ...f, productCode: e.target.value })} className="field" />
        </Field>

        <div className="sm:col-span-2 mt-1 border-t border-divide pt-3">
          <p className="label">{tr('How it is sold')}</p>
        </div>
        <Field label={tr('Pack is called')}>
          <input value={f.unitLabel} onChange={(e) => setF({ ...f, unitLabel: e.target.value })}
            placeholder={tr('strip')} className="field" />
        </Field>
        <Field label={tr('Each unit inside is called')}>
          <input value={f.subUnitLabel} onChange={(e) => setF({ ...f, subUnitLabel: e.target.value })}
            placeholder={tr('tablet')} className="field" />
        </Field>
        <Field label={tr('Units per pack')} hint={tr('10 tablets in a strip = 10')}>
          <input value={f.packSize} onChange={(e) => setF({ ...f, packSize: e.target.value })} className="field num" />
        </Field>
        <Field label={tr('Reorder level')} hint={tr('In units, not packs')}>
          <input value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })}
            className="field num" />
        </Field>
        <label className="flex items-center gap-2 text-2xs sm:col-span-2">
          <input type="checkbox" checked={f.allowLoose}
            onChange={(e) => setF({ ...f, allowLoose: e.target.checked })} />
          {tr('Can be sold loose, a few units at a time')}
        </label>

        {/* ------------------------------------------------------ pricing */}
        <div className="sm:col-span-2 mt-1 border-t border-divide pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="label mb-0">{tr('Pricing')}</p>
            <div className="flex gap-1">
              {([['unit', 'Per unit'], ['pack', 'Per pack']] as const).map(([id, lbl]) => (
                <button key={id} type="button" onClick={() => setPriceBy(id)}
                  disabled={packSize === 1}
                  className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
                    priceBy === id ? 'bg-brand text-white'
                      : 'border-2 border-line bg-card text-muted hover:bg-raised'} ${
                    packSize === 1 ? 'opacity-40' : ''}`}>
                  {tr(lbl)}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-2xs text-muted">
            {packSize === 1
              ? tr('One unit per pack, so the two are the same.')
              : priceBy === 'pack'
                ? `${tr('Enter what one')} ${f.unitLabel || tr('pack')} ${tr('of')} ${packSize} ${tr('costs. The per-unit price is worked out for you.')}`
                : `${tr('Enter what one')} ${f.subUnitLabel || tr('unit')} ${tr('costs. The pack price is worked out for you.')}`}
          </p>
        </div>

        <Field label={`${tr('Purchase rate')} — ${priceBy === 'pack' ? tr('per pack') : tr('per unit')}`}
          hint={tr('What you pay')}>
          <input value={shown(f.purchase)}
            onChange={(e) => setPrice('purchase', e.target.value)}
            placeholder="0.00" className="field num text-right" />
        </Field>

        <Field label={`${tr('Retail rate')} — ${priceBy === 'pack' ? tr('per pack') : tr('per unit')}`}
          hint={tr('What the customer pays')}>
          <input value={shown(f.retail)}
            onChange={(e) => setPrice('retail', e.target.value)}
            placeholder="0.00" className="field num text-right" />
        </Field>

        <div className="sm:col-span-2">
          <PriceSummary f={f} packSize={packSize} priceBy={priceBy} />
        </div>

        {/* ------------------------------------------------ classification */}
        <div className="sm:col-span-2 mt-1 border-t border-divide pt-3">
          <p className="label">{tr('Formula, company and shelf')}</p>
        </div>

        {/*
          Pick from the list only. A formula typed in freely here becomes
          "Paracetamol", "paracetamol " and "Paracetamole" within a month, and
          then the search for every brand of it finds a third of them.
          New ones are added under Suppliers & formulas.
        */}
        <Field label={tr('Formula')}
          hint={tr('Pick from the registered list. Add new ones under Suppliers & formulas.')}>
          <Combobox value={f.saltId} label={saltLabel}
            placeholder={tr('Search a formula')}
            search={(q) => api.pharmaSalts(q)}
            onPick={(id, name) => { setF({ ...f, saltId: id }); setSaltLabel(name) }} />
        </Field>

        <Field label={tr('Company')}
          hint={tr('Pick from the registered list. Add new ones under Suppliers & formulas.')}>
          <Combobox value={f.manufacturerId} label={makerLabel}
            placeholder={tr('Search a company')}
            search={(q) => api.pharmaManufacturers(q)}
            onPick={(id, name) => {
              // The name is kept in the old text column too, so screens that
              // still read it show the right company.
              setF({ ...f, manufacturerId: id, manufacturer: name }); setMakerLabel(name)
            }} />
        </Field>

        <Field label={tr('Group')} hint={tr('Tablets, syrups, injections')}>
          <select value={f.groupId} onChange={(e) => setF({ ...f, groupId: Number(e.target.value) })}
            className="field">
            <option value={0}>{tr('Not grouped')}</option>
            {groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>

        <Field label={tr('Schedule')}>
          <select value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} className="field">
            <option value="otc">{tr('Over the counter')}</option>
            <option value="g">{tr('Schedule G — warning shown')}</option>
            <option value="controlled">{tr('Controlled — prescriber required')}</option>
            <option value="refrigerated">{tr('Refrigerated')}</option>
          </select>
        </Field>
        <Field label={tr('Tax rate (%)')}>
          <input value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })} className="field num" />
        </Field>
        <Field label={tr('Rack location')} span>
          <input value={f.rackLocation} onChange={(e) => setF({ ...f, rackLocation: e.target.value })}
            placeholder={tr('A-3')} className="field" />
        </Field>
      </div>
      <p className="mt-3 text-2xs text-muted">
        Prices and batches are set when stock is received, not here. This is the
        catalogue entry.
      </p>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}

/**
 * Both prices and the margin, shown together.
 *
 * Whichever way the figures were typed, this is the other one — and the
 * margin, which is the number that actually decides whether stocking the
 * medicine is worth the shelf space. Reading it while setting the price beats
 * discovering it in a report next month.
 */
function PriceSummary({ f, packSize, priceBy }: {
  f: any; packSize: number; priceBy: 'unit' | 'pack'
}) {
  const purchase = toPaisa(f.purchase)
  const retail = toPaisa(f.retail)
  if (!purchase && !retail) return null

  const margin = retail - purchase
  const pct = purchase > 0 ? (margin / purchase) * 100 : 0
  const other = priceBy === 'pack' ? tr('per unit') : tr('per pack')
  const mul = priceBy === 'pack' ? 1 : packSize

  return (
    <div className="rounded-xl border-2 border-line bg-raised p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {packSize > 1 && (
          <div>
            <p className="text-2xs uppercase tracking-wide text-muted">
              {tr('Works out at')} — {other}
            </p>
            <p className="num text-sm text-heading">
              {tr('Cost')} {purchase ? rs(priceBy === 'pack' ? Math.round(purchase / packSize) : purchase * mul) : '—'}
            </p>
            <p className="num text-sm text-heading">
              {tr('Sells')} {retail ? rs(priceBy === 'pack' ? Math.round(retail / packSize) : retail * mul) : '—'}
            </p>
          </div>
        )}

        <div>
          <p className="text-2xs uppercase tracking-wide text-muted">{tr('Margin')}</p>
          <p className={`num text-lg font-semibold ${
            margin > 0 ? 'text-ok' : margin < 0 ? 'text-bad' : 'text-muted'}`}>
            {rs(margin)}
          </p>
        </div>

        <div>
          <p className="text-2xs uppercase tracking-wide text-muted">{tr('Margin %')}</p>
          <p className={`num text-lg font-semibold ${
            pct >= 10 ? 'text-ok' : pct > 0 ? 'text-warn' : 'text-bad'}`}>
            {purchase ? `${pct.toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {retail > 0 && purchase > 0 && retail < purchase && (
        <p className="mt-2 text-2xs font-medium text-bad">
          {tr('This sells for less than it costs. Check the two figures.')}
        </p>
      )}
    </div>
  )
}
