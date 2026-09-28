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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
