import PDFDocument from 'pdfkit'
import { getHospitalInfo } from './settings'
import { writeOff } from './write-off'

/**
 * The slip that goes in the file when stock comes off the shelf.
 *
 * This is the piece of paper somebody signs. Everything on it is there
 * because of a question that gets asked later:
 *
 *   What went          medicine, batch, expiry, quantity
 *   What it cost       per unit and in total, frozen at the batch
 *   Why                the reason typed against each line
 *   Who said so        the person who made it, and two signature lines
 *   Which slip         the tracking number, repeated in the footer
 *
 * No colour. These get photocopied, faxed to an owner who is out of the
 * country, and photographed on a phone, and a grey that reads well on a
 * screen disappears in all three.
 *
 * NO CHARACTER OUTSIDE WINANSI. The built-in Helvetica cannot print a true
 * minus sign, an en dash, an arrow or an ellipsis, and pdfkit substitutes a
 * stray quote mark for each without warning. Hyphens and full stops only.
 */

const MARGIN = 36
const INK = '#000000'
const GREY = '#555555'
const FAINT = '#999999'

const when = (v: any) => v
  ? new Date(v).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  : ''

const money = (p: any) =>
  (Number(p ?? 0) / 100).toLocaleString('en-PK',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const asDate = (v: any) => v
  ? new Date(v).toLocaleDateString('en-GB',
      { day: '2-digit', month: 'short', year: 'numeric' })
  : ''

export async function writeOffPdf(id: number, printedBy: string): Promise<Buffer> {
  const w: any = await writeOff(id)
  const hospital = await getHospitalInfo()
  const damage = w.kind === 'damage'

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) =>
    doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  /* ------------------------------------------------------------- head */

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
     .text(String(hospital.name ?? 'Hospital').toUpperCase(), MARGIN, MARGIN,
       { width, align: 'center' })
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
     .text('PHARMACY', MARGIN, doc.y + 1, { width, align: 'center' })

  /*
   * The heading says which kind, in words, at the top.
   *
   * A slip that only differs from the other kind by a three-letter prefix on
   * a number is a slip somebody files in the wrong place.
   */
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
     .text(damage ? 'DAMAGED STOCK REMOVED' : 'EXPIRED STOCK REMOVED',
       MARGIN, doc.y + 8, { width, align: 'center' })

  doc.y += 10
  let y = doc.y
  const field = (label: string, value: string, x: number, w2: number) => {
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, x, y, { width: 72, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
       .text(value, x + 74, y, { width: w2 - 74, lineBreak: false })
  }

  const half = width / 2
  field('Reference', String(w.write_off_no), MARGIN, half)
  field('Raised by', String(w.created_by), MARGIN + half, half)
  y += 12
  field('Date', when(w.created_at), MARGIN, half)
  field('Lines', `${w.lines} on ${w.units} units`, MARGIN + half, half)
  y += 12
  if (w.note) { field('Note', String(w.note), MARGIN, width); y += 12 }

  doc.y = y + 4
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(1.2).strokeColor(INK).stroke()
  doc.y += 8

  /* ------------------------------------------------------------ table */

  const cols = {
    no: MARGIN + 2,
    name: MARGIN + 22,
    batch: MARGIN + width * 0.40,
    expiry: MARGIN + width * 0.56,
    qty: MARGIN + width * 0.70,
    rate: MARGIN + width * 0.78,
    value: MARGIN + width * 0.88
  }

  const header = () => {
    const hy = doc.y
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
    doc.text('#', cols.no, hy, { lineBreak: false })
    doc.text('MEDICINE', cols.name, hy, { lineBreak: false })
    doc.text('BATCH', cols.batch, hy, { lineBreak: false })
    doc.text('EXPIRY', cols.expiry, hy, { lineBreak: false })
    doc.text('QTY', cols.qty - 4, hy, { width: 40, align: 'right', lineBreak: false })
    doc.text('RATE', cols.rate - 4, hy, { width: 48, align: 'right', lineBreak: false })
    doc.text('VALUE', cols.value - 4, hy,
      { width: MARGIN + width - cols.value, align: 'right', lineBreak: false })
    doc.y = hy + 11
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.y += 3
  }

  header()

  let n = 0
  for (const it of w.items as any[]) {
    /*
     * Leave room for the totals and both signature blocks, not just the row.
     * A slip whose last line lands at the foot of page one and pushes the
     * signatures onto page two gets signed on the page nobody keeps.
     */
    if (doc.y > doc.page.height - MARGIN - 150) {
      doc.addPage(); doc.y = MARGIN; header()
    }

    const ry = doc.y
    n++

    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(String(n), cols.no, ry + 3, { lineBreak: false })
    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(String(it.product_name), cols.name, ry + 2,
         { width: width * 0.36, lineBreak: false, ellipsis: true })
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(String(it.batch_no ?? ''), cols.batch, ry + 3,
         { width: width * 0.15, lineBreak: false, ellipsis: true })
    doc.text(asDate(it.expiry_date), cols.expiry, ry + 3,
      { width: width * 0.13, lineBreak: false })

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
       .text(String(it.qty), cols.qty - 4, ry + 2,
         { width: 40, align: 'right', lineBreak: false })
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
       .text(money(it.unit_cost_paisa), cols.rate - 4, ry + 3,
         { width: 48, align: 'right', lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
       .text(money(it.value_paisa), cols.value - 4, ry + 3,
         { width: MARGIN + width - cols.value, align: 'right', lineBreak: false })

    let bottom = ry + 15

    /* The reason sits under the medicine it belongs to, not in a column of
     * its own: it is a sentence, and a sentence in a 60-point column is
     * three truncated words. */
    if (it.reason) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(GREY)
         .text(String(it.reason), cols.name, bottom - 2,
           { width: width * 0.60, lineBreak: false, ellipsis: true })
      bottom += 10
    }

    doc.y = bottom
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
    doc.y += 2
  }

  /* ----------------------------------------------------------- totals */

  doc.y += 4
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(1).strokeColor(INK).stroke()
  doc.y += 6

  const ty = doc.y
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
     .text('TOTAL REMOVED', cols.name, ty, { lineBreak: false })
  doc.text(String(w.units), cols.qty - 4, ty,
    { width: 40, align: 'right', lineBreak: false })
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text('Rs ' + money(w.value_paisa), cols.rate - 4, ty - 1,
       { width: MARGIN + width - cols.rate + 4, align: 'right', lineBreak: false })
  doc.y = ty + 16

  doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
     .text(damage
       ? 'Valued at what these batches cost when they were bought. '
         + 'This stock has been taken off the shelf and cannot be sold.'
       : 'Valued at what these batches cost when they were bought. '
         + 'This stock is out of date and has been taken off the shelf.',
       MARGIN, doc.y, { width: width * 0.70 })

  /* ------------------------------------------------------- signatures */

  doc.y += 26
  if (doc.y > doc.page.height - MARGIN - 80) { doc.addPage(); doc.y = MARGIN + 20 }

  /*
   * Two signatures, not one.
   *
   * The person who takes stock off the shelf and the person who agrees it
   * should come off are different people, or the control is not a control.
   */
  const sigY = doc.y + 24
  const half2 = width / 2
  for (const [i, label] of [
    damage ? 'Removed by' : 'Checked by', 'Approved by'
  ].entries()) {
    const x = MARGIN + i * half2
    doc.moveTo(x, sigY).lineTo(x + half2 - 40, sigY)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, x, sigY + 4, { width: half2 - 40, lineBreak: false })
    doc.font('Helvetica').fontSize(7).fillColor(FAINT)
       .text('Name and date', x, sigY + 15, { width: half2 - 40, lineBreak: false })
  }

  doc.font('Helvetica').fontSize(7).fillColor(GREY)
     .text(`${w.write_off_no} . printed ${when(new Date())} by ${printedBy}`,
       MARGIN, doc.page.height - MARGIN - 10,
       { width, align: 'center', lineBreak: false })

  doc.end()
  return done
}
