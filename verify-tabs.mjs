/**
 * Switching tabs must never wedge a module.
 *
 * A module shell wrapped in `AnimatePresence mode="wait"` holds the incoming
 * tab until the outgoing one finishes animating away. When that exit did not
 * complete, every screen in the module went blank and stayed blank until the
 * whole application was remounted by signing in again — which is a module that
 * has stopped working, reached by pressing a tab.
 *
 * Static check, no server needed: the shells must not wait for an exit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/client/src'
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))) }

function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(p)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

console.log('\n— module shells do not wait on an exit —')
const shells = files.filter((f) =>
  /screens\/(Admin|MainCounter|Pharmacy|Stores|Lab|OpdCounter|IpdCounter|Doctor)\.tsx$/.test(f))
ok('every module shell was found', shells.length === 8, String(shells.length))

for (const f of shells) {
  const src = strip(readFileSync(f, 'utf8'))
  const name = f.split('/').pop()
  ok(`${name} does not hold tabs behind mode="wait"`, !/mode=["']wait["']/.test(src))
}

console.log('\n— a keyed panel still animates the change —')
for (const f of shells.filter((x) => /(Admin|MainCounter|Pharmacy|Stores)\.tsx$/.test(x))) {
  const src = strip(readFileSync(f, 'utf8'))
  ok(`${f.split('/').pop()} keys its panel on the tab`, /key=\{tab\}/.test(src))
}

console.log('\n— overlays may still use it, they are not a module shell —')
{
  /*
   * A dialog or a toast disappearing is a different thing: if its exit hangs
   * the worst case is a stuck overlay the user can close, not a module that
   * will not render.
   */
  const ui = strip(readFileSync(join(ROOT, 'components/ui.tsx'), 'utf8'))
  ok('the modal does not wait either', !/mode=["']wait["']/.test(ui))
}

console.log('\n— settings screens actually contain their fields —')
{
  /*
   * A field that is missing renders perfectly well.
   *
   * The credential boxes for a shared printer were written, shipped, and never
   * appeared, because the edit that added them silently matched nothing. Every
   * other check passed: it typechecked, it rendered, the tests were green. The
   * only thing that would have caught it is asking whether the field is there.
   */
  const printer = strip(readFileSync(join(ROOT, 'components/PrinterSettings.tsx'), 'utf8'))

  for (const [what, needle] of [
    ['the share path', 'target.unc'],
    ['a username for the PC holding the printer', 'target.user'],
    ['a password for it', 'target.pass'],
    ['the network host', 'target.host'],
    ['a test print button', 'testPrint']
  ]) {
    ok(`printer settings offer ${what}`, printer.includes(needle))
  }

  // The two credential boxes are useless unless the server is told about them.
  const printing = strip(
    readFileSync(join('src/server/services', 'printing.ts'), 'utf8'))
  ok('and the server reads them back', /user/.test(printing) && /pass/.test(printing))
}

console.log('\n— a tab that can be switched off is wired at both ends —')
{
  /*
   * The prescriptions tab is switched off for a pharmacy running on its own:
   * a standalone chemist has no doctors sending prescriptions through, so the
   * tab is an empty screen somebody clicks once and never again.
   *
   * Three things have to agree for that to work, and two of them fail
   * silently. A permission the access screen does not offer can never be
   * unticked; a tab the shell does not guard stays visible however it is set;
   * and a permission missing from the pharmacist's defaults would take the
   * tab away from every hospital already running this, which is the one
   * outcome that must not happen on an upgrade.
   */
  const shell = strip(readFileSync(join(ROOT, 'screens/Pharmacy.tsx'), 'utf8'))
  ok('the pharmacy shell guards the prescriptions tab',
    /prescriptions:\s*'prescriptions\.see'/.test(shell))

  const pharma = strip(readFileSync(join('src/server/services', 'pharma.ts'), 'utf8'))
  ok('the access screen offers it as a checkbox',
    /key:\s*'prescriptions\.see'/.test(pharma))

  /*
   * On by default for a pharmacist, so an existing hospital sees no change.
   * Read from the role defaults block rather than the whole file, since the
   * permission's own definition also mentions the key.
   */
  const defaults = pharma.slice(pharma.indexOf('ROLE_DEFAULTS'))
  const pharmacist = defaults.slice(defaults.indexOf('pharmacist:'),
    defaults.indexOf('pharmacy_admin:'))
  ok('and a pharmacist has it on by default',
    pharmacist.includes("'prescriptions.see'"), pharmacist.slice(0, 120))
}


/* --------------------------------- a table's headings match its columns -- */

/**
 * Every <Th> over a <td>, and no column without a heading.
 *
 * The receive screen had eight headings over nine columns of data, so from
 * "Cost" rightwards every title sat over the wrong box: "Sells at" labelled
 * the tax field and "Line" labelled the sale price. Nothing broke, nothing
 * threw, and the pharmacy read it for two weeks as a confusing table rather
 * than as a mislabelled one.
 *
 * Counted on the SOURCE, by matching each <thead> against the first <tr> in
 * the <tbody> that follows it. A rendered check cannot see this: the browser
 * is perfectly happy to draw a short header row, which is the whole problem.
 *
 * A table whose body row uses colSpan is skipped. One cell spanning two
 * columns is a deliberate choice and counting it would report a table that
 * is right as wrong.
 */
console.log('\n— table headings line up with their columns —')
{
  let checked = 0
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'))

    /* Each <thead> ... </thead> followed by the body's first <tr> ... </tr>. */
    const heads = [...src.matchAll(/<thead[\s\S]*?<\/thead>([\s\S]*?)<\/tbody>/g)]
    for (const [i, m] of heads.entries()) {
      const whole = m[0]
      const headPart = whole.slice(0, whole.indexOf('</thead>'))
      const bodyPart = m[1]

      const ths = (headPart.match(/<Th[\s>]/g) ?? []).length
      if (ths === 0) continue

      /* The first row of the body, which is the one that defines the shape. */
      const row = bodyPart.match(/<tr[^>]*>([\s\S]*?)<\/tr>/)
      if (!row) continue
      if (/colSpan/i.test(row[1])) continue

      /*
       * A cell is a <td>, or a component that renders one.
       *
       * Doctor.tsx has a <Money /> that returns a single <td>, and counting
       * only the literal tags reported a correct eight-column table as a
       * three-column one. The components are found by reading the file:
       * anything declared in it whose first returned tag is a <td> is a cell.
       */
      const cellComponents = []
      for (const d of src.matchAll(/(?:function\s+|const\s+)([A-Z]\w*)\s*[({=]/g)) {
        /* The first tag this declaration returns, within its opening lines. */
        const body = src.slice(d.index, d.index + 700)
        const firstTag = body.match(/return\s*\(?\s*<(\w+)/)
        if (firstTag && firstTag[1] === 'td') cellComponents.push(d[1])
      }

      const tds = (row[1].match(/<td[\s>]/g) ?? []).length
        + cellComponents.reduce((n, name) =>
            n + (row[1].match(new RegExp('<' + name + '[\\s/>]', 'g')) ?? []).length, 0)
      if (tds === 0) continue

      checked++
      ok(`${f.split('/').pop()} table ${i + 1}: ${ths} headings over ${tds} columns`,
        ths === tds,
        ths < tds ? `${tds - ths} column(s) with no heading above them`
                  : `${ths - tds} heading(s) with no column under them`)
    }
  }
  ok('and there were tables to check', checked > 20, `${checked} tables`)
}


/* ------------------------------- every rail item has a drawn icon -------- */

/**
 * No navigation item standing on a letter.
 *
 * The rail took an optional `icon` with a one or two character `glyph`
 * behind it, and two whole modules never supplied the icon. The pharmacy's
 * rail read B, Rx, R, M, PO, in, S, Au, Dm, Ex, Op, O, Bl, L, Rp, A, P —
 * seventeen abbreviations to decode instead of a menu to scan, and in Urdu
 * they are not even in the right script.
 *
 * Counted on the source: every object in a NAV array that declares a `label`
 * must declare an `icon` beside it.
 */
console.log('\n— every rail item has an icon, not a letter —')
{
  let items = 0
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'))
    /* A NavItem array, however the file names it. */
    for (const arr of src.matchAll(
      /:\s*\(?NavItem[^=]*=\s*\[([\s\S]*?)\n\]/g)) {
      for (const entry of arr[1].matchAll(/\{([^{}]*)\}/g)) {
        const body = entry[1]
        if (!/\blabel\s*:/.test(body)) continue
        items++
        const id = (body.match(/id:\s*'([^']+)'/) ?? [])[1]
          ?? (body.match(/label:\s*'([^']+)'/) ?? [])[1] ?? '?'
        ok(`${f.split('/').pop()} · ${id} has an icon`, /\bicon\s*:/.test(body),
          'only a letter glyph')
      }
    }
  }
  ok('and there were rail items to check', items > 40, `${items} items`)
}

/**
 * The module mark in the corner is drawn too.
 *
 * It was `title.slice(0, 1)` for every module, so the corner of the pharmacy
 * said "P" above a rail of other letters.
 */
{
  const sidebar = strip(readFileSync(`${ROOT}/components/Sidebar.tsx`, 'utf8'))
  ok('the rail takes a brand icon', /brandIcon/.test(sidebar))

  const shells = files.filter((f) => /<Sidebar\b/.test(strip(readFileSync(f, 'utf8'))))
  for (const f of shells) {
    const src = strip(readFileSync(f, 'utf8'))
    ok(`${f.split('/').pop()} passes one`, /brandIcon=/.test(src),
      'its corner still shows the first letter of the title')
  }
  ok('and every module shell was checked', shells.length >= 8, `${shells.length} shells`)
}


/* -------------------------- the reports screen passes its filters on ---- */

/**
 * A dropdown that changes nothing is worse than no dropdown.
 *
 * The suites hit the report API directly, so a screen that drew the filter
 * and then ran the report without it would pass every one of them while
 * showing a cashier the wrong doctor's statement. That is the same shape as
 * the purchase order id the receive screen sent and the server dropped:
 * the layer under the UI worked and nothing tested the UI's own path.
 *
 * Read off the source, because it is the call site that matters and there
 * is nothing to click here.
 */
console.log('\n— the reports screen sends its filters —')
{
  const src = strip(readFileSync(`${ROOT}/screens/pharma/Reports.tsx`, 'utf8'))

  ok('it keeps the chosen filter values',
    /chosen/.test(src), 'no filter state found')
  ok('the on-screen run includes them',
    /runAnyReport\([^)]*\.\.\.chosen/.test(src),
    'runAnyReport is called without the filters')
  ok('and so does the printed copy',
    /Object\.entries\(chosen\)/.test(src),
    'the download URL is built without the filters')
  ok('and the dropdowns are actually drawn',
    /def\?\.filters/.test(src) && /allLabel/.test(src),
    'the catalogue declares filters that the screen never renders')
}


/* ------------------------------ an imported component that nothing uses -- */

/**
 * No screen importing a component it never renders.
 *
 * The main counter's bill history imported ChitPreview and
 * CounterBillPreview, kept state for both, and nothing anywhere opened
 * either one. So the only thing a cashier could do with an old bill was
 * print it and look at the paper — on a thermal printer, a wrong guess is a
 * wasted slip and a confused patient. The preview had been built and wired
 * up to the point just before it was reachable.
 *
 * That is invisible to a typechecker, to the render check and to every HTTP
 * suite: the code compiles, the screen draws, and the feature is simply not
 * there. Reading the imports and checking each one is actually rendered
 * catches it, and catches the next one.
 *
 * Only capitalised imports from the project's own files, and only names used
 * as JSX. A helper function or a type is not expected to appear as a tag.
 */
console.log('\n— every imported component is actually rendered —')
{
  let checked = 0
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'))

    for (const imp of src.matchAll(
      /import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
      const from = imp[2]
      /* Only the component files. lib/ holds helpers and stores. */
      if (/\/lib\//.test(from)) continue

      for (const raw of imp[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim() ?? ''
        if (!/^[A-Z]\w*$/.test(name)) continue
        if (/^type\s/.test(raw.trim())) continue

        /*
         * Used as a tag, passed as a value (icon={Foo}, [Foo, ...]), or read
         * as an object (SPRING.pill). The last one matters: not every
         * capitalised export is a component, and a motion constant is used
         * by its members rather than rendered.
         */
        const used = new RegExp(
          `<${name}[\\s/>]|\\b${name}\\s*\\}|[[(,:]\\s*${name}\\s*[,\\])]`
          + `|\\b${name}\\.`
        ).test(src.replace(imp[0], ''))

        checked++
        ok(`${f.split('/').pop()} renders ${name}`, used,
          'imported and never used — a feature wired up to just short of reachable')
      }
    }
  }
  ok('and there were imports to check', checked > 100, `${checked} imports`)
}


/* -------------------------------- a state setter that nothing ever calls -- */

/**
 * No useState setter declared and never called.
 *
 * This is the check that would have found the bill-history bug, and the
 * import check above would NOT have: the main counter imported
 * ChitPreview and CounterBillPreview, RENDERED both of them behind
 * `{chit && ...}`, and nothing anywhere called setChit or setBill. So the
 * imports were used, the components were rendered, the file compiled, the
 * screen drew — and the preview was unreachable. The only way to look at an
 * old bill was to print it and read the paper.
 *
 * A setter nobody calls means a piece of state that can never change from
 * its initial value, which means the branch that depends on it is dead. It
 * is a small rule and it catches a feature built to one line short of
 * working.
 *
 * Setters passed on rather than called — `onChange={setFoo}`, or handed to a
 * child as a prop — count as used, because the call happens elsewhere.
 */
console.log('\n— every piece of state can actually change —')
{
  let checked = 0
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'))

    for (const st of src.matchAll(
      /const\s*\[\s*(\w+)\s*,\s*(set[A-Z]\w*)\s*\]\s*=\s*useState/g)) {
      const setter = st[2]
      /* Anywhere other than the declaration itself. */
      const rest = src.split(st[0]).join('\n')
      const used = new RegExp(`\\b${setter}\\b`).test(rest)
      checked++
      ok(`${f.split('/').pop()} · ${setter} is called`, used,
        `state "${st[1]}" can never change, so anything behind it is dead`)
    }
  }
  ok('and there was state to check', checked > 150, `${checked} setters`)
}


/* ------------------ a document you can print, you can look at first ------ */

/**
 * Every screen that lists finished documents offers a preview, not only
 * Print.
 *
 * The main counter's bill history offered Print again and nothing else. The
 * preview dialog existed, was imported into that very file, had state kept
 * for it, and was rendered behind `{chit && ...}` — and nothing ever set
 * `chit`. So the only way to check you had the right bill was to print it
 * and read the paper, which on a thermal printer costs a slip and a
 * confused patient.
 *
 * NAMED SCREENS RATHER THAN A PATTERN, deliberately. Two general checks were
 * tried first and neither catches this: the imports were used, the component
 * was rendered, and the setter was called — with null, from the close
 * handler. Both of those rules are worth keeping for what they do catch, but
 * claiming either guards this would be false.
 *
 * So the rule is stated as what it is: these screens list documents somebody
 * will want to read before printing, and each must open a preview from the
 * row. Add a screen to the list when you add a screen that lists documents.
 */
console.log('\n— an old document can be looked at before printing —')
{
  const LISTS = [
    ['screens/counter/History.tsx', ['ChitPreview', 'CounterBillPreview']],
    ['screens/pharmacy/Bills.tsx', ['ReceiptPreview']]
  ]

  for (const [rel, previews] of LISTS) {
    const src = strip(readFileSync(`${ROOT}/${rel}`, 'utf8'))
    const name = rel.split('/').pop()

    for (const p of previews) {
      ok(`${name} renders ${p}`, new RegExp(`<${p}[\\s/>]`).test(src))
    }

    /*
     * The trigger, which is the part that was missing. A setter called with
     * something that is not null or false — that is a row opening the
     * preview rather than the dialog closing itself.
     */
    const opens = [...src.matchAll(/\bset[A-Z]\w*\(\s*([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((arg) => arg && arg !== 'null' && arg !== 'false')
    ok(`${name} opens it from a row`, opens.length > 0,
      'every setter is only ever called with null, so nothing can open the preview')

    /* And it says so in words somebody can find. */
    ok(`${name} labels the way in`,
      /tr\('(View|Receipt|Preview receipt)'\)/.test(src),
      'no View, Receipt or Preview label on the row')
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
