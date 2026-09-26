import { useCallback, useEffect, useState } from 'react'
import { Search, Sliders, AlertTriangle } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, SkeletonRows, Th } from '../../components/ui'
import { TestSetup } from '../Admin'
import { t as tr } from '../../lib/prefs'

/**
 * Reference ranges, set by the people who run the tests.
 *
 * An administrator decides what a test is called and what it costs. What it
 * reports, in what units and against which ranges, belongs here: the
 * laboratory knows what its own analyser produces, and a range that has to go
 * through an administrator stays wrong until somebody gets round to it.
 *
 * The same dialog the administrator has, in the department that uses it, so
 * there is no second implementation to drift out of step.
 */
export function TestSetupTab({ me }: { me: SessionUser }) {
  const isRadiology = me.role === 'radiology'
  const [rows, setRows] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.services(true)
      .then((all: any[]) => setRows(all.filter((s) =>
        s.category === (isRadiology ? 'radiology' : 'lab'))))
      .catch((e: any) => setErr(e.message))
  }, [isRadiology])
  useEffect(() => { load() }, [load])

  const shown = (rows ?? []).filter((s) =>
    !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()))
  const bare = (rows ?? []).filter((s) => s.is_active && !s.parameter_count)

  return (
    <div className="space-y-4 p-4">
      <Card title={tr('Test setup')}
        hint={tr('What each test reports, in what units, against which ranges. Names and prices are set by an administrator.')}>
        <ErrorNote>{err}</ErrorNote>

        {bare.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-warn/40
                          bg-warn/5 p-3">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-2xs text-warn">
              {bare.length} {tr('have no parameters yet.')}{' '}
              <span className="text-muted">
                {tr('Results for those are typed as one free-text finding until ranges are added.')}
              </span>
            </p>
          </div>
        )}

        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search tests')} className="field pl-9" />
        </div>

        {!rows ? <SkeletonRows rows={6} cols={3} />
          : shown.length === 0 ? <Empty title={tr('Nothing matches that')} /> : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Test')}</Th><Th w="w-32" right>{tr('Parameters')}</Th>
                <Th w="w-32" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped">
              {shown.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{s.name}</span>
                    {!s.is_active && <Badge>{tr('hidden')}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s.parameter_count
                      ? <span className="num text-2xs text-primary">{s.parameter_count}</span>
                      : <Badge tone="warn">{tr('none')}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(s)}
                      className="btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-2xs">
                      <Sliders size={13} /> {tr('Set up')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && <TestSetup service={editing} onClose={() => { setEditing(null); load() }} />}
    </div>
  )
}
