/**
 * Receipts reach a printer as ESC/POS, and the bytes are right.
 *
 * A fake printer listens on 9100, the server is told to print to it, and what
 * arrives is checked: the initialise sequence, the text, the double-height
 * total, and — the whole point of this rewrite — a cut command at the end and
 * no page of any kind. A thermal printer feeds exactly the paper it prints.
 */
import { createServer } from 'node:net'

const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
const login = async (u, p) => (await (await fetch(B + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p })
})).json()).token
const q = async (path, as, o = {}) => {
  const r = await fetch(B + path, { ...o, headers: {
    'content-type': 'application/json', authorization: 'Bearer ' + tok[as], ...(o.headers || {}) } })
  const t = await r.text(); let b
  try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

/* A printer that just records what it is sent. */
let received = []
const printer = createServer((socket) => {
  const chunks = []
  socket.on('data', (d) => chunks.push(d))
  socket.on('close', () => received.push(Buffer.concat(chunks)))
})
await new Promise((r) => printer.listen(9199, '127.0.0.1', r))

tok.mc = await login('main-counter', '1234')

console.log('\n— pointing a counter at a printer —')
let r = await q('/printing/config/counter', 'mc', {
  method: 'PUT',
  body: JSON.stringify({ target: { kind: 'network', host: '127.0.0.1', port: 9199 },
    width: '80mm', copies: 1, feedLines: 2 })
})
ok('the target is saved', r.status === 200 && r.body.target.kind === 'network',
  JSON.stringify(r.body?.target))

console.log('\n— a test page —')
received = []
r = await q('/printing/test/counter', 'mc', { method: 'POST' })
ok('the server reports it printed', r.status === 200 && r.body.ok, JSON.stringify(r.body))
await new Promise((res) => setTimeout(res, 300))
ok('the printer received bytes', received.length === 1, `${received.length} jobs`)

const job = received[0] ?? Buffer.alloc(0)
const asText = job.toString('latin1')

console.log('\n— what arrived is ESC/POS —')
ok('it starts with the initialise command', job[0] === 0x1b && job[1] === 0x40,
  [...job.slice(0, 4)].map((b) => b.toString(16)).join(' '))
ok('a code page is selected', asText.includes('\x1b\x74'))
ok('it ends with a cut', /\x1d\x56\x42\x00$/.test(asText),
  [...job.slice(-6)].map((b) => b.toString(16)).join(' '))
ok('paper is fed before the cut, so the blade misses the last line',
  /\x1b\x64/.test(asText.slice(-12)))
ok('the hospital name is in it', /HOSPITAL|Hospital/i.test(asText))
ok('it is not HTML, and not a page', !/<html|<div|@page/i.test(asText))

console.log('\n— a real chit —')
received = []
const chits = (await q('/chits?status=paid', 'mc')).body
if (chits.length) {
  r = await q(`/printing/chit/${chits[0].id}?module=counter`, 'mc', { method: 'POST' })
  ok('the chit printed', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 90))
  await new Promise((res) => setTimeout(res, 300))
  const chit = (received[0] ?? Buffer.alloc(0)).toString('latin1')
  ok('the chit number is on it', chit.includes(chits[0].chit_no), chits[0].chit_no)
  ok('the patient name is on it', chit.includes(String(chits[0].patient_name).slice(0, 8)))
  ok('the total is on it', /TOTAL/.test(chit))
  ok('the token is doubled in size', /\x1d\x21\x11/.test(chit))
  ok('it ends with a cut', /\x1d\x56\x42\x00$/.test(chit))
  /*
   * The number that mattered: a receipt is a few hundred bytes of text, not a
   * page. Nothing in it can make a printer feed three metres of roll.
   */
  ok('it is a few hundred bytes, not a page', chit.length < 4000, `${chit.length} bytes`)
} else {
  ok('a paid chit exists to print', false, 'none in the demo data')
}

console.log('\n— share paths people actually type —')
{
  const { normaliseUnc } = await import('./src/server/services/printing.ts')

  /*
   * String.raw so these read as what somebody types into the box, rather than
   * as a wall of escaped backslashes that is impossible to check by eye.
   */
  const want = String.raw`\\DESKTOP-HODM0GF\RECIEPT`
  const cases = [
    // exactly what was typed at the hospital: doubled separators throughout
    [String.raw`\\DESKTOP-HODM0GF\\RECIEPT`, want],
    [String.raw`\\DESKTOP-HODM0GF\RECIEPT`, want],
    // pasted from documentation, or typed by somebody used to Linux
    [String.raw`//DESKTOP-HODM0GF/RECIEPT`, want],
    // the leading pair left off
    [String.raw`DESKTOP-HODM0GF\RECIEPT`, want],
    // spaces and a trailing separator from a copy and paste
    // a trailing separator and spaces, as a copy and paste leaves them.
    // (built by concatenation: a raw template cannot end in a backslash)
    ['  ' + String.raw`\\DESKTOP-HODM0GF\RECIEPT` + '\\  ', want],
    ['', '']
  ]

  for (const [input, expected] of cases) {
    const got = normaliseUnc(input)
    ok(`"${input.trim() || '(empty)'}" resolves correctly`, got === expected,
      `got ${got || '(empty)'}`)
  }
}

console.log('\n— two counter PCs keep separate printers —')
{
  /*
   * Two machines at the main counter, each with its own thermal printer and
   * its own queue of patients. They share the module name 'counter', so
   * without a per-machine key the second PC would overwrite the first and
   * only one of the two printers could ever be registered.
   *
   * Keyed on the PC rather than the account on purpose: the printer is
   * plugged into a machine. A cashier covering the other window must print
   * beside them, not wherever they sat yesterday.
   */
  const asPc = (pc) => ({ headers: { 'x-device-id': pc } })

  await q('/printing/config/counter', 'mc', {
    method: 'PUT', ...asPc('pc-one'),
    body: JSON.stringify({ target: { kind: 'share', unc: String.raw`\\MC1\Receipt` } })
  })
  await q('/printing/config/counter', 'mc', {
    method: 'PUT', ...asPc('pc-two'),
    body: JSON.stringify({ target: { kind: 'share', unc: String.raw`\\MC2\Receipt` } })
  })

  const one = (await q('/printing/config/counter', 'mc', asPc('pc-one'))).body
  const two = (await q('/printing/config/counter', 'mc', asPc('pc-two'))).body

  ok('the first PC kept its own printer', /MC1/.test(one.target?.unc ?? ''), one.target?.unc)
  ok('the second did not overwrite it', /MC2/.test(two.target?.unc ?? ''), two.target?.unc)
  ok('and they are different', one.target.unc !== two.target.unc)

  // Saving on one must not disturb the other.
  await q('/printing/config/counter', 'mc', {
    method: 'PUT', ...asPc('pc-two'),
    body: JSON.stringify({ target: { kind: 'share', unc: String.raw`\\MC2\Receipt2` } })
  })
  const stillOne = (await q('/printing/config/counter', 'mc', asPc('pc-one'))).body
  ok('changing the second leaves the first alone',
    /MC1/.test(stillOne.target?.unc ?? ''), stillOne.target?.unc)

  /*
   * A PC that has never been set up falls back to the counter-wide setting,
   * which is what every installation had before this existed. Without the
   * fallback an upgrade would silently stop a working counter printing.
   */
  const fresh = (await q('/printing/config/counter', 'mc', asPc('pc-never-seen'))).body
  ok('an unconfigured PC falls back rather than failing', !!fresh.target)
}

console.log('\n— a setting can be filled in in any order —')
{
  /*
   * The type has to be chosen before there is anywhere to type an address, so
   * saving a half-filled setting must work. It did not: the address was
   * required, the save was rejected, and the dropdown snapped back to "Not
   * set" — there was no order in which the form could be completed.
   */
  let r = await q('/printing/config/counter', 'mc', {
    method: 'PUT', body: JSON.stringify({ target: { kind: 'network', host: '', port: 9100 } })
  })
  ok('a network printer can be chosen before its address is typed', r.status === 200,
    `got ${r.status}`)

  r = await q('/printing/test/counter', 'mc', { method: 'POST' })
  ok('but printing to it is refused', r.status >= 400, `got ${r.status}`)
  ok('and the message names the empty box',
    /address/i.test(r.body?.error ?? ''), r.body?.error)

  r = await q('/printing/config/counter', 'mc', {
    method: 'PUT', body: JSON.stringify({ target: { kind: 'share', unc: '' } })
  })
  ok('a shared printer can be chosen before its path is typed', r.status === 200,
    `got ${r.status}`)
  r = await q('/printing/test/counter', 'mc', { method: 'POST' })
  ok('printing to that is refused too', r.status >= 400)
  ok('and it says what a path looks like',
    /PC-NAME/.test(r.body?.error ?? ''), r.body?.error)
}

console.log('\n— two PCs at one counter, two printers —')
{
  /*
   * A main counter with two windows has two PCs and two thermal printers.
   * The setting used to be held per counter, so whichever window was set up
   * second overwrote the first and only one printer could ever be registered.
   * It is held per PC now.
   */
  const asPc = (id) => ({ 'x-device-id': id })

  await q('/printing/config/counter', 'mc', {
    method: 'PUT', headers: asPc('pc-window-one'),
    body: JSON.stringify({ target: { kind: 'share', unc: String.raw`\\WINDOW-1\Receipt` } })
  })
  await q('/printing/config/counter', 'mc', {
    method: 'PUT', headers: asPc('pc-window-two'),
    body: JSON.stringify({ target: { kind: 'share', unc: String.raw`\\WINDOW-2\Receipt` } })
  })

  const one = (await q('/printing/config/counter', 'mc', { headers: asPc('pc-window-one') })).body
  const two = (await q('/printing/config/counter', 'mc', { headers: asPc('pc-window-two') })).body

  ok('the first window kept its own printer',
    one.target.unc === String.raw`\\WINDOW-1\Receipt`, one.target.unc)
  ok('setting up the second did not overwrite it',
    two.target.unc === String.raw`\\WINDOW-2\Receipt`, two.target.unc)
  ok('and the two are different', one.target.unc !== two.target.unc)

  // A PC that has never been set up falls back rather than failing, so an
  // upgrade does not stop a counter that was already printing.
  const fresh = (await q('/printing/config/counter', 'mc', {
    headers: asPc('pc-never-seen') })).body
  ok('a PC with no setting of its own still gets one', !!fresh.target)
}

console.log('\n— a printer that is not there —')
await q('/printing/config/counter', 'mc', {
  method: 'PUT',
  body: JSON.stringify({ target: { kind: 'network', host: '127.0.0.1', port: 9198 } })
})
r = await q('/printing/test/counter', 'mc', { method: 'POST' })
ok('it is refused with a clear message', r.status === 409 && r.body.code === 'UNREACHABLE',
  JSON.stringify(r.body).slice(0, 100))

await q('/printing/config/counter', 'mc', {
  method: 'PUT', body: JSON.stringify({ target: { kind: 'none' } })
})
r = await q('/printing/test/counter', 'mc', { method: 'POST' })
ok('and so is a counter with no printer set', r.status === 409 && r.body.code === 'NO_PRINTER')

printer.close()
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
