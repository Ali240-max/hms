import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, LogOut, Clock, WifiOff, Fingerprint, XCircle } from 'lucide-react'
import { api, type SessionUser } from '../lib/api'
import { t as tr } from '../lib/prefs'

/**
 * The screen by the door.
 *
 * It shows what the SERVER recorded, not what the reader thought it saw. The
 * agent on the attendance PC could confirm a scan a fraction of a second
 * sooner by announcing its own result, and it would then say "recorded" for
 * punches that never reached the server. The one thing somebody standing at a
 * door needs to know is that it counted.
 *
 * Polled rather than pushed, because a browser tab left open for three months
 * on a machine nobody logs into needs to survive the server restarting, the
 * network dropping and the screensaver waking. A poll recovers from all three
 * by itself; a socket needs reconnection logic that nobody will be there to
 * watch fail.
 */

const POLL_MS = 2000

/** How long a confirmation stays up before the screen goes back to waiting. */
const SHOW_MS = 6000

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/*
 * The reader agent, when it runs on THIS PC.
 *
 * Only for scans that failed. A failure never reaches the server, so without
 * this somebody whose finger was not recognised saw nothing happen and kept
 * pressing. It is never used to say a scan COUNTED — that still comes only
 * from the server, for the reason at the top of this file.
 */
const AGENT = 'http://127.0.0.1:5577'
const FAILED_MS = 4000

export function Kiosk({ me }: { me: SessionUser }) {
  const [latest, setLatest] = useState<any | null>(null)
  const [recent, setRecent] = useState<any[]>([])
  const [offline, setOffline] = useState(false)
  const [now, setNow] = useState(() => new Date())

  /*
   * The highest punch id already shown.
   *
   * Kept in a ref rather than state so the polling loop reads the current
   * value without being torn down and rebuilt on every scan.
   */
  const seen = useRef<number>(0)
  const clearAt = useRef<number>(0)

  const poll = useCallback(async () => {
    try {
      const rows = await api.recentPunches(seen.current || undefined)
      setOffline(false)

      if (rows.length === 0) return

      /* Newest first from the server. */
      const newest = rows[0]
      if (seen.current === 0) {
        /*
         * The first poll after the screen opens shows the recent list but no
         * confirmation. Otherwise a screen switched on at noon would announce
         * somebody who arrived at eight as though they had just scanned.
         */
        seen.current = Number(newest.id)
        setRecent(rows.slice(0, 6))
        return
      }

      seen.current = Number(newest.id)
      setLatest(newest)
      clearAt.current = Date.now() + SHOW_MS
      setRecent((old) => [...rows, ...old].slice(0, 6))
    } catch {
      /*
       * Said plainly rather than hidden.
       *
       * A screen that silently stops updating looks identical to a quiet
       * corridor, and somebody would keep pressing a finger on a reader whose
       * results are going nowhere.
       */
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => clearInterval(t)
  }, [poll])

  /* A failed scan at the reader on this PC, briefly. */
  const [failed, setFailed] = useState<string | null>(null)
  const failedUntil = useRef<number>(0)
  const agentSeq = useRef<number | null>(null)

  useEffect(() => {
    let stopped = false
    let misses = 0
    let timer: any
    const check = async () => {
      try {
        const st = await (await fetch(AGENT + '/status')).json()
        misses = 0
        const seq = st?.lastScan?.seq
        if (typeof seq === 'number') {
          /* The first read only sets the mark: an old failure is not news. */
          if (agentSeq.current != null && seq > agentSeq.current) {
            setFailed(String(st.lastScan.result || 'not_recognised'))
            failedUntil.current = Date.now() + FAILED_MS
          }
          agentSeq.current = seq
        }
      } catch {
        /* No agent on this PC, which is normal on most. Ask rarely after that. */
        misses++
      }
      if (!stopped) timer = setTimeout(check, misses >= 3 ? 30_000 : 1000)
    }
    check()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const t = setInterval(() => {
      if (failedUntil.current && Date.now() > failedUntil.current) {
        failedUntil.current = 0
        setFailed(null)
      }
    }, 500)
    return () => clearInterval(t)
  }, [])

  /* A punch that did go through replaces any failure still showing. */
  useEffect(() => { if (latest) { failedUntil.current = 0; setFailed(null) } }, [latest])

  /* The clock, and clearing a confirmation once its time is up. */
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date())
      if (clearAt.current && Date.now() > clearAt.current) {
        clearAt.current = 0
        setLatest(null)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const leaving = latest?.direction === 'out'
  const late = Number(latest?.late_minutes ?? 0) > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-screen">
      {/* ----------------------------------------------------------- top */}
      <header className="flex items-center justify-between border-b-2 border-line
                         px-6 py-3">
        <span className="text-sm font-medium text-muted">{me.displayName}</span>
        <span className="num text-2xl font-semibold text-heading">
          {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>

      {/* ------------------------------------------------- the big answer */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <AnimatePresence mode="wait">
          {offline ? (
            <motion.div key="offline"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="text-center">
              <WifiOff size={72} className="mx-auto text-warn" />
              <p className="mt-4 text-2xl font-semibold text-warn">
                {tr('Not connected to the server')}
              </p>
              <p className="mt-1 text-sm text-muted">
                {tr('Scans are still being recorded and will appear when it returns.')}
              </p>
            </motion.div>
          ) : failed && !latest ? (
            <motion.div key={'failed-' + failed}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="text-center">
              <XCircle size={88} className="mx-auto text-bad" />
              <p className="mt-5 text-3xl font-semibold text-bad">
                {failed === 'unreadable'
                  ? tr('Could not read your finger')
                  : tr('Not recognised')}
              </p>
              <p className="mt-2 text-sm text-muted">
                {tr('Lift your finger, then press it again, flat and firm.')}
              </p>
            </motion.div>
          ) : latest ? (
            <motion.div key={latest.id}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="text-center">
              {/*
                Arrival and leaving look different at a glance, because the
                person reading this is three feet away and walking.
              */}
              {leaving
                ? <LogOut size={96} className="mx-auto text-primary" />
                : <CheckCircle2 size={96} className="mx-auto text-ok" />}

              <p className="mt-5 text-5xl font-bold tracking-tight text-heading">
                {latest.display_name}
              </p>
              <p className={`mt-2 text-3xl font-semibold ${
                leaving ? 'text-primary' : 'text-ok'}`}>
                {leaving ? tr('Checked out') : tr('Checked in')}
              </p>
              <p className="mt-2 num text-2xl text-body">{clock(latest.at)}</p>

              {/*
                Stated, not scolded. A monitor by a door is the wrong place to
                tell somebody off, and the ward sister already knows.
              */}
              {late && !leaving && (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-xl
                              border-2 border-warn/40 bg-warn/5 px-3 py-1.5
                              text-sm text-warn">
                  <Clock size={14} />
                  {latest.late_minutes} {tr('minutes after')}{' '}
                  {String(latest.shift_start).slice(0, 5)}
                </p>
              )}
            </motion.div>
          ) : (
            <motion.div key="waiting"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="text-center">
              <Fingerprint size={88} className="mx-auto text-muted/50" />
              <p className="mt-5 text-3xl font-semibold text-heading">
                {tr('Place your finger on the reader')}
              </p>
              <p className="mt-2 text-sm text-muted">
                {tr('Press flat and firm, and hold until it beeps.')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ------------------------------------------------ the last few in */}
      {recent.length > 0 && (
        <footer className="border-t-2 border-line px-6 py-3">
          <p className="label mb-2">{tr('Last few')}</p>
          <ul className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <li key={r.id}
                className="rounded-xl border-2 border-line bg-card px-3 py-1.5">
                <span className="text-sm text-heading">{r.display_name}</span>
                <span className="ml-2 num text-2xs text-muted">
                  {clock(r.at)} · {r.direction === 'out' ? tr('out') : tr('in')}
                </span>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </div>
  )
}
