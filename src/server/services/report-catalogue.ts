import {
  salesSummary, salesBy, invoiceRegister, purchaseSummary, purchaseBy,
  stockStatement, zeroSaleStock, profitByManufacturer, discountMonitor, type Window
} from './pharma-reports'
import { priceHistory, outstanding } from './pharma'
import {
  labRegister, labBy, labSummary, labOutstanding, labTurnaround, labAbnormal,
  counterSummary, counterBy, counterRegister, patientRegister, unpaidChits,
  doctorEarnings, hospitalIncome, hospitalDaily
} from './hospital-reports'
import type { Column } from './report-pdf'

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
  chart?: { label: string; value: string; kind: 'bar' | 'line' }
  totalKeys?: string[]
  groupBy?: string
  groupLabel?: string
  /** Needs a date window. Stock reports are a snapshot and do not. */
  dated: boolean
  landscape?: boolean
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
  {
    id: 'sales-daily', group: 'Sales', module: 'pharmacy', title: 'Daily Sales Summary',
    blurb: 'One line per trading day: what was invoiced, what it cost, what was left.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Date', 12), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount'),
      money('margin_paisa', 'Margin'), money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
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
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'month')
  },
  {
    id: 'sales-hourly', group: 'Sales', module: 'pharmacy', title: 'Sales by Hour',
    blurb: 'When the counter is busy. Useful for deciding when to put a second person on.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Hour', 8), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'invoices', kind: 'bar' },
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
    columns: [text('invoice_no', 'Invoice', 12), text('sold_at', 'Date', 18),
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
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
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
    id: 'rate-change', group: 'Profit', module: 'pharmacy', title: 'Rate Change List',
    blurb: 'Every price change, old against new, with who changed it.',
    permission: 'report.profit', dated: true, landscape: true,
    columns: [text('product_name', 'Name of Product', 30), text('pack_label', 'Packing', 9),
      money('old_purchase_paisa', 'Old Pur.', 11), money('new_purchase_paisa', 'New Pur.', 11),
      money('old_retail_paisa', 'Old Retail', 11), money('new_retail_paisa', 'New Retail', 11),
      text('changed_by', 'User', 12)],
    run: (w) => priceHistory({ from: w.from, to: w.to })
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
      columns: [text('report_no', 'Report No', 12), text('patient_name', 'Patient', 22),
        text('mrn', 'MRN', 11), text('service_name', 'Test', 22),
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
      columns: [text('patient_name', 'Patient', 24), text('mrn', 'MRN', 11),
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
    chart: { label: 'label', value: 'taken_paisa', kind: 'bar' },
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
    id: 'counter-by-hour', group: 'Counter', module: 'counter',
    title: 'Counter Busy Hours',
    blurb: 'When the window is busy. Useful for deciding when to open a second counter.',
    permission: 'report.counter', dated: true,
    columns: [text('label', 'Hour', 8), num('bills', 'Bills', 8),
      money('taken_paisa', 'Collected')],
    chart: { label: 'label', value: 'bills', kind: 'bar' },
    totalKeys: ['bills', 'taken_paisa'],
    run: (w) => counterBy(w, 'hour')
  },
  {
    id: 'counter-register', group: 'Counter', module: 'counter',
    title: 'Counter Bill Register',
    blurb: 'Bill by bill, the counter day book.',
    permission: 'report.counter', dated: true, landscape: true,
    columns: [text('bill_no', 'Bill No', 12), text('created_at', 'When', 15),
      text('patient_name', 'Patient', 22), text('mrn', 'MRN', 11),
      text('kind', 'For', 12), text('pay_method', 'Method', 10),
      text('cashier_name', 'Cashier', 14), money('total_paisa', 'Amount')],
    totalKeys: ['total_paisa'],
    run: (w, q) => counterRegister(w, q), stats: (w) => counterSummary(w)
  },
  {
    id: 'counter-patients', group: 'Counter', module: 'counter',
    title: 'Patient Registration Register',
    blurb: 'Everyone registered in the period and what happened to them.',
    permission: 'report.counter', dated: true, landscape: true,
    columns: [text('visit_no', 'Visit', 16), text('created_at', 'When', 15),
      text('patient_name', 'Patient', 22), text('mrn', 'MRN', 11),
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
    columns: [text('chit_no', 'Chit No', 13), text('created_at', 'Raised', 11),
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
    run: (w) => doctorEarnings(w)
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
    chart: { label: 'label', value: 'total_paisa', kind: 'bar' },
    totalKeys: ['patients', 'lab_tests', 'counter_paisa', 'pharmacy_paisa', 'total_paisa'],
    run: (w) => hospitalDaily(w)
  }
]

REPORTS.push(
  ...departmentReports('laboratory', 'Laboratory', 'lab', 'test'),
  ...LAB_ONLY,
  ...departmentReports('radiology', 'Radiology', 'radiology', 'scan'),
  ...COUNTER,
  ...HOSPITAL
)

export const reportById = (id: string) => REPORTS.find((r) => r.id === id)
