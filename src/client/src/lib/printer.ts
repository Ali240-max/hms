/**
 * Printer preferences, per machine.
 *
 * An honest limitation first: a web page cannot choose which printer to use.
 * The browser's print dialog owns that, and there is no API that lets a page
 * pick a device — deliberately, since a page that could silently print to any
 * printer would be a nuisance at best. So the printer itself is set once in
 * Windows, by making the till's roll printer the default on that PC.
 *
 * What this file does control is everything on our side of that line: paper
 * width, how many copies, whether to show the preview or go straight to the
 * dialog, and which optional blocks appear on the slip. Those are stored per
 * machine, because the pharmacy till and the main counter are different PCs
 * with different hardware and different habits.
 */

export type PaperWidth = '58mm' | '80mm' | 'A4'

export type PrinterSettings = {
  paper: PaperWidth
  copies: number
  /** Skip the on-screen preview and open the print dialog immediately. */
  autoPrint: boolean
  showLetterhead: boolean
  showFooter: boolean
  /** Extra blank lines at the end, so the tear-off does not cut the total. */
  feedLines: number
}

export const DEFAULTS: PrinterSettings = {
  paper: '80mm',
  copies: 1,
  autoPrint: false,
  showLetterhead: true,
  showFooter: true,
  feedLines: 2
}

/** Printable width after the margins the print head cannot reach. */
export const PAPER_WIDTH: Record<PaperWidth, string> = {
  '58mm': '48mm',
  '80mm': '72mm',
  'A4': '190mm'
}

const key = (module: string) => `hms.printer.${module}`

export function loadPrinter(module: string): PrinterSettings {
  try {
    const raw = localStorage.getItem(key(module))
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch { return { ...DEFAULTS } }
}

export function savePrinter(module: string, s: PrinterSettings) {
  try { localStorage.setItem(key(module), JSON.stringify(s)) } catch { /* private mode */ }
}

/**
 * Applies the chosen paper width to the print stylesheet.
 *
 * Done as a variable on the document rather than inline on the slip so that
 * the @page rule can use it too — the page box and the content have to agree
 * or the printer scales the slip and the columns stop lining up.
 */
export function applyPaper(paper: PaperWidth) {
  const root = document.documentElement
  root.style.setProperty('--print-paper', paper === 'A4' ? '210mm' : paper)
  root.style.setProperty('--print-width', PAPER_WIDTH[paper])
}

/** Print, honouring the copy count. */
export function printNow(module: string) {
  const s = loadPrinter(module)
  applyPaper(s.paper)
  for (let i = 0; i < Math.max(1, s.copies); i++) window.print()
}

/**
 * Print a full-page document rather than a till slip.
 *
 * The receipt roll width is held in CSS variables and applies to everything
 * printable, so a report came out 72mm wide with its right-hand columns cut
 * off. This swaps the page to A4 for the duration of the print and puts the
 * roll settings back afterwards, so the next receipt is unaffected.
 *
 * Done in JavaScript rather than with a named @page rule because support for
 * those is uneven, and a report that prints wrongly on one machine in the
 * hospital is worse than one that prints the same everywhere.
 */
export function printSheet() {
  const root = document.documentElement
  const paper = root.style.getPropertyValue('--print-paper')
  const width = root.style.getPropertyValue('--print-width')

  root.style.setProperty('--print-paper', 'A4')
  root.style.setProperty('--print-width', 'auto')

  const restore = () => {
    root.style.setProperty('--print-paper', paper || '80mm')
    root.style.setProperty('--print-width', width || '72mm')
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)

  window.print()
  // Safari never fires afterprint from a programmatic print, so put the roll
  // settings back regardless once the dialog has had time to open.
  setTimeout(restore, 1500)
}
