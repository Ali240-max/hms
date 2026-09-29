import PDFDocument from 'pdfkit'
import { getHospitalInfo, getSetting } from './settings'
import { crossMatch } from './cross-match'
import { signatories } from './lab'

/**
 * A cross match report.
 *
 * Laid out as the hospital's existing Word template is, because the people
 * reading it — a ward sister checking a bag against a patient before hanging
 * it — already know where to look. Two blocks, patient then donor, the
 * screening indented beneath, and the conclusion underlined across the page.
 *
 * The conclusion is the line that matters. It is set large and underlined
 * because somebody in a hurry reads that sentence and nothing else, and the
 * whole point of the report is that they can.
 */

const MARGIN = 48
const INK = '#000000'
const GREY = '#555555'

const when = (v: any) => v
  ? new Date(v).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  : '—'

export async function crossMatchPdf(id: number): Promise<Buffer> {
  const r = await crossMatch(id)
  const hospital = await getHospitalInfo()
  const signers = await signatories()
  const logoPosition = (await getSetting('lab.logoPosition')) || 'right'

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2
  const top = MARGIN

  /* ---------------------------------------------------------- letterhead */

  const showLogo = hospital.logoDataUri && logoPosition !== 'none'
  const logoLeft = logoPosition === 'left'
  if (showLogo) {
    try {
      const b64 = String(hospital.logoDataUri).split(',').pop() ?? ''
      doc.image(Buffer.from(b64, 'base64'),
        logoLeft ? MARGIN : MARGIN + width - 86, top, { fit: [82, 40] })
    } catch { /* a bad logo must never stop a report printing */ }
  }

  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK)
     .text(String(hospital.name ?? 'Hospital').toUpperCase(), MARGIN, top + 2,
       { width, align: 'center' })
  doc.font('Helvetica').fontSize(9).fillColor(GREY)
  for (const line of [hospital.address, hospital.phone].filter(Boolean)) {
    doc.text(String(line), MARGIN, doc.y, { width, align: 'center' })
  }

  doc.moveTo(MARGIN, doc.y + 8).lineTo(MARGIN + width, doc.y + 8)
     .lineWidth(1.2).strokeColor(INK).stroke()

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
     .text('CROSS MATCH REPORT', MARGIN, doc.y + 16, { width, align: 'center' })

  /* ------------------------------------------------------ report header */

  let y = doc.y + 14
  doc.font('Helvetica').fontSize(9).fillColor(GREY)
  doc.text(`Report No: ${r.report_no}`, MARGIN, y, { width: width / 2, lineBreak: false })
  doc.text(`Date: ${when(r.created_at)}`, MARGIN + width / 2, y,
    { width: width / 2, align: 'right', lineBreak: false })
  if (r.doctor_name) {
    y += 13
    doc.text(`Ref. By Dr: ${r.doctor_name}`, MARGIN, y, { width, lineBreak: false })
  }

  doc.y = y + 20

  /*
   * A row is a shaded label and a centred value.
   *
   * The values are centred rather than left aligned against the labels
   * because that is how the template reads, and a blood group of one
   * character looks like a stray mark anywhere else on the line.
   */
  const row = (label: string, value: any, opts: { shade?: boolean; big?: boolean } = {}) => {
    const h = opts.big ? 22 : 18
    /*
     * Both halves pinned to one baseline.
     *
     * `doc.text()` moves doc.y down as it draws, so reading doc.y again for
     * the value puts it on the line below its own label — which turns eight
     * tidy rows into sixteen stray lines.
     */
    const y0 = doc.y
    if (opts.shade) doc.rect(MARGIN, y0 - 3, width * 0.62, h).fill('#EDEDED')

    doc.font(opts.big ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(opts.big ? 12 : 11).fillColor(INK)
       .text(label, MARGIN + 4, y0, { width: width * 0.34, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(opts.big ? 13 : 11.5).fillColor(INK)
       .text(String(value ?? '—'), MARGIN + width * 0.34, y0,
         { width: width * 0.4, align: 'center', lineBreak: false })
    doc.y = y0 + h
  }

  /* ------------------------------------------------------------ patient */

  row('Patient Name  :', r.patient_name, { shade: true, big: true })
  row('MRN  :', r.mrn)
  row('Blood Group  :', r.patient_group ? `"${r.patient_group}"` : '—')
  row('RH Factor  :', r.patient_rh)

  doc.y += 8

  /* -------------------------------------------------------------- donor */

  row('Donor Name  :', r.donor_name, { shade: true, big: true })
  row('Age / Sex  :', [
    r.donor_age != null ? `${r.donor_age} YEAR` : null,
    r.donor_sex ? String(r.donor_sex).toUpperCase() : null
  ].filter(Boolean).join(' / ') || '—')
  row('Blood Group  :', r.donor_group ? `"${r.donor_group}"` : '—')
  row('RH Factor  :', r.donor_rh)
  row('HB%  :', r.donor_hb)
  row('Blood Bag no.  :', r.blood_bag_no, { big: true })

  doc.y += 10

  /* ---------------------------------------------------------- screening */

  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK)
     .text("Donor's Screening  :", MARGIN, doc.y, { underline: true, lineBreak: false })
  doc.y += 20

  /*
   * Indented, and set apart from the identity rows above.
   *
   * These five are the infections screened before every transfusion. Reading
   * them as a block is what a ward sister does; mixing them into the donor's
   * details would make her hunt for them.
   */
  const screen = (label: string, value: any, bullet = false) => {
    const y0 = doc.y
    if (bullet) {
      doc.font('Helvetica').fontSize(10).fillColor(INK)
         .text('•', MARGIN + 44, y0, { lineBreak: false })
    }
    doc.font('Helvetica').fontSize(11).fillColor(INK)
       .text(label, MARGIN + 62, y0, { width: width * 0.32, lineBreak: false })
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(':', MARGIN + 62 + width * 0.32, y0, { lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
       .text(String(value ?? '—').toUpperCase(),
         MARGIN + 74 + width * 0.32, y0, { lineBreak: false })
    doc.y = y0 + 17
  }

  screen('HbsAg', r.hbsag)
  screen('Anti HCV', r.anti_hcv)
  screen('HIV', r.hiv)
  screen('SYPHILIS (VDRL)', r.vdrl)
  screen('M.P', r.mp)
  doc.y += 4
  screen('Direct Phase', r.direct_phase, true)
  screen('ALBUMIN PHASE', r.albumin_phase, true)

  /* --------------------------------------------------------- conclusion */

  if (r.conclusion) {
    doc.y += 18
    const incompatible = /NOT COMPATIBLE|INCOMPATIBLE/i.test(r.conclusion)
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK)
       .text(String(r.conclusion).toUpperCase(), MARGIN, doc.y,
         { width, underline: true })

    /*
     * An incompatible result gets a box round it.
     *
     * A compatible report is routine and reads as one line among many. An
     * incompatible one has to stop somebody, and underlining alone does not
     * do that on a page where three other things are underlined.
     */
    if (incompatible) {
      doc.rect(MARGIN - 6, doc.y - 24, width + 12, 30)
         .lineWidth(1.5).strokeColor(INK).stroke()
      doc.y += 8
    }
  }

  if (r.notes) {
    doc.y += 14
    doc.font('Helvetica').fontSize(9.5).fillColor(GREY)
       .text(String(r.notes), MARGIN, doc.y, { width })
  }

  /* --------------------------------------------------------- signatures */

  const sigY = doc.page.height - MARGIN - 86
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
     .text('ELECTRONICALLY VERIFIED REPORT — NO SIGNATURE REQUIRED',
       MARGIN, sigY - 14, { width, align: 'center', lineBreak: false })

  const shown = (signers ?? []).slice(0, 3)
  if (shown.length > 0) {
    const colW = width / shown.length
    shown.forEach((s: any, i: number) => {
      const x = MARGIN + i * colW
      let cy = sigY
      if (s.signature) {
        try {
          const b64 = String(s.signature).split(',').pop() ?? ''
          doc.image(Buffer.from(b64, 'base64'), x, cy, { fit: [colW - 12, 24] })
        } catch { /* a bad image must not stop the report */ }
      }
      cy += 28
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
         .text(String(s.name ?? '').toUpperCase(), x, cy, { width: colW - 10 })
      cy = doc.y
      for (const line of [s.qualification, s.designation, s.registration]) {
        if (!line) continue
        doc.font('Helvetica').fontSize(6.5).fillColor(GREY)
           .text(String(line), x, cy, { width: colW - 10 })
        cy = doc.y
      }
    })
  }

  doc.end()
  return done
}
