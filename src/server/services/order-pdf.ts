import PDFDocument from 'pdfkit'
import { getHospitalInfo } from './settings'

/**
 * The purchase order, as a sheet handed to a distributor's rep.
 *
 * This leaves the building, which is the whole reason it looks different from
 * the count sheet. A rep reads it standing at the counter, takes it away, and
 * somebody at the depot picks against it. So it carries the shop's name and
 * the supplier's at the top, the quantity in the largest type on the page,
 * and a pack figure beside each line — the shop orders in units, the depot
 * picks in packs, and the conversion has to be on the paper rather than in
 * somebody's head.
 *
 * The sales figure each quantity was suggested from is printed too. It is the
 * answer to "why are you asking for three hundred", and having it on the page
 * has settled that conversation more than once.
 *
 * Built-in Helvetica means WinAnsi encoding: ASCII and common accented
 * letters only. No true minus sign, no arrows, no typographic dashes — they
 * come out as stray quote marks. The same trap the lab report and the count
 * sheet both fell into.
 */

const MARGIN = 32
const INK = '#000000'
const GREY = '#555555'
const FAINT = '#999999'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const when = (v: any) => v
  ? new Date(v).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  : '-'

/** 19:00 -> "7:00 pm". The rep reads this, not a 24-hour clock. */
export function slotLabel(weekday: number, atTime: string): string {
  const [h, m] = String(atTime).split(':').map(Number)
  const hour12 = ((h ?? 0) % 12) || 12
  const ampm = (h ?? 0) < 12 ? 'am' : 'pm'
  return `${DAYS[weekday] ?? ''} ${hour12}:${String(m ?? 0).padStart(2, '0')} ${ampm}`
}

export async function purchaseOrderPdf(order: any, printedBy: string): Promise<Buffer> {
  const hospital = await getHospitalInfo()
  const items: any[] = order.items ?? []

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2

  /* ------------------------------------------------------------- header */

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
     .text(String(hospital.name ?? 'Hospital').toUpperCase(), MARGIN, MARGIN,
       { width, align: 'center' })
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
     .text('PHARMACY', MARGIN, doc.y + 1, { width, align: 'center' })
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
     .text('PURCHASE ORDER', MARGIN, doc.y + 8, { width, align: 'center' })

  doc.y += 12

  /*
   * Two columns: us on the left, them on the right.
   *
   * A sheet that names only one party is ambiguous the moment it is put down
   * on a desk with three others.
   */
  const top = doc.y
  const half = width / 2

  const pair = (x: number, w: number, rows: [string, string][]) => {
    let y = top
    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
         .text(label, x, y, { width: 72, lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
         .text(value || '-', x + 74, y, { width: w - 74, lineBreak: false, ellipsis: true })
      y += 12
    }
    return y
  }

  const leftEnd = pair(MARGIN, half - 10, [
    ['Order no', String(order.order_no)],
    ['Raised', when(order.created_at)],
    ['By', String(order.created_by ?? '')]
  ])

  const rightEnd = pair(MARGIN + half, half, [
    ['Supplier', String(order.supplier_name ?? '')],
    ['Phone', String(order.supplier_phone ?? '')],
    ['Status', String(order.status ?? 'open').toUpperCase()]
  ])

  doc.y = Math.max(leftEnd, rightEnd) + 2

  if (order.note) {
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
       .text('Note', MARGIN, doc.y, { width: 72, lineBreak: false })
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
       .text(String(order.note), MARGIN + 74, doc.y, { width: width - 74 })
    doc.y += 4
  }

  doc.y += 4
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(1.2).strokeColor(INK).stroke()
  doc.y += 8

  /* -------------------------------------------------------------- table */

  /*
   * Four columns and the quantity. The sales figure and the stock figure are
   * deliberately NOT here.
   *
   * They were, on the reasoning that they justify the quantity — "sold 240 in
   * seven days" is an answer to "why are you asking for this much". But this
   * sheet leaves the building and goes to a distributor, and what the shop
   * holds and what it sells is nobody's business at the depot. The figures
   * are still on the order in the system, where the question actually gets
   * asked.
   */
  const cols = {
    no:    MARGIN + 2,
    name:  MARGIN + 24,
    mfr:   MARGIN + width * 0.42,
    pack:  MARGIN + width * 0.68,
    packs: MARGIN + width * 0.84
  }

  const header = () => {
    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK)
    doc.text('#', cols.no, y, { lineBreak: false })
    doc.text('MEDICINE', cols.name, y, { lineBreak: false })
    doc.text('COMPANY', cols.mfr, y, { lineBreak: false })
    doc.text('PACK', cols.pack, y, { lineBreak: false })
    doc.text('PACKS', cols.packs - 4, y, { width: 56, align: 'right', lineBreak: false })
    doc.y = y + 10
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.y += 3
  }

  header()

  const ROW = 15
  let n = 0
  let totalPacks = 0
  let totalUnits = 0

  for (const it of items) {
    if (doc.y > doc.page.height - MARGIN - 96) {
      doc.addPage()
      doc.y = MARGIN
      header()
    }

    const y = doc.y
    n++
    const packSize = Math.max(1, Number(it.pack_size ?? 1))
    const packs = Number(it.order_packs ?? 0)
    const units = Number(it.order_units ?? packs * packSize)
    totalPacks += packs
    totalUnits += units

    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT)
       .text(String(n), cols.no, y + 3, { lineBreak: false })
    doc.font('Helvetica').fontSize(9).fillColor(INK)
       .text(String(it.product_name ?? ''), cols.name, y + 3,
         { width: width * 0.33, lineBreak: false, ellipsis: true })
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
       .text(String(it.manufacturer ?? ''), cols.mfr, y + 4,
         { width: width * 0.24, lineBreak: false, ellipsis: true })
    doc.text(String(it.pack_label ?? `${packSize}'s`), cols.pack, y + 4,
      { width: 70, lineBreak: false })

    /*
     * The number of packs, in the largest type on the page, with the unit
     * total under it.
     *
     * This is the only figure the depot acts on, and it is now the figure the
     * shop typed rather than one derived from it — the order is placed in
     * packs. The unit line underneath is for the person checking the delivery
     * against the shelf, which is counted in units.
     */
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
       .text(String(packs), cols.packs - 4, y + 1,
         { width: 56, align: 'right', lineBreak: false })
    doc.font('Helvetica').fontSize(6.5).fillColor(FAINT)
       .text(`${units} units`, cols.packs - 4, y + 11,
         { width: 56, align: 'right', lineBreak: false })

    doc.y = y + ROW
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
       .lineWidth(0.3).strokeColor('#DDDDDD').stroke()
  }

  /* -------------------------------------------------------------- total */

  doc.y += 2
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y)
     .lineWidth(1).strokeColor(INK).stroke()
  doc.y += 4
  {
    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
       .text(`${items.length} medicine${items.length === 1 ? '' : 's'}`,
         cols.name, y, { lineBreak: false })
    /*
     * Right-aligned into whatever room is left before the number column,
     * computed rather than fixed. A hardcoded width here ran the label
     * straight into the figure — "TOTAL UNITS5024" — and would do it again
     * the next time a column moves.
     */
    doc.text('TOTAL PACKS', cols.mfr, y,
      { width: (cols.packs - 4) - cols.mfr - 8, align: 'right', lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(11)
       .text(String(totalPacks), cols.packs - 4, y - 2,
         { width: 56, align: 'right', lineBreak: false })
    doc.font('Helvetica').fontSize(6.5).fillColor(FAINT)
       .text(`${totalUnits} units`, cols.packs - 4, y + 11,
         { width: 56, align: 'right', lineBreak: false })
    doc.y = y + 20
  }

  /* --------------------------------------------------------- signatures */

  if (doc.y > doc.page.height - MARGIN - 72) { doc.addPage(); doc.y = MARGIN + 20 }

  const sigY = doc.y + 22
  const third = width / 3
  for (const [i, label] of ['Ordered by', 'Supplier rep', 'Received by'].entries()) {
    const x = MARGIN + i * third
    doc.moveTo(x, sigY).lineTo(x + third - 24, sigY)
       .lineWidth(0.8).strokeColor(INK).stroke()
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
       .text(label, x, sigY + 4, { width: third - 24, lineBreak: false })
    doc.font('Helvetica').fontSize(7).fillColor(FAINT)
       .text('Name and date', x, sigY + 15, { width: third - 24, lineBreak: false })
  }

  /*
   * Who printed it and when, on every copy.
   *
   * The same rule as every other report in the system: a sheet that can be
   * reprinted needs to say which printing you are holding.
   */
  doc.font('Helvetica').fontSize(7).fillColor(FAINT)
     .text(`${order.order_no} · quantities in PACKS · ` +
       `suggested from ${order.window_days} day(s) of sales · ` +
       `printed by ${printedBy} ${when(new Date())}`,
       MARGIN, doc.page.height - MARGIN - 10,
       { width, align: 'center', lineBreak: false })

  doc.end()
  return done
}
