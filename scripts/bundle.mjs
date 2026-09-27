/**
 * Build an offline bundle.
 *
 * Everything needed to run the system on a machine with no internet, and
 * nothing else. The full `node_modules` is around 300 MB across 40,000 files,
 * most of which are build tools a running server never touches: Vite,
 * esbuild, TypeScript, the test harnesses. Carrying them to a hospital on a
 * USB stick wastes twenty minutes and sometimes fails on Windows path lengths.
 *
 * This builds first, then copies only what the built server actually imports.
 */

import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const OUT = '.bundle'
const ZIP = 'hms-offline.zip'
const SKIP_BUILD = process.argv.includes('--no-build')

/*
 * The build runs here, as part of bundling.
 *
 * This script used to check that `dist/` existed and tell you to run the build
 * yourself if it did not. That shipped a stale application: unzip a new
 * version over the repository, run the bundle without rebuilding, and `dist/`
 * is still last week's — which is exactly how an old sign-in screen with
 * department buttons turned up on a laptop after an update.
 *
 * A command whose output is carried to a hospital must not be able to package
 * something other than the current source.
 */
if (SKIP_BUILD) {
  console.log('  skipping the build, as asked')
} else {
  console.log('  building…')
  execSync('npm run build', { stdio: 'inherit' })
}

if (!existsSync('dist/server/index.js') || !existsSync('dist/client/index.html')) {
  console.error('\n  The build produced nothing. Fix that before bundling.\n')
  process.exit(1)
}

/*
 * A second check, in case --no-build was used.
 *
 * If any source file is newer than the build, the bundle would carry code that
 * does not match the repository. Better to stop than to hand somebody a USB
 * stick with the wrong version on it.
 */
const builtAt = Math.min(
  statSync('dist/server/index.js').mtimeMs,
  statSync('dist/client/index.html').mtimeMs
)

async function newestUnder(dir) {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, await newestUnder(path))
    else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  return newest
}

const sourceAt = Math.max(await newestUnder('src'), statSync('package.json').mtimeMs)
if (sourceAt > builtAt + 2000) {
  console.error(
    '\n  The build is older than the source.\n' +
    `  Newest source: ${new Date(sourceAt).toLocaleString()}\n` +
    `  Build:         ${new Date(builtAt).toLocaleString()}\n\n` +
    '  Run `npm run bundle` without --no-build.\n')
  process.exit(1)
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

console.log('  copying the build…')
await cp('dist', join(OUT, 'dist'), { recursive: true })
await cp('drizzle', join(OUT, 'drizzle'), { recursive: true })
await cp('scripts', join(OUT, 'scripts'), { recursive: true })

/*
 * Only the packages the built server actually imports.
 *
 * Reading `dependencies` from package.json was the obvious approach and it was
 * wrong: it carried lucide-react, recharts, framer-motion and the web fonts,
 * 60 MB of them, all already compiled into dist/client and never loaded by the
 * server. What the server needs is exactly what its bundle still imports by
 * name, so that is what is read.
 */
console.log('  working out the runtime packages…')

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const serverJs = await readFile('dist/server/index.js', 'utf8')

const bare = new Set()
for (const m of serverJs.matchAll(/(?:require\(|from\s*)["']([^"'.][^"']*)["']/g)) {
  const spec = m[1]
  if (spec.startsWith('node:')) continue
  // "@scope/name/sub" keeps two segments, "name/sub" keeps one.
  const parts = spec.split('/')
  bare.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
}
const runtime = [...bare].filter((n) => existsSync(join('node_modules', n)))

/*
 * Each runtime package and everything it depends on.
 *
 * Read with the filesystem rather than by spawning `node -p`, which mangled
 * paths on Windows and produced nonsense like ./node_modules@hono.
 */
const seen = new Set()

async function collect(name) {
  if (seen.has(name)) return
  const dir = join('node_modules', name)
  if (!existsSync(dir)) return
  seen.add(name)
  try {
    const meta = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(meta.dependencies ?? {})) await collect(dep)
  } catch {
    // A package with no readable manifest is a leaf.
  }
}

for (const name of runtime) await collect(name)

console.log(`  copying ${seen.size} packages…`)
for (const name of seen) {
  await cp(join('node_modules', name), join(OUT, 'node_modules', name), { recursive: true })
}

/*
 * A stamp, so the version on a machine can be checked rather than guessed.
 *
 * An old bundle on a laptop looked identical to a new one from the outside.
 * Now VERSION.txt says when it was built and from how fresh a source tree.
 */
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
await writeFile(join(OUT, 'VERSION.txt'),
  'Hospital Management System\r\n' +
  `bundled : ${stamp}\r\n` +
  `packages: ${seen.size}\r\n` +
  `source  : newest file ${new Date(sourceAt).toISOString().slice(0, 16).replace('T', ' ')}\r\n`)

await writeFile(join(OUT, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  scripts: {
    start: 'node dist/server/index.js',
    seed: 'node --experimental-strip-types scripts/seed.ts'
  },
  dependencies: pkg.dependencies
}, null, 2) + '\n')

await writeFile(join(OUT, 'START.bat'),
  '@echo off\r\n' +
  'rem Starts the hospital server. Keep this window open.\r\n' +
  'cd /d "%~dp0"\r\n' +
  'node dist\\server\\index.js\r\n' +
  'pause\r\n')

await writeFile(join(OUT, 'README.txt'),
  'Hospital Management System - offline bundle\r\n\r\n' +
  '1. Install Node.js and PostgreSQL.\r\n' +
  '2. Create the database:  createdb -U postgres hms\r\n' +
  '3. Create a .env file beside this one:\r\n' +
  '     DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/hms\r\n' +
  '     PORT=4000\r\n' +
  '4. Double-click START.bat\r\n' +
  '5. Open http://localhost:4000 and create the first administrator.\r\n\r\n' +
  'Migrations run by themselves on first start.\r\n' +
  'See VERSION.txt to confirm which build this is.\r\n')

console.log('  zipping…')
await rm(ZIP, { force: true })

/* Windows has no `zip`, and Linux has no PowerShell. Try each. */
try {
  execSync(`cd ${OUT} && zip -qr ../${ZIP} .`, { stdio: 'pipe' })
} catch {
  execSync(
    'powershell -NoProfile -Command ' +
    `"Compress-Archive -Path '${OUT}\\*' -DestinationPath '${ZIP}' -Force"`,
    { stdio: 'inherit' })
}

await rm(OUT, { recursive: true, force: true })
console.log(`\n  ${ZIP} is ready — built ${stamp}. Copy it to the hospital machine.\n`)
