import PDFDocument from 'pdfkit'
import { getHospitalInfo } from './settings'
import { audit, adjustment } from './stock-audit'

/**
 * The count sheet, and the record of what was changed afterwards.
 *
 * The count sheet is a working document: somebody carries it round the racks
 * with a pen. That decides nearly every choice here — wide rows, heavy rules,
 * no colour, and boxes big enough to write a number in while standing up.
 */

const MARGIN = 32
const INK = '#000000'
const GREY = '#555555'

const when = (v: any) => v
  ? new Date(v).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  : '—'

function head(doc: any, width: number, hospital: any,
  title: string, lines: [string, string][]) {
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
     .text(String(hospital.name ?? 'Hospital').toUpperCase(), MARGIN, MARGIN,
       { width, align: 'center' })
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
     .text('PHARMACY', MARGIN, doc.y + 1, { width, align: 'center' })

  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
     .text(title, MARGIN, doc.y + 8, { width, align: 'center' })

  doc.y += 10
  const top = doc.y
  let y = top
  for (const [label, value] of lines) {
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, MARGIN, y, { width: 90, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
       .text(value, MARGIN + 92, y, { width: width / 2 - 92, lineBreak: false })
    y += 12
  }

  doc.y = y + 4
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(1.2).strokeColor(INK).stroke()
  doc.y += 8
}

/**
 * The count sheet.
 *
 * Three empty columns, because that is how a stock count is actually done on
 * paper: write what you counted, then the difference as a plus or a minus.
 * Asking for only the counted figure means whoever types it back has to do
 * forty subtractions in their head, and the plus and minus columns are what
 * a supervisor scans down looking for trouble.
 */
export async function auditSheetPdf(auditId: number): Promise<Buffer> {
  const { audit: a, items } = await audit(auditId)
  const hospital = await getHospitalInfo()

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  head(doc, width, hospital, 'STOCK COUNT SHEET', [
    ['Audit no', a.audit_no],
    ['Printed', when(a.created_at)],
    ['By', a.created_by],
    ...(a.scope === 'manufacturer'
      ? [['Company', String(a.scope_ref ?? '')] as [string, string]]
      : a.scope === 'rack'
        ? [['Rack', String(a.scope_ref ?? '')] as [string, string]]
        : []),
    ...(a.title ? [['Note', String(a.title)] as [string, string]] : [])
  ])

  const cols = {
    no: MARGIN + 2,
    name: MARGIN + 26,
    pack: MARGIN + width * 0.46,
    rack: MARGIN + width * 0.56,
    system: MARGIN + width * 0.64,
    counted: MARGIN + width * 0.74,
    plus: MARGIN + width * 0.85,
    minus: MARGIN + width * 0.93
  }

  const header = () => {
    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
    doc.text('#', cols.no, y, { lineBreak: false })
    doc.text('MEDICINE', cols.name, y, { lineBreak: false })
    doc.text('PACK', cols.pack, y, { lineBreak: false })
    doc.text('RACK', cols.rack, y, { lineBreak: false })
    doc.text('SYSTEM', cols.system, y, { width: 42, align: 'right', lineBreak: false })
    doc.text('COUNTED', cols.counted - 4, y, { width: 50, align: 'center', lineBreak: false })
    /*
     * A hyphen, not a true minus sign.
     *
     * U+2212 MINUS SIGN is not in the WinAnsi encoding the built-in Helvetica
     * uses, so pdfkit printed a substitution glyph — it came out as a stray
     * quote mark. The same trap as the up and down arrows on the lab report.
     *
     * Centred over the boxes below rather than right aligned: the heading
     * labels a column of boxes, so it belongs over the middle of them, and
     * right aligning put it against the next column's edge.
     */
    doc.text('+', cols.plus - 2, y, { width: 30, align: 'center', lineBreak: false })
    doc.text('-', cols.minus - 2, y, { width: 30, align: 'center', lineBreak: false })
    doc.y = y + 11
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.y += 3
  }

  header()

  /*
   * Rows tall enough to write in.
   *
   * Eighteen points rather than the twelve a screen table would use. The
   * person filling this in is holding it against a shelf, and a row they
   * cannot fit a number into gets written in the margin instead, which is
   * then mistyped.
   */
  const ROW = 18
  let n = 0

  for (const it of items as any[]) {
    if (doc.y > doc.page.height - MARGIN - 90) {
      doc.addPage()
      doc.y = MARGIN
      header()
    }

    const y = doc.y
    n++

    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(String(n), cols.no, y + 4, { lineBreak: false })
    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(it.product_name, cols.name, y + 4,
         { width: width * 0.40, lineBreak: false, ellipsis: true })
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
       .text(it.pack_label ?? '', cols.pack, y + 5, { width: 46, lineBreak: false })
    doc.text(it.rack_location ?? '', cols.rack, y + 5, { width: 42, lineBreak: false })

    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
       .text(String(it.expected_qty), cols.system, y + 4,
         { width: 42, align: 'right', lineBreak: false })

    /*
     * The three boxes somebody writes in.
     *
     * Drawn as boxes rather than left as empty space, because a ruled line
     * tells a person where to put the number and keeps forty of them in a
     * column that can be read down quickly afterwards.
     */
    doc.lineWidth(0.6).strokeColor('#999999')
    doc.rect(cols.counted - 4, y + 1, 50, ROW - 4).stroke()
    doc.rect(cols.plus - 2, y + 1, 30, ROW - 4).stroke()
    doc.rect(cols.minus - 2, y + 1, 30, ROW - 4).stroke()

    doc.y = y + ROW
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
  }

  /* ------------------------------------------------------- signatures */

  doc.y += 18
  if (doc.y > doc.page.height - MARGIN - 70) { doc.addPage(); doc.y = MARGIN + 20 }

  const sigY = doc.y + 24
  const third = width / 3
  for (const [i, label] of ['Counted by', 'Checked by', 'Approved by'].entries()) {
    const x = MARGIN + i * third
    doc.moveTo(x, sigY).lineTo(x + third - 24, sigY)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, x, sigY + 4, { width: third - 24, lineBreak: false })
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
       .text('Name and date', x, sigY + 15, { width: third - 24, lineBreak: false })
  }

  doc.font('Helvetica').fontSize(7).fillColor(GREY)
     .text(`${a.audit_no} · ${items.length} medicines · printed ${when(new Date())}`,
       MARGIN, doc.page.height - MARGIN - 10, { width, align: 'center', lineBreak: false })

  doc.end()
  return done
}

/**
 * What was actually changed, after the counting.
 *
 * Kept as its own document because it is the one that gets filed: it names a
 * person, a time and every quantity that moved, and it is what somebody
 * produces months later when a figure is questioned.
 */
export async function adjustmentPdf(adjustmentId: number): Promise<Buffer> {
  const { adjustment: adj, items } = await adjustment(adjustmentId)
  const hospital = await getHospitalInfo()

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  head(doc, width, hospital, 'STOCK ADJUSTMENT', [
    ['Adjustment no', adj.adjustment_no],
    ['Against sheet', `${adj.audit_no} (${when(adj.audit_at)})`],
    ['Adjusted', when(adj.created_at)],
    ['By', adj.created_by],
    ...(adj.note ? [['Note', String(adj.note)] as [string, string]] : [])
  ])

  const cols = {
    name: MARGIN + 2,
    mfr: MARGIN + width * 0.36,
    sheet: MARGIN + width * 0.58,
    before: MARGIN + width * 0.70,
    counted: MARGIN + width * 0.82,
    diff: MARGIN + width * 0.92
  }

  const y0 = doc.y
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
  doc.text('MEDICINE', cols.name, y0, { lineBreak: false })
  doc.text('COMPANY', cols.mfr, y0, { lineBreak: false })
  doc.text('ON SHEET', cols.sheet, y0, { width: 44, align: 'right', lineBreak: false })
  doc.text('BEFORE', cols.before, y0, { width: 44, align: 'right', lineBreak: false })
  doc.text('COUNTED', cols.counted, y0, { width: 40, align: 'right', lineBreak: false })
  doc.text('CHANGE', cols.diff, y0, { width: 42, align: 'right', lineBreak: false })
  doc.y = y0 + 11
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(0.8).strokeColor(INK).stroke()
  doc.y += 4

  let added = 0, removed = 0

  for (const it of items as any[]) {
    if (doc.y > doc.page.height - MARGIN - 70) { doc.addPage(); doc.y = MARGIN }
    const y = doc.y
    const d = Number(it.delta_qty)
    if (d > 0) added += d; else removed -= d

    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
       .text(it.product_name, cols.name, y, { width: width * 0.33, lineBreak: false, ellipsis: true })
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
       .text(it.manufacturer ?? '', cols.mfr, y + 1,
         { width: width * 0.20, lineBreak: false, ellipsis: true })
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
       .text(String(it.expected_qty), cols.sheet, y, { width: 44, align: 'right', lineBreak: false })
    doc.fillColor(INK)
       .text(String(it.before_qty), cols.before, y, { width: 44, align: 'right', lineBreak: false })
    doc.font('Helvetica-Bold')
       .text(String(it.counted_qty), cols.counted, y, { width: 40, align: 'right', lineBreak: false })
    /*
     * The change is signed and bold. It is the only number on the page
     * anybody reads first, and a bare "2" that might be plus or minus is
     * worse than no number.
     */
    doc.font('Helvetica-Bold').fontSize(9)
       .text((d > 0 ? '+' : '') + d, cols.diff, y, { width: 42, align: 'right', lineBreak: false })

    doc.y = y + 14
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + width, doc.y - 3)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
  }

  doc.y += 8
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
     .text(`${items.length} medicines changed · ${added} added · ${removed} removed`,
       MARGIN, doc.y, { width, align: 'right' })

  const sigY = doc.page.height - MARGIN - 48
  const half = width / 2
  for (const [i, label] of ['Adjusted by', 'Approved by'].entries()) {
    const x = MARGIN + i * half
    doc.moveTo(x, sigY).lineTo(x + half - 30, sigY)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, x, sigY + 4, { width: half - 30, lineBreak: false })
  }
  doc.font('Helvetica').fontSize(7).fillColor(GREY)
     .text(`${adj.adjustment_no} · against ${adj.audit_no} · ${adj.created_by}`,
       MARGIN, doc.page.height - MARGIN - 10, { width, align: 'center', lineBreak: false })

  doc.end()
  return done
}
