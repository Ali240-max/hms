import { useCallback, useEffect, useState } from 'react'
import { Printer, Wifi, Network, CheckCircle2, AlertTriangle, Monitor } from 'lucide-react'
import { api, deviceId } from '../lib/api'
import { Card, ErrorNote, Field } from '../components/ui'
import { t as tr } from '../lib/prefs'

/**
 * Which printer this counter's receipts go to.
 *
 * The server prints them, not the browser, so the printer has to be reachable
 * from the server. That is the one thing worth understanding here, and it
 * decides which of the two options applies:
 *
 *   - a printer with its own network connection is reached directly on port
 *     9100, from anywhere on the hospital network
 *   - a printer plugged into a counter PC by USB has to be shared from that
 *     PC first, and is then reached as \\PC-NAME\ShareName
 *
 * Printing used to go through the browser, which is why receipts were
 * followed by metres of blank roll: a browser prints pages, and a thermal
 * printer feeds to the end of whatever page its driver is set to. None of
 * that applies any more.
 */
export function PrinterSettingsCard({ module, label }: { module: string; label: string }) {
  const [cfg, setCfg] = useState<any>(null)
  const [available, setAvailable] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [tested, setTested] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.printerConfig(module).then(setCfg).catch((e: any) => setErr(e.message))
    api.availablePrinters().then(setAvailable).catch(() => {})
  }, [module])
  useEffect(() => { load() }, [load])

  async function save(patch: any) {
    setBusy(true); setErr(null); setTested(null)
    try {
      setCfg(await api.savePrinterConfig(module, patch))
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function testPrint() {
    setBusy(true); setErr(null); setTested(null)
    try {
      await api.testPrint(module)
      setTested(tr('Sent. Check the printer.'))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!cfg) return <Card title={label}><p className="text-2xs text-muted">{tr('Loading…')}</p></Card>

  const kind = cfg.target?.kind ?? 'none'

  return (
    <Card title={label}
      hint={tr('Receipts are sent straight to the printer by the server, not through the browser.')}>
      <ErrorNote>{err}</ErrorNote>

      {/*
        Which PC these settings belong to.
        Two windows at one counter have two PCs and two printers, and the
        settings are held against the machine — so it has to be obvious which
        machine is being set up, or somebody sets up the same one twice and
        wonders why the other window still prints nowhere.
      */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border-2 border-line
                      bg-raised px-3 py-2">
        <Monitor size={14} className="shrink-0 text-muted" />
        <span className="text-2xs text-muted">{tr('These settings are for this PC only')}</span>
        <span className="num rounded-lg bg-card px-2 py-0.5 text-2xs text-body">
          {deviceId() || tr('shared')}
        </span>
        <span className="text-2xs text-muted">
          {tr('The other window sets up its own printer on its own PC.')}
        </span>
      </div>

      <Field label={tr('How the printer is connected')} span>
        <select value={kind} className="field mt-1"
          onChange={(e) => {
            const k = e.target.value
            save({ target: k === 'network' ? { kind: 'network', host: '', port: 9100 }
              : k === 'share' ? { kind: 'share', unc: '' }
              : { kind: 'none' } })
          }}>
          <option value="none">{tr('Not set — printing is off for this counter')}</option>
          <option value="network">{tr('Network printer (its own cable or Wi-Fi)')}</option>
          <option value="share">{tr('USB printer shared from a PC')}</option>
        </select>
      </Field>

      {kind === 'network' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_120px]">
          <Field label={tr('Printer address')}
            hint={tr('The IP printed on the printer\'s own self-test page')}>
            <input value={cfg.target.host ?? ''} placeholder="192.168.1.60"
              onChange={(e) => setCfg({ ...cfg, target: { ...cfg.target, host: e.target.value } })}
              onBlur={() => save({ target: cfg.target })}
              className="field num mt-1" />
          </Field>
          <Field label={tr('Port')} hint={tr('9100 almost always')}>
            <input value={cfg.target.port ?? 9100} type="number"
              onChange={(e) => setCfg({
                ...cfg, target: { ...cfg.target, port: Number(e.target.value) || 9100 } })}
              onBlur={() => save({ target: cfg.target })}
              className="field num mt-1" />
          </Field>
        </div>
      )}

      {kind === 'share' && (
        <div className="mt-3">
          <Field label={tr('Share path')}
            hint={tr('Share the printer on the PC it is plugged into, then put its path here')} span>
            <input value={cfg.target.unc ?? ''} placeholder="\\COUNTER-1\\Receipt"
              onChange={(e) => setCfg({ ...cfg, target: { ...cfg.target, unc: e.target.value } })}
              onBlur={() => save({ target: cfg.target })}
              className="field num mt-1" />
          </Field>

          {/*
            Credentials for the PC holding the printer.

            The server is a different machine and has no Windows sign-in on
            that one, so the copy is refused with "the user name or password
            is incorrect" even where nobody set a password on the share. It is
            not a wrong password; there is no password at all. These two boxes
            are what fix it, and they are the usual case rather than the
            exception.
          */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={tr('Username on that PC')}
              hint={tr('Put the PC name in front, as in DESKTOP-ABC\\hmsprint')}>
              <input value={cfg.target.user ?? ''} placeholder="DESKTOP-ABC\\hmsprint"
                autoComplete="off"
                onChange={(e) => setCfg({
                  ...cfg, target: { ...cfg.target, user: e.target.value } })}
                onBlur={() => save({ target: cfg.target })}
                className="field num mt-1" />
            </Field>

            <Field label={tr('Password on that PC')}
              hint={tr('Its Windows password. A blank one will not work over the network.')}>
              <input type="password" value={cfg.target.pass ?? ''}
                autoComplete="new-password"
                onChange={(e) => setCfg({
                  ...cfg, target: { ...cfg.target, pass: e.target.value } })}
                onBlur={() => save({ target: cfg.target })}
                className="field mt-1" />
            </Field>
          </div>

          <p className="mt-2 text-2xs text-muted">
            {tr('Two backslashes at the front, one in the middle. Extra ones are stripped, so a path typed either way still works.')}
          </p>

          {/*
            What the server can see. A printer missing from this list is one
            the server cannot print to either, which is far better to discover
            here than at the counter with a patient waiting.
          */}
          {available?.printers?.length > 0 && (
            <div className="mt-2 rounded-xl border-2 border-line p-2.5">
              <p className="text-2xs text-muted">{tr('Printers this server can see')}:</p>
              <ul className="mt-1 space-y-0.5">
                {available.printers.map((p: any) => (
                  <li key={p.name} className="flex items-center gap-2 text-2xs">
                    <Printer size={12} className="shrink-0 text-muted" />
                    <span className="text-body">{p.name}</span>
                    {p.shared
                      ? <button className="text-primary hover:underline"
                          onClick={() => save({
                            target: { kind: 'share', unc: `\\\\localhost\\${p.share}` } })}>
                          {tr('use')} \\localhost\{p.share}
                        </button>
                      : <span className="text-warn">{tr('not shared')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {available && available.platform !== 'win32' && (
            <p className="mt-2 flex items-start gap-1.5 text-2xs text-warn">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {tr('This server is not running Windows, so it cannot print to a Windows share. Use a network printer.')}
            </p>
          )}
        </div>
      )}

      {kind !== 'none' && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Field label={tr('Roll width')} hint={tr('80mm is the usual counter printer')}>
              <select value={cfg.width} onChange={(e) => save({ width: e.target.value })}
                className="field mt-1">
                <option value="58mm">58mm</option>
                <option value="80mm">80mm</option>
              </select>
            </Field>
            <Field label={tr('Copies')} hint={tr('Two where one goes in the file')}>
              <select value={cfg.copies} onChange={(e) => save({ copies: Number(e.target.value) })}
                className="field num mt-1">
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label={tr('Feed before cut')} hint={tr('Blank lines so the blade misses the text')}>
              <select value={cfg.feedLines}
                onChange={(e) => save({ feedLines: Number(e.target.value) })}
                className="field num mt-1">
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={testPrint} disabled={busy}
              className="btn-primary inline-flex items-center gap-1.5">
              {kind === 'network' ? <Wifi size={14} /> : <Network size={14} />}
              {busy ? tr('Sending…') : tr('Print a test page')}
            </button>
            {tested && (
              <span className="inline-flex items-center gap-1.5 text-2xs text-ok">
                <CheckCircle2 size={14} /> {tested}
              </span>
            )}
            {saved && <span className="text-2xs text-ok">{tr('Saved')}</span>}
          </div>
        </>
      )}

      <p className="mt-4 text-2xs text-muted">
        {tr('The printer only needs to be reachable from the server. Nothing is installed on the counter PCs, and the browser never prints.')}
      </p>
    </Card>
  )
}
