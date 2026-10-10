import { useCallback, useEffect, useState } from 'react'
import { Search, Save } from 'lucide-react'
import { api, stockLabel, type SessionUser } from '../../lib/api'
import { Card, Empty, ErrorNote, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Typing in what is already on the shelves, on the first morning.
 *
 * A shop switching over to this system has stock it never bought through it.
 * Receiving it as a delivery would invent a supplier invoice that does not
 * exist; counting it as an audit adjustment would compare it against a system
 * figure of zero and read as a loss of everything in the shop. So it is its
 * own screen, and its own permission.
 *
 * The box SETS the figure rather than adding to it. Somebody correcting a
 * typo five minutes later expects the box to mean what it says, and "90"
 * meaning "another ninety" is how a changeover ends up with double the stock.
 *
 * Only rows that were actually typed in are sent. Opening a list of nine
 * hundred medicines and saving must not write nine hundred zeroes over
 * whatever is there.
 */
export function Opening({ me }: { me: SessionUser }) {
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.ph.openingStock(q)
      .then(setRows)
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [q])
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  const pending = Object.entries(typed).filter(([, v]) => v !== '')

  async function save() {
    setBusy(true); setErr(null); setSaved(null)
    try {
      const r = await api.ph.saveOpeningStock(
        pending.map(([id, v]) => ({ productId: Number(id), units: Number(v) })))
      setSaved(r.changed === 0
        ? tr('Nothing changed — those figures were already set.')
        : `${r.changed} ${tr('medicines updated.')}`)
      setTyped({})
      load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="p-4">
      <Card title={tr('Opening stock')}
        hint={tr('For the first day only. Type what is actually on the shelf — the figure replaces what is there, it is not added to it.')}
        action={<button onClick={save} disabled={busy || pending.length === 0}
          className="btn-primary inline-flex items-center gap-1.5">
          <Save size={14} />
          {busy ? tr('Saving…')
            : pending.length ? `${tr('Save')} ${pending.length}`
            : tr('Save')}
        </button>}>
        <ErrorNote>{err}</ErrorNote>
        {saved && (
          <p className="mb-3 rounded-lg border-2 border-line bg-primary/10 px-3 py-2
                        text-2xs text-body">{saved}</p>
        )}

        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search medicines')} className="field pl-9" />
        </div>

        {loading ? (
          <p className="py-6 text-center text-2xs text-muted">{tr('Loading…')}</p>
        ) : rows.length === 0 ? (
          <Empty title={tr('No medicines yet')}
            hint={tr('Add medicines first, then come back and set what is on the shelf.')} />
        ) : (
          <div className="max-h-[36rem] overflow-auto">
            <table className="w-full">
              <thead className="thead-strip sticky top-0 z-10">
                <tr>
                  <Th>{tr('Medicine')}</Th>
                  <Th w="w-40">{tr('Company')}</Th>
                  <Th w="w-20">{tr('Pack')}</Th>
                  <Th w="w-20">{tr('Rack')}</Th>
                  <Th w="w-32" right>{tr('On system')}</Th>
                  <Th w="w-28" right>{tr('On shelf')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((r) => {
                  const v = typed[r.product_id]
                  return (
                    <tr key={r.product_id} className={v !== undefined && v !== '' ? 'bg-primary/5' : ''}>
                      <td className="px-3 py-2 text-sm text-heading">{r.product_name}</td>
                      <td className="px-3 py-2 text-2xs text-muted">{r.manufacturer ?? '—'}</td>
                      <td className="px-3 py-2 num text-2xs text-muted">
                        {r.pack_label ?? `${Math.max(1, Number(r.pack_size ?? 1))}'s`}
                      </td>
                      <td className="px-3 py-2 text-2xs text-muted">{r.rack_location ?? '—'}</td>
                      {/* Pack and total units together, as everywhere else. */}
                      <td className="px-3 py-2 text-right num text-2xs text-muted">
                        {stockLabel(r.stock_units, r.pack_label, r.pack_size)}
                        {Number(r.opening_units) > 0 && (
                          <span className="block text-[0.6rem]">
                            {r.opening_units} {tr('opening')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input inputMode="numeric" value={v ?? ''}
                          onChange={(e) => setTyped({
                            ...typed,
                            [r.product_id]: e.target.value.replace(/[^\d]/g, '')
                          })}
                          placeholder="—"
                          className="field num w-20 py-1 text-right" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-2xs text-muted">
          {rows.length} {tr('medicines listed.')}{' '}
          {tr('Only the rows you type into are saved.')} {me.displayName}
        </p>
      </Card>
    </div>
  )
}
