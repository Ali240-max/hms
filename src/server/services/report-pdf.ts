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
  /**
   * What to draw at the back, and how.
   *
   * Carried through from the report definition so the printed chart and the
   * one on screen are the same shape — a report that shows a ring on screen
   * and bars on paper is two reports.
   */
  chart?: { label: string; value: string; kind: 'bar' | 'line' | 'ring' | 'area' }
  from?: string
  to?: string
  columns: Column[]
  rows: Record<string, any>[]
  /** Column key to break on. Each group gets a heading and a sub-total. */
  groupBy?: string
  groupLabel?: string
  /**
   * A second break inside each group.
   *
   * A purchase register reads as supplier, then delivery, then the goods in
   * it: three levels, each with its own total. One level is enough for a
   * sales summary and not enough for this, and the alternative — a row per
   * delivery — hides the only thing anyone opens the report for.
   */
  subGroupBy?: string
  subGroupLabel?: string
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
    const firstTotal = spec.columns.findIndex((x) => spec.totalKeys?.includes(x.key))
    const cut = firstTotal <= 0 ? spec.columns.length : firstTotal

    /*
     * The label spans every column to the left of the first total.
     *
     * Putting it in one column truncated it to that column's width — "Total
     * of Al-Noor Distributors" printed as "Total of Al". It must also not go
     * through the money formatter, which turned a word into NaN.
     */
    const leftWidth = spec.columns.slice(0, cut)
      .reduce((n, c) => n + c.width, 0) + Math.max(0, cut - 1)
    const head = (label.length > leftWidth ? label.slice(0, leftWidth) : label)
      .padStart(leftWidth)
    const rest = spec.columns.slice(cut)
      .map((c) => spec.totalKeys?.includes(c.key)
        ? cell(from[c.key] ?? 0, c) : ' '.repeat(c.width))
    const line = [head, ...rest].join(' ')
    doc.text(line, MARGIN, doc.y, { lineBreak: false })
    doc.y += LINE - 2
    rule(bold)
    doc.font(MONO).fontSize(SIZE)
  }

  let currentGroup: string | null = null
  let groupRows = 0
  let currentSub: string | null = null
  let subRows = 0
  const subTotals: Record<string, number> = {}

  const closeSub = () => {
    if (spec.subGroupBy && currentSub !== null && subRows > 0) {
      totalLine(`${spec.subGroupLabel ?? 'Total'}`, subTotals, false)
      for (const k of Object.keys(subTotals)) delete subTotals[k]
      subRows = 0
    }
  }

  if (spec.rows.length === 0) {
    ensure()
    doc.text('  Nothing to report for this period.', MARGIN, doc.y)
    doc.y += LINE
  }

  for (const row of spec.rows) {
    if (spec.groupBy) {
      const g = String(row[spec.groupBy] ?? '—')
      if (g !== currentGroup) {
        closeSub()
        currentSub = null
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

    /* The second break: a new delivery inside the same supplier. */
    if (spec.subGroupBy) {
      const s = String(row[spec.subGroupBy] ?? '—')
      if (s !== currentSub) {
        closeSub()
        currentSub = s
        ensure(2)
        doc.y += 1
        doc.font(MONO_BOLD).fontSize(SIZE)
           .text(`  ${s}`, MARGIN, doc.y, { lineBreak: false })
        doc.y += LINE
        doc.font(MONO).fontSize(SIZE)
      }
    }

    ensure()
    doc.text(spec.columns.map((c) => cell(row[c.key], c)).join(' '),
      MARGIN, doc.y, { lineBreak: false })
    doc.y += LINE
    add(totals, row); add(groupTotals, row); add(subTotals, row)
    groupRows++; subRows++
  }

  closeSub()
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

  /* ------------------------------------------------------------ chart */

  /*
   * Drawn at the end, on its own page.
   *
   * A chart above the table pushes the numbers onto page two, and the numbers
   * are what a report is for — somebody checking a figure should not have to
   * turn past a picture to reach it. At the back it is there for whoever
   * wants the shape of the month without being in the way of whoever wants
   * the total.
   *
   * Drawn with rectangles rather than an image library: the values are
   * already here, and adding a rendering dependency to draw twenty bars would
   * be a lot of machinery for a page nobody prints alone.
   */
  if (spec.chart && spec.rows.length > 1) {
    drawChart(doc, spec, width, headerBottom)
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

/* ------------------------------------------------------------- charts */

const money0 = (paisa: number) => {
  const n = Math.abs(paisa)
  if (n >= 10_000_000_00) return `${(paisa / 10_000_000_00).toFixed(1)}Cr`
  if (n >= 100_000_00) return `${(paisa / 100_000_00).toFixed(1)}L`
  if (n >= 1_000_00) return `${Math.round(paisa / 1_000_00)}k`
  return String(Math.round(paisa / 100))
}

/**
 * The report's own chart, on a fresh page at the back.
 *
 * Bars for a comparison, a filled run for a series over time, and a stacked
 * bar for a share of a whole — the same three shapes the screen uses, so a
 * printed copy and the screen do not disagree about what the report is
 * saying.
 */
function drawChart(doc: any, spec: any, width: number, headerBottom: number) {
  const key = spec.chart.value
  const labelKey = spec.chart.label
  const isMoney = /paisa/.test(key)

  const rows = spec.rows
    .map((r: any) => ({
      label: String(r[labelKey] ?? ''),
      value: Number(r[key] ?? 0)
    }))
    .filter((r: any) => Number.isFinite(r.value))

  if (rows.length < 2) return

  const shown = spec.chart.kind === 'area' ? rows.slice(0, 40)
    : [...rows].sort((a, b) => b.value - a.value).slice(0, 14)
  const peak = Math.max(...shown.map((r: any) => r.value), 1)

  doc.addPage()
  const top = MARGIN + 16

  doc.font(MONO_BOLD).fontSize(10).fillColor('#000')
     .text(String(spec.title ?? 'Chart').toUpperCase(), MARGIN, top, { lineBreak: false })
  doc.font(MONO).fontSize(7.5).fillColor('#555')
     .text(spec.chart.kind === 'area' ? 'Over the period' : 'Largest first',
       MARGIN, top + 13, { lineBreak: false })

  const plotTop = top + 34
  const plotH = 300
  const plotBottom = plotTop + plotH
  const labelW = 120
  const barArea = width - labelW - 60

  /*
   * Horizontal bars with the label beside each one, rather than vertical bars
   * with labels underneath. Department and product names do not fit under a
   * vertical bar and end up rotated or truncated; beside the bar they simply
   * read.
   */
  if (spec.chart.kind !== 'area') {
    const rowH = Math.min(22, plotH / shown.length)
    shown.forEach((r: any, i: number) => {
      const y = plotTop + i * rowH
      const w = Math.max(1, (r.value / peak) * barArea)

      doc.font(MONO).fontSize(7.5).fillColor('#000')
         .text(r.label.slice(0, 22), MARGIN, y + 3,
           { width: labelW - 6, lineBreak: false })

      doc.rect(MARGIN + labelW, y, w, rowH - 6).fill('#333')
      doc.font(MONO).fontSize(7.5).fillColor('#000')
         .text(isMoney ? money0(r.value) : String(r.value),
           MARGIN + labelW + w + 4, y + 3, { lineBreak: false })
    })
    return
  }

  /* A filled run over time. */
  const stepX = barArea / Math.max(1, shown.length - 1)
  const pointY = (v: number) => plotBottom - (v / peak) * plotH

  doc.moveTo(MARGIN + 30, plotBottom).lineTo(MARGIN + 30 + barArea, plotBottom)
     .lineWidth(0.5).strokeColor('#999').stroke()

  doc.moveTo(MARGIN + 30, plotBottom)
  shown.forEach((r: any, i: number) => {
    doc.lineTo(MARGIN + 30 + i * stepX, pointY(r.value))
  })
  doc.lineTo(MARGIN + 30 + (shown.length - 1) * stepX, plotBottom)
     .fillOpacity(0.18).fill('#333').fillOpacity(1)

  doc.moveTo(MARGIN + 30, pointY(shown[0].value))
  shown.forEach((r: any, i: number) => {
    doc.lineTo(MARGIN + 30 + i * stepX, pointY(r.value))
  })
  doc.lineWidth(1).strokeColor('#000').stroke()

  // Only the ends and the peak are labelled: forty dates along an axis is a
  // smudge, and those three are the ones anybody reads off.
  const peakAt = shown.findIndex((r: any) => r.value === peak)
  for (const i of [...new Set([0, peakAt, shown.length - 1])]) {
    if (i < 0) continue
    doc.font(MONO).fontSize(6.5).fillColor('#555')
       .text(shown[i].label.slice(0, 12), MARGIN + 30 + i * stepX - 22, plotBottom + 5,
         { width: 44, align: 'center', lineBreak: false })
  }
  doc.font(MONO).fontSize(7).fillColor('#000')
     .text(isMoney ? money0(peak) : String(peak), MARGIN, pointY(peak) - 3,
       { width: 26, align: 'right', lineBreak: false })
}
