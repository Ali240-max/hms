import { useEffect, useState } from 'react'
import { AlertTriangle, HardDriveDownload, FolderCheck, Trash2, ShieldAlert } from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import { Card, ErrorNote, Field, Modal } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/* ------------------------------------------------- where backups are kept */

/**
 * A second place to put backups.
 *
 * The copy beside the application is always written and cannot be switched
 * off. This adds one more — a USB drive, a second disk, a mapped network
 * folder — because a backup on the same disk as the database is not a backup:
 * one dead drive takes both.
 *
 * The folder is tested for writability before it is saved. A path that looks
 * right but cannot be written to is worse than none at all, since the screen
 * would claim a copy was being taken when none was.
 */
export function BackupLocationCard() {
  const [d, setD] = useState<any>(null)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.backupLocation().then((r: any) => { setD(r); setDir(r.extraDir ?? '') })
      .catch((e: any) => setErr(e.message))
  }, [])

  async function save(next: string | null) {
    setBusy(true); setErr(null); setSaved(false)
    try {
      const r = await api.saveBackupLocation(next)
      setD((prev: any) => ({ ...prev, extraDir: r.extraDir }))
      setDir(r.extraDir ?? '')
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Card title={tr('Where backups are kept')}
      hint={tr('One copy is always written beside the application. A second is optional.')}>
      <ErrorNote>{err}</ErrorNote>

      <div className="rounded-xl border-2 border-line bg-raised p-3">
        <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted">
          <HardDriveDownload size={13} /> {tr('Always written here')}
        </p>
        <p className="num mt-0.5 break-all text-sm text-heading">{d?.defaultDir ?? '—'}</p>
        <p className="mt-1 text-2xs text-muted">
          {tr('This one cannot be switched off. It runs every 12 hours and keeps the last 14.')}
        </p>
      </div>

      <Field label={tr('Second copy (optional)')}
        hint={tr('A USB drive, another disk, or a network folder.')} span>
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={dir} onChange={(e) => setDir(e.target.value)}
            placeholder="D:\hms-backups" className="field num min-w-48 flex-1" />
          <button onClick={() => save(dir)} disabled={busy || dir === (d?.extraDir ?? '')}
            className="btn-primary inline-flex items-center gap-1.5">
            <FolderCheck size={14} /> {busy ? tr('Checking…') : tr('Check and save')}
          </button>
          {d?.extraDir && (
            <button onClick={() => save(null)} disabled={busy} className="btn-ghost">
              {tr('Remove')}
            </button>
          )}
        </div>
      </Field>

      {saved && <p className="mt-2 text-2xs text-ok">{tr('Saved')}</p>}

      {d?.extraDir && (
        <div className="mt-3 text-2xs">
          {d.lastCopyError
            ? <p className="text-bad">{tr('The last copy failed')}: {d.lastCopyError}</p>
            : d.lastCopyAt
              ? <p className="text-ok">
                  {tr('Last copied')} {new Date(d.lastCopyAt).toLocaleString('en-GB')}
                </p>
              : <p className="text-muted">
                  {tr('No copy taken yet — one goes with the next backup.')}
                </p>}
        </div>
      )}

      <p className="mt-3 text-2xs text-muted">
        {tr('A backup on the same disk as the database is not a backup. One dead drive takes both.')}
      </p>
    </Card>
  )
}

/* ------------------------------------------------------------ start again */

/**
 * Clearing the trading data.
 *
 * Four locks, each guarding a different way this goes wrong: an administrator
 * only; their password again, in case the machine was left unlocked; the
 * hospital's own name typed out, so it cannot be clicked through; and a backup
 * taken first that abandons the whole thing if it fails.
 *
 * Staff, services, departments, doctors and the medicine catalogue survive.
 * That is a week of somebody's setup, and starting clean means dropping the
 * trading, not making them enter everything twice.
 */
export function DangerZoneCard({ me }: { me: SessionUser }) {
  const [open, setOpen] = useState(false)
  return (
    <Card title={tr('Start from a clean slate')}
      hint={tr('Removes every patient, visit, bill and result. Keeps staff, services and the medicine list.')}
      className="border-bad/40">
      <div className="flex items-start gap-3 rounded-xl border-2 border-bad/40 bg-bad/5 p-3">
        <ShieldAlert size={20} className="mt-0.5 shrink-0 text-bad" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-bad">
            {tr('This cannot be undone from inside the system.')}
          </p>
          <p className="mt-0.5 text-2xs text-muted">
            {tr('A full backup is taken first and the wipe is abandoned if it fails, so there is always a file to restore from. Use this after a trial period, never on a hospital that is trading.')}
          </p>
          <button onClick={() => setOpen(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl border-2 border-bad
                       bg-bad/10 px-3 py-2 text-2xs font-medium text-bad transition-colors
                       hover:bg-bad hover:text-white">
            <Trash2 size={14} /> {tr('Clear all data…')}
          </button>
        </div>
      </div>

      {open && <WipeDialog me={me} onClose={() => setOpen(false)} />}
    </Card>
  )
}

function WipeDialog({ me, onClose }: { me: SessionUser; onClose: () => void }) {
  const [preview, setPreview] = useState<any>(null)
  const [hospital, setHospital] = useState<any>(null)
  const [password, setPassword] = useState('')
  const [typedName, setTypedName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.wipePreview().then(setPreview).catch((e: any) => setErr(e.message))
    api.hospital().then(setHospital).catch(() => {})
  }, [])

  const nameMatches =
    typedName.trim().toLowerCase() === String(hospital?.name ?? '').trim().toLowerCase()
  const ready = password.length > 0 && nameMatches && !!hospital?.name

  if (done) {
    return (
      <Modal title={tr('The system has been cleared')} onClose={onClose}
        footer={<button onClick={() => window.location.reload()} className="btn-primary">
          {tr('Reload')}
        </button>}>
        <p className="text-sm text-body">
          {tr('Everything was backed up first. The file is at:')}
        </p>
        <p className="num mt-1 break-all rounded-xl border-2 border-line bg-raised p-2 text-2xs">
          {done.backup}
        </p>
        <p className="mt-3 text-2xs text-muted">
          {tr('Staff, services, departments and the medicine list are untouched. Document numbers start again from one.')}
        </p>
      </Modal>
    )
  }

  return (
    <Modal title={tr('Clear all data?')} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !ready}
          className="rounded-xl bg-bad px-4 py-2 text-sm font-medium text-white
                     transition-opacity hover:opacity-90 disabled:opacity-30"
          onClick={async () => {
            setBusy(true); setErr(null)
            try { setDone(await api.wipeAll(password, typedName)) }
            catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Backing up, then clearing…') : tr('Yes, clear everything')}
        </button>
      </>}>

      <div className="flex items-start gap-2 rounded-xl border-2 border-bad/40 bg-bad/5 p-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" />
        <p className="text-2xs text-bad">
          {tr('A backup is taken before anything is deleted. If the backup fails, nothing is deleted.')}
        </p>
      </div>

      {preview && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="label text-bad">
              {tr('Will be deleted')} — {preview.totalRows.toLocaleString()} {tr('rows')}
            </p>
            <div className="max-h-48 overflow-auto rounded-xl border-2 border-bad/30">
              <table className="w-full">
                <tbody className="divide-y divide-divide">
                  {preview.willDelete.length === 0 && (
                    <tr><td className="px-3 py-2 text-2xs text-muted">
                      {tr('Nothing to delete — the system is already clean.')}
                    </td></tr>
                  )}
                  {preview.willDelete.map((r: any) => (
                    <tr key={r.table}>
                      <td className="px-3 py-1 text-2xs text-body">{r.table}</td>
                      <td className="px-3 py-1 text-right num text-2xs text-bad">
                        {r.rows.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="label text-ok">{tr('Will be kept')}</p>
            <div className="max-h-48 overflow-auto rounded-xl border-2 border-ok/30">
              <table className="w-full">
                <tbody className="divide-y divide-divide">
                  {preview.willKeep.map((r: any) => (
                    <tr key={r.table}>
                      <td className="px-3 py-1 text-2xs text-body">{r.table}</td>
                      <td className="px-3 py-1 text-right num text-2xs text-ok">
                        {r.rows.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label={tr('Your password')}
          hint={`${me.displayName} — ${tr('asked again in case the machine was left unlocked')}`}>
          <input type="password" value={password} autoComplete="off"
            onChange={(e) => setPassword(e.target.value)} className="field" />
        </Field>
        <Field label={tr('Type the hospital name exactly')}
          hint={hospital?.name ? `"${hospital.name}"` : tr('Set it in Settings first')}>
          <input value={typedName} onChange={(e) => setTypedName(e.target.value)}
            className={`field ${typedName && !nameMatches ? 'border-bad' : ''}`} />
        </Field>
      </div>

      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
