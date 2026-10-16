import {
  salesSummary, salesBy, invoiceRegister, purchaseSummary, purchaseBy,
  stockStatement, zeroSaleStock, profitByManufacturer, discountMonitor, type Window
} from './pharma-reports'
import { priceHistory, outstanding } from './pharma'
import {
  adjustments as rawAdjustments, adjustmentHistory as rawAdjustmentDetail,
  adjustmentsByCompany as rawAdjustmentsByCompany
} from './stock-audit'
import { purchaseDetail, purchaseRegister } from './pharma-reports'
import {
  writeOffRegister, writeOffItems, writeOffsByProduct, writeOffSummary
} from './write-off'
import { reportReturns as rawReturns } from './returns'
import { listOrders as rawOrders } from './ordering'
import {
  labRegister, labBy, labSummary, labOutstanding, labTurnaround, labAbnormal,
  counterSummary, counterBy, counterRegister, patientRegister, unpaidChits,
  doctorEarnings, doctorEarningDetail, doctorEarningSummary, doctorChoices,
  cashierChoices, payMethodChoices,
  hospitalIncome, hospitalDaily,
  goodsReceivedDetail, goodsReceivedSummary,
  salesByDepartment, patientsByDepartment
} from './hospital-reports'
import type { Column } from './report-pdf'
import { creditBillReport, creditBillStats } from './credit-bills'
import {
  departmentBillLines, departmentBillRegister, departmentBillStats, departmentChoices
} from './department-bills'

/**
 * Every report, defined once.
 *
 * The screen reads this to build its table and its chart; the PDF reads the
 * same definition to lay out its columns. Keeping them together is what stops
 * the printed copy drifting away from what was on screen — the failure that
 * made the old system's sixty report programs a maintenance problem.
 */

export type ReportDef = {
  id: string
  group: 'Sales' | 'Purchase' | 'Stock' | 'Profit' | 'Money'
       | 'Laboratory' | 'Radiology' | 'Counter' | 'Hospital'
  /**
   * Which module this belongs to.
   *
   * Decides who sees it: the lab sees Laboratory, the counter sees Counter,
   * and the reports desk sees everything. A report is never hidden from the
   * people whose work it describes.
   */
  module: 'pharmacy' | 'laboratory' | 'radiology' | 'counter' | 'hospital'
  title: string
  /** What the report answers, shown under the heading on screen. */
  blurb: string
  /** Which permission gates it. */
  permission: string
  columns: Column[]
  /** Column to plot, and the column to label bars with. */
  /**
   * How to draw it.
   *
   * `bar` compares sizes, `ring` shows shares of a whole, `area` shows a run
   * over time. Picking per report rather than drawing bars for everything:
   * a department split is a question about proportion, and a month of daily
   * takings is a question about shape.
   */
  chart?: { label: string; value: string; kind: 'bar' | 'line' | 'ring' | 'area' }
  totalKeys?: string[]
  groupBy?: string
  groupLabel?: string
  /** A second break inside each group — supplier, then delivery, then goods. */
  subGroupBy?: string
  subGroupLabel?: string
  /** Needs a date window. Stock reports are a snapshot and do not. */
  dated: boolean
  /**
   * Dropdowns the screen shows above the table, beside the dates.
   *
   * The chosen value arrives in `q` under `key`, so a report reads it the
   * same way whether it was run on screen or printed. `options` is a
   * function rather than a list because the choices are rows in the
   * database — the doctors a hospital employs change, and a list baked into
   * the catalogue would go stale the first time somebody is hired.
   *
   * An empty value always means "no filter", and `allLabel` is what that
   * choice is called. Spelling it per report matters: "All doctors" and
   * "Every company" are the same option and read as different questions.
   */
  filters?: {
    key: string
    label: string
    allLabel: string
    options: () => Promise<{ value: string; label: string }[]>
  }[]
  landscape?: boolean
  /**
   * A free-text box beside the dropdowns, arriving in `q` under `key` like
   * a filter. For finding one bill by its number without scrolling.
   */
  search?: { key: string; label: string; placeholder?: string }
  run: (w: Window, q: Record<string, string>) => Promise<any[]>
  /** Optional headline figures shown above the table. */
  stats?: (w: Window, q: Record<string, string>) => Promise<Record<string, any>>
}

const money = (key: string, label: string, width = 14): Column =>
  ({ key, label, width, money: true })
const num = (key: string, label: string, width = 8): Column =>
  ({ key, label, width, align: 'right' })
const text = (key: string, label: string, width = 28): Column =>
  ({ key, label, width })

export const REPORTS: ReportDef[] = [
  /* ------------------------------------------------------------ sales */
  /* ------------------------------------------- audits and adjustments */

  /*
   * Printed the same way as every other report, through the same catalogue.
   *
   * These could have been bespoke pages with their own print buttons, and
   * then they would have their own date pickers, their own PDF layout and
   * their own idea of what a total is. Going through the catalogue means
   * they look like the rest of the system and are covered by the per-login
   * report access that already exists.
   */
  {
    id: 'adjustments-list', group: 'Stock', module: 'pharmacy',
    title: 'Stock Adjustments',
    blurb: 'Every adjustment in the period, with who made it and against which count sheet.',
    permission: 'report.stock', dated: true,
    columns: [text('adjustment_no', 'Adjustment', 17), text('audit_no', 'Count sheet', 17),
      text('when', 'When', 17), text('created_by', 'By', 16),
      num('lines', 'Lines', 7), num('added', 'Added', 7), num('removed', 'Removed', 9)],
    totalKeys: ['lines', 'added', 'removed'],
    run: (w) => adjustmentsReport(w)
  },
  {
    id: 'adjustments-detail', group: 'Stock', module: 'pharmacy',
    title: 'Stock Adjustment Detail',
    /*
     * One row per instance, never a net figure. Panadol adjusted five times
     * is five rows: a single "net -12" hides the pattern that makes somebody
     * look twice, which is the only reason this report exists.
     */
    blurb: 'One row for every medicine every time it was adjusted, with the quantities before and after.',
    /*
     * Landscape because eight columns carrying two names, a clock and four
     * quantities come to 115 character cells, and portrait holds 105. The
     * overflow falls off the right-hand edge, which took the name of the
     * person who made the adjustment with it — the one column on this report
     * that nobody can do without.
     */
    permission: 'report.stock', dated: true, landscape: true,
    columns: [text('product_name', 'Medicine', 22), text('manufacturer', 'Company', 14),
      text('when', 'When', 17), text('adjustment_no', 'Adjustment', 17),
      num('expected_qty', 'On sheet', 9),
      num('before_qty', 'Before', 8), num('counted_qty', 'Counted', 8),
      num('delta_qty', 'Change', 7),
      /*
       * What the correction was worth, split into two columns.
       *
       * "Panadol plus 105" is a quantity; the question that always follows is
       * how much money that is. Each row fills exactly one of these — a row
       * never both gains and loses — and the other prints blank rather than
       * 0.00, because a column of zeroes reads as real figures and hides the
       * one that matters.
       */
      money('added_paisa', 'Added', 12), money('removed_paisa', 'Removed', 12),
      text('created_by', 'By', 14)],
    totalKeys: ['delta_qty', 'added_paisa', 'removed_paisa'],
    run: (w) => adjustmentDetailReport(w),
    stats: (w) => adjustmentValueSummary(w)
  },
  {
    id: 'adjustments-company', group: 'Stock', module: 'pharmacy',
    title: 'Stock Adjustments by Company',
    blurb: 'Which companies\u2019 stock keeps coming up short.',
    permission: 'report.stock', dated: true,
    columns: [text('manufacturer', 'Company', 28), num('products', 'Medicines', 10),
      num('lines', 'Times', 8), num('added', 'Added', 8),
      num('removed', 'Removed', 9), num('net', 'Net', 8)],
    chart: { label: 'manufacturer', value: 'removed', kind: 'bar' },
    totalKeys: ['products', 'lines', 'added', 'removed', 'net'],
    run: (w) => adjustmentsByCompany(w)
  },

  /* ------------------------------------------- damage and expiry losses */

  /*
   * Three reports, because three different people ask about this.
   *
   * The owner wants the money. The storekeeper wants the batch and the slip
   * number. Whoever places the orders wants to know which medicine keeps
   * going in the bin, which is the only one of the three that changes a
   * decision rather than just recording one.
   *
   * Damage and expiry are listed together rather than split into six
   * reports. Running one and reading the Kind column is less work than
   * remembering which of two reports to open, and the total loss for a month
   * is a question somebody asks without caring how it happened.
   */
  {
    id: 'write-offs-list', group: 'Stock', module: 'pharmacy',
    title: 'Damage and Expiry Register',
    blurb: 'Every write-off in the period, with its tracking number and what it cost.',
    /*
     * Landscape, and only just. A 17-wide reference, a clock, a name and the
     * note come to 124 character cells; portrait holds 105. Squeezing it
     * would come out of the note, which is the column that says whether a
     * month of losses was one flood or thirty separate mistakes.
     */
    permission: 'report.stock', dated: true, landscape: true,
    columns: [text('write_off_no', 'Reference', 17), text('kind_label', 'Kind', 8),
      text('when', 'When', 17), text('created_by', 'By', 16),
      num('lines', 'Lines', 7), num('units', 'Units', 8),
      money('value_paisa', 'Value'), text('note', 'Note', 30)],
    totalKeys: ['lines', 'units', 'value_paisa'],
    run: (w) => writeOffRegister(w), stats: (w) => writeOffSummary(w)
  },
  {
    id: 'write-offs-detail', group: 'Stock', module: 'pharmacy',
    title: 'Damage and Expiry Detail',
    blurb: 'One row per batch written off, with the expiry date and the reason given.',
    /*
     * Landscape. Two names, a batch number, a clock, a date, three figures
     * and a reason do not fit the 105 character cells a portrait page holds,
     * and what falls off the right-hand edge is the reason column, which is
     * the one thing on here that is not recoverable from somewhere else.
     */
    permission: 'report.stock', dated: true, landscape: true,
    columns: [text('product_name', 'Medicine', 22), text('manufacturer', 'Company', 13),
      text('kind_label', 'Kind', 7), text('write_off_no', 'Reference', 17),
      text('batch_no', 'Batch', 12), text('expiry_date', 'Expiry', 11),
      num('qty', 'Units', 7), money('unit_cost_paisa', 'Rate', 11),
      money('value_paisa', 'Value', 12), text('reason', 'Reason', 18)],
    totalKeys: ['qty', 'value_paisa'],
    run: (w) => writeOffItems(w), stats: (w) => writeOffSummary(w)
  },
  {
    id: 'write-offs-product', group: 'Stock', module: 'pharmacy',
    title: 'What Keeps Going in the Bin',
    blurb: 'By medicine, worst first. A medicine that expires three times a year is being over-ordered.',
    permission: 'report.stock', dated: true,
    columns: [text('product_name', 'Medicine', 28), text('manufacturer', 'Company', 18),
      num('times', 'Times', 8), num('units', 'Units', 9),
      money('value_paisa', 'Value Lost')],
    chart: { label: 'product_name', value: 'value_paisa', kind: 'bar' },
    totalKeys: ['times', 'units', 'value_paisa'],
    run: (w) => writeOffsByProduct(w), stats: (w) => writeOffSummary(w)
  },
  {
    id: 'sales-daily', group: 'Sales', module: 'pharmacy', title: 'Daily Sales Summary',
    blurb: 'One line per trading day: what was invoiced, what it cost, what was left.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Date', 12), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount'),
      money('margin_paisa', 'Margin'), money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'area' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'day'), stats: (w) => salesSummary(w)
  },
  {
    id: 'sales-monthly', group: 'Sales', module: 'pharmacy', title: 'Monthly Sales Analysis',
    blurb: 'The same figures rolled up by month, for comparing one against another.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Month', 10), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount'),
      money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'area' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'month')
  },
  {
    id: 'sales-hourly', group: 'Sales', module: 'pharmacy', title: 'Sales by Hour',
    blurb: 'When the counter is busy. Useful for deciding when to put a second person on.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Hour', 8), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'invoices', kind: 'area' },
    totalKeys: ['invoices', 'revenue_paisa'],
    run: (w) => salesBy(w, 'hour')
  },
  {
    id: 'sales-product', group: 'Sales', module: 'pharmacy', title: 'Product Sales Analysis',
    blurb: 'Every medicine sold in the period, by value.',
    permission: 'report.sales', dated: true, landscape: true,
    columns: [text('label', 'Name of Product', 34), num('units', 'Units', 8),
      num('invoices', 'Bills', 7), money('revenue_paisa', 'Revenue'),
      money('cost_paisa', 'Cost'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'cost_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'product')
  },
  {
    id: 'sales-salt', group: 'Sales', module: 'pharmacy', title: 'Sales by Formula',
    blurb: 'Grouped by generic rather than brand — what the patients are actually taking.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Formula', 32), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'salt')
  },
  {
    id: 'sales-manufacturer', group: 'Sales', module: 'pharmacy', title: 'Company Sales Statement',
    blurb: 'Sales by manufacturer, for negotiating the next order.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Company', 32), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'manufacturer')
  },
  {
    id: 'sales-group', group: 'Sales', module: 'pharmacy', title: 'Sales by Group',
    blurb: 'Tablets against syrups against surgical. The shape of the shop.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Group', 24), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'group')
  },
  {
    id: 'sales-party', group: 'Sales', module: 'pharmacy', title: 'Customer Sales Statement',
    blurb: 'Who bought, counter and credit together.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Customer', 32), num('invoices', 'Bills', 8),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa'],
    run: (w) => salesBy(w, 'party')
  },
  {
    id: 'sales-cashier', group: 'Sales', module: 'pharmacy', title: 'Sales by Cashier',
    blurb: 'Who served, and how much they discounted while doing it.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Cashier', 24), num('invoices', 'Bills', 8),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount'),
      money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa'],
    run: (w) => salesBy(w, 'cashier')
  },
  {
    id: 'sales-register', group: 'Sales', module: 'pharmacy', title: 'Sales Invoice Register',
    blurb: 'Invoice by invoice, the day book. Cancelled bills are listed too.',
    permission: 'report.sales', dated: true, landscape: true,
    columns: [text('invoice_no', 'Invoice', 17), text('sold_at', 'Date', 18),
      text('party_name', 'Customer', 26), text('sale_kind', 'Type', 9),
      num('lines', 'Lines', 6), money('discount_paisa', 'Discount'),
      money('total_paisa', 'Total Value'), money('margin_paisa', 'Margin')],
    totalKeys: ['lines', 'discount_paisa', 'total_paisa', 'margin_paisa'],
    run: (w, q) => invoiceRegister(w, { kind: q.kind ?? 'all', q: q.q ?? '' })
      .then((rows) => rows.map((r: any) => ({
        ...r, sold_at: new Date(r.sold_at).toLocaleString('en-GB',
          { day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit' })
      }))),
    stats: (w) => salesSummary(w)
  },

  /* --------------------------------------------------------- purchase */
  {
    id: 'purchase-daily', group: 'Purchase', module: 'pharmacy', title: 'Daily Purchase Summary',
    blurb: 'What came in each day and what it cost.',
    permission: 'report.purchase', dated: true,
    columns: [text('label', 'Date', 12), num('deliveries', 'GRNs', 7),
      num('packs', 'Packs', 8), num('bonus_packs', 'Bonus', 7),
      money('total_paisa', 'Total Value')],
    chart: { label: 'label', value: 'total_paisa', kind: 'area' },
    totalKeys: ['deliveries', 'packs', 'bonus_packs', 'total_paisa'],
    run: (w) => purchaseBy(w, 'day'), stats: (w) => purchaseSummary(w)
  },
  {
    id: 'purchase-supplier', group: 'Purchase', module: 'pharmacy', title: 'Supplier Purchase Statement',
    blurb: 'Bought from whom. The list to check before settling accounts.',
    permission: 'report.purchase', dated: true,
    columns: [text('label', 'Name of Supplier', 34), num('deliveries', 'GRNs', 7),
      num('packs', 'Packs', 8), num('bonus_packs', 'Bonus', 7),
      money('total_paisa', 'Total Value')],
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
    totalKeys: ['deliveries', 'packs', 'bonus_packs', 'total_paisa'],
    run: (w) => purchaseBy(w, 'supplier'), stats: (w) => purchaseSummary(w)
  },
  {
    id: 'purchase-product', group: 'Purchase', module: 'pharmacy', title: 'Product Purchase Detail',
    blurb: 'Every medicine received in the period, with bonus packs shown separately.',
    permission: 'report.purchase', dated: true, landscape: true,
    columns: [text('label', 'Name of Product', 36), num('deliveries', 'GRNs', 7),
      num('packs', 'Qty', 8), num('bonus_packs', 'Bonus', 7),
      money('total_paisa', 'Total Value')],
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
    totalKeys: ['packs', 'bonus_packs', 'total_paisa'],
    run: (w) => purchaseBy(w, 'product')
  },
  {
    id: 'purchase-manufacturer', group: 'Purchase', module: 'pharmacy', title: 'Company Purchase Analysis',
    blurb: 'Which manufacturers the money went to.',
    permission: 'report.purchase', dated: true,
    columns: [text('label', 'Company', 34), num('packs', 'Packs', 8),
      num('bonus_packs', 'Bonus', 7), money('total_paisa', 'Total Value')],
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
    totalKeys: ['packs', 'bonus_packs', 'total_paisa'],
    run: (w) => purchaseBy(w, 'manufacturer')
  },
  {
    id: 'orders-list', group: 'Purchase', module: 'pharmacy',
    title: 'Purchase Orders',
    /*
     * Whether anything actually turned up is the point of this report.
     *
     * An order with no GRN against it is either still with the supplier or
     * was quietly forgotten, and those look identical until somebody checks.
     * The window the quantities were suggested from is on the row too: three
     * hundred units is a sensible fortnight and an alarming afternoon.
     */
    blurb: 'Every order raised, who raised it, and whether a delivery ever came against it.',
    permission: 'report.purchase', dated: true, landscape: true,
    columns: [text('order_no', 'Order', 17), text('when', 'Raised', 16),
      text('supplier_name', 'Supplier', 24), text('status', 'Status', 10),
      text('window_label', 'From', 6), num('lines', 'Lines', 6),
      num('units', 'Units', 8), text('grn_no', 'Delivery', 17),
      text('created_by', 'By', 14)],
    totalKeys: ['lines', 'units'],
    run: (w) => ordersReport(w)
  },

  /* ---------------------------------------------------------- returns */
  {
    id: 'returns-register', group: 'Sales', module: 'pharmacy',
    title: 'Sales Returns Register',
    /*
     * The Returns tab is open to everyone at the counter, because a customer
     * holding a strip they want to bring back is the most ordinary thing that
     * happens at a till. This report is what makes that safe: a refund is the
     * one action at the counter that takes money out of the drawer with
     * nothing coming in, so every one of them is named and timed here.
     */
    blurb: 'Every refund given — the bill it came off, who took it back, when, and how much went out.',
    permission: 'report.sales', dated: true, landscape: true,
    columns: [text('return_no', 'Return', 17), text('when', 'When', 16),
      text('invoice_no', 'Against Bill', 17), text('customer', 'Customer', 22),
      num('lines', 'Lines', 6), num('units', 'Units', 7),
      num('written_off', 'Binned', 7),
      money('total_paisa', 'Refunded'), text('returned_by', 'By', 14)],
    totalKeys: ['lines', 'units', 'written_off', 'total_paisa'],
    run: (w) => returnsRegisterReport(w)
  },
  {
    id: 'returns-detail', group: 'Sales', module: 'pharmacy',
    title: 'Sales Returns by Medicine',
    /*
     * One row per medicine per return, never netted. "Which medicines keep
     * coming back" and "who keeps taking them back" are the two questions
     * asked of this data, and a single net figure answers neither.
     */
    blurb: 'One row for every medicine every time it came back, with whether it went on the shelf again.',
    permission: 'report.sales', dated: true, landscape: true,
    columns: [text('product_name', 'Medicine', 26), text('manufacturer', 'Company', 18),
      text('when', 'When', 16), text('return_no', 'Return', 17),
      text('invoice_no', 'Bill', 17), num('qty', 'Units', 7),
      text('restocked', 'Reshelved', 10), money('line_total_paisa', 'Refunded'),
      text('returned_by', 'By', 14)],
    totalKeys: ['qty', 'line_total_paisa'],
    run: (w) => returnsDetailReport(w)
  },

  /* ------------------------------------------------------------ stock */
  {
    id: 'stock-statement', group: 'Stock', module: 'pharmacy', title: 'Stock Statement',
    blurb: 'Everything on the shelf, what it cost and what it is worth at retail.',
    permission: 'report.stock', dated: false, landscape: true,
    columns: [text('name', 'Name of Product', 32), text('pack_label', 'Packing', 9),
      num('on_hand', 'Balance', 8), money('purchase_paisa', 'Pur. Rate', 11),
      money('retail_paisa', 'Retail', 11), money('cost_value_paisa', 'Cost Value'),
      money('retail_value_paisa', 'Sale Value')],
    totalKeys: ['on_hand', 'cost_value_paisa', 'retail_value_paisa'],
    run: async (_w, q) => stockStatement({
      manufacturerId: q.manufacturer ? Number(q.manufacturer) : undefined,
      groupId: q.group ? Number(q.group) : undefined
    })
  },
  {
    id: 'stock-reorder', group: 'Stock', module: 'pharmacy', title: 'Re-Order Report',
    blurb: 'At or below the level set on the medicine. What to put on the next order.',
    permission: 'report.stock', dated: false,
    columns: [text('name', 'Name of Product', 34), text('manufacturer', 'Company', 22),
      num('on_hand', 'Balance', 8), num('reorder_level', 'Min', 7),
      money('purchase_paisa', 'Pur. Rate', 11)],
    chart: { label: 'name', value: 'on_hand', kind: 'bar' },
    run: async () => (await stockStatement())
      .filter((r: any) => Number(r.reorder_level) > 0
        && Number(r.on_hand) <= Number(r.reorder_level))
      .sort((a: any, b: any) => Number(a.on_hand) - Number(b.on_hand))
  },
  {
    id: 'stock-zero-sale', group: 'Stock', module: 'pharmacy', title: 'Zero Sale Stock Statement',
    blurb: 'Bought and never sold. Money asleep on a shelf.',
    permission: 'report.stock', dated: false,
    columns: [text('name', 'Name of Product', 34), text('manufacturer', 'Company', 22),
      num('on_hand', 'Balance', 8), money('tied_up_paisa', 'Tied Up')],
    totalKeys: ['on_hand', 'tied_up_paisa'],
    run: async (_w, q) => zeroSaleStock(Number(q.days ?? 90))
  },
  {
    id: 'stock-expiry', group: 'Stock', module: 'pharmacy', title: 'Near Expiry Stock',
    blurb: 'What is about to be worth nothing. Return it or push it.',
    permission: 'report.stock', dated: false,
    columns: [text('name', 'Name of Product', 34), text('nearest_expiry', 'Expiry', 12),
      num('on_hand', 'Balance', 8), money('cost_value_paisa', 'Value at Risk')],
    totalKeys: ['on_hand', 'cost_value_paisa'],
    run: async () => {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 120)
      return (await stockStatement())
        .filter((r: any) => r.nearest_expiry && new Date(r.nearest_expiry) <= cutoff
          && Number(r.on_hand) > 0)
        .sort((a: any, b: any) => String(a.nearest_expiry).localeCompare(String(b.nearest_expiry)))
    }
  },

  /* ----------------------------------------------------------- profit */
  {
    id: 'profit-manufacturer', group: 'Profit', module: 'pharmacy', title: 'Company Profit Stock Statement',
    blurb: 'Margin by manufacturer. Which companies are worth the shelf space.',
    permission: 'report.profit', dated: true,
    columns: [text('label', 'Company', 30), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('cost_paisa', 'Cost'),
      money('margin_paisa', 'Margin'), num('margin_pct', 'Margin %', 9)],
    chart: { label: 'label', value: 'margin_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'cost_paisa', 'margin_paisa'],
    run: (w) => profitByManufacturer(w)
  },
  {
    id: 'profit-discount', group: 'Profit', module: 'pharmacy', title: 'Discount Monitoring',
    blurb: 'Where the discount went, by medicine. The old system watched this monthly.',
    permission: 'report.profit', dated: true,
    columns: [text('label', 'Name of Product', 34), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount'),
      num('discount_pct', 'Dis. %', 8)],
    chart: { label: 'label', value: 'discount_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'discount_paisa'],
    run: (w) => discountMonitor(w)
  },
  {
    id: 'rate-change', group: 'Profit', module: 'pharmacy', title: 'Rate Change Log',
    /*
     * The selling rate is the one number in the pharmacy that can be moved
     * without anything arriving or leaving, so it is the one that most needs
     * a name and a clock against it. The name was always here; the time was
     * not, which made "who put the rate up on Tuesday" unanswerable from the
     * report even though the row was sitting in the table.
     */
    blurb: 'Every rate change, old against new, with who changed it and when.',
    permission: 'report.profit', dated: true, landscape: true,
    columns: [text('product_name', 'Name of Product', 26), text('pack_label', 'Packing', 8),
      text('when', 'Changed', 16),
      money('old_purchase_paisa', 'Old Pur.', 10), money('new_purchase_paisa', 'New Pur.', 10),
      money('old_trade_paisa', 'Old Trade', 10), money('new_trade_paisa', 'New Trade', 10),
      money('old_retail_paisa', 'Old Retail', 10), money('new_retail_paisa', 'New Retail', 10),
      text('changed_by', 'User', 16), text('reason', 'Why', 16)],
    run: (w) => priceChangeReport(w)
  },

  /* ------------------------------------------------------------ money */
  {
    id: 'party-balances', group: 'Money', module: 'pharmacy', title: 'Customer Balances',
    blurb: 'Who owes what. The list to chase on a Friday.',
    permission: 'report.ledger', dated: false,
    columns: [text('name', 'Account Title', 34), money('debit_paisa', 'Debit'),
      money('credit_paisa', 'Credit'), money('balance_paisa', 'Balance'),
      text('last_movement', 'Last Entry', 12)],
    chart: { label: 'name', value: 'balance_paisa', kind: 'bar' },
    totalKeys: ['debit_paisa', 'credit_paisa', 'balance_paisa'],
    run: async () => outstanding('customer')
  },
  {
    id: 'supplier-balances', group: 'Money', module: 'pharmacy', title: 'Supplier Balances',
    blurb: 'What the pharmacy owes, and to whom.',
    permission: 'report.ledger', dated: false,
    columns: [text('name', 'Account Title', 34), money('debit_paisa', 'Debit'),
      money('credit_paisa', 'Credit'), money('balance_paisa', 'Balance'),
      text('last_movement', 'Last Entry', 12)],
    chart: { label: 'name', value: 'balance_paisa', kind: 'bar' },
    totalKeys: ['debit_paisa', 'credit_paisa', 'balance_paisa'],
    run: async () => outstanding('supplier')
  }
]

/* ------------------------------------------------------------ laboratory */

/** The lab and the x-ray room run the same reports over different categories. */
function departmentReports(
  module: 'laboratory' | 'radiology',
  group: 'Laboratory' | 'Radiology',
  cat: 'lab' | 'radiology',
  noun: string
): ReportDef[] {
  const permission = 'report.lab'
  return [
    {
      id: `${module}-register`, group, module,
      title: `${group} Register`,
      blurb: `Every ${noun} in the period — patient, price, who took the sample and who reported it.`,
      permission, dated: true, landscape: true,
      columns: [text('report_no', 'Report No', 17), text('patient_name', 'Patient', 22),
        text('mrn', 'MRN', 17), text('service_name', 'Test', 22),
        text('collected_at', 'Collected', 15), text('resulted_at', 'Reported', 15),
        text('resulted_by', 'By', 14), money('price_paisa', 'Price', 11)],
      totalKeys: ['price_paisa'],
      run: (w) => labRegister(w, cat),
      stats: (w) => labSummary(w, cat)
    },
    {
      id: `${module}-daily`, group, module,
      title: `Daily ${group} Summary`,
      blurb: `One line per day: how many ${noun}s, for how many patients, and what they earned.`,
      permission, dated: true,
      columns: [text('label', 'Date', 12), num('tests', 'Tests', 8),
        num('patients', 'Patients', 9), num('reported', 'Reported', 9),
        num('avg_minutes', 'Avg mins', 9), money('revenue_paisa', 'Revenue')],
      chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
      totalKeys: ['tests', 'patients', 'reported', 'revenue_paisa'],
      run: (w) => labBy(w, cat, 'day'), stats: (w) => labSummary(w, cat)
    },
    {
      id: `${module}-by-test`, group, module,
      title: `${group} by Test`,
      blurb: 'Which tests are actually being ordered, and what each brings in.',
      permission, dated: true,
      columns: [text('label', 'Test', 30), num('tests', 'Count', 8),
        num('patients', 'Patients', 9), num('avg_minutes', 'Avg mins', 9),
        money('revenue_paisa', 'Revenue')],
      chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
      totalKeys: ['tests', 'revenue_paisa'],
      run: (w) => labBy(w, cat, 'test')
    },
    {
      id: `${module}-by-technician`, group, module,
      title: `${group} by Technician`,
      blurb: 'Who did the work. Counted against whoever reported it, or took the sample if it is not reported yet.',
      permission, dated: true,
      columns: [text('label', 'Technician', 26), num('tests', 'Tests', 8),
        num('reported', 'Reported', 9), num('verified', 'Verified', 9),
        num('avg_minutes', 'Avg mins', 9), money('revenue_paisa', 'Value')],
      chart: { label: 'label', value: 'tests', kind: 'bar' },
      totalKeys: ['tests', 'reported', 'verified', 'revenue_paisa'],
      run: (w) => labBy(w, cat, 'technician')
    },
    {
      id: `${module}-by-doctor`, group, module,
      title: `${group} by Referring Doctor`,
      blurb: 'Who is sending the work. Walk-ins who paid at the counter are counted separately.',
      permission, dated: true,
      columns: [text('label', 'Referred by', 28), num('tests', 'Tests', 8),
        num('patients', 'Patients', 9), money('revenue_paisa', 'Revenue')],
      chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
      totalKeys: ['tests', 'patients', 'revenue_paisa'],
      run: (w) => labBy(w, cat, 'doctor')
    },
    {
      id: `${module}-outstanding`, group, module,
      title: `${group} — Paid but Not Done`,
      blurb: 'Money taken for work the hospital still owes. Read this one every morning.',
      permission, dated: true, landscape: true,
      columns: [text('patient_name', 'Patient', 24), text('mrn', 'MRN', 17),
        text('phone', 'Phone', 14), text('service_name', 'Test', 24),
        text('ordered_at', 'Ordered', 11), num('days_waiting', 'Days', 6),
        text('stage', 'Stage', 12), money('price_paisa', 'Paid', 11)],
      totalKeys: ['price_paisa'],
      run: (w) => labOutstanding(w, cat)
    },
    {
      id: `${module}-turnaround`, group, module,
      title: `${group} Turnaround`,
      blurb: 'How long each test sits between being ordered, sampled and reported.',
      permission, dated: true,
      columns: [text('label', 'Test', 30), num('tests', 'Count', 8),
        num('to_sample_mins', 'To sample', 11), num('to_result_mins', 'To result', 11),
        num('total_mins', 'Total mins', 11)],
      chart: { label: 'label', value: 'total_mins', kind: 'bar' },
      run: (w) => labTurnaround(w, cat)
    }
  ]
}

const LAB_ONLY: ReportDef[] = [
  {
    id: 'lab-abnormal', group: 'Laboratory', module: 'laboratory',
    title: 'Abnormal Result Analysis',
    blurb: 'Which measurements come back outside their range, and how often. A rate that jumps overnight usually means the analyser, not the patients.',
    permission: 'report.lab', dated: true,
    columns: [text('label', 'Measurement', 30), num('measured', 'Measured', 10),
      num('high', 'High', 7), num('low', 'Low', 7), num('abnormal_pct', 'Abnormal %', 11)],
    chart: { label: 'label', value: 'abnormal_pct', kind: 'bar' },
    totalKeys: ['measured', 'high', 'low'],
    run: (w) => labAbnormal(w)
  }
]

/* --------------------------------------------------------- main counter */

const COUNTER: ReportDef[] = [
  {
    id: 'counter-daily', group: 'Counter', module: 'counter',
    title: 'Daily Collection Summary',
    blurb: 'What the counter took each day, and how many patients came through.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Date', 12), num('bills', 'Bills', 8),
      num('cash_bills', 'Cash', 7), money('average_paisa', 'Avg Bill'),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'taken_paisa', kind: 'area' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'day'), stats: (w) => counterSummary(w)
  },
  {
    id: 'counter-by-cashier', group: 'Counter', module: 'counter',
    title: 'Collection by Cashier',
    blurb: 'The figure to reconcile against what is physically in each drawer at closing.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Cashier', 26), num('bills', 'Bills', 8),
      num('cash_bills', 'Cash bills', 11), money('average_paisa', 'Avg Bill'),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'taken_paisa', kind: 'bar' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'cashier'), stats: (w) => counterSummary(w)
  },
  {
    id: 'counter-by-method', group: 'Counter', module: 'counter',
    title: 'Collection by Payment Method',
    blurb: 'Cash against card against mobile money.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Method', 20), num('bills', 'Bills', 8),
      money('average_paisa', 'Avg Bill'), money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'taken_paisa', kind: 'bar' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'method')
  },
  {
    id: 'counter-by-department', group: 'Counter', module: 'counter',
    title: 'Collection by Department',
    blurb: 'Which department the money was collected for — consultation, lab, radiology.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Department', 24), num('bills', 'Bills', 8),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'taken_paisa', kind: 'bar' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'department')
  },
  {
    id: 'dept-summary', group: 'Counter', module: 'counter',
    title: 'Department Summary',
    blurb: 'Patients and money taken, one line per department, with the totals underneath.',
    permission: 'report.counter', dated: true,
    columns: [text('department', 'Department', 30), num('patients', 'Total patients', 14),
      money('received_paisa', 'Received')],
    chart: { label: 'department', value: 'received_paisa', kind: 'ring' },
    totalKeys: ['patients', 'received_paisa'],
    run: (w) => salesByDepartment(w)
  },
  {
    id: 'dept-patients', group: 'Counter', module: 'counter',
    title: 'Patients by Department',
    blurb: 'Every patient seen, in a separate table per department, with what was done and taken.',
    permission: 'report.counter', dated: true, landscape: true,
    /*
     * Broken into a table per department rather than one long list with a
     * department column. A head of department reads their own sheet and
     * nothing else, and the totals under each table are the ones they are
     * asked about.
     */
    groupBy: 'department', groupLabel: 'Department',
    columns: [num('no', 'No', 5), text('doctor_name', 'Doctor', 22),
      text('patient_name', 'Patient', 22), text('procedure_name', 'Procedure', 26),
      text('mrn', 'MRN', 17), money('received_paisa', 'Received'),
      money('discount_paisa', 'Discount')],
    totalKeys: ['received_paisa', 'discount_paisa'],
    /*
     * One department's sheet on its own. The choices are the department
     * records themselves, and the value is the department's id.
     */
    filters: [{ key: 'department', label: 'Department', allLabel: 'All Departments',
      options: departmentChoices }],
    run: (w, q) => patientsByDepartment(w, q)
  },
  {
    id: 'counter-by-hour', group: 'Counter', module: 'counter',
    title: 'Counter Busy Hours',
    blurb: 'When the window is busy. Useful for deciding when to open a second counter.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Hour', 8), num('bills', 'Bills', 8),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'bills', kind: 'area' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'hour')
  },
  {
    id: 'counter-register', group: 'Counter', module: 'counter',
    title: 'Counter Bill Register',
    blurb: 'Bill by bill, the counter day book.',
    permission: 'report.counter', dated: true, landscape: true,
    columns: [text('bill_no', 'Bill No', 17), text('created_at', 'When', 15),
      text('patient_name', 'Patient', 20), text('mrn', 'MRN', 17),
      text('kind', 'For', 10), text('pay_method', 'Method', 9),
      text('cashier_name', 'Cashier', 12),
      /*
       * What was taken off, so the day book shows it.
       *
       * The counter could discount a bill long before anything controlled
       * how much, and the figure was on the bill and on no report. Somebody
       * reconciling a drawer could see the total was short and had nothing
       * to tell them which bill it came off.
       */
      money('discount_paisa', 'Discount', 11),
      money('total_paisa', 'Amount', 12)],
    totalKeys: ['discount_paisa', 'total_paisa'],
    /*
     * Both of these were already read from the query string and nothing
     * ever sent one, so the report could be narrowed and there was no way
     * to do it from the screen.
     */
    filters: [
      { key: 'cashier', label: 'Cashier', allLabel: 'Every cashier',
        options: cashierChoices },
      { key: 'method', label: 'Paid by', allLabel: 'Any method',
        options: payMethodChoices }
    ],
    run: (w, q) => counterRegister(w, q), stats: (w) => counterSummary(w)
  },
  {
    id: 'counter-patients', group: 'Counter', module: 'counter',
    title: 'Patient Registration Register',
    blurb: 'Everyone registered in the period and what happened to them.',
    permission: 'report.counter', dated: true, landscape: true,
    columns: [text('visit_no', 'Visit', 17), text('created_at', 'When', 15),
      text('patient_name', 'Patient', 22), text('mrn', 'MRN', 17),
      num('age_years', 'Age', 5), text('gender', 'Sex', 7),
      text('doctor_name', 'Doctor', 18), text('status', 'Status', 12),
      money('consultation_fee_paisa', 'Fee', 10)],
    totalKeys: ['consultation_fee_paisa'],
    run: (w) => patientRegister(w), stats: (w) => counterSummary(w)
  },
  {
    id: 'counter-unpaid-chits', group: 'Counter', module: 'counter',
    title: 'Unpaid Chits',
    blurb: 'Work ordered that nobody paid for. Every line is either money owed or a chit raised by mistake.',
    permission: 'report.counter', dated: true, landscape: true,
    columns: [text('chit_no', 'Chit No', 17), text('created_at', 'Raised', 11),
      num('days_old', 'Days', 6), text('patient_name', 'Patient', 24),
      text('phone', 'Phone', 14), text('department', 'Department', 14),
      money('total_paisa', 'Amount')],
    totalKeys: ['total_paisa'],
    run: (w) => unpaidChits(w)
  },
  {
    id: 'counter-doctor-earnings', group: 'Counter', module: 'counter',
    title: 'Doctor Earnings',
    blurb: 'What each doctor earned, split between consultations and their share of tests.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Doctor', 26), num('consultations', 'Consults', 10),
      money('consultation_paisa', 'From consults'), num('services', 'Tests', 7),
      money('service_paisa', 'From tests'), money('total_paisa', 'Total')],
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
    totalKeys: ['consultations', 'services', 'consultation_paisa', 'service_paisa', 'total_paisa'],
    /*
     * One doctor, or all of them. The same dropdown as the detail below, so
     * somebody can narrow the summary and then open the detail on the same
     * person without setting the filter twice.
     */
    filters: [{
      key: 'doctor', label: 'Doctor', allLabel: 'All doctors',
      options: doctorChoices
    }],
    run: (w, q) => doctorEarnings(w, q)
  },
  {
    id: 'counter-doctor-detail', group: 'Counter', module: 'counter',
    title: 'Doctor Earnings Detail',
    blurb: 'Every line behind the total: which patient, what was done, and the share of it.',
    /*
     * Landscape. A doctor's name, a clock, a patient's name, an MRN, what
     * was done and three figures do not fit the 105 character cells a
     * portrait page holds, and the column that falls off the edge is the
     * amount.
     */
    permission: 'report.counter', dated: true, landscape: true,
    /*
     * No "Kind" column. It said "Consultation" next to a What for that also
     * said "Consultation", and "Test or procedure" next to the name of the
     * test — a column that is either a duplicate or a category nobody asked
     * for. The width went to the MRN, which was exactly as wide as an MRN
     * and so printed with no gap after it, and to What for, where a long
     * test name was being cut.
     */
    columns: [text('when', 'When', 17),
      text('patient_name', 'Patient', 22), text('mrn', 'MRN', 18),
      text('description', 'What for', 26),
      money('gross_paisa', 'Billed', 13), num('share_pct', 'Share %', 8),
      money('amount_paisa', 'Earned', 13)],
    /*
     * Grouped by doctor, so "all doctors" prints as a stack of statements
     * with a subtotal under each rather than one list somebody has to sort.
     * Picking one doctor leaves a single group, which is the statement.
     */
    groupBy: 'doctor', groupLabel: 'Doctor',
    totalKeys: ['gross_paisa', 'amount_paisa'],
    filters: [{
      key: 'doctor', label: 'Doctor', allLabel: 'All doctors',
      options: doctorChoices
    }],
    run: (w, q) => doctorEarningDetail(w, q),
    stats: (w, q) => doctorEarningSummary(w, q)
  }
]

/* ------------------------------------------------------- whole hospital */

const HOSPITAL: ReportDef[] = [
  {
    id: 'hospital-income', group: 'Hospital', module: 'hospital',
    title: 'Income by Till',
    blurb: 'Everything taken, named by where it was taken. Deliberately not one figure — an owner wants to check each till, not trust a total.',
    permission: 'report.hospital', dated: true,
    columns: [text('label', 'Till', 28), num('bills', 'Bills', 8),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'taken_paisa', kind: 'bar' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => hospitalIncome(w)
  },
  {
    id: 'hospital-daily', group: 'Hospital', module: 'hospital',
    title: 'Hospital Day Book',
    blurb: 'One line per day across every module — patients, counter, pharmacy, lab.',
    permission: 'report.hospital', dated: true,
    columns: [text('label', 'Date', 12), num('patients', 'Patients', 9),
      num('lab_tests', 'Lab tests', 10), money('counter_paisa', 'Counter'),
      money('pharmacy_paisa', 'Pharmacy'), money('total_paisa', 'Total')],
    chart: { label: 'label', value: 'total_paisa', kind: 'area' },
    totalKeys: ['patients', 'lab_tests', 'counter_paisa', 'pharmacy_paisa', 'total_paisa'],
    run: (w) => hospitalDaily(w)
  }
]

const GOODS_RECEIVED: ReportDef[] = [
  {
    id: 'purchase-grn-detail', group: 'Purchase', module: 'pharmacy',
    title: 'Receiving Purchase Invoice With Pack',
    blurb: 'Every delivery with the items inside it, each invoice totalled separately. This is the copy you check line by line against the supplier\'s paper.',
    permission: 'report.purchase', dated: true, landscape: true,
    /*
     * Grouped, not summarised.
     *
     * A store keeper reconciling a delivery needs the lines — a single row per
     * invoice cannot show where the supplier and the system disagree, which is
     * the only reason anyone opens this report.
     */
    groupBy: 'group_key', groupLabel: 'Supplier',
    columns: [text('product_name', 'Name of Product', 30), text('packing', 'Packing', 9),
      text('batch_no', 'Batch No.', 12), text('expiry', 'Expiry', 10),
      money('rate_paisa', 'Rate', 11), num('qty', 'Qty', 7), num('bonus', 'Bonus', 7),
      money('line_total_paisa', 'Total Value')],
    totalKeys: ['qty', 'bonus', 'line_total_paisa'],
    run: (w, q) => goodsReceivedDetail(w, q),
    stats: (w) => purchaseSummary(w)
  },
  {
    id: 'purchase-grn-register', group: 'Purchase', module: 'pharmacy',
    title: 'Goods Received Register',
    blurb: 'One line per delivery — GRN number, supplier, their invoice number, the order it answers, who booked it in and when.',
    permission: 'report.purchase', dated: true, landscape: true,
    columns: [text('grn_no', 'GRN No', 17), text('received_on', 'Invoiced', 10),
      text('booked_at', 'Booked In', 15), text('supplier_name', 'Supplier', 22),
      text('supplier_invoice_no', 'Their Invoice', 13),
      text('order_no', 'Order', 17), text('received_by', 'By', 14),
      num('lines', 'Lines', 6), num('packs', 'Packs', 7), num('bonus', 'Bonus', 6),
      money('total_paisa', 'Total Value')],
    totalKeys: ['lines', 'packs', 'bonus', 'total_paisa'],
    run: (w, q) => goodsReceivedSummary(w, q),
    stats: (w) => purchaseSummary(w)
  }
]

/* ------------------------------------------------------- goods received */

const PURCHASE_DETAIL: ReportDef[] = [
  {
    id: 'purchase-detail', group: 'Purchase', module: 'pharmacy',
    title: 'Receiving Purchase Invoice With Pack',
    blurb: 'Every delivery in full — supplier, GRN, and each medicine with its pack, rate, quantity and bonus. Totals per delivery, per supplier, then overall.',
    permission: 'report.purchase', dated: true, landscape: true,
    groupBy: 'supplier_name', groupLabel: 'Supplier',
    subGroupBy: 'grn_block', subGroupLabel: 'Purchase Invoice Total',
    columns: [
      text('product_name', 'Name of Product', 30),
      text('pack_label', 'Packing', 9),
      text('batch_no', 'Batch No', 12),
      money('rate_paisa', 'Rate', 11),
      num('qty', 'Qty', 6),
      num('bonus_qty', 'Bonus', 6),
      num('discount_pct', 'Dis. %', 7),
      money('line_total_paisa', 'Total Value', 13)
    ],
    totalKeys: ['qty', 'bonus_qty', 'line_total_paisa'],
    run: (w, q) => purchaseDetail(w, q)
  },
  {
    id: 'purchase-register', group: 'Purchase', module: 'pharmacy',
    title: 'Goods Received Register',
    blurb: 'One line per delivery: GRN, supplier, their invoice number and what it came to.',
    permission: 'report.purchase', dated: true, landscape: true,
    columns: [
      text('grn_no', 'GRN No', 18),
      text('invoice_date', 'Date', 11),
      text('supplier_name', 'Supplier', 28),
      text('supplier_invoice_no', 'Their Inv#', 13),
      num('lines', 'Lines', 6),
      num('packs', 'Packs', 7),
      num('bonus', 'Bonus', 6),
      money('total_paisa', 'Total Value', 13)
    ],
    totalKeys: ['lines', 'packs', 'bonus', 'total_paisa'],
    run: (w, q) => purchaseRegister(w, q)
  }
]

/* ------------------------------------- credit bills and department bills */

const PHARMACY_ACCOUNTS: ReportDef[] = [
  {
    id: 'credit-bills', group: 'Money', module: 'pharmacy',
    title: 'Credit Bills',
    blurb: 'Every pharmacy bill given on credit in the period, what has been received against it and what is still owed — with who wrote the bill and who took the money.',
    permission: 'report.ledger', dated: true, landscape: true,
    /* Widths sum to the landscape page (see verify-print). */
    columns: [text('invoice_no', 'Invoice', 17), text('sold_at', 'Billed', 15),
      text('party_name', 'Customer', 15), text('customer_ref', 'MRN / Phone', 11),
      text('cashier', 'Billed By', 10), money('total_paisa', 'Bill', 11),
      money('received_paisa', 'Received', 11), money('outstanding_paisa', 'Owed', 11),
      text('status_label', 'Status', 9), text('last_received_at', 'Paid On', 15),
      text('last_received_by', 'Received By', 10), text('last_method', 'Method', 7)],
    /*
     * Received is what came in against THESE bills, whenever it came. The
     * money collected IN the period, whichever bill it was for, is a
     * different question and is the "collected" headline figure — the two
     * are kept apart so a bill and its later payment are never added up as
     * two collections.
     */
    totalKeys: ['total_paisa', 'received_paisa', 'outstanding_paisa'],
    filters: [{
      key: 'status', label: 'Status', allLabel: 'Every credit bill',
      options: async () => [
        { value: 'open', label: 'Still owed (outstanding or part paid)' },
        { value: 'outstanding', label: 'Outstanding — nothing received' },
        { value: 'partial', label: 'Part paid' },
        { value: 'settled', label: 'Settled' }
      ]
    }],
    search: { key: 'q', label: 'Search', placeholder: 'Invoice, customer, MRN or phone' },
    run: (w, q) => creditBillReport(w, q),
    stats: (w, q) => creditBillStats(w, q)
  },
  {
    id: 'department-bills', group: 'Sales', module: 'pharmacy',
    title: 'Interdepartmental Bills',
    blurb: 'Medicines issued to hospital departments, department by department: each bill with its items, a total per department and a grand total.',
    permission: 'report.sales', dated: true, landscape: true,
    groupBy: 'department_name', groupLabel: 'Department',
    subGroupBy: 'bill_block', subGroupLabel: 'Bill Total',
    columns: [text('product_name', 'Medicine', 30), text('batch_no', 'Batch', 12),
      num('qty', 'Qty', 7), text('sold_as', 'As', 6), money('unit_price_paisa', 'Rate', 11),
      money('line_total_paisa', 'Amount', 13)],
    totalKeys: ['qty', 'line_total_paisa'],
    filters: [{ key: 'department', label: 'Department', allLabel: 'Every department',
      options: departmentChoices }],
    search: { key: 'q', label: 'Bill number', placeholder: 'e.g. PH-261016' },
    run: (w, q) => departmentBillLines(w, q),
    stats: (w, q) => departmentBillStats(w, q)
  },
  {
    id: 'department-bills-register', group: 'Sales', module: 'pharmacy',
    title: 'Interdepartmental Bill Register',
    blurb: 'One line per bill issued to a department, grouped by department with a total for each.',
    permission: 'report.sales', dated: true, landscape: true,
    groupBy: 'department_name', groupLabel: 'Department',
    columns: [text('invoice_no', 'Invoice', 17), text('sold_at', 'Date', 15),
      text('customer_name', 'Issued To', 26), text('cashier', 'Issued By', 15),
      num('lines', 'Items', 6), text('status', 'Status', 18), money('total_paisa', 'Total', 13)],
    totalKeys: ['lines', 'total_paisa'],
    filters: [{ key: 'department', label: 'Department', allLabel: 'Every department',
      options: departmentChoices }],
    search: { key: 'q', label: 'Bill number', placeholder: 'e.g. PH-261016' },
    run: (w, q) => departmentBillRegister(w, q),
    stats: (w, q) => departmentBillStats(w, q)
  }
]

REPORTS.push(
  ...PHARMACY_ACCOUNTS,
  ...PURCHASE_DETAIL,
  ...GOODS_RECEIVED,
  ...departmentReports('laboratory', 'Laboratory', 'lab', 'test'),
  ...LAB_ONLY,
  ...departmentReports('radiology', 'Radiology', 'radiology', 'scan'),
  ...COUNTER,
  ...HOSPITAL
)

export const reportById = (id: string) => REPORTS.find((r) => r.id === id)


/* ----------------------------------------- audits, shaped for a report */

/**
 * A timestamp a printed report can show.
 *
 * The catalogue prints strings, and every one of these reports exists so a
 * figure can be traced back to a moment and a person. Formatted here rather
 * than in the PDF so the screen and the paper read identically.
 */
function stamp(v: any) {
  return v ? new Date(v).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }) : ''
}

async function adjustmentsReport(w: { from?: string; to?: string }) {
  const rows = await rawAdjustments({ from: w.from, to: w.to, limit: 2000 })
  return (rows as any[]).map((r) => ({ ...r, when: stamp(r.created_at) }))
}

async function adjustmentDetailReport(w: { from?: string; to?: string }) {
  const rows = await rawAdjustmentDetail({ from: w.from, to: w.to })
  return (rows as any[]).map((r) => {
    const delta = Number(r.delta_qty)
    const value = Number(r.value_paisa ?? 0)
    return {
      ...r,
      manufacturer: r.manufacturer ?? '',
      when: stamp(r.created_at),
      /*
       * One side or the other, never both, and null for the side that does
       * not apply so it prints blank instead of 0.00.
       */
      added_paisa: delta > 0 ? value : null,
      removed_paisa: delta < 0 ? Math.abs(value) : null
    }
  })
}

async function adjustmentsByCompany(w: { from?: string; to?: string }) {
  return rawAdjustmentsByCompany({ from: w.from, to: w.to })
}

async function priceChangeReport(w: { from?: string; to?: string }) {
  const rows = await priceHistory({ from: w.from, to: w.to })
  return (rows as any[]).map((r) => ({
    ...r,
    when: stamp(r.changed_at),
    changed_by: r.changed_by ?? '',
    reason: r.reason ?? ''
  }))
}

/* ------------------------------------------- returns and orders, for the record */

/**
 * Every refund given, one row per medicine per return.
 *
 * The counter now shows the Returns tab to everybody, which is right — a
 * customer with a strip to bring back is the most ordinary thing that happens
 * at a till. What makes that safe is this report: refunding is the one action
 * at the counter that takes money out of the drawer with nothing coming in,
 * so every line of it carries who did it and when.
 *
 * One row per medicine rather than per return, because "which medicines keep
 * coming back" and "who keeps taking them back" are the two questions asked,
 * and a netted figure answers neither.
 */
async function returnsDetailReport(w: { from?: string; to?: string }) {
  const rows = await rawReturns({ from: w.from, to: w.to, detail: true })
  return (rows as any[]).map((r) => ({
    ...r,
    when: stamp(r.returned_at),
    returned_by: r.returned_by ?? '',
    /* A half-used bottle comes back for a refund but never goes back on the
     * shelf. The difference is the whole reason the restock flag exists. */
    restocked: r.restock ? 'Yes' : 'No',
    reason: r.reason ?? ''
  }))
}

async function returnsRegisterReport(w: { from?: string; to?: string }) {
  const rows = await rawReturns({ from: w.from, to: w.to, detail: false })
  return (rows as any[]).map((r) => ({
    ...r,
    when: stamp(r.returned_at),
    returned_by: r.returned_by ?? '',
    customer: r.party_name ?? r.customer_name ?? 'Walk-in',
    reason: r.reason ?? ''
  }))
}

/** Orders raised, and whether anything ever turned up against them. */
async function ordersReport(w: { from?: string; to?: string }) {
  const rows = await rawOrders({ from: w.from, to: w.to })
  return (rows as any[]).map((r) => ({
    ...r,
    when: stamp(r.created_at),
    grn_no: r.grn_no ?? '-',
    status: String(r.status ?? '').toUpperCase(),
    window_label: `${r.window_days}d`
  }))
}

/**
 * The value of what moved, for the line under the grand total.
 *
 * The two totals are already on the grand total row; what is missing from
 * there is the one figure somebody actually wants — whether the shop is up or
 * down overall. Stated in words rather than left as a signed number, because
 * "-4,210.00" in a Net column is read as a loss by some people and as a
 * correction by others.
 */
async function adjustmentValueSummary(w: { from?: string; to?: string }) {
  const rows = await rawAdjustmentDetail({ from: w.from, to: w.to }) as any[]
  const added = rows.filter((r) => Number(r.delta_qty) > 0)
    .reduce((n, r) => n + Number(r.value_paisa ?? 0), 0)
  const removed = rows.filter((r) => Number(r.delta_qty) < 0)
    .reduce((n, r) => n + Math.abs(Number(r.value_paisa ?? 0)), 0)
  const net = added - removed
  const money = (p: number) =>
    (p / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return {
    notes: [
      `Stock value added     Rs ${money(added)}`,
      `Stock value removed   Rs ${money(removed)}`,
      net === 0
        ? 'Net change            nothing, the two sides cancel out'
        : `Net change            Rs ${money(Math.abs(net))} ` +
          `${net > 0 ? 'MORE stock than the system held' : 'LESS stock than the system held'}`
    ]
  }
}
