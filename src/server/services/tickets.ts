import { randomBytes } from 'node:crypto'

/**
 * One-minute tickets for files the browser has to fetch by itself.
 *
 * The session travels in an Authorization header, which a plain link, an
 * <embed>, or the browser's built-in PDF viewer cannot send. The first attempt
 * at this fetched the file and handed it over as a blob URL, and that failed
 * in a way worth recording: the object URL is released when the dialog closes,
 * so a download still in flight, or a print job still reading, ends up with a
 * truncated file. "Failed to load PDF" with a file of the right size is
 * exactly that.
 *
 * So the file gets a real URL instead, with a ticket the browser can carry in
 * the query string. The ticket is:
 *
 *  - random, 32 bytes, not guessable
 *  - bound to one path, so it cannot be turned on another patient's report
 *  - bound to the user who asked for it, so it inherits their permissions
 *  - valid for sixty seconds, which covers opening, printing and reloading
 *  - reusable inside that minute, because a PDF viewer re-requests ranges
 *
 * Kept in memory deliberately. They are worthless after a minute, and a
 * restart invalidating them is the correct behaviour rather than a problem.
 */

type Ticket = { path: string; userId: number; expires: number }

const tickets = new Map<string, Ticket>()
const LIFETIME_MS = 60_000

function sweep() {
  const now = Date.now()
  for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k)
}

export function createTicket(path: string, userId: number): string {
  sweep()
  const ticket = randomBytes(32).toString('base64url')
  tickets.set(ticket, { path, userId, expires: Date.now() + LIFETIME_MS })
  return ticket
}

/** Returns the user id the ticket was issued to, or null. */
export function checkTicket(ticket: string, path: string): number | null {
  const t = tickets.get(ticket)
  if (!t) return null
  if (t.expires < Date.now()) { tickets.delete(ticket); return null }
  // Compared exactly: a ticket for one report must not open another.
  if (t.path !== path) return null
  return t.userId
}
