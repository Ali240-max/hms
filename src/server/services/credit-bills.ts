import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { documentNo } from './numbering'
import { postLedger } from './pharma'

/**
 * Pharmacy credit bills: what is owed on each, and taking the money.
 *
 * A credit bill is a sale with nothing taken at the counter: `sale_kind =
 * 'credit'` (written by the rebuilt pharmacy and the demo, against a customer
 * account) or `pay_method = 'credit'` (written by the till, which never set
 * the kind). Bills issued to a hospital department are NOT credit bills even
 * though nothing is taken for them either — nobody is going to walk in and
 * pay for the OT's saline — so they are excluded here and reported on their
 * own.
 *
 * What is outstanding is worked out, never stored:
 *
 *     total − returned − received (sale_payments)
 *
 * Deliberately not from `paid_paisa`. The till used to write paid_paisa =
 * total on every credit bill, so the column says "paid" on bills nobody has
 * paid; trusting it would show every old credit bill as settled. Those rows
 * are left exactly as they were billed, and the money that actually comes in
 * against them is recorded as its own dated row.
 *
 * The collected-money rule follows from this: a credit bill contributes
 * nothing to "collected" on the day it is made, and each payment contributes
 * its amount on the day it is RECEIVED. The bill's total is never counted as
 * collected, so a bill and its later payment can never be counted twice.
 */

export class CreditBillError extends Error {
  constructor(message: string, public code:
    'NOT_FOUND' | 'NOT_CREDIT' | 'CANCELLED' | 'ALREADY_SETTLED' | 'STALE' | 'TOO_MUCH' | 'BAD_INPUT') {
    super(message)
  }
}

/** Is this sale (alias `a`) a customer credit bill? */
export const isCreditBill = (a = 'sa'): SQL =>
  sql.raw(`((${a}.sale_kind = 'credit' OR ${a}.pay_method = 'credit')
            AND ${a}.sale_kind <> 'department' AND ${a}.department_id IS NULL)`)

/**
 * Was money taken for this sale (alias `a`) at the counter, when it was made?
 * False for credit bills and for bills issued to a department.
 */
export const paidAtSale = (a = 'sa'): SQL =>
  sql.raw(`(${a}.pay_method <> 'credit' AND ${a}.sale_kind NOT IN ('credit', 'department')
            AND ${a}.department_id IS NULL)`)

/** Live: not voided, not cancelled. */
const LIVE = sql`sa.status <> 'voided' AND sa.cancelled_at IS NULL`

/** The per-bill figures, as a lateral join on `sa`. */
const FIGURES = sql`
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sp.amount_paisa), 0)::bigint AS received_paisa,
           MAX(sp.received_at) AS last_received_at,
           COUNT(*)::int AS payment_count
    FROM sale_payments sp WHERE sp.sale_id = sa.id) rcv ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sr.total_paisa), 0)::bigint AS returned_paisa
    FROM sale_returns sr WHERE sr.sale_id = sa.id) ret ON true`

const OUTSTANDING = sql`GREATEST(0, sa.total_paisa - ret.returned_paisa - rcv.received_paisa)`
const STATUS = sql`CASE WHEN ${OUTSTANDING} = 0 THEN 'settled'
                        WHEN rcv.received_paisa > 0 THEN 'partial'
                        ELSE 'outstanding' END`

export type CreditStatus = 'open' | 'outstanding' | 'partial' | 'settled' | 'all'

/** Every credit bill matching the filters, with what is owed on each. */
export async function listCreditBills(opts: {
  status?: CreditStatus; q?: string; from?: string; to?: string
  sort?: 'newest' | 'oldest' | 'owed_desc' | 'owed_asc'
} = {}) {
  const status = opts.status ?? 'open'
  let where = sql`${LIVE} AND ${isCreditBill('sa')}`
  if (opts.from && opts.to) {
    where = sql`${where} AND sa.sold_at >= ${opts.from}::date
                         AND sa.sold_at < (${opts.to}::date + interval '1 day')`
  }
  const q = (opts.q ?? '').trim()
  if (q) {
    const like = `%${q}%`
    where = sql`${where} AND (sa.invoice_no ILIKE ${like} OR sa.customer_name ILIKE ${like}
                              OR sa.customer_phone ILIKE ${like} OR p.mrn ILIKE ${like}
                              OR p.name ILIKE ${like} OR pt.name ILIKE ${like})`
  }
  let having = sql`true`
  if (status === 'open') having = sql`${OUTSTANDING} > 0`
  else if (status !== 'all') having = sql`${STATUS} = ${status}`

  const order = ({
    newest: sql`sa.sold_at DESC`,
    oldest: sql`sa.sold_at ASC`,
    owed_desc: sql`outstanding_paisa DESC, sa.sold_at DESC`,
    owed_asc: sql`outstanding_paisa ASC, sa.sold_at DESC`
  } as Record<string, SQL>)[opts.sort ?? 'newest'] ?? sql`sa.sold_at DESC`

  const rows = (await db.execute<any>(sql`
    SELECT sa.id, sa.invoice_no, sa.sold_at, sa.total_paisa, sa.pay_method, sa.sale_kind,
           sa.cashier, sa.cashier_staff_id, sa.customer_name, sa.customer_phone,
           COALESCE(pt.name, p.name, sa.customer_name) AS party_name,
           p.mrn, pt.name AS account_name,
           rcv.received_paisa, rcv.last_received_at, rcv.payment_count,
           ret.returned_paisa,
           ${OUTSTANDING}::bigint AS outstanding_paisa,
           ${STATUS} AS credit_status,
           (SELECT sp.received_by FROM sale_payments sp WHERE sp.sale_id = sa.id
            ORDER BY sp.received_at DESC, sp.id DESC LIMIT 1) AS last_received_by,
           (SELECT sp.method FROM sale_payments sp WHERE sp.sale_id = sa.id
            ORDER BY sp.received_at DESC, sp.id DESC LIMIT 1) AS last_method
    FROM sales sa
    LEFT JOIN patients p ON p.id = sa.patient_id
    LEFT JOIN parties pt ON pt.id = sa.party_id
    ${FIGURES}
    WHERE ${where} AND ${having}
    ORDER BY ${order}
    LIMIT 500`)).rows as any[]

  const totals = rows.reduce((t, r) => ({
    bills: t.bills + 1,
    billed_paisa: t.billed_paisa + Number(r.total_paisa),
    returned_paisa: t.returned_paisa + Number(r.returned_paisa),
    received_paisa: t.received_paisa + Number(r.received_paisa),
    outstanding_paisa: t.outstanding_paisa + Number(r.outstanding_paisa)
  }), { bills: 0, billed_paisa: 0, returned_paisa: 0, received_paisa: 0, outstanding_paisa: 0 })

  return { rows, totals }
}

/** One credit bill with its payments, for the confirmation dialog and the detail view. */
export async function creditBill(saleId: number) {
  const bill = ((await db.execute<any>(sql`
    SELECT sa.*, COALESCE(pt.name, p.name, sa.customer_name) AS party_name, p.mrn,
           rcv.received_paisa, ret.returned_paisa,
           ${OUTSTANDING}::bigint AS outstanding_paisa, ${STATUS} AS credit_status,
           ${isCreditBill('sa')} AS is_credit
    FROM sales sa
    LEFT JOIN patients p ON p.id = sa.patient_id
    LEFT JOIN parties pt ON pt.id = sa.party_id
    ${FIGURES}
    WHERE sa.id = ${saleId}`)).rows as any[])[0]
  if (!bill) throw new CreditBillError('Bill not found', 'NOT_FOUND')
  const payments = (await db.execute<any>(sql`
    SELECT * FROM sale_payments WHERE sale_id = ${saleId} ORDER BY received_at, id`)).rows
  return { bill, payments }
}

/**
 * Take money against one credit bill.
 *
 * Guarded three ways, all on the server:
 *
 *  - The sale row is locked FOR UPDATE, so two counters receiving the same
 *    bill at once are serialised and the second sees what the first took.
 *  - The caller states the outstanding amount it showed in its confirmation
 *    dialog. If that is no longer what is owed — the same confirmation sent
 *    twice, a second tab, somebody else got there first — it is refused
 *    rather than taken again. That is what makes a double click harmless.
 *  - The amount may not exceed what is owed. Less is a part payment and
 *    leaves the bill partly paid, never marked settled.
 *
 * When the bill sits on a customer account that carries a ledger (it was
 * debited there when it was made), a receipt voucher and a ledger credit are
 * written in the same transaction, so the account balance and the bill agree.
 */
export async function receiveCreditPayment(input: {
  saleId: number
  amountPaisa: number
  expectedOutstandingPaisa: number
  method?: string
  reference?: string | null
  note?: string | null
  by: string
  byStaffId?: number | null
  /** Demo only: when it was received. Everything real is now(). */
  at?: Date
}) {
  if (!Number.isInteger(input.amountPaisa) || input.amountPaisa <= 0) {
    throw new CreditBillError('Enter an amount above zero', 'BAD_INPUT')
  }
  return db.transaction(async (tx) => {
    const sale = ((await tx.execute<any>(sql`
      SELECT * FROM sales WHERE id = ${input.saleId} FOR UPDATE`)).rows as any[])[0]
    if (!sale) throw new CreditBillError('Bill not found', 'NOT_FOUND')

    const credit = ((await tx.execute<any>(sql`
      SELECT ${isCreditBill('sa')} AS ok FROM sales sa WHERE sa.id = ${sale.id}`)).rows as any[])[0]
    if (!credit?.ok) {
      throw new CreditBillError(`${sale.invoice_no} is not a credit bill`, 'NOT_CREDIT')
    }
    if (sale.cancelled_at || sale.status === 'voided') {
      throw new CreditBillError(`${sale.invoice_no} was cancelled`, 'CANCELLED')
    }

    const owed = ((await tx.execute<any>(sql`
      SELECT GREATEST(0, sa.total_paisa
               - COALESCE((SELECT SUM(total_paisa) FROM sale_returns WHERE sale_id = sa.id), 0)
               - COALESCE((SELECT SUM(amount_paisa) FROM sale_payments WHERE sale_id = sa.id), 0)
             )::bigint AS owed
      FROM sales sa WHERE sa.id = ${sale.id}`)).rows as any[])[0].owed
    const outstanding = Number(owed)

    if (outstanding <= 0) {
      throw new CreditBillError(`${sale.invoice_no} is already fully paid`, 'ALREADY_SETTLED')
    }
    if (outstanding !== input.expectedOutstandingPaisa) {
      throw new CreditBillError(
        `${sale.invoice_no} has changed since it was opened: Rs ${(outstanding / 100).toFixed(2)} ` +
        'is owed now. Nothing was recorded — check the bill and confirm again.', 'STALE')
    }
    if (input.amountPaisa > outstanding) {
      throw new CreditBillError(
        `Only Rs ${(outstanding / 100).toFixed(2)} is owed on ${sale.invoice_no}`, 'TOO_MUCH')
    }

    const at = input.at ? sql`${input.at.toISOString()}::timestamptz` : sql`now()`
    const method = input.method ?? 'cash'

    /* The customer account, when this bill was posted to one. */
    let paymentId: number | null = null
    const onLedger = sale.party_id && ((await tx.execute<any>(sql`
      SELECT 1 FROM ledger_entries
      WHERE party_kind = 'customer' AND party_ref = ${sale.party_id}
        AND source = 'sale' AND source_id = ${sale.id} LIMIT 1`)).rows as any[]).length > 0
    if (onLedger) {
      const voucherNo = await documentNo(tx, { prefix: 'RV', letter: 'R', when: input.at })
      const v = ((await tx.execute<any>(sql`
        INSERT INTO payments (voucher_no, kind, party_kind, party_ref, amount_paisa,
                              method, reference, note, created_by, created_at)
        VALUES (${voucherNo}, 'receipt', 'customer', ${sale.party_id}, ${input.amountPaisa},
                ${method}, ${input.reference ?? null},
                ${'Against ' + sale.invoice_no + (input.note ? ' — ' + input.note : '')},
                ${input.by}, ${at})
        RETURNING *`)).rows as any[])[0]
      paymentId = Number(v.id)
      await postLedger({
        tx, partyKind: 'customer', partyRef: sale.party_id,
        description: `Received — ${voucherNo} against ${sale.invoice_no}`,
        creditPaisa: input.amountPaisa, source: 'payment', sourceId: v.id, by: input.by,
        entryDate: input.at ? input.at.toISOString().slice(0, 10) : undefined
      })
    }

    const row = ((await tx.execute<any>(sql`
      INSERT INTO sale_payments
        (sale_id, amount_paisa, method, outstanding_before_paisa, reference, note,
         payment_id, received_by, received_by_staff_id, received_at)
      VALUES (${sale.id}, ${input.amountPaisa}, ${method}, ${outstanding},
              ${input.reference ?? null}, ${input.note ?? null}, ${paymentId},
              ${input.by}, ${input.byStaffId ?? null}, ${at})
      RETURNING *`)).rows as any[])[0]

    const left = outstanding - input.amountPaisa
    return {
      payment: row, invoiceNo: sale.invoice_no,
      outstandingPaisa: left, status: left === 0 ? 'settled' : 'partial'
    }
  })
}

/**
 * Credit payments received in a window, as money collected.
 *
 * Counted by the day the money came in, which is what makes the collected
 * figures add up: a bill made on Monday and paid on Thursday is Thursday's
 * money and nobody else's.
 */
export async function creditReceivedIn(w: { from: string; to: string }) {
  const r = (await db.execute<any>(sql`
    SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount_paisa), 0)::bigint AS received_paisa
    FROM sale_payments
    WHERE received_at >= ${w.from}::date AND received_at < (${w.to}::date + interval '1 day')`))
    .rows as any[]
  return { payments: Number(r[0].payments), receivedPaisa: Number(r[0].received_paisa) }
}

/* ---------------------------------------------------------------- reports */

/** The Credit Bills report: one row per bill with who made it and who was paid. */
export async function creditBillReport(w: { from: string; to: string }, q: Record<string, string>) {
  const { rows } = await listCreditBills({
    from: w.from, to: w.to, q: q.q ?? '',
    status: (['outstanding', 'partial', 'settled', 'open'].includes(q.status)
      ? q.status : 'all') as CreditStatus,
    sort: 'oldest'
  })
  const fmt = (t: any) => t ? new Date(t).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const label: Record<string, string> = {
    outstanding: 'Outstanding', partial: 'Part paid', settled: 'Settled' }
  return rows.map((r) => ({
    ...r,
    sold_at: fmt(r.sold_at),
    last_received_at: fmt(r.last_received_at),
    party_name: r.party_name || 'Walk-in',
    customer_ref: r.mrn ?? r.customer_phone ?? '',
    status_label: label[r.credit_status] ?? r.credit_status,
    last_received_by: r.last_received_by ?? '—',
    last_method: r.last_method ?? '—',
    cashier: r.cashier ?? '—'
  }))
}

export async function creditBillStats(w: { from: string; to: string }, q: Record<string, string>) {
  const rows = await creditBillReport(w, q)
  const received = await creditReceivedIn(w)
  const sum = (k: string) => rows.reduce((n: number, r: any) => n + Number(r[k]), 0)
  return {
    bills: rows.length,
    billed_paisa: sum('total_paisa'),
    received_on_these_paisa: sum('received_paisa'),
    outstanding_paisa: sum('outstanding_paisa'),
    outstanding_bills: rows.filter((r: any) => r.credit_status === 'outstanding').length,
    part_paid_bills: rows.filter((r: any) => r.credit_status === 'partial').length,
    settled_bills: rows.filter((r: any) => r.credit_status === 'settled').length,
    collected_in_period_paisa: received.receivedPaisa
  }
}
