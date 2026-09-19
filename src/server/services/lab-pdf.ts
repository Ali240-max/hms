import PDFDocument from 'pdfkit'
import { getHospitalInfo, getSetting } from './settings'
import { reportFor, visitWork } from './lab'

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

const MARGIN = 40
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
  for (const id of orderIds) reports.push(await reportFor(id))

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  reports.forEach((r, i) => {
    if (i > 0) doc.addPage()
    drawPage(doc, width, r, hospital, footer, i + 1, reports.length)
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

function drawPage(doc: any, width: number, r: any, hospital: any,
                  footer: LabFooter, pageNo: number, pageCount: number) {
  const { report, values } = r
  const top = MARGIN

  /* ------------------------------------------------------- letterhead */

  if (hospital.logoDataUri) {
    try {
      const b64 = String(hospital.logoDataUri).split(',').pop() ?? ''
      doc.image(Buffer.from(b64, 'base64'), MARGIN, top, { fit: [110, 42] })
    } catch { /* a bad logo must never stop a report printing */ }
  }

  const textLeft = hospital.logoDataUri ? MARGIN + 124 : MARGIN
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
     .text(hospital.name || 'Hospital', textLeft, top + 2,
       { width: width * 0.56 - (textLeft - MARGIN), lineBreak: false })
  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
  if (hospital.address) doc.text(hospital.address, textLeft, doc.y + 2, { width: width * 0.54 })
  if (hospital.phone) doc.text(hospital.phone, textLeft, doc.y, { width: width * 0.54 })
  let headerBottom = Math.max(doc.y, top + 46)

  // Patient block on the right, as on the report this copies.
  const rx = MARGIN + width * 0.60
  let ry = top
  const idLine = (label: string, value: string, bold = false) => {
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, rx, ry, { width: 74, lineBreak: false })
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK)
       .text(value || '—', rx + 76, ry, { width: width * 0.40 - 76, lineBreak: false })
    ry += 12
  }
  idLine('MRN', report.mrn, true)
  idLine('Name', report.patient_name, true)
  idLine('Age / Gender',
    [report.age_years != null ? `${report.age_years} yr(s)` : null,
     report.gender ? String(report.gender)[0].toUpperCase() : null]
      .filter(Boolean).join(' / '))
  idLine('Ref. By', report.doctor_name ?? 'Self')
  idLine('Report No', report.report_no)
  headerBottom = Math.max(headerBottom, ry)

  doc.y = headerBottom + 6
  rule(doc, width, 1)

  /* --------------------------------------------------- the date band */

  doc.y += 4
  const bandY = doc.y
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
  doc.text(`Visit Date: ${when(report.visit_at)}`, MARGIN, bandY,
    { width: width * 0.36, lineBreak: false })
  doc.font('Helvetica-Bold')
     .text(report.verified_at ? 'Final Report' : 'Provisional Report',
       MARGIN + width * 0.36, bandY, { width: width * 0.28, align: 'center', lineBreak: false })
  doc.font('Helvetica')
     .text(`Report Date: ${when(report.resulted_at)}`,
       MARGIN + width * 0.64, bandY, { width: width * 0.36, align: 'right', lineBreak: false })
  doc.y = bandY + 14
  rule(doc, width, 1)

  /* ------------------------------------------------- column headings */

  const cols = {
    name: MARGIN + 8,
    result: MARGIN + width * 0.42,
    range: MARGIN + width * 0.60,
    unit: MARGIN + width * 0.88
  }
  doc.y += 3
  const hy = doc.y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
  doc.text('Test Name', MARGIN, hy, { lineBreak: false })
  doc.text('Results', cols.result, hy, { lineBreak: false })
  doc.text('Reference Ranges', cols.range, hy, { lineBreak: false })
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
  doc.font('Helvetica').fontSize(6.5).fillColor(GREY)
     .text(shortDate(report.collected_at ?? report.visit_at),
       cols.result, bandTop + 3, { lineBreak: false })
  doc.text(report.report_no, cols.result, bandTop + 10, { lineBreak: false })
  doc.y = bandTop + 24

  /* ------------------------------------------------------- the values */

  for (const v of values as any[]) {
    if (doc.y > doc.page.height - 200) {
      doc.addPage()
      doc.y = MARGIN
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY)
         .text(`${report.service_name} (continued)`, MARGIN, doc.y, { lineBreak: false })
      doc.y += 16
    }
    const y = doc.y
    const abnormal = v.flag === 'low' || v.flag === 'high'

    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(v.name, cols.name, y, { width: width * 0.32, lineBreak: false })

    /*
     * A drawn triangle rather than an arrow character.
     *
     * The built-in Helvetica has no up or down arrow, so printing one emits a
     * substitution glyph — it came out as a stray quote mark. Drawing the
     * shape needs no font at all, and it survives a photocopy, which a colour
     * does not.
     */
    if (abnormal) {
      const ax = cols.result - 10, ay = y + 2.5, s = 4
      doc.save().fillColor(HIGH)
      if (v.flag === 'high') {
        doc.moveTo(ax, ay + s).lineTo(ax + s, ay + s).lineTo(ax + s / 2, ay).fill()
      } else {
        doc.moveTo(ax, ay).lineTo(ax + s, ay).lineTo(ax + s / 2, ay + s).fill()
      }
      doc.restore()
    }
    doc.font(abnormal ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .fillColor(abnormal ? HIGH : INK)
       .text(String(v.value ?? ''), cols.result, y, { width: width * 0.16, lineBreak: false })

    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
       .text(v.ref_text ?? '', cols.range, y, { width: width * 0.26 })
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(GREY)
       .text(v.unit ?? '', cols.unit, y, { width: width * 0.12, align: 'right', lineBreak: false })

    doc.y = Math.max(doc.y, y + 15)
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + width, doc.y - 3)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
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
  const SIG = 62                    // signature lines and their captions
  const bandBottom = doc.page.height - FOOT - SIG - 10

  doc.font('Helvetica').fontSize(7.5)
  const discHeight = doc.heightOfString(footer.disclaimer, { width })
  const noteHeight = report.notes
    ? doc.fontSize(8).heightOfString(report.notes, { width }) + 4 : 0

  // Start high enough that the whole block lands above the signatures.
  let cy = Math.min(doc.y + 6, bandBottom - discHeight - noteHeight - 14)
  cy = Math.max(cy, doc.y + 6)

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
     .text('Comments:', MARGIN, cy, { lineBreak: false })
  cy += 12
  if (report.notes) {
    doc.font('Helvetica').fontSize(8).fillColor(INK)
       .text(report.notes, MARGIN, cy, { width, height: noteHeight })
    cy += noteHeight
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
     .text(footer.disclaimer, MARGIN, cy, { width, height: discHeight })
  doc.y = cy + discHeight

  /* -------------------------------------------------------- signatures */

  const sigY = doc.page.height - FOOT - SIG
  signature(doc, MARGIN, sigY, width * 0.30, report.resulted_by ?? '', 'Performed by')
  if (report.verified_by || footer.inCharge) {
    signature(doc, MARGIN + width * 0.64, sigY, width * 0.36,
      report.verified_by || footer.inCharge,
      report.verified_by ? 'Verified by' : footer.inChargeTitle,
      footer.registrationNo)
  }

  /* ------------------------------------------------------------ footer */

  const fy = doc.page.height - MARGIN - 48
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
