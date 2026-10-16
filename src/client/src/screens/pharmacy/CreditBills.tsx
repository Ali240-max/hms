import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa, today, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Modal, SkeletonRows, Stat, Th } from '../../components/ui'
import { useToast } from '../../lib/toast'
import { t as tr } from '../../lib/prefs'

/**
 * Credit bills: who owes for which bill, and taking the money.
 *
 * Everything that decides what is owed, and whether a payment may be taken,
 * is on the server (services/credit-bills.ts). This screen shows it and asks
 * twice before money is recorded. It never works out a balance of its own
 * beyond showing what the server sent.
 */

const STATUSES = [
  ['open', 'Still owed'], ['outstanding', 'Outstanding'], ['partial', 'Part paid'],
  ['settled', 'Settled'], ['all', 'All']
] as const

const STATUS_TONE: Record<string, 'bad' | 'warn' | 'ok'> = {
  outstanding: 'bad', partial: 'warn', settled: 'ok'
}
const STATUS_LABEL: Record<string, string> = {
  outstanding: 'Outstanding', partial: 'Part paid', settled: 'Settled'
}

const when = (v: any) => v
  ? new Date(v).toLocaleString('en-GB',
      { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—'

export function CreditBills({ me }: { me: SessionUser }) {
  const [status, setStatus] = useState<string>('open')
  const [dated, setDated] = useState(false)
  const [from, setFrom] = useState(today().slice(0, 8) + '01')
  const [to, setTo] = useState(today())
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('newest')
  const [data, setData] = useState<{ rows: any[]; totals: any } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paying, setPaying] = useState<any>(null)
  const [mayReceive, setMayReceive] = useState(false)

  /*
   * Whether to offer the button at all. The server checks payment.receive
   * on every payment regardless; this only stops somebody without the tick
   * being shown a button that will refuse them.
   */
  useEffect(() => {
    api.permissionsFor(me.id)
      .then((d: any) => setMayReceive(me.role === 'admin'
        || (d.allowed ?? []).includes('payment.receive')))
      .catch(() => setMayReceive(me.role === 'admin'))
  }, [me.id, me.role])

  const load = useCallback(() => {
    setErr(null)
    api.ph.creditBills({
      status, q, sort, from: dated ? from : undefined, to: dated ? to : undefined
    }).then(setData).catch((e: any) => { setErr(e.message); setData({ rows: [], totals: {} }) })
  }, [status, q, sort, dated, from, to])

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  const totals = data?.totals ?? {}
  return (
    <div className="space-y-4">
      <Card title={tr('Credit Bills')}
        hint={tr('Bills given on credit and what is still owed on each. A credit bill is not counted as money collected until the payment is received here.')}>
        <div className="flex flex-wrap items-center gap-2">
          {STATUSES.map(([id, label]) => (
            <button key={id} onClick={() => setStatus(id)}
              className={`rounded-xl px-2.5 py-1.5 text-2xs ${
                status === id ? 'bg-brand text-white' : 'border-2 border-line bg-card text-muted hover:bg-screen'}`}>
              {tr(label)}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block flex-1 min-w-48"><span className="label">{tr('Search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Invoice, customer, MRN or phone')} className="field" /></label>
          <label className="flex items-center gap-2 pb-2 text-2xs text-muted">
            <input type="checkbox" checked={dated} onChange={(e) => setDated(e.target.checked)} />
            {tr('Billed between')}
          </label>
          {dated && (
            <>
              <label className="block"><span className="label">{tr('From')}</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                  className="field num w-40" /></label>
              <label className="block"><span className="label">{tr('To')}</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                  className="field num w-40" /></label>
            </>
          )}
          <label className="block"><span className="label">{tr('Sort')}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="field w-40">
              <option value="newest">{tr('Newest')}</option>
              <option value="oldest">{tr('Oldest')}</option>
              <option value="owed_desc">{tr('Most owed first')}</option>
              <option value="owed_asc">{tr('Least owed first')}</option>
            </select></label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={tr('Credit bills')} value={String(totals.bills ?? 0)} />
          <Stat label={tr('Billed on credit')} value={`Rs ${rs(totals.billed_paisa ?? 0)}`} tone="accent" />
          <Stat label={tr('Received')} value={`Rs ${rs(totals.received_paisa ?? 0)}`} tone="ok"
            sub={Number(totals.returned_paisa) > 0
              ? `${tr('Returned')} Rs ${rs(totals.returned_paisa)}` : undefined} />
          <Stat label={tr('Still owed')} value={`Rs ${rs(totals.outstanding_paisa ?? 0)}`} tone="bad" />
        </div>

        <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>

        {!data ? <div className="mt-4"><SkeletonRows rows={6} cols={6} /></div>
          : data.rows.length === 0 ? <Empty title={tr('No credit bills match that')} /> : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr><Th w="w-32">{tr('Invoice')}</Th><Th>{tr('Customer')}</Th>
                  <Th w="w-32">{tr('Billed')}</Th><Th w="w-28">{tr('Billed by')}</Th>
                  <Th w="w-24" right>{tr('Bill')}</Th><Th w="w-24" right>{tr('Received')}</Th>
                  <Th w="w-24" right>{tr('Owed')}</Th><Th w="w-24">{tr('Status')}</Th>
                  <Th w="w-32" right /></tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {data.rows.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2 num text-2xs text-primary">{b.invoice_no}</td>
                    <td className="px-3 py-2 text-sm text-heading">
                      {b.party_name || <span className="text-muted">{tr('Walk-in')}</span>}
                      {(b.mrn || b.customer_phone) && (
                        <span className="block num text-2xs text-muted">
                          {[b.mrn, b.customer_phone].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 num text-2xs text-muted">{when(b.sold_at)}</td>
                    <td className="px-3 py-2 text-2xs text-muted">{b.cashier ?? '—'}</td>
                    <td className="px-3 py-2 text-right num text-sm">{rs(b.total_paisa)}</td>
                    <td className="px-3 py-2 text-right num text-sm text-ok">
                      {Number(b.received_paisa) > 0 ? rs(b.received_paisa) : '—'}
                      {b.last_received_by && (
                        <span className="block text-2xs text-muted">{b.last_received_by}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right num text-sm font-medium text-primary">
                      {rs(b.outstanding_paisa)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[b.credit_status]}>
                        {tr(STATUS_LABEL[b.credit_status] ?? b.credit_status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {Number(b.outstanding_paisa) > 0 && mayReceive && (
                        <button onClick={() => setPaying(b)} className="btn-primary px-2.5 py-1 text-2xs">
                          {tr('Receive payment')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!mayReceive && data && data.rows.some((b) => Number(b.outstanding_paisa) > 0) && (
          <p className="mt-3 text-2xs text-muted">
            {tr('Taking a payment needs the "Take a payment from a customer" tick under Access.')}
          </p>
        )}
      </Card>

      {paying && (
        <ReceiveDialog bill={paying} onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); load() }} />
      )}
    </div>
  )
}

/**
 * Two steps: say what was received, then confirm it.
 *
 * The confirmation names the bill, the customer and the amount in full,
 * because "OK" on a dialog nobody read is how money gets recorded against
 * the wrong bill. The amount owed shown here is sent back with the payment;
 * if the bill has changed in the meantime (somebody else took it, this was
 * pressed twice) the server refuses rather than recording it again.
 */
function ReceiveDialog({ bill, onClose, onDone }: {
  bill: any; onClose: () => void; onDone: () => void
}) {
  const toast = useToast()
  const owed = Number(bill.outstanding_paisa)
  const [amount, setAmount] = useState((owed / 100).toFixed(2))
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const paisa = toPaisa(amount)
  const valid = paisa > 0 && paisa <= owed
  const full = paisa === owed

  async function submit() {
    setBusy(true); setErr(null)
    try {
      const r = await api.ph.receiveCredit(bill.id, {
        amountPaisa: paisa, expectedOutstandingPaisa: owed, method,
        reference: reference.trim() || null, note: note.trim() || null
      })
      toast(r.status === 'settled'
        ? `${r.invoiceNo} ${tr('paid in full')}`
        : `Rs ${rs(paisa)} ${tr('received')} · Rs ${rs(r.outstandingPaisa)} ${tr('still owed')}`, 'ok')
      onDone()
    } catch (e: any) {
      setErr(e.message)
      setConfirming(false)
    } finally { setBusy(false) }
  }

  return (
    <Modal title={confirming ? tr('Confirm payment received') : tr('Receive payment')}
      hint={`${bill.invoice_no} · ${bill.party_name ?? tr('Walk-in')}`}
      onClose={() => { if (!busy) onClose() }}
      footer={confirming ? (
        <>
          <button onClick={() => setConfirming(false)} disabled={busy} className="btn-ghost">
            {tr('Back')}
          </button>
          <button onClick={submit} disabled={busy} className="btn-primary">
            {busy ? tr('Recording…') : `${tr('Yes, record')} Rs ${rs(paisa)}`}
          </button>
        </>
      ) : (
        <>
          <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
          <button onClick={() => setConfirming(true)} disabled={!valid} className="btn-primary">
            {tr('Continue')}
          </button>
        </>
      )}>
      <dl className="grid grid-cols-3 gap-3 rounded-2xl border-2 border-line bg-raised p-3 text-2xs">
        <div><dt className="text-muted">{tr('Bill')}</dt>
          <dd className="num text-sm text-heading">Rs {rs(bill.total_paisa)}</dd></div>
        <div><dt className="text-muted">{tr('Received so far')}</dt>
          <dd className="num text-sm text-ok">Rs {rs(bill.received_paisa)}</dd></div>
        <div><dt className="text-muted">{tr('Owed now')}</dt>
          <dd className="num text-sm font-semibold text-primary">Rs {rs(owed)}</dd></div>
      </dl>

      {confirming ? (
        <div className="mt-4 rounded-2xl border-2 border-primary/30 bg-primary/5 p-4 text-sm">
          <p className="text-heading">
            {tr('Record')} <strong className="num">Rs {rs(paisa)}</strong> {tr('received by')}{' '}
            <strong>{tr(method)}</strong> {tr('against bill')}{' '}
            <strong className="num">{bill.invoice_no}</strong>
            {bill.party_name ? <> {tr('for')} <strong>{bill.party_name}</strong></> : null}?
          </p>
          <p className="mt-2 text-2xs text-muted">
            {full
              ? tr('This settles the bill in full.')
              : `${tr('This is a part payment.')} Rs ${rs(owed - paisa)} ${tr('will still be owed.')}`}
            {' '}{tr('It counts as money collected today, under your name.')}
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">{tr('Amount received (Rs)')}</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
              className="field num text-right text-lg" autoFocus />
            {paisa > owed && (
              <span className="mt-1 block text-2xs text-bad">
                {tr('More than is owed on this bill.')}
              </span>
            )}
            {paisa > 0 && paisa < owed && (
              <span className="mt-1 block text-2xs text-warn">
                {tr('Part payment')} — Rs {rs(owed - paisa)} {tr('will still be owed')}
              </span>
            )}
          </label>
          <label className="block"><span className="label">{tr('Paid by')}</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="field">
              <option value="cash">{tr('cash')}</option>
              <option value="card">{tr('card')}</option>
              <option value="easypaisa">{tr('easypaisa')}</option>
              <option value="jazzcash">{tr('jazzcash')}</option>
              <option value="bank">{tr('bank')}</option>
            </select></label>
          <label className="block"><span className="label">{tr('Reference')}</span>
            <input value={reference} onChange={(e) => setReference(e.target.value)}
              placeholder={tr('Optional. Transaction or cheque number')} className="field" /></label>
          <label className="block"><span className="label">{tr('Note')}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={tr('Optional')} className="field" /></label>
        </div>
      )}
      <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
