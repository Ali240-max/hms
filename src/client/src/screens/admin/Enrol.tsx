import { useCallback, useEffect, useRef, useState } from 'react'
import { Fingerprint, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api'
import { Badge, ErrorNote, Empty, Modal } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Enrolling a finger.
 *
 * A browser cannot touch USB, so this talks to the agent running on THIS PC
 * rather than to the server. That is the one hard constraint: enrolment only
 * works at the machine with the reader plugged into it, and saying so plainly
 * is better than a screen that silently does nothing everywhere else.
 */

/* The agent listens on loopback only, so nothing on the LAN can reach it. */
const AGENT = 'http://127.0.0.1:5577'

async function agent(path: string, init?: RequestInit) {
  const r = await fetch(AGENT + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  })
  if (!r.ok) throw new Error(`The reader agent answered ${r.status}`)
  return r.json()
}

export function EnrolFinger({ staff, onClose }: {
  staff: any
  onClose: () => void
}) {
  const [fingers, setFingers] = useState<any[]>([])
  const [reader, setReader] = useState<any | null>(null)
  const [looking, setLooking] = useState(true)
  const [running, setRunning] = useState(false)
  const [captures, setCaptures] = useState(0)
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [fingerIndex, setFingerIndex] = useState(1)

  const timer = useRef<any>(null)

  const loadFingers = useCallback(() => {
    api.attendanceFingerprints(staff.id).then(setFingers).catch(() => {})
  }, [staff.id])

  useEffect(() => {
    loadFingers()
    agent('/status')
      .then((s) => { setReader(s); setLooking(false) })
      .catch(() => { setReader(null); setLooking(false) })
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [loadFingers])

  async function start() {
    setErr(null); setNote(''); setCaptures(0); setRunning(true)
    try {
      await agent('/enrol/start', {
        method: 'POST',
        body: JSON.stringify({ staffId: staff.id, fingerIndex })
      })
    } catch (e: any) { setErr(e.message); setRunning(false); return }

    timer.current = setInterval(async () => {
      try {
        const p = await agent('/enrol/progress')
        setCaptures(p.captures ?? 0)
        if (p.message) setNote(p.message)

        if (p.failed) {
          clearInterval(timer.current); setRunning(false)
          setErr(p.message || tr('The reader could not merge those captures.'))
          return
        }

        if (p.done && p.template) {
          clearInterval(timer.current)
          /*
           * The template reaches HMS through the administrator's own session,
           * not the agent's. The agent holds a reader key, which is only good
           * for reading templates and writing punches — deciding whose finger
           * this is belongs to whoever is signed in here.
           */
          try {
            await api.saveFingerprint(staff.id, fingerIndex, p.template)
            setNote(tr('Finger enrolled.'))
            loadFingers()
          } catch (e: any) { setErr(e.message) }
          setRunning(false)
        }
      } catch (e: any) {
        clearInterval(timer.current); setRunning(false)
        setErr(e.message)
      }
    }, 700)
  }

  async function cancel() {
    if (timer.current) clearInterval(timer.current)
    setRunning(false)
    try { await agent('/enrol/cancel', { method: 'POST' }) } catch { /* it stops anyway */ }
  }

  const taken = new Set(fingers.map((f) => Number(f.finger_index)))

  return (
    <Modal title={`${tr('Fingerprints')} — ${staff.display_name}`} onClose={onClose}
      hint={tr('Only works at the PC with the reader plugged into it.')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        {running
          ? <button onClick={cancel} className="btn-ghost">{tr('Stop')}</button>
          : <button onClick={start} disabled={!reader} className="btn-primary">
              {tr('Enrol this finger')}
            </button>}
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {/* ------------------------------------------------- is there a reader */}
      {looking ? (
        <p className="text-2xs text-muted">{tr('Looking for the reader…')}</p>
      ) : !reader ? (
        /*
         * The common case on every machine except one, so it explains itself
         * rather than just refusing.
         */
        <div className="flex items-start gap-2 rounded-xl border-2 border-warn/40
                        bg-warn/5 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-2xs text-warn">
            {tr('No reader agent on this PC. Fingerprints can only be enrolled at the machine the reader is plugged into, with the agent running.')}
          </p>
        </div>
      ) : (
        <p className="text-2xs text-muted">
          {tr('Reader')}: <b>{reader.reader}</b> · {reader.templates} {tr('fingers loaded')}
        </p>
      )}

      {/* --------------------------------------------------- which finger */}
      <p className="label mt-4">{tr('Which finger')}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {[1, 2, 3].map((i) => (
          <button key={i} onClick={() => setFingerIndex(i)} disabled={running}
            className={`rounded-xl px-3 py-1.5 text-2xs transition-colors ${
              fingerIndex === i ? 'bg-brand text-white'
                : 'border-2 border-line bg-card text-body hover:bg-raised'}`}>
            {tr('Finger')} {i}{taken.has(i) ? ` · ${tr('enrolled')}` : ''}
          </button>
        ))}
      </div>
      {/*
        Two fingers is the advice, not one. Hospital hands get cut, bandaged
        and gloved, and one enrolled thumb is one bad morning away from
        somebody standing at a door unable to clock in.
      */}
      <p className="mt-1 text-2xs text-muted">
        {tr('Enrol two, so a cut thumb does not lock somebody out.')}
      </p>

      {/* ------------------------------------------------------ the capture */}
      {running && (
        <div className="mt-4 rounded-xl border-2 border-primary/30 bg-primary/5 p-4
                        text-center">
          <Fingerprint size={48} className="mx-auto text-primary" />
          <p className="mt-2 text-sm font-medium text-heading">
            {tr('Press the same finger three times')}
          </p>
          <div className="mt-3 flex justify-center gap-2">
            {[0, 1, 2].map((i) => (
              <span key={i}
                className={`h-2.5 w-10 rounded-full ${
                  i < captures ? 'bg-ok' : 'bg-line'}`} />
            ))}
          </div>
          <p className="mt-2 text-2xs text-muted">
            {captures} {tr('of 3')}{note ? ` · ${note}` : ''}
          </p>
        </div>
      )}

      {!running && note && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border-2
                        border-ok/40 bg-ok/5 p-3">
          <CheckCircle2 size={15} className="shrink-0 text-ok" />
          <p className="text-2xs text-ok">{note}</p>
        </div>
      )}

      {/* --------------------------------------------------- what is enrolled */}
      <p className="label mt-5">{tr('Enrolled')}</p>
      {fingers.length === 0 ? (
        <Empty title={tr('No fingers enrolled yet')} />
      ) : (
        <ul className="mt-1 divide-y divide-divide rounded-xl border-2 border-line">
          {fingers.map((f) => (
            <li key={f.id} className="flex items-center justify-between px-3 py-2">
              <span>
                <span className="text-sm text-heading">
                  {tr('Finger')} {f.finger_index}
                </span>
                <span className="block text-2xs text-muted">
                  {f.enrolled_by ? `${tr('by')} ${f.enrolled_by} · ` : ''}
                  {new Date(f.created_at).toLocaleDateString('en-GB')}
                </span>
              </span>
              <button
                onClick={() => api.deleteFingerprint(f.id).then(loadFingers)
                  .catch((e: any) => setErr(e.message))}
                className="rounded-lg px-2 py-1 text-muted hover:bg-bad/10 hover:text-bad">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {fingers.length > 0 && (
        <p className="mt-2 text-2xs text-muted">
          <Badge tone="ok">{tr('live')}</Badge>{' '}
          {tr('Readers pick up a new finger within five minutes, or straight away if the agent is restarted.')}
        </p>
      )}
    </Modal>
  )
}
