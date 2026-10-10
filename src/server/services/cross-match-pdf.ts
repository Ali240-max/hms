import PDFDocument from 'pdfkit'
import { getHospitalInfo, getSetting } from './settings'
import { crossMatch } from './cross-match'
import { signatories } from './lab'
import { drawLetterhead, drawSignatureRow, MARGIN } from './lab-pdf'

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

/*
 * The page margin comes from the lab report rather than being set again here.
 *
 * It was 48 in this file and 40 there, so the shared letterhead drew at one
 * inset and everything below it at another — a few millimetres out, which is
 * exactly the kind of thing nobody spots on screen and everybody spots on
 * paper held next to another report.
 */
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
  /* Same letterhead, same logo size. Read here too so the two reports from
   * one laboratory cannot print the mark at different sizes. */
  const logoScale = Math.max(40, Math.min(400,
    Number((await getSetting('lab.logoScale')) || '100'))) / 100

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2
  const top = MARGIN

  /*
   * The same letterhead and identity block as every other laboratory report.
   *
   * This file used to draw its own, which looked close enough and was not: a
   * different font size on the hospital name, the address centred rather than
   * left, no MRN in the corner. A patient handed two reports from the same
   * laboratory on the same day should not be able to tell they came from
   * different code.
   */
  drawLetterhead(doc, width, hospital, {
    logoPosition,
    logoScale,
    lines: [
      ['MRN', r.mrn, true],
      ['Name', r.patient_name, true],
      ['Age / Gender',
        [r.age_years != null ? `${r.age_years} yr(s)` : null,
         r.gender ? String(r.gender)[0].toUpperCase() : null]
          .filter(Boolean).join(' / ')],
      ['Ref. By', r.doctor_name ?? 'Self'],
      ['Report No', r.report_no]
    ]
  })

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
     .text('CROSS MATCH REPORT', MARGIN, doc.y + 10, { width, align: 'center' })

  /*
   * Sample taken on the left, reported on the right, as on every other
   * report from this laboratory.
   *
   * A doctor reading a cross match wants to know how old the sample is, same
   * as for anything else. Printing only the reported time left that
   * unanswerable, and a report that answers a different set of questions from
   * the one beside it is a report somebody has to learn separately.
   */
  const bandY = doc.y + 6
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
     .text(`Sample Taken: ${when(r.sample_taken_at ?? r.created_at)}`, MARGIN, bandY,
       { width: width * 0.4, lineBreak: false })
  doc.font('Helvetica')
     .text(`Reported: ${when(r.created_at)}`, MARGIN + width * 0.6, bandY,
       { width: width * 0.4, align: 'right', lineBreak: false })
  doc.y = bandY + 14

  doc.y += 18

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

  /*
   * The patient's name and MRN are not repeated here.
   *
   * They are in the letterhead, two inches above, where they are on every
   * other report from this laboratory. Printing them twice on one page makes
   * a reader check whether the two agree, which is work for nothing.
   *
   * What does belong here is the blood group, because the whole report is a
   * comparison between this and the donor's.
   */
  row('Patient Blood Group  :', r.patient_group ? `"${r.patient_group}"` : '—',
    { shade: true, big: true })
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
    /*
     * Centred across the page.
     *
     * It was left aligned, which on a page whose every other line starts at
     * the margin made the one sentence that matters look like another label.
     * It is the line a ward sister reads and nothing else, so it sits in the
     * middle where nothing else does.
     */
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK)
       .text(String(r.conclusion).toUpperCase(), MARGIN, doc.y,
         { width, align: 'center', underline: true })

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

  /* The shared row: the people who sign this are the people who sign everything. */
  /*
   * The signature row sits at the foot of the page, unless the content has
   * already reached it.
   *
   * It was drawn at a fixed height from the bottom with no check, so a report
   * carrying four screening lines, a long note and a boxed conclusion ran
   * into it — pdfkit then started a new page mid-draw and the signatures came
   * out somewhere nobody expected, or on top of the conclusion.
   *
   * Asking for the page first when there is not room leaves them where they
   * belong on a page of their own, which is what every other report does.
   */
  const SIG_SPACE = 96
  if (doc.y > doc.page.height - MARGIN - SIG_SPACE) {
    doc.addPage()
  }
  drawSignatureRow(doc, width, signers, doc.page.height - MARGIN - 72)

  doc.end()
  return done
}
