import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArchiveRestore, CheckCircle2, FileUp, HardDrive, ShieldAlert } from 'lucide-react'
import { api, type BackupSummary } from '../../lib/api'
import { Badge, Card, ErrorNote, Field, LoadingBar, Modal } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Restore from a backup.
 *
 * Three steps, and nothing is replaced until the third:
 *
 *   1. choose — a file from this PC (a USB stick, a copy kept elsewhere), or
 *      one of the backups already in the server's backups folder
 *   2. check — the server reads the whole file and says what is in it and
 *      when it was taken, or why it cannot be used. Nothing is touched.
 *   3. confirm — password and the word RESTORE. The server backs up the
 *      current data first and abandons the restore if that fails, then
 *      replaces everything in one transaction that either completes or
 *      leaves the data exactly as it was.
 *
 * Everybody is signed out afterwards, because the staff list itself has just
 * been replaced.
 */
export function RestoreBackupCard() {
  const [source, setSource] = useState<'server' | 'upload'>('server')
  const [backups, setBackups] = useState<any[]>([])
  const [picked, setPicked] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{
    summary: BackupSummary; upload?: string; file?: string; label: string
  } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.backups().then((b) => { setBackups(b); setPicked(b[0]?.file ?? '') }).catch(() => {})
  }, [])

  /* A new choice throws away the previous check, and its upload. */
  function reset() {
    if (checked?.upload) api.discardBackupUpload(checked.upload).catch(() => {})
    setChecked(null); setErr(null)
  }

  async function check() {
    reset()
    setChecking(true)
    try {
      if (source === 'upload') {
        if (!file) return
        const r = await api.uploadBackup(file)
        setChecked({ summary: r.summary, upload: r.upload, label: file.name })
      } else {
        if (!picked) return
        setChecked({ summary: await api.inspectBackup(picked), file: picked, label: picked })
      }
    } catch (e: any) {
      setErr(e.message)
    } finally { setChecking(false) }
  }

  const s = checked?.summary

  return (
    <Card title={tr('Restore from backup')}
      hint={tr('Put the system back to the state saved in a backup file made by this system.')}
      className="border-warn/40">
      <div className="flex items-start gap-3 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
        <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warn" />
        <p className="text-2xs text-body">
          {tr('Restoring replaces ALL current data — patients, bills, stock, staff and settings — with what the backup holds. Anything entered after the backup was taken is lost from the live system. A backup of the current data is taken first, so this can be undone by restoring that file.')}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => { setSource('server'); reset() }}
          className={source === 'server' ? 'btn-primary inline-flex items-center gap-1.5 text-2xs'
            : 'btn-ghost inline-flex items-center gap-1.5 text-2xs'}>
          <HardDrive size={14} /> {tr('A backup on the server')}
        </button>
        <button onClick={() => { setSource('upload'); reset() }}
          className={source === 'upload' ? 'btn-primary inline-flex items-center gap-1.5 text-2xs'
            : 'btn-ghost inline-flex items-center gap-1.5 text-2xs'}>
          <FileUp size={14} /> {tr('A file from this computer')}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        {source === 'server' ? (
          <Field label={tr('Backup')} span>
            <select value={picked} onChange={(e) => { setPicked(e.target.value); reset() }}
              className="field num mt-1 min-w-72">
              {backups.length === 0 && <option value="">{tr('No backups yet')}</option>}
              {backups.map((b) => (
                <option key={b.file} value={b.file}>
                  {new Date(b.takenAt).toLocaleString('en-GB')} · {b.file} · {(b.size / 1024).toFixed(0)} kB
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={tr('Backup file (.ndjson.gz)')} span>
            <input ref={input} type="file" accept=".gz,application/gzip"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset() }}
              className="field mt-1 min-w-72 text-2xs" />
          </Field>
        )}
        <button onClick={check}
          disabled={checking || (source === 'server' ? !picked : !file)}
          className="btn-ghost">
          {checking ? tr('Checking…') : tr('Check this backup')}
        </button>
      </div>

      {checking && (
        <>
          <LoadingBar />
          <p className="text-2xs text-muted">
            {source === 'upload'
              ? tr('Uploading and reading the whole file. A large backup can take a minute.')
              : tr('Reading the whole file. A large backup can take a minute.')}
          </p>
        </>
      )}
      <ErrorNote>{err}</ErrorNote>

      {s && checked && (
        <div className="anim-in mt-4 rounded-2xl border-2 border-ok/40 bg-ok/5 p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ok">
            <CheckCircle2 size={16} /> {tr('This backup can be restored')}
          </p>
          <div className="mt-2 grid gap-x-6 gap-y-1 text-2xs sm:grid-cols-2">
            <span className="text-muted">{tr('Taken')}</span>
            <span className="num text-heading">
              {s.takenAt ? new Date(s.takenAt).toLocaleString('en-GB') : '—'}
              {s.reason && <Badge>{tr(s.reason)}</Badge>}
            </span>
            <span className="text-muted">{tr('File')}</span>
            <span className="num break-all text-heading">{checked.label}</span>
            <span className="text-muted">{tr('Size')}</span>
            <span className="num text-heading">{(s.sizeBytes / 1024).toFixed(0)} kB</span>
            <span className="text-muted">{tr('Contents')}</span>
            <span className="num text-heading">
              {s.tables} {tr('tables')} · {s.totalRows.toLocaleString()} {tr('rows')}
            </span>
          </div>
          {s.highlights.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {s.highlights.map((h) => (
                <span key={h.table}
                  className="rounded-lg border-2 border-line bg-card px-2 py-1 text-2xs text-body">
                  {tr(h.label)} <span className="num font-medium text-primary">{h.rows.toLocaleString()}</span>
                </span>
              ))}
            </div>
          )}
          {!s.completenessChecked && (
            <p className="mt-3 text-2xs text-warn">
              {tr('Made by an older version, before backups recorded their own row counts. The file is whole, but its row counts cannot be cross-checked.')}
            </p>
          )}
          {s.notInBackup.length > 0 && (
            <p className="mt-2 text-2xs text-muted">
              {tr('Made before some newer parts of the system existed. Their tables are left as they are, or emptied where they refer to restored records:')}{' '}
              <span className="num">{s.notInBackup.join(', ')}</span>
            </p>
          )}
          <button onClick={() => setConfirming(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl border-2 border-warn
                       bg-warn/10 px-3 py-2 text-2xs font-medium text-warn transition-colors
                       hover:bg-warn hover:text-white">
            <ArchiveRestore size={14} /> {tr('Restore this backup…')}
          </button>
        </div>
      )}

      {confirming && checked && (
        <RestoreDialog checked={checked} onClose={() => setConfirming(false)} />
      )}
    </Card>
  )
}

function RestoreDialog({ checked, onClose }: {
  checked: { summary: BackupSummary; upload?: string; file?: string; label: string }
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const ready = password.length > 0 && typed.trim().toUpperCase() === 'RESTORE'
  const s = checked.summary

  if (done) {
    return (
      /*
        Reloading is the only way out: every session was signed out by the
        restore, this one included, and the screen still holds data from
        before it.
      */
      <Modal title={tr('The backup has been restored')} onClose={() => window.location.reload()}
        footer={<button onClick={() => window.location.reload()} className="btn-primary">
          {tr('Sign in again')}
        </button>}>
        <p className="text-sm text-body">
          {done.rows.toLocaleString()} {tr('rows restored from the backup taken')}{' '}
          <span className="num">{done.takenAt ? new Date(done.takenAt).toLocaleString('en-GB') : '—'}</span>.
        </p>
        <p className="mt-3 text-2xs text-muted">{tr('The data as it was before the restore was saved to:')}</p>
        <p className="num mt-1 break-all rounded-xl border-2 border-line bg-raised p-2 text-2xs">
          {done.safetyBackup}
        </p>
        <p className="mt-3 text-2xs text-muted">
          {tr('Everybody has been signed out. Sign in with an account from the restored data.')}
        </p>
      </Modal>
    )
  }

  return (
    <Modal title={tr('Replace all current data with this backup?')} wide
      onClose={() => { if (!busy) onClose() }}
      footer={<>
        <button onClick={onClose} disabled={busy} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !ready}
          className="rounded-xl bg-warn px-4 py-2 text-sm font-medium text-white
                     transition-opacity hover:opacity-90 disabled:opacity-30"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              setDone(await api.restoreBackup({
                upload: checked.upload, file: checked.file, password, confirm: typed
              }))
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Backing up, then restoring…') : tr('Yes, restore this backup')}
        </button>
      </>}>
      <div className="flex items-start gap-2 rounded-xl border-2 border-warn/40 bg-warn/5 p-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
        <div className="text-2xs text-body">
          <p>
            {tr('Everything in the system now will be replaced by the backup taken')}{' '}
            <span className="num font-medium text-heading">
              {s.takenAt ? new Date(s.takenAt).toLocaleString('en-GB') : '—'}
            </span>.
          </p>
          <p className="mt-1">
            {tr('A backup of the current data is taken first. If that fails, or anything goes wrong while restoring, nothing is changed.')}
          </p>
          <p className="mt-1">
            {tr('Do this when nobody else is using the system: other screens wait while it runs, and everybody is signed out afterwards.')}
          </p>
        </div>
      </div>

      {busy && (
        <>
          <LoadingBar />
          <p className="text-2xs text-muted">
            {tr('Backing up the current data, then restoring. Do not close this window.')}
          </p>
        </>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label={tr('Your password')}>
          <input type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} className="field" />
        </Field>
        <Field label={tr('Type RESTORE to confirm')}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)}
            placeholder="RESTORE" className="field num" />
        </Field>
      </div>
      <ErrorNote>{err}</ErrorNote>
    </Modal>
  )
}
