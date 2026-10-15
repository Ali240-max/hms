/**
 * Types for verify-pdf.mjs.
 *
 * The helper is plain JavaScript so the .mjs suites can import it with node
 * alone, and the TypeScript suites need a declaration to go with it. Kept as
 * a separate file rather than rewriting the helper in TypeScript, because
 * two of the suites that use it are run by node directly.
 */
export function sampleDir(): string
export function savePdf(name: string, buf: Buffer | Uint8Array): string
export function hasPdfToText(): boolean
export function pdfText(path: string, mode?: 'layout' | 'bbox'): string | null
export function notePdfToolMissing(): void
