/**
 * Switching tabs must never wedge a module.
 *
 * A module shell wrapped in `AnimatePresence mode="wait"` holds the incoming
 * tab until the outgoing one finishes animating away. When that exit did not
 * complete, every screen in the module went blank and stayed blank until the
 * whole application was remounted by signing in again — which is a module that
 * has stopped working, reached by pressing a tab.
 *
 * Static check, no server needed: the shells must not wait for an exit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/client/src'
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(p)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

console.log('\n— module shells do not wait on an exit —')
const shells = files.filter((f) =>
  /screens\/(Admin|MainCounter|Pharmacy|Stores|Lab|OpdCounter|IpdCounter|Doctor)\.tsx$/.test(f))
ok('every module shell was found', shells.length === 8, String(shells.length))

for (const f of shells) {
  const src = strip(readFileSync(f, 'utf8'))
  const name = f.split('/').pop()
  ok(`${name} does not hold tabs behind mode="wait"`, !/mode=["']wait["']/.test(src))
}

console.log('\n— a keyed panel still animates the change —')
for (const f of shells.filter((x) => /(Admin|MainCounter|Pharmacy|Stores)\.tsx$/.test(x))) {
  const src = strip(readFileSync(f, 'utf8'))
  ok(`${f.split('/').pop()} keys its panel on the tab`, /key=\{tab\}/.test(src))
}

console.log('\n— overlays may still use it, they are not a module shell —')
{
  /*
   * A dialog or a toast disappearing is a different thing: if its exit hangs
   * the worst case is a stuck overlay the user can close, not a module that
   * will not render.
   */
  const ui = strip(readFileSync(join(ROOT, 'components/ui.tsx'), 'utf8'))
  ok('the modal does not wait either', !/mode=["']wait["']/.test(ui))
}

console.log('\n— settings screens actually contain their fields —')
{
  /*
   * A field that is missing renders perfectly well.
   *
   * The credential boxes for a shared printer were written, shipped, and never
   * appeared, because the edit that added them silently matched nothing. Every
   * other check passed: it typechecked, it rendered, the tests were green. The
   * only thing that would have caught it is asking whether the field is there.
   */
  const printer = strip(readFileSync(join(ROOT, 'components/PrinterSettings.tsx'), 'utf8'))

  for (const [what, needle] of [
    ['the share path', 'target.unc'],
    ['a username for the PC holding the printer', 'target.user'],
    ['a password for it', 'target.pass'],
    ['the network host', 'target.host'],
    ['a test print button', 'testPrint']
  ]) {
    ok(`printer settings offer ${what}`, printer.includes(needle))
  }

  // The two credential boxes are useless unless the server is told about them.
  const printing = strip(
    readFileSync(join('src/server/services', 'printing.ts'), 'utf8'))
  ok('and the server reads them back', /user/.test(printing) && /pass/.test(printing))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
