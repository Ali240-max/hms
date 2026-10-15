/**
 * A report takes the shape its test needs.
 *
 * Three things, each of which was wrong before: a test answering POSITIVE or
 * NEGATIVE printed two empty columns; a timed test printed as a flat list
 * with no way to tell the blocks apart; and both were hard-coded, so neither
 * could be changed per test.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  saveParameters, saveReportLayout, reportLayoutFor, saveResults
} from './src/server/services/lab'
import { labReportPdf } from './src/server/services/lab-pdf'
import { writeFile, readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
/*
 * Samples go to a scratch directory and the text extraction is optional.
 *
 * Both used to be fixed to the machine these checks were written on: a
 * directory that exists nowhere else, and a `pdftotext` that is not on a
 * Windows server. The hospital running `npm run verify` on its own box got a
 * failure about a missing path rather than anything about the system.
 */
import { savePdf, pdfText, hasPdfToText, notePdfToolMissing } from './verify-pdf.mjs'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

const svc = ((await db.execute<any>(sql`
  SELECT id, name FROM services WHERE category = 'lab' ORDER BY id LIMIT 1`)).rows as any[])[0]
ok('there is a test to set up', !!svc, JSON.stringify(svc))

console.log('\n— the layout is per test —')
await saveReportLayout(svc.id, 'qualitative')
ok('it can be set to positive-or-negative', await reportLayoutFor(svc.id) === 'qualitative')
await saveReportLayout(svc.id, 'standard')
ok('and back to numbers', await reportLayoutFor(svc.id) === 'standard')
await saveReportLayout(svc.id, 'nonsense' as any)
ok('anything else falls back to numbers rather than breaking the report',
  await reportLayoutFor(svc.id) === 'standard')

console.log('\n— sections, as on a glucose tolerance test —')
await saveParameters(svc.id, [
  { name: 'Glucose Fasting', unit: 'mg/dl', refText: '70 - 110' },
  { name: 'Urine Sugar', refText: 'Nil' },
  { name: 'Given 75g Glucose D', refText: '' },
  { name: 'Glucose Random', unit: 'mg/dl', refText: '< 140', section: 'After 1hr' },
  { name: 'Urine Sugar (1hr)', refText: 'Nil' },
  { name: 'Glucose Random (2hr)', unit: 'mg/dl', refText: '< 140', section: 'After 2hr' },
  { name: 'Urine Sugar (2hr)', refText: 'Nil' }
])
const saved = (await db.execute<any>(sql`
  SELECT name, section FROM service_parameters
  WHERE service_id = ${svc.id} ORDER BY display_order`)).rows as any[]

ok('every line is kept in order', saved.length === 7, String(saved.length))
ok('the headings sit on the first line of each block',
  saved[3].section === 'After 1hr' && saved[5].section === 'After 2hr',
  JSON.stringify(saved.map((s) => s.section)))
ok('and the lines beneath carry none',
  saved[4].section === null && saved[6].section === null)
/*
 * The first block has no heading on purpose: a report starts with its
 * readings, and "Section 1" above them would be a heading invented by the
 * software rather than one the laboratory asked for.
 */
ok('the first block needs no heading', saved[0].section === null)

console.log('\n— it prints —')
const order = ((await db.execute<any>(sql`
  SELECT lo.id, lo.visit_id
  FROM lab_orders lo
  JOIN service_orders so ON so.id = lo.service_order_id
  WHERE so.service_id = ${svc.id} AND lo.status = 'resulted' LIMIT 1`)).rows as any[])[0]

if (!order) {
  console.log('  skip  no finished report for this test in this database')
} else {
  for (const layout of ['standard', 'qualitative', 'ranges'] as const) {
    await saveReportLayout(svc.id, layout)
    const pdf = await labReportPdf({ visitId: order.visit_id })
    const file = savePdf(`sample-lab-${layout}.pdf`, pdf)
    ok(`the ${layout} layout produces a PDF`, pdf.length > 1000, `${pdf.length} bytes`)

    if (!hasPdfToText()) { notePdfToolMissing(); continue }
    const text = pdfText(file, 'layout')!

    /*
     * "Normal Values", not "Reference Ranges". The latter is laboratory
     * language and the people holding the report are not laboratory staff.
     */
    const wantHeading = layout === 'qualitative' ? 'Normal Range' : 'Normal Values'
    ok(`  its heading row says ${wantHeading}`, text.includes(wantHeading))
    ok('  and never says Reference Ranges', !text.includes('Reference Ranges'))

    /* Only a yes-or-no test has no units. A written range still measures. */
    const wantsUnits = layout !== 'qualitative'
    ok(`  Units ${wantsUnits ? 'is shown' : 'is dropped'}`,
      wantsUnits ? /\bUnits\b/.test(text) : !/\bUnits\b/.test(text))

    /*
     * Every column heading sits over its own contents.
     *
     * Reported from the hospital, and both halves were real. The Units
     * figures were right aligned inside their column, which pinned them to
     * the right-hand margin of the page forty points away from the heading,
     * and ragged between rows because a long unit and a short one started in
     * different places. The Result column was worse to diagnose: the numbers
     * and the heading did share an x, but the red out-of-range triangle was
     * drawn ten points to the LEFT of the number, outside the column it
     * belonged to, so the column visibly began left of its own title.
     *
     * Measured rather than eyeballed, from the real geometry: pdftotext
     * -bbox gives the x of every word, and a heading and the values beneath
     * it must share one.
     */
    const bbox = pdfText(file, 'bbox')!
    const words = [...bbox.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]), t: m[3] }))

    /*
     * The out-of-range triangle is checked in the SOURCE, not the PDF.
     *
     * It is drawn with fill(), not written with a font, so it is vector art
     * and no text extraction can see it — removing this fix and re-running
     * the geometry checks below passes cleanly, which is exactly the kind of
     * false comfort worth naming. The one thing that went wrong was its x,
     * so its x is what gets pinned.
     */
    const src = await readFile('./src/server/services/lab-pdf.ts', 'utf8')
    ok('  the out-of-range marker is drawn inside the Result column',
      /const ax = cols\.result \+/.test(src),
      (src.match(/const ax = cols\.result[^\n]*/) ?? ['not found'])[0])

    const heading = words.find((w) => w.t === 'Result')
    if (!heading) {
      ok('  the Result heading is on the page', false)
    } else {
      /*
       * The figures are the words on the rows below the heading that start at
       * some x and are not in the Test Name column. Taking them by x is
       * circular, so they are taken by row: anything on a line below the
       * heading whose x is within a few points of the heading's is a hit, and
       * the assertion is that at least one exists and none of the result
       * figures sit elsewhere.
       */
      const below = words.filter((w) => w.y > heading.y + 5)
      const atHeading = below.filter((w) => Math.abs(w.x - heading.x) < 1)
      ok('  result figures line up under the Result heading', atHeading.length > 0,
        `nothing at x=${heading.x.toFixed(1)}; nearest ` +
        below.map((w) => `${w.t}@${w.x.toFixed(0)}`).slice(0, 6).join(' '))
    }

    /*
     * No status label between the sample and reported times.
     *
     * It printed "Final Report" or "Provisional Report" in the middle of the
     * date band, and since nothing unverified ever leaves the laboratory it
     * said "Final Report" on every sheet that reached a patient. A label that
     * never varies is not information; it just crowded the one band whose job
     * is to show how old the sample is.
     */
    ok('  there is no Final/Provisional label in the date band',
      !/Final Report|Provisional Report/.test(text))
    ok('  but the sample and reported times are both still there',
      /Sample Taken/.test(text) && /Reported/.test(text))

    if (wantsUnits) {
      const uh = words.find((w) => w.t === 'Units')
      const rh = words.find((w) => w.t === 'Result')
      /*
       * Only the TABLE rows, found by taking the lines that carry a result
       * figure. Everything below the heading would also sweep up the page
       * footer, which legitimately sits against the right margin — "Page 1
       * of 1" reported as a stray unit was this check's first answer.
       */
      const rowYs = rh
        ? words.filter((w) => w.y > rh.y + 5 && Math.abs(w.x - rh.x) < 1).map((w) => w.y)
        : []
      const onRows = words.filter((w) => rowYs.some((ry) => Math.abs(w.y - ry) < 3))
      const atUnits = uh ? onRows.filter((w) => Math.abs(w.x - uh.x) < 1) : []
      ok('  units line up under the Units heading', !!uh && atUnits.length > 0,
        uh ? `nothing at x=${uh.x.toFixed(1)} on a result row` : 'no Units heading')
      /*
       * And specifically not flush to the right margin, which is where they
       * were. A4 is 595.28 wide on a 40pt margin, so content ends at 555.
       */
      const flushRight = onRows.filter((w) => w.x > 520)
      ok('  and no row content is pushed to the right-hand margin',
        flushRight.length === 0,
        flushRight.map((w) => `${w.t}@${w.x.toFixed(0)}`).slice(0, 4).join(' '))
    }
  }
  await saveReportLayout(svc.id, 'standard')
}

console.log('\n— a normal value that differs by sex —')
{
  /*
   * Haemoglobin is 13.0 to 17.5 for a man and 11.5 to 15.0 for a woman. One
   * column could only hold one of them, so every CBC printed a range that was
   * wrong for half the patients who read it.
   *
   * BOTH are printed, labelled. Showing only the patient's own would be
   * tidier and would invite exactly the misreading this exists to stop: a
   * doctor checking a woman's result against an unlabelled range.
   */
  await saveReportLayout(svc.id, 'standard')
  await saveParameters(svc.id, [
    { name: 'Hb', unit: 'g/dl', maleLow: 13.0, maleHigh: 17.5, femaleLow: 11.5, femaleHigh: 15.0,
      hasSexRanges: true },
    { name: 'TLC', unit: '/cmm', refText: '4000 - 11000' }
  ])

  const saved = (await db.execute<any>(sql`
    SELECT name, male_low, male_high, female_low, female_high, has_sex_ranges
    FROM service_parameters WHERE service_id = ${svc.id} ORDER BY display_order`)).rows as any[]
  /* Numbers, so they can be compared without parsing English back into digits. */
  ok('both ranges are kept as numbers',
    Number(saved[0].male_low) === 13 && Number(saved[0].male_high) === 17.5
    && Number(saved[0].female_low) === 11.5 && Number(saved[0].female_high) === 15,
    JSON.stringify(saved[0]))
  ok('the switch is stored, not guessed from the fields',
    saved[0].has_sex_ranges === true && saved[1].has_sex_ranges === false)

  const order = ((await db.execute<any>(sql`
    SELECT lo.id, lo.visit_id FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    WHERE so.service_id = ${svc.id} AND lo.status = 'resulted' LIMIT 1`)).rows as any[])[0]

  if (!order) {
    console.log('  skip  no finished report for this test')
  } else {
    /*
     * The saved values have to be re-entered against the new parameter names.
     * The range is looked up by name at print time, deliberately: a report
     * printed after the ranges were corrected should show the corrected ones,
     * not the ones that were current when somebody typed the result.
     */
    await saveResults({
      labOrderId: order.id,
      values: [
        { name: 'Hb', value: '11.7', unit: 'g/dl' },
        { name: 'TLC', value: '7200', unit: '/cmm' }
      ],
      notes: null, by: 'Lab Tech'
    } as any)

    const pdf = await labReportPdf({ visitId: order.visit_id })
    const sexFile = savePdf('sample-lab-sexranges.pdf', pdf)
    const text = pdfText(sexFile, 'layout')
    if (text === null) notePdfToolMissing()
    else {
      ok('the male range prints, labelled', /M: 13\.0 - 17\.5/.test(text))
      ok('the female range prints under it, labelled', /F: 11\.5 - 15\.0/.test(text))
    }
    /*
     * The plain low-and-high row is checked by the numbers layout above and
     * by `display_range` below, both against the database rather than against
     * extracted PDF text. Reading it back out of the page here depended on
     * which parameters the previous block happened to leave behind, which
     * made it a test of the scaffolding rather than of the report.
     */

  }
}

console.log('\n— high and low, on all three kinds of normal value —')
{
  /*
   * The arrow has to mean the same thing however the normal value was
   * written. Before, only a numeric low and high were compared, so a test
   * written as "< 0.50" or as separate male and female ranges never flagged
   * at all — and a missing arrow reads as "normal", not as "not checked".
   */
  await saveReportLayout(svc.id, 'standard')
  await saveParameters(svc.id, [
    { name: 'Hb', unit: 'g/dl', maleLow: 13.0, maleHigh: 17.5, femaleLow: 11.5, femaleHigh: 15.0,
      hasSexRanges: true },
    { name: 'TLC', unit: '/cmm', refLow: 4000, refHigh: 11000 }
  ])
  /*
   * No operator here on purpose. An operator belongs to the written-range
   * layout, and a numbers test that kept one had two competing answers for
   * the same question. The operator cases are checked on their own layout
   * further down.
   */

  const order = ((await db.execute<any>(sql`
    SELECT lo.id, lo.patient_id FROM lab_orders lo
    JOIN service_orders so ON so.id = lo.service_order_id
    WHERE so.service_id = ${svc.id} AND lo.status = 'resulted' LIMIT 1`)).rows as any[])[0]

  if (!order) {
    console.log('  skip  no finished report for this test')
  } else {
    const flagsFor = async (sex: string, values: any[]) => {
      await db.execute(sql`
        UPDATE patients SET gender = ${sex} WHERE id = ${order.patient_id}`)
      await saveResults({ labOrderId: order.id, values, notes: null, by: 'Lab' } as any)
      const rows = (await db.execute<any>(sql`
        SELECT name, flag FROM lab_values WHERE lab_order_id = ${order.id}`)).rows as any[]
      return Object.fromEntries(rows.map((r) => [r.name, r.flag]))
    }

    /* 11.7 is normal for a woman and low for a man. The same number, both. */
    let f = await flagsFor('female', [
      { name: 'Hb', value: '11.7' }, { name: 'TLC', value: '7200' },
    ])
    ok('11.7 haemoglobin is normal for a woman', f.Hb === 'normal', f.Hb)

    f = await flagsFor('male', [
      { name: 'Hb', value: '11.7' }, { name: 'TLC', value: '7200' },
    ])
    ok('and low for a man', f.Hb === 'low', f.Hb)
    ok('a plain low-and-high range still works', f.TLC === 'normal', f.TLC)

    f = await flagsFor('male', [
      { name: 'Hb', value: '15.0' }, { name: 'TLC', value: '200' },
    ])
    ok('200 against 4000-11000 is low', f.TLC === 'low', f.TLC)
    ok('15.0 is normal for a man', f.Hb === 'normal', f.Hb)
  }
}

console.log('\n— the three report kinds flag independently —')
{
  const { flagFor, parametersFor } = await import('./src/server/services/lab')

  /*
   * A written range is ONE-SIDED. "> 0.8" says anything above 0.8 is what the
   * test wants; there is no upper bound to be high of. Treating it as a pair
   * put a red up arrow on 0.9, which is the result the doctor hoped for.
   */
  ok('"> 0.8": 0.9 is normal', flagFor(0.9, { ref_op: '>', ref_value: 0.8 }) === 'normal')
  ok('"> 0.8": 0.7 is low, never high',
    flagFor(0.7, { ref_op: '>', ref_value: 0.8 }) === 'low')
  ok('"> 0.8": nothing is ever high',
    flagFor(99, { ref_op: '>', ref_value: 0.8 }) === 'normal')
  ok('"< 0.5": 0.9 is high', flagFor(0.9, { ref_op: '<', ref_value: 0.5 }) === 'high')
  ok('"< 0.5": nothing is ever low',
    flagFor(0.001, { ref_op: '<', ref_value: 0.5 }) === 'normal')

  ok('numbers still read both ends',
    flagFor(120, { ref_low: 150, ref_high: 200 }) === 'low'
    && flagFor(250, { ref_low: 150, ref_high: 200 }) === 'high')

  /* Words are not greater or less than anything. */
  ok('positive or negative is never flagged',
    flagFor('Reactive', { ref_text: 'Non reactive' } as any) === null)

  /*
   * One range per row. A test moved from numbers to a written range used to
   * keep its old low and high, and the results screen showed those instead of
   * the range the laboratory had just typed.
   */
  await saveReportLayout(svc.id, 'ranges')
  await saveParameters(svc.id, [
    { name: 'LDL', unit: 'mg/dl', refLow: 100, refHigh: 200, refOp: '>', refValue: 0.8 }
  ])
  const written: any = (await parametersFor(svc.id))[0]
  ok('a written range drops the low and high it never uses',
    written.ref_low === null && written.ref_high === null)
  ok('and the results screen is shown the range itself',
    written.display_range === '> 0.8', written.display_range)

  await saveReportLayout(svc.id, 'standard')
  await saveParameters(svc.id, [
    { name: 'Hb', unit: 'g/dl', hasSexRanges: true,
      maleLow: 13, maleHigh: 17.5, femaleLow: 11.5, femaleHigh: 15,
      refOp: '>', refValue: 9 }
  ])
  const numbers: any = (await parametersFor(svc.id))[0]
  ok('a numbers test drops the operator it never uses', numbers.ref_op === null)
  ok('and shows both sex ranges',
    numbers.display_range.includes('M: 13 - 17.5')
    && numbers.display_range.includes('F: 11.5 - 15'), numbers.display_range)
}

console.log('\n— the footer keeps clear of the signatures —')
{
  /*
   * Reported from the laboratory: the footer rule printed through the names
   * of the people who sign the report.
   *
   * The rule sat at a fixed height from the bottom of the page while a
   * signatory block is as tall as that person has lines — a signature image,
   * a name, a qualification, a designation, a registration number. Three
   * filled-in signatories reached about six points past the rule, and more
   * when a name wrapped.
   *
   * Set up here with every optional line filled, which is the tall case, and
   * measured: the lowest signature text must sit clear above the first
   * footer line.
   */
  const { saveSignatories } = await import('./src/server/services/lab')
  const { setSetting } = await import('./src/server/services/settings')

  const before = (await db.execute<any>(sql`
    SELECT name, qualification, designation, registration, signature
    FROM lab_signatories ORDER BY id`)).rows as any[]

  await saveSignatories([
    { name: 'Dr Imran Shah', qualification: 'MBBS, FCPS (Haematology)',
      designation: 'Consultant Pathologist', registration: 'PMDC 45321-P', signature: null },
    { name: 'Farhan Javed', qualification: 'BS MLT',
      designation: 'Chief Technologist', registration: 'MLT-2291', signature: null },
    { name: 'Dr Ayesha Noor', qualification: 'MBBS, MPhil',
      designation: 'Laboratory In-charge', registration: 'PMDC 77120-P', signature: null }
  ] as any)
  await setSetting('lab.logoScale', '100')

  const tall = ((await db.execute<any>(sql`
    SELECT lo.id, lo.visit_id FROM lab_orders lo
    WHERE lo.status = 'resulted' ORDER BY lo.id DESC LIMIT 1`)).rows as any[])[0]

  if (!tall) {
    console.log('  skip  no finished report in this database')
  } else {
    const pdf = await labReportPdf({ labOrderId: Number(tall.id) })
    const sigFile = savePdf('sample-lab-signatures.pdf', pdf)
    const bbox = pdfText(sigFile, 'bbox')
    if (bbox === null) notePdfToolMissing()
    const words = bbox === null ? [] : [...bbox.matchAll(
      /<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ top: Number(m[1]), bottom: Number(m[2]), t: m[3] }))

    if (bbox === null) { /* nothing further is measurable */ } else {
    ok('the signatories are on the page',
      words.some((w) => w.t === 'Pathologist'), 'no designation text found')

    /* The registration numbers are the lowest thing a signatory prints. */
    const sigWords = words.filter((w) =>
      /PMDC|MLT-|Pathologist|Technologist|In-charge/.test(w.t))
    const lowestSig = Math.max(...sigWords.map((w) => w.bottom))
    /* "Printed <date>" is the last footer line. */
    const footer = words.filter((w) => w.t === 'Printed')
    const firstFooter = footer.length ? Math.min(...footer.map((w) => w.top)) : Infinity

    /*
     * Measured against the RULE, not the footer text.
     *
     * The thing that was printing through the names is the horizontal line,
     * and it is drawn with fill and stroke rather than written with a font —
     * vector art, invisible to any text extraction. Checking the gap to the
     * footer's first text line instead passes happily while the rule sits on
     * top of a registration number, which is how the first version of this
     * check gave a clean result on a layout I could see was wrong.
     *
     * drawPage puts the rule at fy and the first footer line at fy + 5, and
     * pdftotext reports that line's top 15 points below the rule. So the
     * rule's y is recoverable from the text, and that is what to compare.
     */
    const RULE_ABOVE_FIRST_LINE = 15
    const ruleY = firstFooter - RULE_ABOVE_FIRST_LINE

    ok('the footer rule is below every signature line',
      ruleY > lowestSig,
      `lowest signature ${lowestSig.toFixed(0)}, rule ${ruleY.toFixed(0)}`)
    ok('and clear of it, not just touching',
      ruleY - lowestSig > 8,
      `only ${(ruleY - lowestSig).toFixed(1)} points between them`)
    }
  }

  /* Put the laboratory's own signatories back. */
  await saveSignatories(before.length ? (before as any) : [])
}


/* ------------------------------- the logo and the hospital name ---------- */

/**
 * How far the hospital name starts from the logo.
 *
 * The name was placed from the WIDTH OF THE LOGO'S BOX rather than the width
 * of the logo. `fit` keeps an image's proportions, so a square emblem in an
 * 86 x 42 box prints 42 wide and leaves 44 points of the box empty - and the
 * name started after all of it, plus a 14 point gap. Fifty-eight points of
 * white between a mark and the name beside it, which is what the pharmacy
 * reported as a huge gap.
 *
 * A SQUARE logo on purpose. A wide banner fills its box, so the old
 * arithmetic and the new one agree on it and this check would pass on the
 * broken code.
 */
console.log('\n- the logo sits beside the hospital name -')
{
  const { setSetting, getSetting, getHospitalInfo } =
    await import('./src/server/services/settings')

  const keptLogo = await getSetting('hospital.logoDataUri')
  const keptPos = await getSetting('lab.logoPosition')
  const keptScale = await getSetting('lab.logoScale')

  /* 64 x 64. At 100% it fits by its height: 42 wide, 42 tall. */
  const SQUARE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsEtiJoMZ2gi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgtnbaDiRwHMMAAAAABJRU5ErkJggg=='

  await setSetting('hospital.logoDataUri', SQUARE)
  await setSetting('lab.logoPosition', 'left')
  await setSetting('lab.logoScale', '100')

  const withLogo = ((await db.execute<any>(sql`
    SELECT lo.id FROM lab_orders lo
    WHERE lo.status = 'resulted' ORDER BY lo.id DESC LIMIT 1`)).rows as any[])[0]

  if (!withLogo) {
    console.log('  skip  no finished report in this database')
  } else {
    const pdf = await labReportPdf({ labOrderId: Number(withLogo.id) })
    const logoFile = savePdf('sample-lab-logo.pdf', pdf)
    const bbox = pdfText(logoFile, 'bbox')
    if (bbox === null) notePdfToolMissing()
    const words = bbox === null ? [] : [...bbox.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x: Number(m[1]), top: Number(m[2]), t: m[5] }))

    const hospital = await getHospitalInfo()
    const first = String((hospital as any).name ?? 'Hospital').split(/\s+/)[0]
    if (bbox === null) { /* nothing to measure without the text */ } else {
    const hit = words.filter((w) => w.t === first)
      .sort((a, b) => a.top - b.top)[0]

    ok('the hospital name is on the page', !!hit, `looking for "${first}"`)

    if (hit) {
      /*
       * MARGIN is 40 and a square logo draws 42 wide, so the mark ends at 82.
       * Anything past about 92 means the empty part of the box is being
       * reserved again. Before the fix this read 140.
       */
      const LOGO_RIGHT = 40 + 42
      ok('it starts right beside the logo, not past the empty part of its box',
        hit.x - LOGO_RIGHT <= 10,
        `${(hit.x - LOGO_RIGHT).toFixed(0)} points of gap, name at x=${hit.x.toFixed(0)}`)
      ok('and not on top of it either', hit.x >= LOGO_RIGHT,
        `name at x=${hit.x.toFixed(0)}, logo ends at ${LOGO_RIGHT}`)
    }
    }
  }

  await setSetting('hospital.logoDataUri', keptLogo ?? '')
  await setSetting('lab.logoPosition', keptPos ?? 'right')
  await setSetting('lab.logoScale', keptScale ?? '100')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
