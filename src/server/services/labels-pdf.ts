import PDFDocument from 'pdfkit'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { getHospitalInfo } from './settings'

/**
 * Printed labels.
 *
 * Two sheets, both on plain A4:
 *
 *   - 21 patient stickers, three across and seven down, for sticking on
 *     files, sample bottles and request forms
 *   - ward labels for the bed, the door and a smaller one, three to a page
 *
 * The measurements came in as inches, and as inches they are impossible: three
 * columns of 6.1in is 18.3in across a sheet that is 8.27in wide. Read as
 * centimetres they land almost exactly on A4 — 20.9cm of a 21cm width and
 * 29.5cm of a 29.7cm height — so centimetres is what they are, and that is
 * what is used here.
 *
 * Everything below is laid out in centimetres converted to points at the last
 * moment, so the numbers in this file are the numbers somebody measures off a
 * printed sheet with a ruler.
 */

/** pdfkit works in points. One centimetre is 72/2.54 of them. */
const CM = 72 / 2.54
const cm = (v: number) => v * CM

const A4 = { w: 21.0, h: 29.7 }

/* ----------------------------------------------------------- 21 stickers */

const SHEET = {
  /** Label size. */
  labelW: 6.1,
  labelH: 3.5,
  cols: 3,
  rows: 7,
  /** Space between labels, both directions. */
  gap: 0.5,
  /** Paper margins. */
  marginX: 0.8,
  marginY: 1.0,
  /** How round the corners are. */
  radius: 0.25
}

type Patient = {
  name: string
  mrn: string
  age_years: number | null
  gender: string | null
  address: string | null
  phone: string | null
}

/**
 * A sheet of 21 identical stickers for one patient.
 *
 * `from` lets a part-used sheet be filled: a sheet where the first five have
 * already been peeled off starts at position six rather than wasting the rest.
 */
export async function patientStickers(
  patientId: number, opts: { from?: number; count?: number } = {}
): Promise<Buffer> {
  const p = ((await db.execute<any>(sql`
    SELECT name, mrn, age_years, gender, address, phone
    FROM patients WHERE id = ${patientId}`)).rows as any[])[0] as Patient
  if (!p) throw new Error('No such patient')

  const hospital = await getHospitalInfo()
  const doc = new PDFDocument({ size: 'A4', margin: 0 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))))

  const perSheet = SHEET.cols * SHEET.rows
  const from = Math.min(Math.max(opts.from ?? 1, 1), perSheet)
  const count = Math.min(opts.count ?? perSheet, perSheet)

  let placed = 0
  let slot = from - 1

  while (placed < count) {
    if (slot >= perSheet) { doc.addPage(); slot = 0 }
    const col = slot % SHEET.cols
    const row = Math.floor(slot / SHEET.cols)

    const x = cm(SHEET.marginX + col * (SHEET.labelW + SHEET.gap))
    const y = cm(SHEET.marginY + row * (SHEET.labelH + SHEET.gap))
    drawSticker(doc, x, y, cm(SHEET.labelW), cm(SHEET.labelH), p, hospital)

    slot++; placed++
  }

  doc.end()
  return done
}

function drawSticker(doc: any, x: number, y: number, w: number, h: number,
                     p: Patient, hospital: any) {
  /*
   * A hairline outline, not a heavy border.
   *
   * These are printed on sticker sheets that are already die-cut, so the line
   * is a guide for lining the print up with the cuts. Light enough not to
   * matter if it is a millimetre out.
   */
  doc.save()
  doc.roundedRect(x, y, w, h, cm(SHEET.radius))
     .lineWidth(0.4).strokeColor('#BBBBBB').stroke()

  const pad = cm(0.35)
  const innerW = w - pad * 2

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
     .text((hospital.name || 'Hospital').toUpperCase(), x + pad, y + cm(0.3),
       { width: innerW, align: 'center', lineBreak: false })

  doc.moveTo(x + pad, y + cm(0.78)).lineTo(x + w - pad, y + cm(0.78))
     .lineWidth(0.5).strokeColor('#000000').stroke()

  /*
   * Labels and values on one line each, the label in grey and narrow so the
   * values line up down the sticker. A ward clerk reads the name and the MRN
   * off these at a glance; alignment is most of what makes that possible.
   */
  const lines: [string, string][] = [
    ['Name', p.name],
    ['Age', [p.age_years != null ? `${p.age_years} yrs` : null,
             p.gender ? String(p.gender)[0].toUpperCase() : null]
             .filter(Boolean).join(' / ') || '—'],
    ['MRN', p.mrn],
    ['Address', p.address || '—']
  ]

  let ly = y + cm(0.95)
  for (const [label, value] of lines) {
    doc.font('Helvetica').fontSize(6.5).fillColor('#555555')
       .text(`${label}:`, x + pad, ly, { width: cm(1.1), lineBreak: false })
    doc.font(label === 'Name' ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(label === 'Name' ? 8.5 : 7.5).fillColor('#000000')
       .text(value, x + pad + cm(1.15), ly - (label === 'Name' ? 1.5 : 0.5),
         { width: innerW - cm(1.15), height: cm(0.5), ellipsis: true, lineBreak: false })
    ly += cm(0.56)
  }

  doc.restore()
}

/* --------------------------------------------------------- ward labels */

const WARD = {
  big:   { w: 14.5, h: 7.0 },
  small: { w: 9.5,  h: 4.7 }
}

type WardInfo = {
  patient_name: string
  mrn: string
  age_years: number | null
  gender: string | null
  speciality: string | null
  doctor_name: string | null
  admitted_on: string | null
  diagnosis: string | null
}

/**
 * Bed, door and a smaller card, three to a sheet.
 *
 * The three carry the same fields at different sizes, which is deliberate:
 * the bed label and the door label are read from across a room and the small
 * one goes on a file or a trolley, so the layout is the same and only the
 * scale changes. Somebody reading one already knows where to look on another.
 */
export async function wardLabels(visitId: number, extra: {
  diagnosis?: string | null; admittedOn?: string | null
} = {}): Promise<Buffer> {
  const v = ((await db.execute<any>(sql`
    SELECT p.name AS patient_name, p.mrn, p.age_years, p.gender,
           d.specialisation AS speciality,
           st.display_name AS doctor_name,
           dep.name AS department,
           v.created_at AS admitted_on,
           v.complaint AS diagnosis
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = v.doctor_id
    LEFT JOIN staff st ON st.id = d.staff_id
    LEFT JOIN departments dep ON dep.id = v.department_id
    WHERE v.id = ${visitId}`)).rows as any[])[0]
  if (!v) throw new Error('No such visit')

  const info: WardInfo = {
    ...v,
    // The speciality a ward needs is the department the doctor works in; the
    // doctor's own specialisation is the better answer when it is recorded.
    speciality: v.speciality || v.department || null,
    admitted_on: extra.admittedOn ?? v.admitted_on,
    diagnosis: extra.diagnosis ?? v.diagnosis
  }

  const hospital = await getHospitalInfo()
  const doc = new PDFDocument({ size: 'A4', margin: 0 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))))

  /*
   * Two big labels and one small one, stacked with even space between.
   * 7 + 7 + 4.7 = 18.7cm of label on a 29.7cm sheet, so the remaining 11cm is
   * split into four gaps of 2.2cm — top, between each, and bottom.
   */
  const totalH = WARD.big.h * 2 + WARD.small.h
  const gap = (A4.h - totalH) / 4

  let y = gap
  drawWardLabel(doc, cm((A4.w - WARD.big.w) / 2), cm(y),
    cm(WARD.big.w), cm(WARD.big.h), info, hospital, 'BED', 'big')
  y += WARD.big.h + gap

  drawWardLabel(doc, cm((A4.w - WARD.big.w) / 2), cm(y),
    cm(WARD.big.w), cm(WARD.big.h), info, hospital, 'DOOR', 'big')
  y += WARD.big.h + gap

  drawWardLabel(doc, cm((A4.w - WARD.small.w) / 2), cm(y),
    cm(WARD.small.w), cm(WARD.small.h), info, hospital, 'FILE', 'small')

  doc.end()
  return done
}

function drawWardLabel(doc: any, x: number, y: number, w: number, h: number,
                       v: WardInfo, hospital: any, kind: string,
                       size: 'big' | 'small') {
  const big = size === 'big'
  const pad = cm(big ? 0.6 : 0.45)
  const innerW = w - pad * 2

  doc.save()
  doc.roundedRect(x, y, w, h, cm(0.3))
     .lineWidth(1).strokeColor('#333333').stroke()

  /* The hospital band across the top, so a label is identifiable at a glance. */
  const bandH = cm(big ? 1.15 : 0.85)
  doc.save()
  doc.roundedRect(x, y, w, bandH, cm(0.3)).clip()
  doc.rect(x, y, w, bandH).fill('#EEEEEE')
  doc.restore()

  doc.font('Helvetica-Bold').fontSize(big ? 15 : 11).fillColor('#000000')
     .text((hospital.name || 'Hospital').toUpperCase(), x + pad, y + cm(big ? 0.34 : 0.24),
       { width: innerW, align: 'center', lineBreak: false })

  // Which of the three this is, small and out of the way; it is for whoever
  // is sticking them up, not for whoever reads them afterwards.
  doc.font('Helvetica').fontSize(big ? 7 : 6).fillColor('#888888')
     .text(kind, x + pad, y + cm(big ? 0.38 : 0.26),
       { width: innerW, align: 'right', lineBreak: false })

  const rows: [string, string][] = [
    ['Patient Name', v.patient_name],
    ['Speciality', v.speciality || '—'],
    ['Admission Date', v.admitted_on
      ? new Date(v.admitted_on).toLocaleDateString('en-GB',
          { day: '2-digit', month: 'short', year: 'numeric' })
      : '—'],
    ['Diagnosis', v.diagnosis || '—']
  ]

  const labelW = cm(big ? 3.6 : 2.7)
  let ly = y + bandH + cm(big ? 0.55 : 0.4)
  const step = (h - bandH - cm(big ? 0.9 : 0.6)) / rows.length

  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(big ? 10 : 8).fillColor('#666666')
       .text(`${label}:`, x + pad, ly, { width: labelW, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(big ? 13 : 9.5).fillColor('#000000')
       .text(value, x + pad + labelW, ly - (big ? 2.5 : 1.5),
         { width: innerW - labelW, height: step, ellipsis: true, lineBreak: false })
    ly += step
  }

  /* The MRN bottom right: the one field anybody looking one up will need. */
  doc.font('Helvetica').fontSize(big ? 9 : 7).fillColor('#444444')
     .text(`MRN ${v.mrn}`, x + pad, y + h - cm(big ? 0.7 : 0.5),
       { width: innerW, align: 'right', lineBreak: false })

  doc.restore()
}
