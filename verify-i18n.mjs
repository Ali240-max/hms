/**
 * Translation coverage.
 *
 * Every t('...') in the interface must have an Urdu entry, or that string
 * silently falls back to English and the screen ends up half translated —
 * which is exactly what it did before this check existed. Runs offline; no
 * server needed.
 *
 *   node verify-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}
const prefs = readFileSync('src/client/src/lib/prefs.tsx', 'utf8')
const dict = new Set([...prefs.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map(m => JSON.parse(`"${m[1]}"`)))
let missing = [], total = 0
for (const f of walk('src/client/src')) {
  if (f.endsWith('prefs.tsx')) continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\btr\('((?:[^'\\]|\\')*)'\)/g)) {
    const k = m[1].replace(/\\'/g, "'")
    total++
    if (!dict.has(k)) missing.push(`${f.split('/').pop()}: ${k}`)
  }
}
console.log(`${total} translated call sites, ${dict.size} dictionary entries`)

/**
 * The translator must never be shadowed by a local of the same name.
 *
 * This is not hypothetical: `const t = data.totals` inside the earnings screen
 * turned every t('...') on that screen into a call on a plain object, and the
 * whole page went white. Renaming the import to `tr` made a collision far less
 * likely; this check makes it impossible to ship one unnoticed.
 */
const shadows = []
for (const f of walk('src/client/src')) {
  const src = readFileSync(f, 'utf8')
  if (!src.includes('tr(')) continue
  src.split('\n').forEach((line, i) => {
    if (/(const|let|var)\s+tr\s*=(?!\s*useT)/.test(line)) {
      shadows.push(`${f.split('/').pop()}:${i + 1}: ${line.trim()}`)
    }
  })
}
if (shadows.length) {
  console.log('SHADOWED TRANSLATOR — these screens will crash:')
  shadows.forEach((s) => console.log('  ' + s))
}
if (missing.length) { console.log('MISSING:'); missing.forEach(m => console.log('  ' + m)) }
else console.log('every key has an Urdu translation')
process.exit(missing.length || shadows.length ? 1 : 0)
