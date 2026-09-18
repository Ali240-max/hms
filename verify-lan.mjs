/**
 * Browser APIs that only work over HTTPS or on localhost.
 *
 * This system is served over plain HTTP on a LAN address, so every machine
 * except the server itself runs in an insecure context. Anything on this list
 * is simply absent there and throws the moment it is called — and it all works
 * perfectly in testing, because testing happens on localhost. That is what
 * makes this class of bug worth a dedicated check rather than a code review.
 *
 *   node verify-lan.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const BANNED = [
  ['crypto.randomUUID', 'use newId() from lib/api'],
  ['crypto.subtle', 'not available over plain HTTP'],
  ['navigator.clipboard', 'guard it, or offer a select-and-copy fallback'],
  ['navigator.geolocation', 'not available over plain HTTP'],
  ['navigator.mediaDevices', 'not available over plain HTTP — affects barcode scanning by camera'],
  ['navigator.serviceWorker', 'not available over plain HTTP'],
  ['showOpenFilePicker', 'not available over plain HTTP'],
  ['showSaveFilePicker', 'not available over plain HTTP']
]

function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

const hits = []
for (const f of walk('src/client/src')) {
  const src = readFileSync(f, 'utf8')
  src.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
    for (const [api, advice] of BANNED) {
      if (line.includes(api)) {
        hits.push(`${f.replace('src/client/src/', '')}:${i + 1}  ${api} — ${advice}`)
      }
    }
  })
}

if (hits.length) {
  console.log('\nSecure-context APIs found. These crash on every machine except the server:\n')
  hits.forEach((h) => console.log('  ' + h))
  console.log('')
} else {
  console.log('\nno secure-context-only browser APIs in the client\n')
}
process.exit(hits.length ? 1 : 0)
