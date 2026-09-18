import { useCallback, useEffect, useState } from 'react'
import { api, type SessionUser } from '../../lib/api'
import { Card, Empty, ErrorNote, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Who can do what.
 *
 * A checkbox per capability rather than a fixed role, because the useful
 * distinction in a pharmacy is not "pharmacist or not" — it is whether this
 * particular person may give a discount, see the margin, or change a price.
 * The system this replaces carried 47 such flags per user and that is a large
 * part of why it survived twenty years of staff turnover.
 *
 * Only the differences from the role's default are stored, so changing what a
 * role means later still reaches everyone whose boxes were never touched.
 */
export function Access({ me }: { me: SessionUser }) {
  const [staff, setStaff] = useState<any[]>([])
  const [catalogue, setCatalogue] = useState<any[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [allowed, setAllowed] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    /*
     * The pharmacy's own list, not the hospital staff list.
     *
     * /staff is administrators only, so a pharmacy administrator asking for it
     * got a 403 and an empty screen that said there were no accounts — which
     * was the opposite of true.
     */
    api.pharmacyStaff().then((s: any[]) => {
      setStaff(s)
      if (s[0]) setSelected(s[0].id)
    }).catch((e: any) => setErr(e.message))
    api.pharmaPermissions().then(setCatalogue).catch(() => {})
  }, [])

  const load = useCallback(() => {
    if (selected == null) return
    api.permissionsFor(selected)
      .then((d) => { setAllowed(new Set(d.allowed)); setDirty(false) })
      .catch((e: any) => setErr(e.message))
  }, [selected])
  useEffect(load, [load])

  const groups = [...new Set(catalogue.map((p) => p.group))]
  const person = staff.find((s) => s.id === selected)

  function toggle(key: string) {
    setAllowed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
    setDirty(true)
  }

  function setGroup(group: string, on: boolean) {
    setAllowed((prev) => {
      const next = new Set(prev)
      for (const p of catalogue.filter((x) => x.group === group)) {
        on ? next.add(p.key) : next.delete(p.key)
      }
      return next
    })
    setDirty(true)
  }

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[260px_1fr]">
      <Card title={tr('Pharmacy staff')} hint={`${staff.length} ${tr('accounts')}`}>
        {staff.length === 0 ? (
          <Empty title={tr('No pharmacy accounts yet')}
            hint={tr('Add one under Administration, Staff. Tick Pharmacy administrator to let it set other people\'s access.')} />
        ) : (
          <ul className="space-y-0.5">
            {staff.map((s) => (
              <li key={s.id}>
                <button onClick={() => setSelected(s.id)}
                  className={`w-full rounded-lg px-2 py-2 text-left transition-colors ${
                    selected === s.id ? 'bg-primary/10' : 'hover:bg-raised'}`}>
                  <span className={`block text-sm ${
                    selected === s.id ? 'font-medium text-primary' : 'text-heading'}`}>
                    {s.display_name}
                  </span>
                  <span className="block text-2xs text-muted">
                    {s.username} · {tr(s.role)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={person ? `${tr('What')} ${person.display_name} ${tr('can do')}` : tr('Access')}
        hint={tr('Unticked means refused, whatever the role would normally allow')}
        action={
          <button onClick={async () => {
            if (selected == null) return
            setBusy(true); setErr(null); setSaved(false)
            try {
              await api.savePermissions(selected, [...allowed])
              setDirty(false); setSaved(true); setTimeout(() => setSaved(false), 2500)
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }} disabled={busy || !dirty} className="btn-primary">
            {busy ? tr('Saving…') : saved ? tr('Saved') : tr('Save')}
          </button>
        }>
        <ErrorNote>{err}</ErrorNote>

        {person?.role === 'admin' && (
          <p className="mb-3 rounded-xl border-2 border-warn/40 bg-warn/5 p-3 text-2xs text-warn">
            {tr('This is an administrator. They keep full access regardless of what is ticked here.')}
          </p>
        )}

        <div className="space-y-5">
          {groups.map((g) => {
            const items = catalogue.filter((p) => p.group === g)
            const on = items.filter((p) => allowed.has(p.key)).length
            return (
              <section key={g}>
                <div className="flex items-baseline justify-between border-b-2 border-line pb-1.5">
                  <h3 className="text-sm font-medium text-heading">
                    {tr(g)} <span className="num ml-1 text-2xs font-normal text-muted">
                      {on}/{items.length}
                    </span>
                  </h3>
                  <span className="flex gap-2">
                    <button onClick={() => setGroup(g, true)}
                      className="text-2xs text-primary hover:underline">{tr('All')}</button>
                    <button onClick={() => setGroup(g, false)}
                      className="text-2xs text-muted hover:underline">{tr('None')}</button>
                  </span>
                </div>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {items.map((p) => (
                    <li key={p.key}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5
                                        hover:bg-raised">
                        <input type="checkbox" checked={allowed.has(p.key)}
                          onChange={() => toggle(p.key)} className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-2xs text-body">{tr(p.label)}</span>
                          <span className="block num text-[0.6rem] text-muted">{p.key}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>

        {dirty && (
          <p className="mt-4 text-2xs text-warn">{tr('Unsaved changes')}</p>
        )}
      </Card>
    </div>
  )
}
