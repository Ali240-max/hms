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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
