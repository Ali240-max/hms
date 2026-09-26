import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Crown, AlertTriangle } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, SkeletonRows } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * What each administrator is allowed to change.
 *
 * A hospital ends up with several administrator accounts: the owner, the
 * manager, whoever set the staff list up. They do not all need the same
 * powers, and the ones that matter are the quiet ones — a price, a doctor's
 * share, clearing the system — because nothing on the screen afterwards says
 * that it happened.
 *
 * The first administrator account always holds everything and cannot be
 * restricted, by anybody, including itself. Without that rule one careless
 * save leaves a hospital with no way back in.
 */
export function AdminAccess({ me }: { me: SessionUser }) {
  const [catalogue, setCatalogue] = useState<any[] | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [allowed, setAllowed] = useState<Set<string>>(new Set())
  const [isRoot, setIsRoot] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.adminPermissionCatalogue().then(setCatalogue).catch((e: any) => setErr(e.message))
    api.adminAccounts().then((a: any[]) => {
      setAccounts(a)
      // Open on somebody who can actually be edited, not on the root account.
      const first = a.find((x) => !x.is_root) ?? a[0]
      if (first) setSelected(first.id)
    }).catch((e: any) => setErr(e.message))
  }, [])

  const load = useCallback(() => {
    if (selected == null) return
    api.adminPermissionsFor(selected).then((r: any) => {
      setAllowed(new Set(r.allowed)); setIsRoot(!!r.isRoot); setDirty(false)
    }).catch((e: any) => setErr(e.message))
  }, [selected])
  useEffect(() => { load() }, [load])

  function toggle(key: string) {
    if (isRoot) return
    setAllowed((s) => {
      const next = new Set(s)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
    setDirty(true)
  }

  async function save() {
    if (selected == null) return
    setBusy(true); setErr(null); setSaved(false)
    try {
      const r = await api.saveAdminPermissions(selected, [...allowed])
      setAllowed(new Set(r.allowed)); setDirty(false)
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const groups = [...new Set((catalogue ?? []).map((p) => p.group))]
  const current = accounts.find((a) => a.id === selected)

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Card title={tr('Administrators')} hint={`${accounts.length} ${tr('accounts')}`}>
        {accounts.length === 0 ? <Empty title={tr('Nobody yet')} /> : (
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li key={a.id}>
                <button onClick={() => setSelected(a.id)}
                  className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left
                              transition-colors ${
                    a.id === selected ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-body hover:bg-raised'}`}>
                  {a.is_root ? <Crown size={14} className="shrink-0 text-warn" />
                             : <ShieldCheck size={14} className="shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs">{a.display_name}</span>
                    <span className="block truncate num text-[0.65rem] text-muted">
                      {a.username}
                    </span>
                  </span>
                  {a.id === me.id && <Badge>{tr('you')}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-2xs text-muted">
          {tr('Add administrator accounts under Staff. They start with everything except prices, shares, demo data, clearing the system and this screen.')}
        </p>
      </Card>

      <Card title={current ? `${tr('What')} ${current.display_name} ${tr('can change')}`
                           : tr('Access')}
        hint={tr('Checked here and checked again on the server, so an unticked box is a refusal rather than a hidden button.')}
        action={
          <button onClick={save} disabled={busy || !dirty || isRoot} className="btn-primary">
            {busy ? tr('Saving…') : saved ? tr('Saved') : tr('Save')}
          </button>
        }>
        <ErrorNote>{err}</ErrorNote>

        {isRoot && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border-2 border-warn/40
                          bg-warn/5 p-3">
            <Crown size={16} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-2xs text-warn">
              {tr('This is the first administrator account and holds everything. It cannot be restricted, including by itself.')}
              <span className="mt-0.5 block text-muted">
                {tr('If it could, one careless save would leave the hospital with no way back in.')}
              </span>
            </p>
          </div>
        )}

        {!catalogue ? <SkeletonRows rows={8} cols={2} /> : (
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g}>
                <p className="label">{tr(String(g))}</p>
                <ul className="divide-y divide-divide">
                  {catalogue.filter((p) => p.group === g).map((p) => {
                    const on = allowed.has(p.key)
                    return (
                      <li key={p.key}>
                        <label className={`flex items-start gap-3 py-2.5 ${
                          isRoot ? 'cursor-default opacity-70' : 'cursor-pointer'}`}>
                          <input type="checkbox" checked={on} disabled={isRoot}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5 h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-sm text-heading">{tr(p.label)}</span>
                              {/*
                                The guarded ones are off for a new account. They
                                change money, pay, or data that cannot be got
                                back, and none of them leaves a trace on screen.
                              */}
                              {p.guarded && (
                                <Badge tone="warn">
                                  <ShieldAlert size={10} className="mr-0.5 inline" />
                                  {tr('granted deliberately')}
                                </Badge>
                              )}
                            </span>
                            <span className="block text-2xs text-muted">{tr(p.blurb)}</span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {dirty && !isRoot && (
          <p className="mt-4 flex items-center gap-1.5 text-2xs text-warn">
            <AlertTriangle size={13} /> {tr('Unsaved changes')}
          </p>
        )}
      </Card>
    </div>
  )
}
