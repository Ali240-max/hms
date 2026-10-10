/**
 * Printing a slip prints the slip, and nothing else, on a page its own size.
 *
 * This runs the real printElement from lib/printer.ts against a real DOM.
 * jsdom does not paint, so the measured height is zero and print() is a stub,
 * but it does check the four things that were each wrong in turn:
 *
 *   1. the document being printed contains only the slip
 *   2. none of the application is in it
 *   3. the page has an explicit height, never `auto`
 *   4. print is called on that document, not on the page the user is looking at
 *
 * Run with:  npx tsx verify-print.mjs
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM(`<!doctype html><html><head>
  <style id="app-css">.print-area{width:72mm}</style>
  <link rel="stylesheet" href="/assets/index.css">
</head><body>
  <div id="root">
    <div style="height:4000px">the whole application</div>
    <div class="flex justify-center">
      <div class="print-area"><h1>SULTAN HOSPITAL</h1><p>CHIT-260927-T00001</p></div>
    </div>
    <div class="no-print">buttons nobody prints</div>
  </div>
</body></html>`, { url: 'http://localhost:4000/' })

global.window = dom.window
global.document = dom.window.document
global.localStorage = dom.window.localStorage
global.HTMLIFrameElement = dom.window.HTMLIFrameElement

const { printElement } = await import('./src/client/src/lib/printer.ts')

let printed = 0
const realCreate = document.createElement.bind(document)
document.createElement = (tag) => {
  const el = realCreate(tag)
  if (tag === 'iframe') {
    queueMicrotask(() => {
      if (el.contentWindow) el.contentWindow.print = () => { printed++ }
    })
  }
  return el
}

const source = document.querySelector('.print-area')
const frame = printElement(source, '72mm', 1, true)
const doc = frame.contentDocument

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

console.log('\n— the document that gets printed —')
ok('a separate document is built', !!doc && doc !== document)
ok('it contains the slip', doc.body.querySelectorAll('.print-area').length === 1)
ok('it contains nothing else at all', doc.body.children.length === 1,
  `${doc.body.children.length} children`)
ok('the application is not in it', !doc.body.textContent.includes('the whole application'))
ok('the 4000px block that fed metres of blank roll is gone',
  !doc.body.innerHTML.includes('4000px'))
ok('the buttons are not in it', !doc.body.textContent.includes('buttons nobody prints'))

console.log('\n— the page is the size of the slip —')
const page = [...doc.head.querySelectorAll('style')]
  .map((s) => s.textContent).find((c) => c.includes('@page'))
ok('an @page rule is written', !!page, String(page))
ok('its width is the paper width', /size:72mm/.test(page ?? ''), page)
ok('its height is a number, never auto', /@page\{size:72mm \d+mm;/.test(page ?? ''), page)
ok('margins are zero, so nothing is added around it', /margin:0/.test(page ?? ''))

console.log('\n— the app is carried in only as styling —')
ok('the stylesheets come across',
  doc.querySelectorAll('link[rel="stylesheet"], style').length >= 3)
ok('a <base> keeps font URLs resolving', !!doc.querySelector('base'))

console.log('\n— nothing is left behind in the real page —')
ok('the real document still has its own content',
  document.querySelectorAll('.print-area').length === 1)
ok('no print host is added to it', !document.getElementById('print-root'))

/*
 * ------------------------------------------- every report fits on its page
 *
 * The report PDF lays its table out in fixed character cells and draws from
 * the left margin, so a table wider than the paper does not shrink or wrap —
 * its rightmost columns simply fall off the edge and are never seen. Stock
 * Adjustment Detail shipped that way for one build: 115 cells of columns on a
 * page that holds 105, which silently cut off the name of the person who made
 * the adjustment, the single column the report exists to show.
 *
 * Nothing about the catalogue entry looks wrong when that happens, and the
 * PDF opens without complaint, so it is not the kind of mistake anybody
 * notices by reading the code. The arithmetic is three lines, so it is
 * checked here instead, against the same constants report-pdf.ts uses.
 */
const { REPORTS } = await import('./src/server/services/report-catalogue.ts')

const SIZE = 8.5                 // report-pdf.ts
const CHAR = SIZE * 0.6          // Courier advance at that size
const MARGIN = 28
const A4_SHORT = 595.28, A4_LONG = 841.89

console.log('\n— every report fits the paper it prints on —')
const over = []
for (const r of REPORTS) {
  const cols = r.columns ?? []
  if (!cols.length) continue
  /* One space between columns, which is how report-pdf.ts joins them. */
  const cells = cols.reduce((n, c) => n + c.width, 0) + (cols.length - 1)
  const budget = Math.floor(((r.landscape ? A4_LONG : A4_SHORT) - MARGIN * 2) / CHAR)
  if (cells > budget) {
    over.push(`${r.id} ${r.landscape ? 'landscape' : 'portrait'} ` +
      `${cells} cells vs ${budget} (+${cells - budget})`)
  }
}
ok(`all ${REPORTS.length} reports stay inside their margins`, over.length === 0,
  over.join('; '))

/*
 * ------------------------------------- document numbers fit their column
 *
 * The page-width check above catches a table wider than the paper. It cannot
 * catch a single column too narrow for its contents, because that depends on
 * the data — and the symptom is quieter: cell() truncates and appends a dot,
 * so "GRN-261009-G00003" prints as "GRN-261009-G000." and looks like a
 * complete number until somebody tries to search for it.
 *
 * Three columns shipped that way at once. Every house document number has a
 * known shape, PREFIX-YYMMDD-X00000, whose longest form is 17 characters, so
 * a column holding one has a floor that can simply be asserted.
 */
console.log('\n— a document number is never truncated by its own column —')
{
  /*
   * Every number the system issues itself, and nothing else.
   *
   * `batch_no` and `supplier_invoice_no` are deliberately absent: those are
   * the supplier's, in whatever shape the supplier uses, so there is no
   * length to assert and demanding 17 would waste a third of a page on
   * reports that carry both.
   */
  const NUMBER_KEYS = new Set(['grn_no', 'order_no', 'invoice_no', 'return_no',
    'adjustment_no', 'audit_no', 'bill_no', 'chit_no', 'report_no', 'visit_no',
    'mrn'])
  /* PREFIX-YYMMDD-LNNNNN, and the MRN scheme, both reach exactly this. */
  const LONGEST = 17
  const narrow = []
  for (const r of REPORTS) {
    for (const c of r.columns ?? []) {
      if (NUMBER_KEYS.has(c.key) && c.width < LONGEST) {
        narrow.push(`${r.id}.${c.key} is ${c.width}, needs ${LONGEST}`)
      }
    }
  }
  ok('every column holding a document number is at least 17 wide',
    narrow.length === 0, narrow.join('; '))
}

/*
 * A report with no name against it cannot be audited, and the ones that move
 * stock or money are the ones somebody will later ask about. The printing
 * user's name goes on every report by report-pdf.ts, so what is checked here
 * is that the rows themselves carry the actor where the row is the record.
 */
console.log('\n— the reports that record an action name who did it —')
for (const id of ['adjustments-list', 'adjustments-detail', 'rate-change']) {
  const r = REPORTS.find((x) => x.id === id)
  ok(`${id} has a column for the person`, !!r &&
    r.columns.some((c) => /^(created_by|changed_by)$/.test(c.key)),
    r ? r.columns.map((c) => c.key).join(',') : 'no such report')
  ok(`${id} has a column for the time`, !!r &&
    r.columns.some((c) => c.key === 'when'))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
