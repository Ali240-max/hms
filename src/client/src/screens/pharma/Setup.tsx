import { useCallback, useEffect, useState } from 'react'
import { Truck, Factory, FlaskConical, Plus, Search } from 'lucide-react'
import { api } from '../../lib/api'
import { Card, Empty, ErrorNote, Field, Modal, Th } from '../../components/ui'
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
      <div className="flex flex-wrap gap-1">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-2xs
                        transition-colors ${
              tab === id ? 'bg-brand text-white'
                         : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            <Icon size={13} /> {tr(label)}
          </button>
        ))}
      </div>

      {tab === 'suppliers' && <Suppliers />}
      {tab === 'companies' && <Companies />}
      {tab === 'salts' && <Salts />}
    </div>
  )
}

/* ------------------------------------------------------------- suppliers */

function Suppliers() {
  const [rows, setRows] = useState<any[]>([])
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.ph.suppliers().then(setRows).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(load, [load])

  return (
    <Card title={tr('Suppliers')} hint={tr('Who you buy from. Chosen when receiving a delivery.')}
      action={<button onClick={() => setAdding(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add supplier')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>
      {rows.length === 0 ? <Empty title={tr('No suppliers yet')} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr><Th>{tr('Name')}</Th><Th w="w-36">{tr('Phone')}</Th>
              <Th>{tr('Address')}</Th></tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 text-sm text-heading">{s.name}</td>
                <td className="px-3 py-2 num text-2xs text-muted">{s.phone ?? '—'}</td>
                <td className="px-3 py-2 text-2xs text-muted">{s.address ?? '—'}</td>
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
    </Card>
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
