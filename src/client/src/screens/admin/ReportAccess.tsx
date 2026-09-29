import { useCallback, useEffect, useState } from 'react'
import { BarChart3, Check, X } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, SkeletonRows } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Which reports each login can open.
 *
 * Reports used to be gated by role alone: the laboratory saw laboratory
 * reports and nobody else saw anything. Right most of the time, and wrong
 * often enough to matter — an owner wants the cashier to see the day's
 * takings but not the doctors' shares.
 *
 * The role still decides the starting point, so a new account is sensible
 * without anybody touching this screen, and a report added in a later version
 * appears for the roles it belongs to on its own. What is ticked here is the
 * difference from that starting point.
 */
export function ReportAccess({ me }: { me: SessionUser }) {
  const [accounts, setAccounts] = useState<any[]>([])
  const [catalogue, setCatalogue] = useState<any[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [allowed, setAllowed] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.reportAccessCatalogue().then(setCatalogue).catch((e: any) => setErr(e.message))
    api.reportAccounts().then((a: any[]) => {
      setAccounts(a)
      if (a.length) setSelected(a[0].id)
    }).catch((e: any) => setErr(e.message))
  }, [])

  const load = useCallback(() => {
    if (selected == null) return
    api.reportsFor(selected)
      .then((r: any) => { setAllowed(new Set(r.allowed)); setDirty(false) })
      .catch((e: any) => setErr(e.message))
  }, [selected])
  useEffect(() => { load() }, [load])

  function toggle(id: string) {
    setAllowed((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
    setDirty(true)
  }

  /** Whole group on or off, because a group can hold a dozen reports. */
  function setGroup(reports: any[], on: boolean) {
    setAllowed((s) => {
      const next = new Set(s)
      for (const r of reports) on ? next.add(r.id) : next.delete(r.id)
      return next
    })
    setDirty(true)
  }

  async function save() {
    if (selected == null) return
    setBusy(true); setErr(null)
    try {
      const r = await api.saveReportsFor(selected, [...allowed])
      setAllowed(new Set(r.allowed)); setDirty(false)
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const current = accounts.find((a) => a.id === selected)
  const total = (catalogue ?? []).reduce((n, g) => n + g.reports.length, 0)

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card title={tr('Logins')} hint={`${accounts.length} ${tr('accounts')}`}>
        {accounts.length === 0 ? <Empty title={tr('Nobody yet')} /> : (
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li key={a.id}>
                <button onClick={() => setSelected(a.id)}
                  className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${
                    a.id === selected ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-body hover:bg-raised'}`}>
                  <span className="block truncate text-2xs">{a.display_name}</span>
                  <span className="block truncate num text-[0.65rem] text-muted">
                    {a.username} · {tr(a.role)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={current ? `${tr('Reports')} ${current.display_name} ${tr('can open')}`
                       : tr('Report access')}
        hint={`${allowed.size} ${tr('of')} ${total} ${tr('reports')} · ${
          tr('unticking one hides it from their Reports tab at once')}`}
        action={
          <button onClick={save} disabled={busy || !dirty} className="btn-primary">
            {busy ? tr('Saving…') : saved ? tr('Saved') : tr('Save')}
          </button>
        }>
        <ErrorNote>{err}</ErrorNote>

        {!catalogue ? <SkeletonRows rows={10} cols={2} /> : (
          <div className="space-y-5">
            {catalogue.map((g) => {
              const on = g.reports.filter((r: any) => allowed.has(r.id)).length
              return (
                <section key={g.group}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="label flex items-center gap-1.5">
                      <BarChart3 size={13} /> {tr(g.group)}
                      <Badge tone={on === 0 ? 'muted' : on === g.reports.length ? 'ok' : 'warn'}>
                        {on}/{g.reports.length}
                      </Badge>
                    </p>
                    <span className="flex gap-1">
                      <button onClick={() => setGroup(g.reports, true)}
                        className="btn-ghost px-2 py-0.5 text-[0.65rem]">
                        <Check size={11} className="mr-0.5 inline" />{tr('All')}
                      </button>
                      <button onClick={() => setGroup(g.reports, false)}
                        className="btn-ghost px-2 py-0.5 text-[0.65rem]">
                        <X size={11} className="mr-0.5 inline" />{tr('None')}
                      </button>
                    </span>
                  </div>

                  <ul className="divide-y divide-divide rounded-xl border-2 border-line px-3">
                    {g.reports.map((r: any) => (
                      <li key={r.id}>
                        <label className="flex cursor-pointer items-start gap-3 py-2">
                          <input type="checkbox" checked={allowed.has(r.id)}
                            onChange={() => toggle(r.id)}
                            className="mt-0.5 h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-heading">{tr(r.title)}</span>
                            <span className="block text-2xs text-muted">{tr(r.blurb)}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}

        <p className="mt-4 text-2xs text-muted">
          {tr('A new account starts with the reports its role would expect, so this screen is only for the exceptions. Reports added in a future version appear the same way, without anybody ticking them here.')}
        </p>
      </Card>
    </div>
  )
}
