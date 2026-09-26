/**
 * Build an offline bundle.
 *
 * Everything needed to run the system on a machine with no internet, and
 * nothing else. The full `node_modules` is around 300 MB and 40,000 files,
 * most of which are build tools that a running server never touches: Vite,
 * esbuild, TypeScript, the test harnesses. Carrying them to a hospital on a
 * USB stick wastes twenty minutes and sometimes fails on Windows path lengths.
 *
 * This walks the runtime dependencies of the built server and copies only
 * those, which comes to a few hundred files.
 */
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const OUT = '.bundle'
const ZIP = 'hms-offline.zip'

if (!existsSync('dist/server/index.js') || !existsSync('dist/client/index.html')) {
  console.error('\n  Run `npm run build` first.\n')
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
 * 60 MB of them, all of which are already compiled into dist/client and never
 * loaded by the server. What the server needs is exactly what its bundle still
 * imports by name, so that is what is read.
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

const seen = new Set()
function collect(name) {
  if (seen.has(name)) return
  const dir = join('node_modules', name)
  if (!existsSync(dir)) return
  seen.add(name)
  try {
    const meta = JSON.parse(
      execSync(`node -p "JSON.stringify(require('./${dir}/package.json'))"`,
        { encoding: 'utf8' }))
    for (const dep of Object.keys(meta.dependencies ?? {})) collect(dep)
  } catch { /* a package with no readable manifest is a leaf */ }
}
for (const name of runtime) collect(name)

console.log(`  copying ${seen.size} packages…`)
for (const name of seen) {
  await cp(join('node_modules', name), join(OUT, 'node_modules', name), { recursive: true })
}

await writeFile(join(OUT, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, type: pkg.type,
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
  'Hospital Management System — offline bundle\r\n\r\n' +
  '1. Install Node.js and PostgreSQL.\r\n' +
  '2. Create the database:  createdb -U postgres hms\r\n' +
  '3. Create a .env file beside this one:\r\n' +
  '     DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/hms\r\n' +
  '     PORT=4000\r\n' +
  '4. Double-click START.bat\r\n' +
  '5. Open http://localhost:4000 and create the first administrator.\r\n\r\n' +
  'Migrations run by themselves on first start.\r\n')

console.log('  zipping…')
await rm(ZIP, { force: true })
try {
  execSync(`cd ${OUT} && zip -qr ../${ZIP} .`, { stdio: 'inherit' })
} catch {
  execSync(`powershell -Command "Compress-Archive -Path '${OUT}/*' -DestinationPath '${ZIP}'"`,
    { stdio: 'inherit' })
}
await rm(OUT, { recursive: true, force: true })
console.log(`\n  ${ZIP} is ready. Copy it to the hospital machine.\n`)
