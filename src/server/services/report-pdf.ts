import PDFDocument from 'pdfkit'
import { getHospitalInfo } from './settings'

/**
 * Reports, printed the way the old system printed them.
 *
 * The layout is copied deliberately from a report the hospital has been
 * reading for twenty years: hospital name centred, the report title under it,
 * the date window on its own line, a timestamp top-left and page numbers
 * top-right, then a ruled table with group headings, sub-totals per group and
 * a grand total, and the operator's name at the foot.
 *
 * Courier throughout, because the columns have to line up when this is read
 * next to last month's copy, and because that is what the staff recognise as
 * a report rather than a screenshot.
 *
 * One renderer serves every report. The old system had roughly sixty report
 * programs which were the same page with different columns; making the
 * columns a parameter is the whole difference.
 */

export type Column = {
  key: string
  label: string
  /** Character width. The whole table is laid out in character cells. */
  width: number
  align?: 'left' | 'right'
  /** Divide by 100 and print with thousands separators. */
  money?: boolean
}

export type ReportSpec = {
  title: string
  subtitle?: string
  from?: string
  to?: string
  columns: Column[]
  rows: Record<string, any>[]
  /** Column key to break on. Each group gets a heading and a sub-total. */
  groupBy?: string
  groupLabel?: string
  /** Column keys to add up, per group and overall. */
  totalKeys?: string[]
  user: string
  /** Extra lines under the grand total, e.g. a margin percentage. */
  notes?: string[]
  landscape?: boolean
}

const MONO = 'Courier'
const MONO_BOLD = 'Courier-Bold'
const SIZE = 8.5
const CHAR = SIZE * 0.6          // Courier advance width at this size
const LINE = 12
const MARGIN = 28

const money = (v: any) => {
  const n = Number(v ?? 0) / 100
  return n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function cell(v: any, col: Column): string {
  let s = col.money ? money(v) : String(v ?? '')
  if (s.length > col.width) s = s.slice(0, col.width - 1) + '.'
  return col.align === 'right' || col.money
    ? s.padStart(col.width)
    : s.padEnd(col.width)
}

export async function reportPdf(spec: ReportSpec): Promise<Buffer> {
  const hospital = await getHospitalInfo()
  const doc = new PDFDocument({
    size: 'A4', layout: spec.landscape ? 'landscape' : 'portrait',
    margin: MARGIN, bufferPages: true
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))))

  const width = doc.page.width - MARGIN * 2
  const bottom = doc.page.height - MARGIN - 34
  const stamp = new Date().toLocaleString('en-GB',
    { day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit' })

  /** Headings are text even in a money column, so they never go through cell(). */
  const head = (c: Column) => {
    const s = c.label.length > c.width ? c.label.slice(0, c.width) : c.label
    return c.align === 'right' || c.money ? s.padStart(c.width) : s.padEnd(c.width)
  }
  const header = spec.columns.map(head).join(' ')
  const ruleWidth = Math.min(header.length * CHAR, width)

  function rule(bold = false) {
    doc.lineWidth(bold ? 1 : 0.5).strokeColor('#000')
       .moveTo(MARGIN, doc.y).lineTo(MARGIN + ruleWidth, doc.y).stroke()
    doc.y += 3
  }

  function pageHead() {
    doc.font(MONO_BOLD).fontSize(13).fillColor('#000')
       .text(hospital.name || 'Hospital', MARGIN, MARGIN, { width, align: 'center' })
    doc.font(MONO).fontSize(11).text(spec.title, { width, align: 'center' })
    if (spec.from && spec.to) {
      doc.fontSize(10).text(`From  # ${fmt(spec.from)}   To   # ${fmt(spec.to)}`,
        { width, align: 'center' })
    }
    if (spec.subtitle) doc.fontSize(9).text(spec.subtitle, { width, align: 'center' })

    const y = doc.y + 4
    headerBottom = y
    doc.font(MONO).fontSize(7.5)
    doc.text(stamp, MARGIN, y, { width: width / 2, lineBreak: false })
    doc.y = y + 12

    rule()
    doc.font(MONO_BOLD).fontSize(SIZE).text(header, MARGIN, doc.y, { lineBreak: false })
    doc.y += LINE - 2
    rule()
    doc.font(MONO).fontSize(SIZE)
  }

  function ensure(lines = 1) {
    if (doc.y + LINE * lines > bottom) { doc.addPage(); pageHead() }
  }

  let headerBottom = MARGIN + 44
  pageHead()

  /* ------------------------------------------------------------- body */

  const totals: Record<string, number> = {}
  const groupTotals: Record<string, number> = {}
  const add = (into: Record<string, number>, row: any) => {
    for (const k of spec.totalKeys ?? []) into[k] = (into[k] ?? 0) + Number(row[k] ?? 0)
  }

  function totalLine(label: string, from: Record<string, number>, bold: boolean) {
    ensure(2)
    doc.y += 1
    rule()
    doc.font(bold ? MONO_BOLD : MONO).fontSize(SIZE)
    const line = spec.columns.map((c, i) => {
      if (spec.totalKeys?.includes(c.key)) return cell(from[c.key] ?? 0, c)
      // The label sits in the last column before the first total.
      const firstTotal = spec.columns.findIndex((x) => spec.totalKeys?.includes(x.key))
      if (i === Math.max(0, firstTotal - 1)) return cell(label, { ...c, align: 'right' })
      return ' '.repeat(c.width)
    }).join(' ')
    doc.text(line, MARGIN, doc.y, { lineBreak: false })
    doc.y += LINE - 2
    rule(bold)
    doc.font(MONO).fontSize(SIZE)
  }

  let currentGroup: string | null = null
  let groupRows = 0

  if (spec.rows.length === 0) {
    ensure()
    doc.text('  Nothing to report for this period.', MARGIN, doc.y)
    doc.y += LINE
  }

  for (const row of spec.rows) {
    if (spec.groupBy) {
      const g = String(row[spec.groupBy] ?? '—')
      if (g !== currentGroup) {
        if (currentGroup !== null && groupRows > 0) {
          totalLine(`Total of ${currentGroup}`, groupTotals, false)
        }
        for (const k of Object.keys(groupTotals)) delete groupTotals[k]
        groupRows = 0
        currentGroup = g
        ensure(2)
        doc.y += 2
        doc.font(MONO_BOLD).fontSize(SIZE)
           .text(`${spec.groupLabel ?? 'Group'} #   ${g}`, MARGIN, doc.y, { lineBreak: false })
        doc.y += LINE
        doc.font(MONO).fontSize(SIZE)
      }
    }

    ensure()
    doc.text(spec.columns.map((c) => cell(row[c.key], c)).join(' '),
      MARGIN, doc.y, { lineBreak: false })
    doc.y += LINE
    add(totals, row); add(groupTotals, row); groupRows++
  }

  if (spec.groupBy && currentGroup !== null && groupRows > 0) {
    totalLine(`Total of ${currentGroup}`, groupTotals, false)
  }
  if (spec.totalKeys?.length) totalLine('Grand Total', totals, true)

  if (spec.notes?.length) {
    doc.y += 4
    doc.font(MONO).fontSize(8)
    for (const n of spec.notes) {
      ensure(); doc.text(n, MARGIN, doc.y, { lineBreak: false }); doc.y += LINE
    }
  }

  /* ----------------------------------------------------------- footer */

  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    // "Page 1 of 3" can only be written once the total is known.
    doc.font(MONO).fontSize(7.5).fillColor('#000')
    doc.text(`Page      ${i + 1} of ${range.count}`, MARGIN, headerBottom,
      { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false })
    doc.text(`User  #  ${spec.user}`, MARGIN, doc.page.height - MARGIN - 14,
      { width: doc.page.width - MARGIN * 2 })
  }

  doc.end()
  return done
}

function fmt(d: string) {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}
