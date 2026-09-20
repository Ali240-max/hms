import { sql } from 'drizzle-orm'
import { nextCounter } from '../db/client'

/**
 * Document numbers.
 *
 * Every invoice, chit, report and voucher is numbered the same way:
 *
 *     INV-260618-C00123
 *      |     |     | |
 *      |     |     | +-- the day's sequence, reset each morning
 *      |     |     +---- the kind, so a glance tells you what it is
 *      |     +---------- the date, YYMMDD
 *      +---------------- the document
 *
 * Two reasons for the date, and only the second is the obvious one.
 *
 * The counter resets daily, so the sequence never has to be wide enough to
 * hold a decade of trading. A single running number that reaches 999999 is a
 * problem a hospital discovers on the day it happens, mid-queue; a daily one
 * would need three thousand documents in one day to come close, and if a
 * hospital is doing that it has bigger questions than numbering.
 *
 * The date also makes a number self-describing. Somebody holding a slip four
 * months later, or reading a WhatsApp photograph of one, can find the day
 * without looking it up — which is most of what anyone wants from a reference
 * when they ring the counter.
 *
 * YYMMDD rather than DDMMYY: it sorts chronologically in any list, a file
 * manager, a spreadsheet or a printed report, and it cannot be misread as a
 * US-style date. If the hospital insists on DDMMYY, this is the one function
 * to change.
 */

/** The date segment, in the hospital's own day rather than UTC. */
export function dateSegment(when: Date = new Date()): string {
  const y = String(when.getFullYear()).slice(2)
  const m = String(when.getMonth() + 1).padStart(2, '0')
  const d = String(when.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * The next number for a kind of document, today.
 *
 * `prefix` is what the document is called, `letter` marks the kind within it —
 * C for a consultation bill, D for a chit, S for a sale. The counter key
 * carries the date, which is what makes the reset automatic rather than
 * something somebody has to remember to do in January.
 */
export async function documentNo(tx: any, opts: {
  prefix: string
  letter?: string
  /** Digits in the daily sequence. Five is 99,999 documents in one day. */
  width?: number
  when?: Date
}): Promise<string> {
  const day = dateSegment(opts.when)
  const key = `${opts.prefix.toLowerCase()}:${day}`
  const n = await nextCounter(tx, key)
  return `${opts.prefix}-${day}-${opts.letter ?? ''}${String(n).padStart(opts.width ?? 5, '0')}`
}

/**
 * MRNs are deliberately not dated.
 *
 * A medical record number identifies a person for life, not an event on a day.
 * Putting a date in it would imply the record belongs to the day it was
 * opened, and a patient registered in 2026 is still the same patient in 2031.
 * It stays a single gapless sequence.
 */
export async function nextMrn(tx: any): Promise<string> {
  return `MRN-${String(await nextCounter(tx, 'mrn')).padStart(6, '0')}`
}
