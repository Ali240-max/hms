import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Start the server and the client together.
 *
 * This replaces a `concurrently` one-liner that worked on Linux and silently
 * started only the client on Windows. The cause was quoting: the script went
 * through package.json escaping, then PowerShell, then concurrently's own
 * `npm:` shorthand parser, and the server half came out mangled with no error
 * to show for it.
 *
 * Spawning the two processes from Node removes every layer of that. There is
 * no shell involved, so there is nothing to quote.
 */

const local = (bin) =>
  join('node_modules', '.bin', process.platform === 'win32' ? `${bin}.cmd` : bin)

if (!existsSync(local('tsx')) || !existsSync(local('vite'))) {
  console.error('\n  Dependencies are missing. Run:\n\n    npm install\n')
  process.exit(1)
}

const COLOUR = { server: '\x1b[34m', client: '\x1b[35m', reset: '\x1b[0m' }

function start(name, bin, args) {
  const child = spawn(local(bin), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // .cmd shims on Windows are batch files and need a shell to run at all.
    // The arguments are ours, not user input, so there is nothing to inject.
    shell: process.platform === 'win32'
  })

  const prefix = `${COLOUR[name]}[${name}]${COLOUR.reset} `
  const pipe = (stream, out) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) out.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)

  child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) {
      process.stdout.write(`${prefix}exited with code ${code}\n`)
      /**
       * If one half dies the other is useless — a client with no server just
       * prints connection errors, which is what made the original failure so
       * confusing. Bring both down so the problem is obvious.
       */
      stop()
    }
  })
  return child
}

let shuttingDown = false
const children = []

function stop() {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    if (!c.killed) c.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  }
  setTimeout(() => process.exit(1), 500).unref()
}

children.push(start('server', 'tsx', ['watch', 'src/server/index.ts']))
children.push(start('client', 'vite', process.argv.slice(2)))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { shuttingDown = true; for (const c of children) c.kill(); process.exit(0) })
}
