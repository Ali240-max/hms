import { useCallback, useEffect, useState } from 'react'
import { BedDouble, Plus, Trash2 } from 'lucide-react'
import { api, rs, toPaisa } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Wards and beds.
 *
 * A ward carries the nightly charge its beds inherit, so a twenty-bed general
 * ward is priced once rather than twenty times. A bed can override it, which
 * is what private rooms do: pricing each one on its own is the whole point of
 * a private room.
 */
export function WardSetup() {
  const [wards, setWards] = useState<any[] | null>(null)
  const [beds, setBeds] = useState<any[]>([])
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [bedFor, setBedFor] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.wards(true).then(setWards).catch((e: any) => setErr(e.message))
    api.bedBoard().then(setBeds).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <Card title={tr('Wards and beds')}
      hint={tr('A ward sets the nightly charge its beds follow. A private room can be priced on its own.')}
      action={<button onClick={() => setEditing('new')}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add ward')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>

      {!wards ? <SkeletonRows rows={4} cols={4} />
        : wards.length === 0 ? (
          <Empty title={tr('No wards yet')}
            hint={tr('Add a ward, say how many beds it has, and the beds are made for you.')} />
        ) : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Ward')}</Th><Th w="w-24">{tr('Kind')}</Th>
              <Th w="w-20" right>{tr('Beds')}</Th><Th w="w-20" right>{tr('Free')}</Th>
              <Th w="w-28" right>{tr('A night')}</Th><Th w="w-40" right />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {wards.map((w) => (
              <tr key={w.id} className={w.is_active ? '' : 'opacity-50'}>
                <td className="px-3 py-2">
                  <span className="text-sm text-heading">{w.name}</span>
                  {w.floor && <span className="block text-2xs text-muted">{w.floor}</span>}
                </td>
                <td className="px-3 py-2"><Badge>{tr(w.kind)}</Badge></td>
                <td className="px-3 py-2 text-right num text-2xs">{w.bed_count}</td>
                <td className="px-3 py-2 text-right num text-2xs text-ok">{w.free_count}</td>
                <td className="px-3 py-2 text-right num text-sm text-primary">
                  {rs(w.charge_paisa)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setBedFor(w)} className="btn-ghost px-2 py-1 text-2xs">
                    <BedDouble size={13} className="mr-1 inline" />{tr('Beds')}
                  </button>
                  <button onClick={() => setEditing(w)}
                    className="ml-1 btn-ghost px-2 py-1 text-2xs">{tr('Edit')}</button>
                  <button
                    onClick={() => api.deleteWard(w.id).then(load)
                      .catch((e: any) => setErr(e.message))}
                    className="ml-1 btn-ghost px-2 py-1 text-2xs text-bad">
                    {tr('Delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <WardForm initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }} />
      )}
      {bedFor && (
        <BedList ward={bedFor} beds={beds.filter((b) => b.ward_id === bedFor.id)}
          onClose={() => setBedFor(null)} onChanged={load} />
      )}
    </Card>
  )
}

function WardForm({ initial, onClose, onDone }: {
  initial: any | null; onClose: () => void; onDone: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', kind: initial?.kind ?? 'general',
    floor: initial?.floor ?? '',
    charge: initial ? rs(initial.charge_paisa) : '',
    bedCount: initial ? String(initial.bed_count ?? '') : '',
    bedPrefix: '', isActive: initial ? initial.is_active : true
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <Modal title={initial ? `${tr('Edit')} ${initial.name}` : tr('Add a ward')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !f.name.trim()} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.saveWard({
                id: initial?.id, name: f.name.trim(), kind: f.kind,
                floor: f.floor.trim() || null, chargePaisa: toPaisa(f.charge || '0'),
                bedCount: f.bedCount ? Number(f.bedCount) : undefined,
                bedPrefix: f.bedPrefix.trim() || null, isActive: f.isActive
              })
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Save')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Name')}>
          <input value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('General Ward, Private Rooms, ICU')} className="field mt-1" />
        </Field>
        <Field label={tr('Kind')}>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
            className="field mt-1">
            {['general', 'private', 'semi_private', 'icu', 'nursery', 'labour', 'isolation']
              .map((k) => <option key={k} value={k}>{tr(k.replace('_', ' '))}</option>)}
          </select>
        </Field>
        <Field label={tr('Charge a night')} hint={tr('Every bed in the ward follows this')}>
          <input value={f.charge} onChange={(e) => setF({ ...f, charge: e.target.value })}
            inputMode="decimal" className="field num mt-1" />
        </Field>
        <Field label={tr('Floor')}>
          <input value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })}
            className="field mt-1" />
        </Field>

        {/*
          Beds are made in one go.
          A twenty-bed general ward is twenty identical beds, and nobody wants
          to add them one at a time. Raising the number later tops up rather
          than recreating, so an occupied bed is never lost to a typo.
        */}
        <Field label={tr('How many beds')}
          hint={initial ? tr('Raising this adds beds. Lowering it changes nothing.')
            : tr('They are numbered for you')}>
          <input value={f.bedCount} onChange={(e) => setF({ ...f, bedCount: e.target.value })}
            inputMode="numeric" className="field num mt-1" />
        </Field>
        <Field label={tr('Bed name prefix')} hint={tr('G gives G-1, G-2, G-3')}>
          <input value={f.bedPrefix} onChange={(e) => setF({ ...f, bedPrefix: e.target.value })}
            className="field mt-1" />
        </Field>
      </div>
    </Modal>
  )
}

function BedList({ ward, beds, onClose, onChanged }: {
  ward: any; beds: any[]; onClose: () => void; onChanged: () => void
}) {
  const [rows, setRows] = useState(beds)
  const [err, setErr] = useState<string | null>(null)

  async function save(bed: any, chargeText: string) {
    try {
      /*
       * Blank means "follow the ward".
       *
       * Storing the ward's own price against every bed would mean a price
       * rise had to be applied twenty times, and it would be applied
       * nineteen.
       */
      await api.saveBed({
        id: bed.id, wardId: ward.id, name: bed.name,
        chargePaisa: chargeText.trim() === '' ? null : toPaisa(chargeText)
      })
      onChanged()
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <Modal title={`${ward.name} — ${tr('beds')}`} wide onClose={onClose}
      hint={tr('Leave a price blank and the bed follows the ward. Fill it in for a private room.')}
      footer={<button onClick={onClose} className="btn-ghost">{tr('Close')}</button>}>
      <ErrorNote>{err}</ErrorNote>
      {rows.length === 0 ? <Empty title={tr('No beds in this ward yet')} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Bed')}</Th><Th w="w-28">{tr('Status')}</Th>
              <Th w="w-32">{tr('Price a night')}</Th><Th w="w-16" right />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide">
            {rows.map((b, i) => (
              <tr key={b.id}>
                <td className="px-2 py-1.5 num text-sm text-heading">{b.name}</td>
                <td className="px-2 py-1.5"><Badge
                  tone={b.status === 'free' ? 'ok' : b.status === 'occupied' ? 'primary' : 'warn'}>
                  {tr(b.status.replace('_', ' '))}
                </Badge></td>
                <td className="px-2 py-1.5">
                  <input defaultValue={b.own_price ? rs(b.charge_paisa) : ''}
                    placeholder={`${tr('ward')}: ${rs(ward.charge_paisa)}`}
                    onBlur={(e) => save(b, e.target.value)}
                    className="field num py-1 text-2xs" />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    onClick={() => api.deleteBed(b.id)
                      .then(() => { setRows(rows.filter((_, j) => j !== i)); onChanged() })
                      .catch((e: any) => setErr(e.message))}
                    className="rounded-lg px-1.5 text-muted hover:bg-bad/10 hover:text-bad">
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
