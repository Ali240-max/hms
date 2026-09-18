import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Reads .env into process.env.
 *
 * Written by hand rather than pulling in dotenv: it is fifteen lines, and a
 * dependency for this is a dependency to keep patched forever.
 *
 * Real environment variables always win, so a value set by the service manager
 * or the shell is not silently overridden by a stale file someone left behind.
 */
export function loadEnv(file = join(process.cwd(), '.env')) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip matching quotes; a password with a # in it must survive.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

export const DATABASE_URL = () =>
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hms'

/** Hides the password when a connection string goes into a log or a screen. */
export function safeUrl(url: string) {
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')
}
