import PDFDocument from 'pdfkit'
import { getHospitalInfo, getSetting } from './settings'
import {
  reportFor, visitWork, interpretationsFor, signatories, reportNoteFor,
  reportLayoutFor, flagFor
} from './lab'

/**
 * The printed lab report.
 *
 * Laid out after the report a patient here already recognises: logo and
 * hospital block across the top, patient details on the right, a ruled band
 * with Test Name / Results / Reference Ranges, a section heading, and an
 * arrow against anything outside its range.
 *
 * Two decisions worth stating.
 *
 * **One page per test.** A CBC and an LFT get read by different people at
 * different times and are photocopied separately; running them together saves
 * a sheet of paper and costs the patient a legible record.
 *
 * **The technician is named at the foot.** The reports this copies print only
 * "SYSTEM", which tells a doctor ringing about an odd result nothing at all.
 * Whoever ran the test is who the lab needs to ask.
 */

/** Shared, so anything using the letterhead lines up with it. */
export const MARGIN = 40
const INK = '#000000'
const GREY = '#444444'
const RULE = '#000000'
const HIGH = '#C0161C'

export type LabFooter = {
  labName: string
  inCharge: string
  inChargeTitle: string
  registrationNo: string
  contact: string
  note: string
  disclaimer: string
}

export const DEFAULT_FOOTER: LabFooter = {
  labName: 'Clinical Laboratory',
  inCharge: '',
  inChargeTitle: 'Lab In-charge',
  registrationNo: '',
  contact: '',
  note: '',
  disclaimer:
    'Results relate only to the sample received. Please correlate clinically. ' +
    'In case of any unexpected result, contact the laboratory immediately.'
}

export async function getLabFooter(): Promise<LabFooter> {
  const out = { ...DEFAULT_FOOTER }
  for (const key of Object.keys(DEFAULT_FOOTER) as (keyof LabFooter)[]) {
    const v = await getSetting(`lab.${key}`)
    if (v != null && v !== '') out[key] = v
  }
  return out
}

/** Which heading a test sits under, the way a lab report groups them. */
function sectionFor(serviceName: string): string {
  const n = serviceName.toUpperCase()
  if (/CBC|BLOOD COUNT|ESR|HAEMO|HEMO|PLATELET|BLOOD GROUP/.test(n)) return 'Hematology'
  if (/URINE|STOOL/.test(n)) return 'Clinical Pathology'
  if (/DENGUE|TYPHI|HEPATITIS|HIV|WIDAL|SEROLOG|ICT/.test(n)) return 'Serology'
  if (/CULTURE|SENSITIV/.test(n)) return 'Microbiology'
  if (/X-?RAY|ULTRASOUND|SCAN|ECHO|DOPPLER/.test(n)) return 'Radiology'
  return 'Chemistry'
}

/**
 * One report, or every finished report on a visit bound together.
 *
 * Passing a visit prints each test on its own page in one document, which is
 * what a patient who had three tests actually wants to carry away.
 */
export async function labReportPdf(
  input: { labOrderId?: number; visitId?: number }
): Promise<Buffer> {
  const hospital = await getHospitalInfo()
  const footer = await getLabFooter()

  let orderIds: number[] = []
  if (input.labOrderId) {
    orderIds = [input.labOrderId]
  } else if (input.visitId) {
    const work = await visitWork(input.visitId)
    orderIds = work
      .filter((w: any) => w.lab_status === 'resulted' && w.lab_order_id)
      .map((w: any) => Number(w.lab_order_id))
  }
  if (orderIds.length === 0) throw new Error('Nothing to print')

  const reports: any[] = []
  for (const id of orderIds) {
    const r: any = await reportFor(id)
    // What the figures mean, and who signs for them. Read once per report so
    // a test with no interpretation simply prints without that block.
    r.interpretations = await interpretationsFor(r.report.service_id)
    r.note = await reportNoteFor(r.report.service_id)
    // Four columns or three, and whether its rows carry section headings.
    r.layout = await reportLayoutFor(r.report.service_id)
    reports.push(r)
  }

  const signers = await signatories()
  const noteHeading = (await getSetting('lab.noteHeading')) || 'Note'
  const logoPosition = (await getSetting('lab.logoPosition')) || 'right'
  /*
   * How big the logo prints, as a percentage of the default box.
   *
   * A logo is whatever file the hospital happens to have. A wide banner fills
   * the default 86 x 42 box; a tall round emblem fits inside it by its height
   * and prints a third of the size, which is what the laboratory saw. Nobody
   * can compute the right box from the file, so the size is theirs to set
   * against a printed sheet.
   */
  const logoScale = Math.max(40, Math.min(400,
    Number((await getSetting('lab.logoScale')) || '100'))) / 100

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  reports.forEach((r, i) => {
    if (i > 0) doc.addPage()
    drawPage(doc, width, r, hospital, footer, i + 1, reports.length,
      { signers, noteHeading, logoPosition, logoScale })
  })

  // Page numbers can only be written once the total is known.
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
    /*
     * Kept clear of the bottom margin.
     *
     * pdfkit starts a new page as soon as text reaches the margin, even text
     * placed at explicit coordinates — writing the page number flush against
     * it produced a blank final page on every report.
     */
    doc.text(`Page ${i + 1} of ${range.count}`,
      MARGIN, doc.page.height - MARGIN - 20,
      { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false })
  }

  doc.end()
  return done
}

/**
 * The letterhead every laboratory document carries.
 *
 * Exported so the cross match report uses this one rather than a copy of it.
 * Two implementations of a hospital's own letterhead drift, and the one that
 * drifts is always the one nobody looks at — so there is one, and anything
 * that needs a different middle supplies its own `lines` for the identity
 * block on the right.
 *
 * Returns the y the caller should carry on from.
 */
export function drawLetterhead(doc: any, width: number, hospital: any, opts: {
  logoPosition?: string
  logoScale?: number
  /** The identity block, right-hand side. Label, value, and whether it is bold. */
  lines: [string, string, boolean?][]
}): number {
  const top = MARGIN

  /*
   * The mark goes top right by default.
   *
   * Left is where the hospital's own name sits, and the two competed. Right
   * puts it opposite the patient block where a reader's eye lands last, which
   * is where every printed report in the district carries it.
   */
  const showLogo = hospital.logoDataUri && opts.logoPosition !== 'none'
  const logoOnLeft = opts.logoPosition === 'left'

  /* The default box, scaled by the setting. 86 x 42 at 100%. */
  const k = opts.logoScale ?? 1
  const logoW = 86 * k
  const logoH = 42 * k

  if (showLogo) {
    try {
      const b64 = String(hospital.logoDataUri).split(',').pop() ?? ''
      doc.image(Buffer.from(b64, 'base64'),
        logoOnLeft ? MARGIN : MARGIN + width - logoW - 4, top,
        { fit: [logoW, logoH] })
    } catch { /* a bad logo must never stop a report printing */ }
  }

  /*
   * The hospital name starts after the logo, whatever size it has been set
   * to. Fixed at 100 points, a logo scaled up printed straight through the
   * name.
   */
  const textLeft = showLogo && logoOnLeft ? MARGIN + logoW + 14 : MARGIN
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
     .text(hospital.name || 'Hospital', textLeft, top + 2,
       { width: width * 0.56 - (textLeft - MARGIN), lineBreak: false })
  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
  if (hospital.address) doc.text(hospital.address, textLeft, doc.y + 2, { width: width * 0.54 })
  if (hospital.phone) doc.text(hospital.phone, textLeft, doc.y, { width: width * 0.54 })
  /* The header has to clear a scaled-up logo, not just the text. */
  let headerBottom = Math.max(doc.y, top + 46, showLogo ? top + logoH + 4 : 0)

  /*
   * The patient block starts clear of a right-hand logo however big it is.
   * At 0.52 of the width a logo scaled past about 150% printed over it.
   */
  const rx = showLogo && !logoOnLeft
    ? Math.min(MARGIN + width * 0.52, MARGIN + width - logoW - 150)
    : MARGIN + width * 0.60
  let ry = top
  for (const [label, value, bold] of opts.lines) {
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, rx, ry, { width: 74, lineBreak: false })
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK)
       .text(value || '—', rx + 76, ry, { width: width * 0.40 - 76, lineBreak: false })
    ry += 12
  }
  headerBottom = Math.max(headerBottom, ry)

  doc.y = headerBottom + 6
  rule(doc, width, 1)
  return doc.y
}

/**
 * The signature row along the foot of a laboratory document.
 *
 * Exported for the same reason as the letterhead: the people who sign a cross
 * match are the people who sign everything else, and keeping two lists means
 * adding a pathologist in one place and wondering why the other report still
 * names the old one.
 */
/**
 * Returns the y of the lowest thing it drew.
 *
 * The caller needs it to place the footer rule. A signatory block is as tall
 * as the person has lines — a name, a qualification, a designation, a
 * registration number — so its bottom cannot be known in advance, and the
 * footer was drawn at a fixed height that a three-line signatory printed
 * straight through.
 */
export function drawSignatureRow(doc: any, width: number, signers: any[],
                                 y: number): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
     .text('ELECTRONICALLY VERIFIED REPORT — NO SIGNATURE REQUIRED',
       MARGIN, y - 16, { width, align: 'center', lineBreak: false })

  const shown = (signers ?? []).slice(0, 4)
  if (shown.length === 0) return y
  const colW = width / shown.length
  return shown.reduce((lowest: number, s: any, i: number) =>
    Math.max(lowest, drawSignatory(doc, MARGIN + i * colW, y, colW - 8, s)), y)
}

function drawPage(doc: any, width: number, r: any, hospital: any,
                  footer: LabFooter, pageNo: number, pageCount: number,
                  extra: { signers: any[]; noteHeading: string; logoPosition: string;
                           logoScale: number }) {
  const { report, values } = r

  /* The shared letterhead, so this and the cross match report cannot drift. */
  const headerBottom = drawLetterhead(doc, width, hospital, {
    logoPosition: extra.logoPosition,
    logoScale: extra.logoScale,
    lines: [
      ['MRN', report.mrn, true],
      ['Name', report.patient_name, true],
      ['Age / Gender',
        [report.age_years != null ? `${report.age_years} yr(s)` : null,
         report.gender ? String(report.gender)[0].toUpperCase() : null]
          .filter(Boolean).join(' / ')],
      ['Ref. By', report.doctor_name ?? 'Self'],
      ['Report No', report.report_no]
    ]
  })

  /* --------------------------------------------------- the date band */

  doc.y += 4
  const bandY = doc.y
  /*
   * When the sample was taken and when it was reported, not when the patient
   * registered.
   *
   * A doctor reading a result wants to know how old the sample is. The visit
   * date answers a different question — it can be days earlier than the draw,
   * and on a repeat visit it is not even the right day.
   */
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
  doc.text(`Sample Taken: ${when(report.collected_at)}`, MARGIN, bandY,
    { width: width * 0.36, lineBreak: false })
  /*
   * No "Final Report" / "Provisional Report" between the two times.
   *
   * It was meant to warn a reader that a result had not been verified yet,
   * but in practice nothing unverified leaves the laboratory — the report is
   * printed after verification or not at all — so the line said "Final
   * Report" on every sheet that ever reached a patient. A label that is
   * always the same is not information, and it sat in the middle of the one
   * band whose job is to show how old the sample is.
   */
  doc.font('Helvetica')
     .text(`Reported: ${when(report.resulted_at)}`,
       MARGIN + width * 0.64, bandY, { width: width * 0.36, align: 'right', lineBreak: false })
  doc.y = bandY + 14
  rule(doc, width, 1)

  /* ------------------------------------------------- column headings */

  /*
   * Four columns or three, depending on the test.
   *
   * A chemistry panel needs units and a numeric range. A test that answers
   * POSITIVE or NEGATIVE has neither, and printing the two columns empty
   * reads as missing information rather than as columns that do not apply —
   * so that test drops them and gives the range the room instead.
   */
  const layout = r.layout ?? 'standard'
  /*
   * Three columns or four.
   *
   * 'qualitative' answers POSITIVE or NEGATIVE and 'ranges' answers "< 0.50";
   * neither has units or a numeric low and high, and printing those columns
   * empty reads as missing information rather than as columns that do not
   * apply.
   */
  /*
   * Only a yes-or-no test drops the units column.
   *
   * A written range is still a measurement — "< 0.50 mg/dl" means nothing
   * without the mg/dl — so it keeps units and only loses the numeric low and
   * high, which is what it never had.
   */
  const noUnits = layout === 'qualitative'
  const threeCol = noUnits
  const cols = noUnits
    ? { name: MARGIN + 8, result: MARGIN + width * 0.42,
        range: MARGIN + width * 0.66, unit: MARGIN + width * 0.98 }
    : { name: MARGIN + 8, result: MARGIN + width * 0.42,
        range: MARGIN + width * 0.60, unit: MARGIN + width * 0.88 }

  doc.y += 3
  const hy = doc.y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
  doc.text('Test Name', MARGIN, hy, { lineBreak: false })
  doc.text('Result', cols.result, hy, { lineBreak: false })
  // "Normal Values" throughout. "Reference Ranges" is laboratory language;
  // the people holding the report are not laboratory staff.
  doc.text(layout === 'qualitative' ? 'Normal Range' : 'Normal Values', cols.range, hy,
    { lineBreak: false })
  if (!noUnits) doc.text('Units', cols.unit, hy, { lineBreak: false })
  doc.y = hy + 13
  rule(doc, width, 1)

  /* --------------------------------------------------- section band */

  doc.y += 6
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text(sectionFor(report.service_name), MARGIN, doc.y, { lineBreak: false })
  doc.y += 16

  const bandTop = doc.y
  doc.rect(MARGIN, bandTop, width, 18).fill('#E8E8E8')
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
     .text(report.service_name, MARGIN + 6, bandTop + 5, { lineBreak: false })
  /*
   * The date and report number are not repeated beside the test name.
   *
   * Both are already in the letterhead and in the Sample Taken / Reported
   * line above the table. Printed a third time, alongside "CBC", they read as
   * though they belong to that test in particular rather than to the whole
   * report, and they crowd the one row whose job is to name the test.
   */
  doc.y = bandTop + 24

  /* ------------------------------------------------------- the values */

  /*
   * Section headings inside the same table.
   *
   * A glucose tolerance test is three timed blocks — fasting, after one hour,
   * after two — and each needs its own heading above its own rows. The
   * heading is carried by the first parameter of the block, so a test with no
   * sections prints exactly as it always has and nothing had to be filled in
   * for that to remain true.
   */
  let section: string | null = null

  for (const v of values as any[]) {
    if (v.section && v.section !== section) {
      section = v.section
      if (doc.y > doc.page.height - 220) { doc.addPage(); doc.y = MARGIN }
      doc.y += 4
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
         .text(String(v.section), cols.name, doc.y, { lineBreak: false })
      doc.y += 15
    }

    if (doc.y > doc.page.height - 200) {
      doc.addPage()
      doc.y = MARGIN
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY)
         .text(`${report.service_name} (continued)`, MARGIN, doc.y, { lineBreak: false })
      doc.y += 16
    }
    const y = doc.y
    /*
     * Worked out now, from the test as it stands.
     *
     * The stored flag was decided when the result was typed. Correcting a
     * range afterwards left every existing report still showing the old
     * verdict, which is the half of this that nobody notices until a patient
     * brings the paper back.
     */
    const flag = flagFor(v.value, v, r.report?.gender) ?? v.flag
    const abnormal = flag === 'low' || flag === 'high'

    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(v.name, cols.name, y, { width: width * 0.32, lineBreak: false })

    /*
     * The result, with its left edge exactly under the "Result" heading.
     *
     * Drawn first and measured, so the abnormal marker can go AFTER it.
     */
    const shownValue = String(v.value ?? '')
    doc.font(abnormal ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .fillColor(abnormal ? HIGH : INK)
       .text(shownValue, cols.result, y, { width: width * 0.16, lineBreak: false })

    /*
     * A drawn triangle rather than an arrow character.
     *
     * The built-in Helvetica has no up or down arrow, so printing one emits a
     * substitution glyph — it came out as a stray quote mark. Drawing the
     * shape needs no font at all, and it survives a photocopy, which a colour
     * does not.
     *
     * It sits to the RIGHT of the figure. It used to sit ten points to the
     * left, which put it outside the column it belonged to: the leftmost mark
     * in the Result column was then the triangle rather than the number, and
     * the heading above read as ten points too far right. Nothing was
     * actually misaligned — the numbers and the heading share an x — but a
     * column whose contents start left of its own title looks wrong, and
     * looking wrong is the only thing that matters on a report handed to a
     * patient.
     *
     * After the number it reads as what it is: an annotation on that figure.
     */
    if (abnormal) {
      const ax = cols.result + doc.widthOfString(shownValue) + 3
      const ay = y + 2.5, s = 4
      doc.save().fillColor(HIGH)
      if (flag === 'high') {
        doc.moveTo(ax, ay + s).lineTo(ax + s, ay + s).lineTo(ax + s / 2, ay).fill()
      } else {
        doc.moveTo(ax, ay).lineTo(ax + s, ay).lineTo(ax + s / 2, ay + s).fill()
      }
      doc.restore()
    }

    /*
     * A range that differs by sex prints both, one per line.
     *
     *   Hb   11.7   M: 13.0 - 17.5
     *               F: 11.5 - 15.0
     *
     * Both are shown rather than only the patient's own, because a doctor
     * reading a woman's haemoglobin against a male range is the mistake this
     * is meant to prevent, and showing one unlabelled range invites exactly
     * that. Labelled and side by side, there is nothing to misread.
     */
    const rangeW = width * (threeCol ? 0.32 : 0.26)

    /*
     * How far down the page this row reached.
     *
     * A sex range takes two lines, and the row below has to start under the
     * second one. This was tracked with doc.y, which the units column then
     * reset to its own single line — so the next row was drawn on top of the
     * female range. Kept in its own variable, nothing else can move it.
     */
    let rowBottom = y + 15

    /*
     * The normal value is built from the test's current setup.
     *
     * It used to be whatever string was stored beside the result, so
     * correcting a range changed nothing already entered and a reprint of
     * yesterday's report still showed the old one. Read live, a correction
     * reaches every report, which is the whole reason anybody corrects it.
     */
    /*
     * Both ends of a range carry the same number of decimals.
     *
     * A numeric column comes back as 13.0000, and simply trimming the zeros
     * gives "13 - 17.5", which no laboratory writes. Matching the two ends
     * gives "13.0 - 17.5", which is what is on every printed range in the
     * country.
     */
    const span = (lo: any, hi: any) => {
      if (lo == null || hi == null) return null
      const dp = Math.max(decimals(lo), decimals(hi))
      return `${Number(lo).toFixed(dp)} - ${Number(hi).toFixed(dp)}`
    }

    if (v.has_sex_ranges && (v.male_low != null || v.female_low != null)) {
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      let ry = y
      for (const [label, text] of [
        ['M', span(v.male_low, v.male_high)],
        ['F', span(v.female_low, v.female_high)]
      ] as [string, string | null][]) {
        if (!text) continue
        doc.text(`${label}: ${text}`, cols.range, ry, { width: rangeW, lineBreak: false })
        ry += 11
      }
      rowBottom = Math.max(rowBottom, ry + 2)
    } else {
      const shown = v.ref_op && v.ref_value != null
        ? `${v.ref_op} ${num(v.ref_value)}`
        : span(v.p_low, v.p_high) ?? v.p_text ?? v.ref_text ?? ''
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
         .text(shown, cols.range, y, { width: rangeW })
      rowBottom = Math.max(rowBottom, doc.y)
    }
    if (!noUnits) {
      /*
       * Left aligned, under the "Units" heading.
       *
       * These were right aligned inside the column, which pinned every unit
       * to the right-hand margin of the page while the heading stayed at the
       * column's left edge — forty points apart, and ragged between rows
       * because a long unit and a short one started in different places.
       * Right alignment is for figures you compare down a column; a unit is
       * a label, and a label belongs under its heading.
       */
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(GREY)
         .text(v.unit ?? '', cols.unit, y,
           { width: width * 0.12, lineBreak: false })
    }

    doc.y = rowBottom
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + width, doc.y - 3)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
  }

  /* ------------------------------------------------- what the figures mean */

  /*
   * The interpretation table, when the test has one.
   *
   * Printed as plain rows rather than inside the results table: a Vitamin D
   * report has one measured value and four bands, and putting the bands in the
   * results table would suggest four more things were measured.
   */
  if ((r.interpretations ?? []).length > 0) {
    doc.y += 8
    if (doc.y > doc.page.height - 220) { doc.addPage(); doc.y = MARGIN }

    /*
     * No heading above the bands.
     *
     * "Interpretation" over "Normal: 3.80 - 5.80" tells a reader nothing they
     * cannot see, and it competed with the test name higher up the page.
     *
     * The label and its range are set close together rather than in two
     * columns a third of the page apart. Read as a pair — "Good Control
     * 5.5 - 6.8" — they scan in one movement; separated by four centimetres
     * of white the eye has to travel, and on a row with a short label it is
     * easy to read across to the wrong line.
     */
    const labelW = Math.max(...(r.interpretations as any[])
      .map((b: any) => doc.font('Helvetica-Bold').fontSize(8.5)
        .widthOfString(`${b.title}:`))) + 8

    for (const band of r.interpretations as any[]) {
      /*
       * Both halves are pinned to the same baseline.
       *
       * `doc.text()` moves doc.y down as it draws, so reading doc.y again for
       * the second half put the range on the line below its own label — which
       * is how four tidy pairs became eight stray lines.
       */
      const y = doc.y
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
         .text(`${band.title}:`, MARGIN + 8, y, { width: labelW, lineBreak: false })
      doc.font('Helvetica').fontSize(8.5)
         .text(band.range_text ?? '', MARGIN + 8 + labelW, y,
           { width: width - labelW - 8, lineBreak: false })
      doc.y = y + 11
    }
  }

  /* ---------------------------------------------------------- comments */

  /*
   * Everything below here is placed against the bottom of the page, not
   * flowed from where the values happened to end.
   *
   * pdfkit adds a page of its own accord the moment flowing text crosses the
   * bottom margin, and the disclaimer wraps to three lines — so a report with
   * a full panel of values pushed the comments over and produced a second,
   * almost empty page. Measuring the block and pinning it to a fixed band
   * keeps one test on one page, which is the whole point of the layout.
   */
  const FOOT = MARGIN + 34          // the rule and the two footer lines
  /*
   * Room reserved for the signature block, raised from 62.
   *
   * A signatory can carry four lines under their signature image — name,
   * qualification, designation, registration — and 62 points held barely
   * two. The rest printed over the footer rule, which is what the laboratory
   * saw. The footer is placed from the measured bottom now, so this is the
   * reservation that keeps the table from growing into the signatures rather
   * than the thing that prevents the overlap.
   */
  const SIG = 84                    // signature lines and their captions
  const bandBottom = doc.page.height - FOOT - SIG - 10

  doc.font('Helvetica').fontSize(7.5)
  const discHeight = doc.heightOfString(footer.disclaimer, { width })
  const noteHeight = report.notes
    ? doc.fontSize(8).heightOfString(report.notes, { width }) + 4 : 0

  // Start high enough that the whole block lands above the signatures.
  let cy = Math.min(doc.y + 6, bandBottom - discHeight - noteHeight - 14)
  cy = Math.max(cy, doc.y + 6)

  /*
   * The test's own heading and standing note, then whatever the technician
   * typed for this particular report. A test with nothing set falls back to
   * the hospital-wide heading, so a report never loses its comments section.
   */
  const heading = (r.note?.noteHeading || extra.noteHeading || 'Note')
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
     .text(`${heading}:`, MARGIN, cy, { lineBreak: false })
  cy += 12

  if (r.note?.noteText) {
    const h = doc.font('Helvetica').fontSize(8).heightOfString(r.note.noteText, { width })
    doc.fillColor(INK).text(r.note.noteText, MARGIN, cy, { width, height: h })
    cy += h + 3
  }
  if (report.notes) {
    doc.font('Helvetica').fontSize(8).fillColor(INK)
       .text(report.notes, MARGIN, cy, { width, height: noteHeight })
    cy += noteHeight
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
     .text(footer.disclaimer, MARGIN, cy, { width, height: discHeight })
  doc.y = cy + discHeight

  /* -------------------------------------------------------- signatures */

  /*
   * The people who sign, along the foot.
   *
   * Configured once for the hospital, because the same pathologist and
   * technologist sign everything. Where none are configured the report falls
   * back to naming whoever did the work, which is better than a blank line.
   */
  const sigY = doc.page.height - FOOT - SIG - 14
  const signers = (extra.signers ?? []).slice(0, 4)

  /*
   * The line that says a printed signature is not expected.
   *
   * Reports go out the moment they are ready, often before the pathologist is
   * in the building, and a patient handed an unsigned form assumes it is
   * incomplete. This is the standard wording on machine-issued reports in
   * Pakistani laboratories and it saves the counter the argument.
   */
  /* How far down the signatures actually reached. */
  let sigBottom = sigY
  if (signers.length > 0) {
    /* The shared row, so the cross match report signs identically. */
    sigBottom = drawSignatureRow(doc, width, signers, sigY)
  } else {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
       .text('ELECTRONICALLY VERIFIED REPORT — NO SIGNATURE REQUIRED',
         MARGIN, sigY - 16, { width, align: 'center', lineBreak: false })

    signature(doc, MARGIN, sigY + 14, width * 0.30, report.resulted_by ?? '', 'Performed by')
    if (report.collected_by) {
      signature(doc, MARGIN + width * 0.33, sigY + 14, width * 0.28,
        report.collected_by, 'Sample taken by')
    }
    if (report.verified_by || footer.inCharge) {
      signature(doc, MARGIN + width * 0.64, sigY + 14, width * 0.36,
        report.verified_by || footer.inCharge,
        report.verified_by ? 'Verified by' : footer.inChargeTitle,
        footer.registrationNo)
    }
    /* signature() draws its deepest line, the registration number, at +49. */
    sigBottom = sigY + 14 + (footer.registrationNo ? 58 : 49)
  }

  /* ------------------------------------------------------------ footer */

  /*
   * The rule goes below whatever the signatures actually reached.
   *
   * It used to sit at a fixed height, and a signatory with a qualification
   * and a registration number printed through it. Measuring instead of
   * guessing is the only thing that works, because the block is as tall as
   * the person has lines.
   *
   * Floored so a short block does not drag the footer up into the middle of
   * the page, and capped so a very tall one cannot push it off the bottom —
   * in that case the names win and the rule tucks in underneath, since a
   * decoration crossing a pathologist's name is worse than a tight margin.
   */
  const fy = Math.min(
    Math.max(sigBottom + 12, doc.page.height - MARGIN - 44),
    doc.page.height - MARGIN - 22)
  doc.lineWidth(0.6).strokeColor(RULE).moveTo(MARGIN, fy).lineTo(MARGIN + width, fy).stroke()
  doc.font('Helvetica').fontSize(7).fillColor(GREY)
  doc.text([footer.labName, footer.contact, footer.note].filter(Boolean).join('   ·   '),
    MARGIN, fy + 5, { width, align: 'center', lineBreak: false })
  doc.text(`Printed ${when(new Date().toISOString())}` +
    (pageCount > 1 ? `   ·   Test ${pageNo} of ${pageCount}` : ''),
    MARGIN, fy + 15, { width, align: 'center', lineBreak: false })
}

/* ------------------------------------------------------------------ bits */

function rule(doc: any, width: number, w: number) {
  doc.lineWidth(w).strokeColor(RULE)
     .moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).stroke()
}

/**
 * One signatory: scanned signature, then name, then their details.
 *
 * The signature image sits above the name rather than on a ruled line,
 * because that is how a scanned one looks on paper — a line under a scan of a
 * signature reads as two signatures.
 */
/** 13.0 rather than 13.0000, which is how a numeric column comes back. */
function num(v: any) {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : String(v ?? '')
}

/** How many decimals a stored value actually needs, ignoring trailing zeros. */
function decimals(v: any) {
  const s = String(Number(v))
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Returns the y it reached, so the footer can be placed below it. */
function drawSignatory(doc: any, x: number, y: number, w: number, s: any): number {
  let cy = y
  if (s.signature) {
    try {
      const b64 = String(s.signature).split(',').pop() ?? ''
      doc.image(Buffer.from(b64, 'base64'), x, cy, { fit: [w, 26], align: 'left' })
    } catch { /* a bad image must not stop the report */ }
  }
  cy += 30

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
     .text(String(s.name ?? '').toUpperCase(), x, cy, { width: w })
  cy = doc.y

  for (const line of [s.qualification, s.designation, s.registration]) {
    if (!line) continue
    doc.font('Helvetica').fontSize(6.5).fillColor(GREY).text(line, x, cy, { width: w })
    cy = doc.y
  }
  return cy
}

function signature(doc: any, x: number, y: number, width: number,
                   name: string, title: string, sub?: string) {
  doc.lineWidth(0.8).strokeColor(RULE)
     .moveTo(x, y + 24).lineTo(x + width, y + 24).stroke()
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
     .text(name || ' ', x, y + 28, { width, align: 'center', lineBreak: false })
  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
     .text(title, x, y + 39, { width, align: 'center', lineBreak: false })
  if (sub) doc.fontSize(7).text(sub, x, y + 49, { width, align: 'center', lineBreak: false })
}

function when(ts: string | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit' }).replace(',', '')
}

function shortDate(ts: string | null) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: '2-digit' })
}
