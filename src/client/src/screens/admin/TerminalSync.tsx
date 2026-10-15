import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api'
import { ErrorNote, LoadingBar } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Putting somebody onto the network terminal, from their staff record.
 *
 * HMS cannot reach the terminal; the attendance agent beside it can. So the
 * button queues a request, the agent picks it up within a few seconds, and
 * this panel shows what the DEVICE said — created, already there, or why not.
 * Nothing says "done" until the agent has read the person back off the
 * terminal.
 *
 * It sits under the terminal id field because the two are one decision: the
 * id typed there is the id the person is created under, and once they are
 * created that id is filled in for them.
 */
export function TerminalSync({ staffId, savedId, typedId, onMapped }: {
  staffId: number
  /** Their terminal id as stored. */
  savedId: string | null
  /** What the form's terminal id field holds right now, saved or not. */
  typedId: string
  /** Called when a request made from this panel set their terminal id. */
  onMapped: (id: string) => void
}) {
  const [s, setS] = useState<any | null>(null)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /*
   * Requests made from THIS dialog.
   *
   * Only those fill in the id field when they finish. An old finished job
   * read on opening must not, or a terminal id somebody has since changed by
   * hand would be quietly put back.
   */
  const started = useRef<Set<number>>(new Set())
  const reported = useRef<Set<number>>(new Set())

  const load = useCallback(async () => {
    try {
      const st = await api.terminalSyncStatus(staffId)
      setS(st)
      setDeviceId((d) => d ?? (st.terminals[0] ? Number(st.terminals[0].id) : null))
    } catch (e: any) { setErr(e.message) }
  }, [staffId])

  useEffect(() => { load() }, [load])

  const job = s?.jobs?.find((j: any) => Number(j.device_id) === Number(deviceId)) ?? null
  const open = !!job && (job.status === 'pending' || job.status === 'running')
  const terminal = s?.terminals?.find((t: any) => Number(t.id) === Number(deviceId)) ?? null

  /* Watched while the agent has it; quiet otherwise. */
  useEffect(() => {
    if (!open) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [open, load])

  useEffect(() => {
    if (job?.status === 'done' && started.current.has(Number(job.id))
        && !reported.current.has(Number(job.id))) {
      reported.current.add(Number(job.id))
      onMapped(String(job.device_user_id))
    }
  }, [job, onMapped])

  if (!s) return null

  const saved = (savedId ?? '').trim()
  const typed = typedId.trim()
  /*
   * A CHANGE to an existing id has to be saved first: the server keeps the
   * id it has, and refuses a different one from here, so that changing which
   * device user somebody is happens in one visible place.
   */
  const unsavedChange = saved !== '' && typed !== saved
  const id = saved || typed || String(staffId)

  async function send() {
    setBusy(true); setErr(null)
    try {
      const r = await api.requestTerminalSync({
        staffId, deviceId, deviceUserId: saved ? null : (typed || null)
      })
      if (r?.job?.id) started.current.add(Number(r.job.id))
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function cancel() {
    if (!job) return
    setErr(null)
    try { await api.cancelTerminalSync(Number(job.id)); await load() }
    catch (e: any) { setErr(e.message) }
  }

  /* The agent asks for work every few seconds; two minutes of silence is not normal. */
  const lastSeen = terminal?.last_seen_at ? new Date(terminal.last_seen_at) : null
  const agentQuiet = !lastSeen || Date.now() - lastSeen.getTime() > 120_000

  return (
    <div className="rounded-xl border-2 border-line bg-raised/60 p-3 sm:col-span-2">
      <p className="label">{tr('On the attendance terminal')}</p>
      <ErrorNote>{err}</ErrorNote>

      {s.terminals.length === 0 ? (
        <p className="text-2xs text-muted">
          {tr('No network terminal is set up. Add one under Attendance, Readers.')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {s.terminals.length > 1 && (
              <select value={deviceId ?? ''} disabled={busy}
                onChange={(e) => setDeviceId(Number(e.target.value))}
                className="field w-auto py-1.5 text-2xs">
                {s.terminals.map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <span className="text-2xs text-muted">
              {tr('Terminal id')} <b className="num text-heading">{id}</b>
            </span>
            <button onClick={send}
              disabled={busy || open || unsavedChange || !deviceId}
              className="btn-ghost ml-auto px-3 py-1.5 text-2xs">
              {busy ? tr('Sending…')
                : job?.status === 'failed' ? tr('Try again')
                : saved ? tr('Check on the terminal')
                : tr('Create on the terminal')}
            </button>
          </div>

          {unsavedChange && (
            <p className="mt-1 text-2xs text-warn">{tr('Save the new terminal id first.')}</p>
          )}

          {job && open && (
            <div className="mt-2">
              <LoadingBar />
              <div className="flex items-center justify-between gap-2">
                <p className="text-2xs text-muted">
                  {job.status === 'pending'
                    ? tr('Waiting for the terminal agent to pick this up…')
                    : tr('The agent is working on it…')}
                </p>
                {job.status === 'pending' && (
                  <button onClick={cancel} className="text-2xs text-muted hover:text-bad">
                    {tr('Cancel')}
                  </button>
                )}
              </div>
              {/*
                Said rather than left spinning. A request nobody is going to
                pick up looks exactly like one about to be picked up.
              */}
              {job.status === 'pending' && agentQuiet && (
                <p className="mt-1 text-2xs text-warn">
                  {tr('The agent on the terminal PC was last heard from')}{' '}
                  {lastSeen ? lastSeen.toLocaleString('en-GB') : tr('never')}.
                </p>
              )}
            </div>
          )}

          {job && job.status === 'done' && (
            <div className="mt-2 flex items-start gap-2 rounded-xl border-2 border-ok/40
                            bg-ok/5 p-2.5">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
              <div className="text-2xs">
                <p className="text-ok">{job.message}</p>
                <p className="mt-0.5 text-muted">
                  {tr('Next: enrol a finger on the terminal itself. Menu, User Mgt, find this id, Edit, Fingerprint.')}
                </p>
              </div>
            </div>
          )}

          {job && job.status === 'failed' && (
            <div className="mt-2 flex items-start gap-2 rounded-xl border-2 border-bad/40
                            bg-bad/5 p-2.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" />
              <p className="text-2xs text-bad">{job.message}</p>
            </div>
          )}

          <p className="mt-2 text-2xs text-muted">
            {tr('Fingerprints are not sent to the terminal. Each person enrols a finger on the terminal itself, against this id.')}
          </p>
        </>
      )}
    </div>
  )
}
