import { useCallback, useEffect, useState } from 'react'
import { ReceiptText, HandCoins, Building2 } from 'lucide-react'
import { api, rs, today, type SessionUser } from '../../lib/api'
import { Card, Empty, Modal, Stat, Tabs, Th } from '../../components/ui'
import { ReceiptPreview } from '../../components/Chit'
import { t as tr } from '../../lib/prefs'
import { CreditBills } from './CreditBills'

const MODES = [['today', 'Today'], ['range', 'Date range'], ['bills', 'Bill numbers'],
  ['amount', 'Amount'], ['all', 'Everything']] as const

/**
 * The Bills page, one tab per kind of bill.
 *
 * The three tabs split every bill exactly once, decided on the server from
 * the bill's own columns (pharmacy.ts, GET /sales `kind`):
 *
 *   Regular           paid at the counter when it was made
 *   Credit            owed by a patient or customer — its own screen, because
 *                     "who still owes us, and for which bill" is a different
 *                     question from "what did we sell"
 *   Interdepartmental issued to a hospital department. Written as credit
 *                     (nothing is taken at the counter), but nobody is going
 *                     to walk in and pay for the OT's saline, so they are
 *                     never counted as customer credit
 *
 * No bill appears under two tabs, so the tabs' totals add up to the day.
 */
export function Bills({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<'regular' | 'credit' | 'department'>('regular')
  return (
    <div className="space-y-4 p-4">
      <Tabs id="pharmacy-bills" value={tab} onChange={(v) => setTab(v as any)} className="w-fit"
        tabs={[
          { value: 'regular', label: tr('Regular Bills'), icon: ReceiptText },
          { value: 'credit', label: tr('Credit Bills'), icon: HandCoins },
          { value: 'department', label: tr('Interdepartmental Bills'), icon: Building2 }
        ]} />
      {tab === 'credit' ? <CreditBills me={me} />
        // Keyed, so switching tabs starts each list from its own filters.
        : <AllBills key={tab} kind={tab} />}
    </div>
  )
}

/** Past sales, with the filters a shop actually reaches for. */
function AllBills({ kind }: { kind: 'regular' | 'department' }) {
  const isDept = kind === 'department'
  const [mode, setMode] = useState<string>('today')
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [seqFrom, setSeqFrom] = useState(''); const [seqTo, setSeqTo] = useState('')
  const [amtFrom, setAmtFrom] = useState(''); const [amtTo, setAmtTo] = useState('')
  const [q, setQ] = useState(''); const [sort, setSort] = useState('newest')
  const [cashier, setCashier] = useState(0)
  const [cashiers, setCashiers] = useState<any[]>([])
  const [department, setDepartment] = useState(0)
  const [departments, setDepartments] = useState<any[]>([])
  const [data, setData] = useState<{ rows: any[]; totals: any }>({ rows: [], totals: {} })
  const [open, setOpen] = useState<any>(null)
  const [receipt, setReceipt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.ph.sales({
      mode, from, to, q, sort, cashier: cashier || '', kind,
      department: isDept && department ? department : '',
      seqFrom: seqFrom || null, seqTo: seqTo || null,
      amtFrom: amtFrom ? Math.round(parseFloat(amtFrom) * 100) : null,
      amtTo: amtTo ? Math.round(parseFloat(amtTo) * 100) : null
    }).then(setData).finally(() => setLoading(false))
  }, [mode, from, to, q, sort, cashier, seqFrom, seqTo, amtFrom, amtTo, kind, department, isDept])

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])
  useEffect(() => { api.ph.cashiers().then(setCashiers).catch(() => {}) }, [])
  useEffect(() => {
    if (isDept) api.departments().then(setDepartments).catch(() => {})
  }, [isDept])

  const totals = data.totals
  return (
    <div className="space-y-4">
      <Card title={isDept ? tr('Interdepartmental Bills') : tr('Regular Bills')}
        hint={isDept ? tr('Medicines issued to a hospital department. Nothing is collected at the counter for these.')
          : tr('Bills paid at the counter when they were made. Credit and department bills have their own tabs.')}>
        <div className="flex flex-wrap items-center gap-2">
          {MODES.map(([id, label]) => (
            <button key={id} onClick={() => setMode(id)}
              className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                mode === id ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
              {tr(label)}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          {mode === 'range' && (
            <>
              <label className="block"><span className="label">{tr('From')}</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field num w-40" /></label>
              <label className="block"><span className="label">{tr('To')}</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field num w-40" /></label>
            </>
          )}
          {mode === 'bills' && (
            <>
              <label className="block"><span className="label">{tr('Bill no from')}</span>
                <input value={seqFrom} onChange={(e) => setSeqFrom(e.target.value)} className="field num w-28" /></label>
              <label className="block"><span className="label">{tr('to')}</span>
                <input value={seqTo} onChange={(e) => setSeqTo(e.target.value)} className="field num w-28" /></label>
            </>
          )}
          {mode === 'amount' && (
            <>
              <label className="block"><span className="label">{tr('Amount from (Rs)')}</span>
                <input value={amtFrom} onChange={(e) => setAmtFrom(e.target.value)} className="field num w-28" /></label>
              <label className="block"><span className="label">{tr('to')}</span>
                <input value={amtTo} onChange={(e) => setAmtTo(e.target.value)} className="field num w-28" /></label>
            </>
          )}
          <label className="block flex-1 min-w-48"><span className="label">{tr('Search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={isDept ? tr('Invoice, department or an amount')
                : tr('Invoice, customer, phone or an amount')} className="field" /></label>
          {isDept && (
            <label className="block"><span className="label">{tr('Department')}</span>
              <select value={department} onChange={(e) => setDepartment(Number(e.target.value))}
                className="field w-44">
                <option value={0}>{tr('All Departments')}</option>
                {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></label>
          )}
          <label className="block"><span className="label">{tr('Cashier')}</span>
            <select value={cashier} onChange={(e) => setCashier(Number(e.target.value))} className="field w-40">
              <option value={0}>{tr('Everyone')}</option>
              {cashiers.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select></label>
          <label className="block"><span className="label">{tr('Sort')}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="field w-36">
              <option value="newest">{tr('Newest')}</option><option value="oldest">{tr('Oldest')}</option>
              <option value="highest">{tr('Highest first')}</option><option value="lowest">{tr('Lowest first')}</option>
              <option value="bill_desc">{tr('Bill no ↓')}</option><option value="bill_asc">{tr('Bill no ↑')}</option>
            </select></label>
        </div>

        {/*
          Billed and collected side by side, because they are not the same
          number. A credit bill or a bill issued to a department is billed
          today and collected later or never; counting it as collected is how
          the drawer came up short against the screen.
        */}
        {isDept ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label={tr('Bills')} value={String(totals.bill_count ?? 0)} />
            <Stat label={tr('Charged to departments')} value={`Rs ${rs(totals.revenue_paisa)}`}
              tone="accent" />
            <Stat label={tr('Collected')} value="Rs 0.00"
              sub={tr('Departments are not billed at the counter')} />
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label={tr('Bills')} value={String(totals.bill_count ?? 0)}
              sub={Number(totals.discount_paisa) > 0
                ? `${tr('Discount')} Rs ${rs(totals.discount_paisa)}` : undefined} />
            <Stat label={tr('Billed')} value={`Rs ${rs(totals.revenue_paisa)}`} tone="accent"
              sub={Number(totals.tax_paisa) > 0 ? `${tr('Tax')} Rs ${rs(totals.tax_paisa)}` : undefined} />
            {/*
              Taken at the counter for these bills. Credit money received on
              the same days is shown on the Credit Bills tab, against the
              bills it settles, rather than added in here.
            */}
            <Stat label={tr('Collected')} value={`Rs ${rs(totals.collected_at_sale_paisa)}`}
              tone="ok" sub={tr('paid at the counter')} />
          </div>
        )}

        {loading ? <p className="py-8 text-sm text-muted">{tr('Loading…')}</p>
          : data.rows.length === 0 ? <Empty title={tr('No bills match that')} /> : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr><Th w="w-28">{tr('Invoice')}</Th><Th>{isDept ? tr('Department') : tr('Customer')}</Th>
                  <Th w="w-32">{tr('Cashier')}</Th>
                  <Th w="w-24">{tr('Payment')}</Th><Th w="w-16" right>{tr('Items')}</Th>
                  <Th w="w-28" right>{tr('Total')}</Th><Th w="w-32">{tr('Time')}</Th><Th w="w-24" right /></tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {data.rows.map((s) => (
                  <tr key={s.id} onClick={() => api.ph.sale(s.id).then(setOpen)}
                    className="cursor-pointer hover:bg-screen">
                    <td className="px-3 py-2 num text-2xs text-primary">{s.invoice_no}</td>
                    <td className="px-3 py-2 text-sm text-heading">
                      {s.department_name
                        ? <>
                            {s.department_name}
                            {/* Who in the department took it, when the till recorded it. */}
                            {s.customer_name && s.customer_name !== s.department_name && (
                              <span className="block text-2xs text-muted">{s.customer_name}</span>
                            )}
                          </>
                        : s.customer_name || <span className="text-muted">{tr('Walk-in')}</span>}
                      {s.mrn && <span className="ml-2 num text-2xs text-muted">{s.mrn}</span>}
                    </td>
                    {/* `cashier`: this read cashier_name, which sales does not have. */}
                    <td className="px-3 py-2 text-2xs text-muted">{s.cashier}</td>
                    <td className="px-3 py-2 text-2xs capitalize text-muted">
                      {s.department_name ? tr('Charged to department') : tr(s.pay_method)}
                    </td>
                    <td className="px-3 py-2 text-right num text-2xs">{s.line_count}</td>
                    <td className="px-3 py-2 text-right num text-sm font-medium text-primary">{rs(s.total_paisa)}</td>
                    <td className="px-3 py-2 num text-2xs text-muted">
                      {new Date(s.sold_at).toLocaleString('en-GB',
                        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); setReceipt(s.id) }}
                        className="btn-ghost px-2 py-1 text-2xs">
                        {tr('Receipt')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <Modal title={open.sale.invoiceNo} onClose={() => setOpen(null)}
          footer={<>
            <button onClick={() => setOpen(null)} className="btn-ghost">{tr('Close')}</button>
            <button onClick={() => { setReceipt(open.sale.id); setOpen(null) }} className="btn-primary">
              {tr('Preview receipt')}
            </button>
          </>}>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {open.items.map((i: any) => (
                <tr key={i.id}>
                  <td className="py-1.5">
                    <span className="text-heading">{i.product_name}</span>
                    <span className="block text-2xs text-muted num">
                      {i.display_qty} × {rs(i.unit_price_paisa)}{i.batch_no && ` · batch ${i.batch_no}`}
                    </span>
                  </td>
                  <td className="py-1.5 text-right num">{rs(i.line_total_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex justify-between border-t border-divide pt-2 text-lg font-semibold">
            <span>{tr('Total')}</span><span className="num text-primary">Rs {rs(open.sale.totalPaisa)}</span>
          </div>
          <p className="mt-2 text-2xs text-muted">
            {open.sale.cashier} · {new Date(open.sale.soldAt).toLocaleString('en-GB')} ·{' '}
            <span className="capitalize">{tr(open.sale.payMethod)}</span>
          </p>
        </Modal>
      )}

      {receipt && <ReceiptPreview saleId={receipt} onClose={() => setReceipt(null)} />}
    </div>
  )
}
