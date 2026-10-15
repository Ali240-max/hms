/**
 * Reading a generated PDF back, on whatever machine the checks are run on.
 *
 * Three suites render a report and then read the text out of it to prove the
 * layout. Both halves of that were written against the machine they were
 * written on:
 *
 *   1. The PDFs were saved to a fixed directory that exists here and nowhere
 *      else, so `npm run verify` on the hospital server died on a missing
 *      path before it tested anything.
 *   2. They shell out to `pdftotext`, which ships with poppler on Linux and
 *      is not on a Windows machine at all. A hospital that installed this
 *      system and followed the instructions got a failure that said nothing
 *      about the system.
 *
 * So: samples go to a scratch directory under the system temp folder, which
 * exists on every platform, and a missing `pdftotext` SKIPS the text checks
 * with a line saying why rather than failing them. Everything that does not
 * need the tool still runs, which is most of it.
 *
 * Skipping is the honest answer here. The alternative is a check that passes
 * when it could not run, and a green tick that means nothing is worse than a
 * line admitting the tool is absent.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = join(tmpdir(), 'hms-verify')

/** Where a sample PDF can be written. Created on first use. */
export function sampleDir() {
  mkdirSync(DIR, { recursive: true })
  return DIR
}

/** Save a rendered PDF for inspection and return its path. */
export function savePdf(name, buf) {
  const p = join(sampleDir(), name)
  writeFileSync(p, buf)
  return p
}

let available = null

/** Is pdftotext on this machine? Asked once. */
export function hasPdfToText() {
  if (available !== null) return available
  try {
    execSync('pdftotext -v', { stdio: ['ignore', 'ignore', 'ignore'] })
    available = true
  } catch { available = false }
  return available
}

/**
 * The text of a PDF, or null if the tool is not installed.
 *
 * `mode` is 'layout' for text with its columns kept, or 'bbox' for the XML
 * that carries each word's position. Callers that get null are expected to
 * skip, not to guess.
 */
export function pdfText(path, mode = 'layout') {
  if (!hasPdfToText()) return null
  const flag = mode === 'bbox' ? '-bbox' : '-layout'
  return execSync(`pdftotext ${flag} "${path}" -`, { encoding: 'utf8' })
}

/** One line, printed once, explaining why text checks were skipped. */
let said = false
export function notePdfToolMissing() {
  if (said) return
  said = true
  console.log('  skip  pdftotext is not installed on this machine, so the'
    + ' checks that read text out of a PDF were not run.')
  console.log('        Windows: install poppler and put pdftotext.exe on PATH.'
    + '  Debian: apt install poppler-utils')
}
