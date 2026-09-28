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

/**
 * How long a page the printer is set to.
 *
 * A thermal printer feeds to the end of the page its driver is set to,
 * whatever the browser asks for: Chrome only offers the paper sizes the
 * driver exposes, so `@page { size: 72mm 104mm }` is ignored unless a form of
 * that size exists. A driver left on 80 x 3276mm feeds three metres of blank
 * roll after every receipt, which is exactly what happened here.
 *
 * Setting this to the length of the Windows form the printer is actually on
 * makes the browser's page match it, so nothing is scaled or split. Setting
 * it to `content` asks for a page exactly as tall as the slip, which works
 * only where a matching custom form exists — see DEPLOY-WINDOWS-OFFLINE.md.
 */
export type PaperLength = 'content' | '100' | '150' | '210' | '297'

export type PrinterSettings = {
  paper: PaperWidth
  /** Matches the Windows form the printer is set to. See PaperLength. */
  length?: PaperLength
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
  length: 'content',
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

/**
 * Print one element, and nothing else, on a page exactly its own size.
 *
 * Three attempts got this wrong, each in a different way, and all three
 * failed for the same underlying reason: the browser prints the *document*,
 * and the document was the application. Hiding the rest of it with
 * `visibility: hidden` left every hidden box occupying its height, so a
 * thermal printer fed out the whole application as blank roll. Hiding it with
 * `display: none` fixed the height but left the slip laid out inside the
 * app's own flex and height rules, so it landed halfway down a page whose
 * length the printer driver had chosen. Measuring the slip in the app's
 * layout measured it at the wrong width.
 *
 * So the slip is printed from its own document instead. An off-screen iframe
 * is given the application's stylesheets, the slip markup, and nothing else:
 * no #root, no flex parents, no inherited heights, no toast container. Its
 * body is exactly as tall as the slip, and that measured height becomes the
 * page size. There is nothing left for a driver to pad out and nothing to
 * push the slip down the page.
 *
 * It also means an accidental Ctrl+P anywhere in the application prints the
 * page the user is looking at, not a stale slip, because nothing is copied
 * into the main document at all.
 */
export function printElement(
  source: Element,
  widthCss: string,
  copies = 1,
  now = false,
  lengthMm: PaperLength = 'content'
) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:' + widthCss + ';height:10px;border:0;'
  document.body.appendChild(frame)

  const doc = frame.contentDocument
  if (!doc) { frame.remove(); return }

  /*
   * The application's own stylesheets are copied in.
   *
   * The slip is styled with the same classes as everything else, so without
   * them it would print as unstyled text. `<base>` keeps relative font URLs
   * resolving against the real page rather than about:blank.
   */
  const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((n) => n.outerHTML).join('\n')

  doc.open()
  doc.write(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<base href="' + document.baseURI + '">' +
    styles +
    '<style>' +
      'html,body{margin:0;padding:0;background:#fff;height:auto;width:' + widthCss + ';}' +
      '*{box-shadow:none !important;}' +
      '.no-print{display:none !important;}' +
    '</style>' +
    '</head><body></body></html>')
  doc.close()

  doc.body.appendChild(doc.importNode(source, true))

  const finish = () => {
    /*
     * Measured inside the frame, at the paper's own width.
     *
     * This is the number that was wrong before: measuring in the application
     * measured the slip at whatever width the screen gave it, and a slip laid
     * out at 1200px wraps to a fraction of the height it has at 72mm.
     */
    const px = Math.max(
      doc.body.scrollHeight,
      doc.documentElement.scrollHeight,
      (doc.body.firstElementChild as HTMLElement)?.offsetHeight ?? 0
    )
    const measured = Math.max(Math.ceil((px / 96) * 25.4) + 2, 20)

    /*
     * The page length.
     *
     * `content` asks for a page exactly as tall as the slip. Chrome will only
     * honour it if the printer driver has a form that size, so where it does
     * not, the driver's own length wins and the slip is followed by blank
     * roll. Naming the length the printer is actually set to makes the two
     * agree, which stops the browser scaling or splitting the slip.
     */
    const mm = lengthMm === 'content' ? measured : Number(lengthMm)

    const page = doc.createElement('style')
    page.textContent =
      '@page{size:' + widthCss + ' ' + mm + 'mm;margin:0;}' +
      /* Nothing is allowed to spill onto a second page. */
      'html,body{max-height:' + mm + 'mm;overflow:hidden;}'
    doc.head.appendChild(page)

    try {
      frame.contentWindow?.focus()
      for (let i = 0; i < Math.max(1, copies); i++) frame.contentWindow?.print()
    } finally {
      /*
       * Removed late. Chrome returns from print() before the preview has
       * finished rendering, and tearing the frame down early gives a blank
       * preview — which is its own kind of wasted roll.
       */
      setTimeout(() => frame.remove(), 60_000)
      frame.contentWindow?.addEventListener('afterprint', () => {
        setTimeout(() => frame.remove(), 500)
      })
    }
  }

  /*
   * Give the copied stylesheets and any web fonts a moment to apply.
   *
   * `now` skips the wait; it exists so the mechanism can be exercised
   * synchronously by a test, which is how the four things that were wrong
   * here last time are now checked on every run.
   */
  if (now) { finish(); return frame }
  if ((doc as any).fonts?.ready) {
    (doc as any).fonts.ready.then(() => setTimeout(finish, 30)).catch(() => finish())
  } else {
    setTimeout(finish, 120)
  }
  return frame
}

/** The element on the page that is meant to be printed. */
function printable(): Element | null {
  const node = document.querySelector('.print-area')
  if (!node) console.warn('Nothing to print: no .print-area on the page')
  return node
}

/** Print, honouring the copy count. */
export function printNow(module: string) {
  const s = loadPrinter(module)
  applyPaper(s.paper)
  const node = printable()
  if (node) printElement(node, PAPER_WIDTH[s.paper], s.copies, false, s.length ?? 'content')
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

  const node = printable()
  if (node) printElement(node, '190mm')
  // Safari never fires afterprint from a programmatic print, so put the roll
  // settings back regardless once the dialog has had time to open.
  setTimeout(restore, 1500)
}

/* --------------------------------------------------------- workstation */

/**
 * Which PC this browser is.
 *
 * Printer settings were stored per module, so both main counter PCs shared
 * one: setting the share path on the first changed it on the second, and only
 * one of the two thermal printers could ever be registered.
 *
 * The identity that matters is the machine, not the person. A printer is
 * plugged into a PC, and if a cashier signs in at the other window their
 * receipts must come out of the printer next to them, not the one they used
 * yesterday. Keying on the account would put the slip in the wrong queue every
 * time somebody covered a colleague's break.
 *
 * So each browser gets an id of its own, kept in local storage, and printer
 * settings hang off that. Clearing the browser's data loses it, which means
 * re-picking the printer on that PC — a minute's work, and the same thing
 * would be needed on a new machine anyway.
 */
const DEVICE_KEY = 'hms.device'
const DEVICE_NAME_KEY = 'hms.device.name'

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = 'w' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    // Private browsing with storage blocked. Everything still works; the PC
    // simply falls back to the counter-wide setting.
    return ''
  }
}

export function deviceName(): string {
  try { return localStorage.getItem(DEVICE_NAME_KEY) ?? '' } catch { return '' }
}

export function setDeviceName(name: string) {
  try { localStorage.setItem(DEVICE_NAME_KEY, name) } catch { /* nothing to do */ }
}

/**
 * The key a counter's printer settings are stored under.
 *
 * `counter@w3k9f2` rather than `counter`. Where a browser has no id the plain
 * module name is used, which is also what every existing installation already
 * has — so nothing set up before this change is lost.
 */
export function printerScope(module: string): string {
  const id = deviceId()
  return id ? `${module}@${id}` : module
}
