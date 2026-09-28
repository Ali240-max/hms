import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Getting bytes to a thermal printer.
 *
 * The important thing to understand before reading any of this: **the server
 * prints, not the browser**. A counter PC clicks Print, the server builds the
 * ESC/POS bytes and delivers them. That means the printer has to be reachable
 * *from the server*, and a printer plugged into a counter PC by USB is not —
 * not without being shared first.
 *
 * Hence three ways of reaching one:
 *
 *   network  The printer has its own Ethernet or Wi-Fi and listens on port
 *            9100. Nothing to install, nothing to share, works from anywhere
 *            on the LAN. If a printer is being bought, buy this one.
 *
 *   share    A USB printer plugged into a counter PC and shared from Windows,
 *            reached as \\PC-NAME\ShareName. The server copies the bytes to
 *            the share. This is the answer for printers already on desks.
 *            The share must allow raw data — see DEPLOY-PRINTING.md.
 *
 *   local    A printer attached to the server itself, reached through its own
 *            share name on \\localhost.
 *
 * A share is written with `copy /b`, which is the one reliable way to push raw
 * bytes at a Windows print queue without a driver reformatting them. Sending
 * them through the driver would defeat the point: the driver is what turns a
 * receipt into a page.
 */

export type PrinterTarget =
  | { kind: 'network'; host: string; port?: number }
  /*
   * A printer shared from another PC.
   *
   * `user` and `pass` are for that PC, and they are needed more often than
   * not: the server has no sign-in on it, so Windows refuses the copy with
   * "The user name or password is incorrect" even when no password was ever
   * set on the share. Left empty, guest access is attempted.
   */
  | { kind: 'share'; unc: string; user?: string | null; pass?: string | null }
  | { kind: 'local'; unc: string }
  | { kind: 'none' }

export type PrinterConfig = {
  /** Which counter this belongs to: 'counter', 'pharmacy', 'lab'. */
  module: string
  /** Which PC. Null means the shared setting, used where a PC has none. */
  device?: string | null
  /** What to call this PC on screen, so two windows are told apart. */
  deviceName?: string | null
  target: PrinterTarget
  width: '58mm' | '80mm'
  copies: number
  /** Blank lines before the cut, so the blade misses the last line. */
  feedLines: number
  /** Open a cash drawer wired to the printer after each sale. */
  kickDrawer: boolean
}

const DEFAULT: Omit<PrinterConfig, 'module'> = {
  target: { kind: 'none' },
  width: '80mm',
  copies: 1,
  feedLines: 2,
  kickDrawer: false
}

/**
 * Printer settings belong to a PC, not to a counter and not to a person.
 *
 * A main counter with two windows has two PCs and two thermal printers, and
 * one shared setting meant the second window overwrote the first: only one
 * printer could ever be registered. Keying it per person would break the
 * moment both windows sign in as the same account, which is normal, and would
 * follow a cashier to the other window when they moved.
 *
 * The printer is physically attached to one machine, so the setting is held
 * against that machine. A browser gets an id on first use and keeps it.
 *
 * A setting saved before this existed has no device against it, and is used
 * by any PC that has none of its own — so nothing that already works stops
 * working.
 */
const key = (module: string, device?: string | null) =>
  device ? `printer.${module}.${device}` : `printer.${module}`

export async function printerConfig(module: string, device?: string | null): Promise<PrinterConfig> {
  /*
   * This PC's own setting first, then the one with no PC against it.
   *
   * The fallback is what stops an upgrade breaking a counter that was already
   * printing: its setting was saved before any of this existed, so it has no
   * device, and it keeps working until somebody saves a new one.
   */
  const rows = (await db.execute<any>(sql`
    SELECT key, value FROM settings
    WHERE key IN (${key(module, device)}, ${key(module)})`)).rows as any[]

  const mine = rows.find((r) => r.key === key(module, device))
  const shared = rows.find((r) => r.key === key(module))
  const row = (device && mine) || shared

  if (!row?.value) return { module, device: device ?? null, ...DEFAULT }
  try {
    return { module, device: device ?? null, ...DEFAULT, ...JSON.parse(row.value) }
  } catch {
    return { module, device: device ?? null, ...DEFAULT }
  }
}

export async function savePrinterConfig(
  module: string, patch: Partial<PrinterConfig>, device?: string | null
) {
  const current = await printerConfig(module, device)
  const next = { ...current, ...patch, module, device: device ?? null }
  await db.execute(sql`
    INSERT INTO settings (key, value)
    VALUES (${key(module, device)}, ${JSON.stringify(next)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
  return next
}

export async function allPrinterConfigs() {
  const rows = (await db.execute<any>(sql`
    SELECT key, value FROM settings WHERE key LIKE 'printer.%'`)).rows as any[]
  return rows.map((r) => {
    try { return { module: String(r.key).slice(8), ...DEFAULT, ...JSON.parse(r.value) } }
    catch { return { module: String(r.key).slice(8), ...DEFAULT } }
  })
}

/* ------------------------------------------------------------ delivery */

export class PrintError extends Error {
  constructor(msg: string, public code:
    'NO_PRINTER' | 'UNREACHABLE' | 'REFUSED' | 'NOT_WINDOWS') { super(msg) }
}

/**
 * Raw bytes to a printer listening on port 9100.
 *
 * Every network thermal printer speaks this: open a socket, write, close. No
 * protocol, no acknowledgement. The timeout matters because an unplugged
 * printer accepts the connection attempt and then never answers, and without
 * one the request would hang until the browser gave up.
 */
function sendTcp(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const fail = (e: any) => {
      socket.destroy()
      reject(new PrintError(
        `Could not reach the printer at ${host}:${port}. ${e?.message ?? ''}`.trim(),
        'UNREACHABLE'))
    }
    socket.setTimeout(6000)
    socket.on('timeout', () => fail(new Error('It did not answer within six seconds.')))
    socket.on('error', fail)
    socket.on('connect', () => {
      socket.write(bytes, () => {
        // A short pause before closing: some printers drop the tail of the
        // buffer if the socket shuts immediately after the write.
        setTimeout(() => { socket.end(); resolve() }, 150)
      })
    })
  })
}

/**
 * Raw bytes to a shared Windows print queue.
 *
 * `copy /b file \\PC\Share` is the standard way to push raw data at a queue.
 * It works for a printer on this machine and for one shared from a counter PC,
 * which is what makes USB printers on desks reachable at all.
 */
/**
 * A UNC path, tidied up.
 *
 * `\\\\DESKTOP-ABC\\\\RECEIPT` is what somebody types when they are being careful
 * about backslashes, and it does not resolve. Forward slashes get pasted in
 * from documentation. A trailing slash breaks the copy. None of these is worth
 * an error message when the intent is obvious.
 */
export function normaliseUnc(input: string): string {
  const body = String(input ?? '')
    .trim()
    .replace(/[/\\]+/g, '\\')      // every run of separators becomes one
    .replace(/^\\+/, '')            // drop the leading ones
    .replace(/\\+$/, '')            // and any trailing one
  return body ? `\\\\${body}` : ''
}

/**
 * Sign in to the other machine before copying to it.
 *
 * The server runs as a Windows service or as a signed-in user, and either way
 * it has no session on the PC holding the printer — so the copy comes back
 * with "The user name or password is incorrect" even though nothing asked for
 * a password. `net use` establishes that session first.
 *
 * Without credentials it still tries: where the other machine allows guest
 * access this works, and where it does not the error says so plainly.
 */
async function connectShare(unc: string, user?: string | null, pass?: string | null) {
  // \\PC\SHARE -> \\PC, because the session is to the machine, not the printer.
  const server = unc.replace(/^\\\\([^\\]+).*$/, '\\\\$1')

  const args = ['/c', 'net', 'use', server]
  if (pass) args.push(pass)
  if (user) args.push(`/user:${user}`)
  args.push('/persistent:no')

  await new Promise<void>((resolve) => {
    const child = spawn('cmd', args, { windowsHide: true })
    // Resolved either way. An existing connection reports an error that is
    // not one, and a genuine failure is reported by the copy in clearer terms.
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

async function sendShare(unc: string, bytes: Buffer,
                         user?: string | null, pass?: string | null): Promise<void> {
  if (process.platform !== 'win32') {
    throw new PrintError(
      'Printing to a Windows share only works when the server runs on Windows. ' +
      'Use a network printer on port 9100 instead.', 'NOT_WINDOWS')
  }

  const target = normaliseUnc(unc)
  const dir = await mkdtemp(join(tmpdir(), 'hms-print-'))
  const file = join(dir, 'receipt.bin')
  await writeFile(file, bytes)

  try {
    await connectShare(target, user, pass)

    await new Promise<void>((resolve, reject) => {
      const child = spawn('cmd', ['/c', 'copy', '/b', file, target], { windowsHide: true })
      let output = ''
      child.stdout.on('data', (d) => { output += d })
      child.stderr.on('data', (d) => { output += d })
      child.on('error', (e) => reject(new PrintError(
        `Could not run the copy command: ${e.message}`, 'UNREACHABLE')))
      child.on('close', (code) => {
        if (code === 0) return resolve()
        const said = output.trim() || 'copy failed'

        /*
         * The common failure, named.
         *
         * "The user name or password is incorrect" on a share nobody set a
         * password on means the server has no session on that machine, which
         * is a different problem from a wrong password and has a different
         * fix. Saying so here saves an hour of checking passwords that were
         * never wrong.
         */
        const noSession = /user name or password|5|access is denied/i.test(said)
        reject(new PrintError(
          noSession
            ? `Windows would not let the server reach ${target}: ${said} ` +
              'This usually means the server has no sign-in on that PC rather ' +
              'than a wrong password. Put a username and password for that PC ' +
              'in under Printing, or allow guest access to the share.'
            : `Windows refused the print: ${said} ` +
              `Check that ${target} exists and is shared.`,
          'REFUSED'))
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function sendToPrinter(module: string, bytes: Buffer, opts: {
  copies?: number
  /** Which PC asked. Its own printer is used when it has one. */
  device?: string | null
} = {}) {
  const cfg = await printerConfig(module, opts.device)

  if (cfg.target.kind === 'none') {
    throw new PrintError(
      'No printer is set for this counter. Choose one under Printing.', 'NO_PRINTER')
  }

  /*
   * A printer chosen but not addressed.
   *
   * Saving a half-filled setting is allowed, because the type has to be
   * picked before there is anywhere to type an address. Printing to one is
   * not, and this is where that is caught — with a message that says which
   * box is empty rather than a socket error about connecting to "".
   */
  if (cfg.target.kind === 'network' && !String(cfg.target.host ?? '').trim()) {
    throw new PrintError(
      'This counter has a network printer selected but no address. ' +
      'Put its IP address in under Printing.', 'NO_PRINTER')
  }
  if ((cfg.target.kind === 'share' || cfg.target.kind === 'local') &&
      !String(cfg.target.unc ?? '').trim()) {
    throw new PrintError(
      'This counter has a shared printer selected but no path. ' +
      'Put in something like \\\\PC-NAME\\Receipt under Printing.', 'NO_PRINTER')
  }

  const copies = Math.max(1, opts.copies ?? cfg.copies ?? 1)
  for (let i = 0; i < copies; i++) {
    if (cfg.target.kind === 'network') {
      await sendTcp(cfg.target.host, cfg.target.port ?? 9100, bytes)
    } else {
      await sendShare(cfg.target.unc, bytes,
        (cfg.target as any).user, (cfg.target as any).pass)
    }
  }
  return { copies, target: cfg.target }
}

/**
 * Printers Windows knows about, so a counter can pick one from a list rather
 * than typing a UNC path by hand.
 *
 * Only useful on a Windows server, and only shows what that machine can see —
 * which is the point: a printer this list cannot see is one the server cannot
 * print to either, and that is worth finding out while configuring rather
 * than at the counter.
 */
export async function windowsPrinters(): Promise<{ name: string; shared: boolean; share: string | null }[]> {
  if (process.platform !== 'win32') return []
  return new Promise((resolve) => {
    const child = spawn('powershell', [
      '-NoProfile', '-Command',
      'Get-Printer | Select-Object Name,Shared,ShareName | ConvertTo-Json -Compress'
    ], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out || '[]')
        const list = Array.isArray(parsed) ? parsed : [parsed]
        resolve(list.map((p: any) => ({
          name: p.Name, shared: !!p.Shared, share: p.ShareName ?? null
        })))
      } catch { resolve([]) }
    })
  })
}
