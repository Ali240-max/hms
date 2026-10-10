import { useCallback, useEffect, useState } from 'react'
import { Truck, Factory, FlaskConical, Plus, Search, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Card, Empty, ErrorNote, Field, Modal, Tabs, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

type Tab = 'suppliers' | 'companies' | 'salts'

/**
 * The lists a medicine is built from.
 *
 * Suppliers, manufacturers and formulas all had to exist before a medicine
 * could point at them, and there was nowhere to create them — the only way in
 * was a demo seed. Anything a dropdown offers has to be editable by the person
 * who has to live with it.
 */
export function PharmacySetup() {
  const [tab, setTab] = useState<Tab>('suppliers')
  const TABS: [Tab, string, any][] = [
    ['suppliers', 'Suppliers', Truck],
    ['companies', 'Companies', Factory],
    ['salts', 'Formulas', FlaskConical]
  ]

  return (
    <div className="space-y-4 p-4">
      <Tabs id="pharmacy-setup" value={tab} onChange={(v) => setTab(v as Tab)}
        className="w-fit"
        tabs={TABS.map(([id, label, icon]) => ({ value: id, label: tr(label), icon }))} />

      {tab === 'suppliers' && <Suppliers />}
      {tab === 'companies' && <Companies />}
      {tab === 'salts' && <Salts />}
    </div>
  )
}

/* ------------------------------------------------------------- suppliers */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 19:00 -> "7:00 pm". Nobody at this counter reads a 24-hour clock aloud. */
function slotLabel(weekday: number, atTime: string) {
  const [h, m] = String(atTime).split(':').map(Number)
  const hour12 = ((h ?? 0) % 12) || 12
  return `${tr(DAYS[weekday] ?? '')} ${hour12}:${String(m ?? 0).padStart(2, '0')} ` +
    `${(h ?? 0) < 12 ? tr('am') : tr('pm')}`
}

function Suppliers() {
  const [rows, setRows] = useState<any[]>([])
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.ph.supplierTerms().then(setRows).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(load, [load])

  return (
    <Card title={tr('Suppliers')}
      hint={tr('Who you buy from, which companies they carry, and when they take orders.')}
      action={<button onClick={() => setAdding(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add supplier')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>
      {rows.length === 0 ? <Empty title={tr('No suppliers yet')} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr><Th>{tr('Name')}</Th><Th w="w-32">{tr('Phone')}</Th>
              <Th>{tr('Companies they carry')}</Th>
              <Th w="w-44">{tr('Books orders')}</Th>
              <Th w="w-24" /></tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 text-sm text-heading">{s.name}</td>
                <td className="px-3 py-2 num text-2xs text-muted">{s.phone ?? '—'}</td>
                <td className="px-3 py-2">
                  {(s.companies ?? []).length === 0 ? (
                    <span className="text-2xs text-muted">{tr('Not recorded')}</span>
                  ) : (
                    <span className="text-2xs text-body">
                      {(s.companies ?? []).slice(0, 4).map((c: any) => c.name).join(', ')}
                      {(s.companies ?? []).length > 4 &&
                        ` +${(s.companies ?? []).length - 4}`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {(s.slots ?? []).length === 0 ? (
                    <span className="text-2xs text-muted">—</span>
                  ) : (
                    (s.slots ?? []).map((b: any) => (
                      <span key={b.id} className="block text-2xs text-body">
                        {slotLabel(Number(b.weekday), String(b.at_time))}
                      </span>
                    ))
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setOpen(s)} className="btn-ghost px-2 py-1 text-2xs">
                    {tr('Edit terms')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <SimpleForm title={tr('Add supplier')}
          fields={[['name', 'Name', true], ['phone', 'Phone', false],
                   ['address', 'Address', false]]}
          onClose={() => setAdding(false)}
          onSave={async (v) => { await api.ph.createSupplier(v); setAdding(false); load() }} />
      )}

      {open && (
        <SupplierTerms supplier={open}
          onClose={() => { setOpen(null); load() }} />
      )}
    </Card>
  )
}

/**
 * What a distributor carries, and when they take an order.
 *
 * Both exist for the order screen. Recording the companies turns a list of
 * nine hundred medicines into the forty this supplier can actually bring, and
 * the booking time is the thing everybody knows and nobody remembers on the
 * day — "Saturday 7pm" written down once beats asking the rep every week.
 */
function SupplierTerms({ supplier, onClose }: { supplier: any; onClose: () => void }) {
  const [companies, setCompanies] = useState<any[]>(supplier.companies ?? [])
  const [slots, setSlots] = useState<any[]>(supplier.slots ?? [])
  const [all, setAll] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [weekday, setWeekday] = useState(6)
  const [atTime, setAtTime] = useState('19:00')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.ph.supplierCompanies(supplier.id).then(setCompanies).catch(() => {})
    api.ph.supplierSlots(supplier.id).then(setSlots).catch(() => {})
  }, [supplier.id])

  useEffect(() => {
    const t = setTimeout(() => {
      api.pharmaManufacturers(q).then(setAll).catch(() => {})
    }, 200)
    return () => clearTimeout(t)
  }, [q])

  const have = new Set(companies.map((c: any) => c.id))

  const guard = (p: Promise<any>, set: (v: any) => void) => {
    setErr(null)
    p.then(set).catch((e: any) => setErr(e.message))
  }

  return (
    <Modal title={supplier.name} wide
      hint={tr('What they carry, and when they take orders')}
      onClose={onClose}
      footer={<button onClick={onClose} className="btn-primary">{tr('Done')}</button>}>
      <ErrorNote>{err}</ErrorNote>

      {/* ------------------------------------------------- booking times */}

      <p className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {tr('When they take orders')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {slots.map((b: any) => (
          <span key={b.id}
            className="inline-flex items-center gap-1.5 rounded-lg border-2 border-line
                       px-2.5 py-1 text-2xs text-body">
            {slotLabel(Number(b.weekday), String(b.at_time))}
            <button onClick={() => guard(
              api.ph.removeSupplierSlot(supplier.id, b.id), setSlots)}
              className="text-rose-600" title={tr('Remove')}>
              <X size={11} />
            </button>
          </span>
        ))}
        {slots.length === 0 && (
          <span className="text-2xs text-muted">{tr('None set yet.')}</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}
          className="field w-36 py-1 text-2xs">
          {DAYS.map((d, i) => <option key={i} value={i}>{tr(d)}</option>)}
        </select>
        <input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)}
          className="field num w-28 py-1 text-2xs" />
        <button onClick={() => guard(
          api.ph.addSupplierSlot(supplier.id, { weekday, atTime }), setSlots)}
          className="btn-ghost px-2.5 py-1 text-2xs">
          {tr('Add time')}
        </button>
      </div>

      {/* ---------------------------------------------------- companies */}

      <p className="mt-5 text-2xs font-semibold uppercase tracking-wide text-muted">
        {tr('Companies they carry')}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {companies.map((c: any) => (
          <span key={c.id}
            className="inline-flex items-center gap-1.5 rounded-lg border-2 border-primary/40
                       bg-primary/10 px-2.5 py-1 text-2xs text-body">
            {c.name}
            <button onClick={() => guard(
              api.ph.removeSupplierCompany(supplier.id, c.id), setCompanies)}
              className="text-rose-600" title={tr('Remove')}>
              <X size={11} />
            </button>
          </span>
        ))}
        {companies.length === 0 && (
          <span className="text-2xs text-muted">
            {tr('None recorded, so the order screen will list every medicine.')}
          </span>
        )}
      </div>

      <div className="relative mt-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={tr('Search companies to add')} className="field pl-9 py-1.5 text-2xs" />
      </div>

      <ul className="mt-2 grid max-h-52 gap-1 overflow-auto sm:grid-cols-2">
        {all.filter((m: any) => !have.has(m.id)).slice(0, 40).map((m: any) => (
          <li key={m.id}>
            <button onClick={() => guard(
              api.ph.addSupplierCompany(supplier.id, m.id), setCompanies)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border-2
                         border-line px-2.5 py-1.5 text-left hover:border-primary/50">
              <span className="truncate text-2xs text-body">{m.name}</span>
              <span className="shrink-0 num text-[0.6rem] text-muted">
                {m.product_count}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/* ------------------------------------------------------------- companies */

function Companies() {
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.pharmaManufacturers(q).then(setRows).catch((e: any) => setErr(e.message))
  }, [q])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])

  return (
    <Card title={tr('Companies')}
      hint={tr('Who makes the medicine. Separate from the supplier — GSK makes it, a distributor sells it to you.')}
      action={<button onClick={() => setAdding(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add company')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>
      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={tr('Search companies')} className="field mb-3" />

      {rows.length === 0 ? <Empty title={tr('Nothing matches that')} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr><Th>{tr('Company')}</Th><Th w="w-28" right>{tr('Medicines')}</Th>
              <Th w="w-36">{tr('Phone')}</Th></tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 text-sm text-heading">{m.name}</td>
                <td className="px-3 py-2 text-right num text-2xs text-primary">
                  {m.product_count}
                </td>
                <td className="px-3 py-2 num text-2xs text-muted">{m.phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <SimpleForm title={tr('Add company')}
          fields={[['name', 'Name', true], ['phone', 'Phone', false],
                   ['address', 'Address', false]]}
          onClose={() => setAdding(false)}
          onSave={async (v) => { await api.createManufacturer(v); setAdding(false); load() }} />
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- salts */

function Salts() {
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.pharmaSalts(q).then(setRows).catch((e: any) => setErr(e.message))
  }, [q])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])

  return (
    <Card title={tr('Formulas')}
      hint={tr('The generic names a medicine can point at. Over a thousand ship with the system; add your own if one is missing.')}
      action={<button onClick={() => setAdding(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add formula')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={tr('Search formulas — type two letters')} className="field pl-9" />
      </div>

      {rows.length === 0 ? <Empty title={tr('Nothing matches that')} /> : (
        <>
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((s) => (
              <li key={s.id}
                className="flex items-center justify-between gap-2 rounded-lg border-2
                           border-line px-2.5 py-1.5">
                <span className="truncate text-2xs text-body">{s.name}</span>
                {s.product_count > 0 && (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1.5 num text-[0.6rem]
                                   text-primary">{s.product_count}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs text-muted">
            {tr('Showing')} {rows.length}. {tr('Type to narrow the list.')}
          </p>
        </>
      )}

      {adding && (
        <SimpleForm title={tr('Add formula')} fields={[['name', 'Name', true]]}
          onClose={() => setAdding(false)}
          onSave={async (v) => { await api.createSalt(v.name); setAdding(false); load() }} />
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ bits */

function SimpleForm({ title, fields, onClose, onSave }: {
  title: string
  fields: [string, string, boolean][]
  onClose: () => void
  onSave: (v: any) => Promise<void>
}) {
  const [v, setV] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ready = fields.filter(([, , req]) => req).every(([k]) => (v[k] ?? '').trim())

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !ready} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { await onSave(v) }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      {fields.map(([k, label, req]) => (
        <Field key={k} label={tr(label)} span>
          <input autoFocus={k === fields[0][0]} value={v[k] ?? ''}
            onChange={(e) => setV({ ...v, [k]: e.target.value })}
            className="field mt-1" />
          {req && !(v[k] ?? '').trim() && (
            <span className="mt-0.5 block text-2xs text-muted">{tr('Required')}</span>
          )}
        </Field>
      ))}
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
