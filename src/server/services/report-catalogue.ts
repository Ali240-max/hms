import {
  salesSummary, salesBy, invoiceRegister, purchaseSummary, purchaseBy,
  stockStatement, zeroSaleStock, profitByManufacturer, discountMonitor, type Window
} from './pharma-reports'
import { priceHistory, outstanding } from './pharma'
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
    id: 'sales-daily', group: 'Sales', title: 'Daily Sales Summary',
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
    id: 'sales-monthly', group: 'Sales', title: 'Monthly Sales Analysis',
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
    id: 'sales-hourly', group: 'Sales', title: 'Sales by Hour',
    blurb: 'When the counter is busy. Useful for deciding when to put a second person on.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Hour', 8), num('invoices', 'Invoices', 9),
      money('revenue_paisa', 'Revenue'), money('average_paisa', 'Avg Bill')],
    chart: { label: 'label', value: 'invoices', kind: 'bar' },
    totalKeys: ['invoices', 'revenue_paisa'],
    run: (w) => salesBy(w, 'hour')
  },
  {
    id: 'sales-product', group: 'Sales', title: 'Product Sales Analysis',
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
    id: 'sales-salt', group: 'Sales', title: 'Sales by Formula',
    blurb: 'Grouped by generic rather than brand — what the patients are actually taking.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Formula', 32), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'salt')
  },
  {
    id: 'sales-manufacturer', group: 'Sales', title: 'Company Sales Statement',
    blurb: 'Sales by manufacturer, for negotiating the next order.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Company', 32), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'manufacturer')
  },
  {
    id: 'sales-group', group: 'Sales', title: 'Sales by Group',
    blurb: 'Tablets against syrups against surgical. The shape of the shop.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Group', 24), num('units', 'Units', 8),
      money('revenue_paisa', 'Revenue'), money('margin_paisa', 'Margin')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['units', 'revenue_paisa', 'margin_paisa'],
    run: (w) => salesBy(w, 'group')
  },
  {
    id: 'sales-party', group: 'Sales', title: 'Customer Sales Statement',
    blurb: 'Who bought, counter and credit together.',
    permission: 'report.sales', dated: true,
    columns: [text('label', 'Customer', 32), num('invoices', 'Bills', 8),
      money('revenue_paisa', 'Revenue'), money('discount_paisa', 'Discount')],
    chart: { label: 'label', value: 'revenue_paisa', kind: 'bar' },
    totalKeys: ['invoices', 'revenue_paisa', 'discount_paisa'],
    run: (w) => salesBy(w, 'party')
  },
  {
    id: 'sales-cashier', group: 'Sales', title: 'Sales by Cashier',
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
    id: 'sales-register', group: 'Sales', title: 'Sales Invoice Register',
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
    id: 'purchase-daily', group: 'Purchase', title: 'Daily Purchase Summary',
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
    id: 'purchase-supplier', group: 'Purchase', title: 'Supplier Purchase Statement',
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
    id: 'purchase-product', group: 'Purchase', title: 'Product Purchase Detail',
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
    id: 'purchase-manufacturer', group: 'Purchase', title: 'Company Purchase Analysis',
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
    id: 'stock-statement', group: 'Stock', title: 'Stock Statement',
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
    id: 'stock-reorder', group: 'Stock', title: 'Re-Order Report',
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
    id: 'stock-zero-sale', group: 'Stock', title: 'Zero Sale Stock Statement',
    blurb: 'Bought and never sold. Money asleep on a shelf.',
    permission: 'report.stock', dated: false,
    columns: [text('name', 'Name of Product', 34), text('manufacturer', 'Company', 22),
      num('on_hand', 'Balance', 8), money('tied_up_paisa', 'Tied Up')],
    totalKeys: ['on_hand', 'tied_up_paisa'],
    run: async (_w, q) => zeroSaleStock(Number(q.days ?? 90))
  },
  {
    id: 'stock-expiry', group: 'Stock', title: 'Near Expiry Stock',
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
    id: 'profit-manufacturer', group: 'Profit', title: 'Company Profit Stock Statement',
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
    id: 'profit-discount', group: 'Profit', title: 'Discount Monitoring',
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
    id: 'rate-change', group: 'Profit', title: 'Rate Change List',
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
    id: 'party-balances', group: 'Money', title: 'Customer Balances',
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
    id: 'supplier-balances', group: 'Money', title: 'Supplier Balances',
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

export const reportById = (id: string) => REPORTS.find((r) => r.id === id)
