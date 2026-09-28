/**
 * Receipts as ESC/POS bytes, sent straight to the printer.
 *
 * Printing through the browser was the wrong approach and cost several rounds
 * to admit. A browser prints *pages*: it asks Windows for a paper size, and a
 * thermal printer feeds to the end of whatever page its driver is set to. A
 * driver left on 80 x 3276mm fed three metres of blank roll after every
 * receipt, and no amount of CSS could change it, because the page length was
 * never the browser's to choose.
 *
 * ESC/POS has no pages. You send text, the printer prints it, you send a cut
 * command, it cuts. The paper used is exactly the paper printed. That is what
 * a receipt printer is for, and going through a page-based system to reach one
 * was the mistake.
 *
 * These are the commands every ESC/POS printer implements — the XP-80,
 * BlackCopper, Epson TM series and the Chinese clones all take the same
 * bytes.
 */

const ESC = 0x1b
const GS = 0x1d

/** 80mm paper is 48 characters at the standard font, 58mm is 32. */
export const COLUMNS = { '58mm': 32, '80mm': 48 } as const
export type RollWidth = keyof typeof COLUMNS

export class Receipt {
  private parts: Buffer[] = []
  readonly cols: number

  constructor(width: RollWidth = '80mm') {
    this.cols = COLUMNS[width]
    this.raw([ESC, 0x40])            // initialise
    this.raw([ESC, 0x74, 0x10])      // code page 16: Windows-1252, for £ and é
  }

  raw(bytes: number[] | Buffer) {
    this.parts.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    return this
  }

  /**
   * Text, encoded for the printer rather than as UTF-8.
   *
   * A thermal printer has no Unicode. Anything outside its code page comes out
   * as noise, so characters that would be lost are replaced with the nearest
   * plain equivalent — an en dash becomes a hyphen, a rupee sign becomes "Rs".
   * Urdu cannot be printed at all on these and is romanised by the caller.
   */
  text(s: string) {
    const flattened = String(s ?? '')
      .replace(/[–—]/g, '-')
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      .replace(/…/g, '...')
      .replace(/₨|Rs\.?/g, 'Rs')
      .replace(/[^\x20-\x7E\n]/g, '')
    return this.raw(Buffer.from(flattened, 'latin1'))
  }

  line(s = '') { return this.text(s).raw([0x0a]) }

  /** 0 left, 1 centre, 2 right. */
  align(a: 0 | 1 | 2) { return this.raw([ESC, 0x61, a]) }

  bold(on: boolean) { return this.raw([ESC, 0x45, on ? 1 : 0]) }

  /** Doubles height, width, or both. Used for the total and the token. */
  size(w: 0 | 1, h: 0 | 1) { return this.raw([GS, 0x21, (w << 4) | h]) }

  underline(on: boolean) { return this.raw([ESC, 0x2d, on ? 1 : 0]) }

  /** A row with a label on the left and a value hard against the right. */
  pair(left: string, right: string) {
    const l = String(left ?? '')
    const r = String(right ?? '')
    const gap = Math.max(1, this.cols - l.length - r.length)
    return this.line(l + ' '.repeat(gap) + r)
  }

  rule(ch = '-') { return this.line(ch.repeat(this.cols)) }

  /**
   * Text that is too long for the roll, broken on spaces.
   *
   * Without this a long medicine name runs off the edge and the printer wraps
   * it mid-word, which on a 32-column roll makes a mess of every third line.
   */
  wrap(s: string, indent = 0) {
    const width = this.cols - indent
    const words = String(s ?? '').split(/\s+/).filter(Boolean)
    let line = ''
    for (const word of words) {
      if (line && (line + ' ' + word).length > width) {
        this.line(' '.repeat(indent) + line)
        line = word
      } else {
        line = line ? line + ' ' + word : word
      }
    }
    if (line) this.line(' '.repeat(indent) + line)
    return this
  }

  feed(lines = 1) { return this.raw([ESC, 0x64, lines]) }

  /**
   * Cut the paper.
   *
   * Fed on a few lines first because the blade sits about 15mm past the print
   * head: without the feed the cut lands in the middle of the last line.
   */
  cut() { return this.feed(4).raw([GS, 0x56, 0x42, 0x00]) }

  /** Opens a cash drawer wired to the printer, where one is. */
  kickDrawer() { return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]) }

  done() { return Buffer.concat(this.parts) }
}

/* ------------------------------------------------------------- receipts */

const money = (paisa: number | string) =>
  (Number(paisa ?? 0) / 100).toLocaleString('en-PK', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })

const when = (ts: string | null) =>
  ts ? new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).replace(',', '') : ''

function letterhead(r: Receipt, hospital: any, title: string) {
  r.align(1)
  r.bold(true).size(0, 1).line(String(hospital?.name ?? 'Hospital').toUpperCase())
  r.size(0, 0).bold(false)
  if (hospital?.tagline) r.line(hospital.tagline)
  if (hospital?.address) r.wrap(hospital.address)
  const contact = [hospital?.phone, hospital?.email].filter(Boolean).join('  ')
  if (contact) r.line(contact)
  if (hospital?.ntn) r.line(`NTN ${hospital.ntn}`)
  r.rule()
  r.bold(true).line(title.toUpperCase()).bold(false)
  r.rule()
  r.align(0)
}

/**
 * The token, printed big.
 *
 * It is the one number called across a waiting room, so it is double height
 * and double width, centred, where somebody holding the slip can read it from
 * a chair.
 */
function token(r: Receipt, value: number | string | null | undefined) {
  if (value == null || value === '') return
  r.align(1)
  r.line('TOKEN')
  r.bold(true).size(1, 1).line(String(value)).size(0, 0).bold(false)
  r.align(0)
}

export function chitReceipt(input: {
  chit: any; lines: any[]; hospital: any; categoryLabel: string
  width?: RollWidth; feedLines?: number
}): Buffer {
  const { chit, lines, hospital, categoryLabel } = input
  const r = new Receipt(input.width ?? '80mm')

  letterhead(r, hospital, categoryLabel)

  r.align(1).bold(true).line(chit.status === 'paid' ? 'PAID' : 'NOT PAID').bold(false).align(0)
  r.rule()

  token(r, chit.token_no)

  r.bold(true).pair('Chit', chit.chit_no).bold(false)
  r.pair('Date', when(chit.paid_at ?? chit.created_at))
  r.rule('.')

  r.pair('Patient', chit.patient_name ?? '')
  r.pair('MRN', chit.mrn ?? '')
  const age = [chit.age_years != null ? `${chit.age_years}y` : null, chit.gender]
    .filter(Boolean).join(' / ')
  if (age) r.pair('Age/Sex', age)
  if (chit.doctor_name) r.pair('Referred by', chit.doctor_name)
  if (chit.created_by) r.pair('Cashier', chit.created_by)
  r.rule('.')

  for (const l of lines) {
    r.wrap(l.service_name ?? l.name ?? '')
    r.pair('', money(l.price_paisa ?? l.total_paisa ?? 0))
  }

  r.rule()
  r.bold(true).size(0, 1)
  r.pair('TOTAL', 'Rs ' + money(chit.total_paisa))
  r.size(0, 0).bold(false)

  if (chit.status === 'paid') {
    r.pair('Paid', when(chit.paid_at))
    if (chit.pay_method) r.pair('Paid by', chit.pay_method)
    if (chit.paid_by) r.pair('Received by', chit.paid_by)
  }

  r.feed(1).align(1)
  r.bold(true).wrap(`Show this slip at ${categoryLabel}`).bold(false)
  r.wrap('Payment has been received. The department may proceed.')
  r.align(0)

  r.feed(1).rule('.')
  r.line('For department use')
  r.feed(2)
  r.pair('Performed by ______', 'Date ______')

  r.feed(input.feedLines ?? 2)
  r.cut()
  return r.done()
}

export function billReceipt(input: {
  bill: any; items: any[]; hospital: any
  width?: RollWidth; feedLines?: number
}): Buffer {
  const { bill, items, hospital } = input
  const r = new Receipt(input.width ?? '80mm')
  const isConsult = bill.kind === 'consultation'

  letterhead(r, hospital, isConsult ? 'Consultation Fee' : 'Tests and Scans')

  token(r, bill.token_no)

  r.bold(true).pair('Bill', bill.bill_no).bold(false)
  r.pair('Date', when(bill.created_at))
  if (bill.cashier_name) r.pair('Cashier', bill.cashier_name)
  r.rule('.')

  r.pair('Patient', bill.patient_name ?? '')
  r.pair('MRN', bill.mrn ?? '')
  if (bill.doctor_name) r.pair('Doctor', bill.doctor_name)
  r.rule('.')

  for (const it of items) {
    r.wrap(it.description ?? it.service_name ?? '')
    r.pair('', money(it.amount_paisa ?? it.price_paisa ?? 0))
  }

  r.rule()
  if (Number(bill.discount_paisa ?? 0) > 0) {
    r.pair('Subtotal', money(bill.subtotal_paisa))
    r.pair('Discount', '-' + money(bill.discount_paisa))
  }
  r.bold(true).size(0, 1)
  r.pair('TOTAL', 'Rs ' + money(bill.total_paisa))
  r.size(0, 0).bold(false)

  if (bill.pay_method) r.pair('Paid by', bill.pay_method)
  if (Number(bill.tendered_paisa ?? 0) > 0) {
    r.pair('Tendered', money(bill.tendered_paisa))
    r.pair('Change', money(bill.change_paisa))
  }

  r.feed(1).align(1)
  if (hospital?.receiptFooter) r.wrap(hospital.receiptFooter)
  r.align(0)

  r.feed(input.feedLines ?? 2)
  r.cut()
  return r.done()
}

export function saleReceipt(input: {
  sale: any; items: any[]; hospital: any
  width?: RollWidth; feedLines?: number
}): Buffer {
  const { sale, items, hospital } = input
  const r = new Receipt(input.width ?? '80mm')

  letterhead(r, hospital, 'Pharmacy')

  r.bold(true).pair('Invoice', sale.invoice_no ?? sale.invoiceNo ?? '').bold(false)
  r.pair('Date', when(sale.sold_at ?? sale.created_at))
  if (sale.salesman) r.pair('Served by', sale.salesman)
  if (sale.customer_name) r.pair('Customer', sale.customer_name)
  r.rule('.')

  for (const it of items) {
    r.wrap(it.product_name ?? it.name ?? '')
    const qty = `${it.display_qty ?? it.qty} x ${money(it.unit_price_paisa ?? 0)}`
    r.pair('  ' + qty, money(it.line_total_paisa ?? 0))
  }

  r.rule()
  if (Number(sale.discount_paisa ?? 0) > 0) {
    r.pair('Subtotal', money(sale.subtotal_paisa))
    r.pair('Discount', '-' + money(sale.discount_paisa))
  }
  r.bold(true).size(0, 1)
  r.pair('TOTAL', 'Rs ' + money(sale.total_paisa))
  r.size(0, 0).bold(false)

  if (Number(sale.paid_paisa ?? 0) > 0) {
    r.pair('Paid', money(sale.paid_paisa))
    r.pair('Change', money(sale.change_paisa ?? 0))
  }

  r.feed(1).align(1)
  if (hospital?.receiptFooter) r.wrap(hospital.receiptFooter)
  r.align(0)

  r.feed(input.feedLines ?? 2)
  r.cut()
  return r.done()
}

/** A page proving the printer works, used by the Test print button. */
export function testPage(hospital: any, width: RollWidth = '80mm'): Buffer {
  const r = new Receipt(width)
  letterhead(r, hospital, 'Printer Test')
  r.line(`Roll width : ${width}`)
  r.line(`Columns    : ${r.cols}`)
  r.line(`Printed at : ${when(new Date().toISOString())}`)
  r.rule('.')
  r.line('1234567890'.repeat(Math.ceil(r.cols / 10)).slice(0, r.cols))
  r.bold(true).line('Bold text').bold(false)
  r.size(0, 1).line('Double height').size(0, 0)
  r.align(1).line('Centred').align(0)
  r.pair('Left', 'Right')
  r.rule()
  r.align(1).wrap('If this is straight, unclipped and cut cleanly, the printer is set up correctly.')
  r.align(0).feed(2).cut()
  return r.done()
}
