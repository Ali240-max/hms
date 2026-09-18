import { useCallback, useEffect, useState } from 'react'
import { api, rs, toPaisa, today, type SessionUser } from '../../lib/api'
import { Badge, Card, Empty, ErrorNote, Field, Modal, Stat, Th, SkeletonRows } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Customer and supplier ledgers.
 *
 * A balance here is the sum of the entries, computed when the statement is
 * opened. Nothing keeps a running total on a master row, so a receipt entered
 * late corrects every line after it rather than leaving two numbers that
 * disagree.
 */
export function Ledgers({ me }: { me: SessionUser }) {
  const [side, setSide] = useState<'customer' | 'supplier'>('customer')
  const [rows, setRows] = useState<any[]>([])
  const [open, setOpen] = useState<any | null>(null)
  const [paying, setPaying] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.outstandingParties(side).then(setRows).finally(() => setLoading(false))
  }, [side])
  useEffect(load, [load])

  const owed = rows.reduce((n, r) => n + Math.max(0, Number(r.balance_paisa)), 0)
  const advance = rows.reduce((n, r) => n + Math.min(0, Number(r.balance_paisa)), 0)

  return (
    <div className="space-y-4 p-4">
      <div className="flex gap-1">
        {(['customer', 'supplier'] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
              side === s ? 'bg-brand text-white'
                : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            {s === 'customer' ? tr('Customers') : tr('Suppliers')}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={side === 'customer' ? tr('Owed to us') : tr('We owe')}
          value={`Rs ${rs(owed)}`} tone={owed ? 'warn' : 'ok'} />
        <Stat label={tr('Paid in advance')} value={`Rs ${rs(-advance)}`} />
        <Stat label={tr('Accounts with a balance')} value={String(rows.length)} />
      </div>

      <Card title={side === 'customer' ? tr('Customer balances') : tr('Supplier balances')}
        hint={tr('Only accounts that are not square')}>
        <ErrorNote>{err}</ErrorNote>
        {loading ? <SkeletonRows rows={5} cols={5} />
          : rows.length === 0 ? <Empty title={tr('Everything is settled')} /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th>{tr('Account Title')}</Th><Th w="w-32" right>{tr('Debit')}</Th>
                  <Th w="w-32" right>{tr('Credit')}</Th><Th w="w-32" right>{tr('Balance')}</Th>
                  <Th w="w-28">{tr('Last Entry')}</Th><Th w="w-44" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((r) => {
                  const bal = Number(r.balance_paisa)
                  return (
                    <tr key={r.party_ref}>
                      <td className="px-3 py-2 text-sm text-heading">{r.name}</td>
                      <td className="px-3 py-2 text-right num text-2xs">{rs(r.debit_paisa)}</td>
                      <td className="px-3 py-2 text-right num text-2xs">{rs(r.credit_paisa)}</td>
                      <td className={`px-3 py-2 text-right num text-sm font-medium ${
                        bal > 0 ? 'text-warn' : bal < 0 ? 'text-ok' : 'text-muted'}`}>
                        {rs(Math.abs(bal))}
                        <span className="ml-1 text-2xs font-normal">
                          {bal > 0 ? tr('Dr') : bal < 0 ? tr('Cr') : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 num text-2xs text-muted">{r.last_movement ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setOpen(r)} className="btn-ghost px-2 py-1 text-2xs">
                          {tr('Statement')}
                        </button>
                        <button onClick={() => setPaying(r)}
                          className="ml-1 btn-primary px-2 py-1 text-2xs">
                          {side === 'customer' ? tr('Receive') : tr('Pay')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <Statement side={side} party={open} onClose={() => setOpen(null)} />}
      {paying && (
        <TakePayment side={side} party={paying} me={me}
          onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); load() }} />
      )}
    </div>
  )
}

function Statement({ side, party, onClose }: { side: string; party: any; onClose: () => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(today())
  const [d, setD] = useState<any>(null)

  useEffect(() => {
    api.ledger(side, party.party_ref, { from: from || undefined, to: to || undefined })
      .then(setD).catch(() => {})
  }, [side, party, from, to])

  return (
    <Modal title={`${tr('Statement')} — ${party.name}`} wide onClose={onClose}
      footer={<button onClick={onClose} className="btn-ghost">{tr('Close')}</button>}>
      <div className="flex items-end gap-2">
        <label className="block"><span className="label">{tr('From')}</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="field num w-36 py-1.5 text-2xs" /></label>
        <label className="block"><span className="label">{tr('To')}</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="field num w-36 py-1.5 text-2xs" /></label>
        {d && (
          <span className="ml-auto text-right">
            <span className="label">{tr('Closing balance')}</span>
            <span className={`block num text-xl font-semibold ${
              d.closingPaisa > 0 ? 'text-warn' : 'text-ok'}`}>
              Rs {rs(Math.abs(d.closingPaisa))} {d.closingPaisa > 0 ? tr('Dr') : tr('Cr')}
            </span>
          </span>
        )}
      </div>

      {!d ? <p className="mt-4 text-2xs text-muted">{tr('Loading…')}</p> : (
        <table className="mt-4 w-full">
          <thead className="thead-strip">
            <tr>
              <Th w="w-28">{tr('Date')}</Th><Th>{tr('Particulars')}</Th>
              <Th w="w-28" right>{tr('Debit')}</Th><Th w="w-28" right>{tr('Credit')}</Th>
              <Th w="w-32" right>{tr('Balance')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped anim-rows">
            <tr>
              <td className="px-3 py-2 text-2xs text-muted" colSpan={4}>
                {tr('Opening balance')}
              </td>
              <td className="px-3 py-2 text-right num text-2xs font-medium">
                {rs(d.openingPaisa)}
              </td>
            </tr>
            {d.lines.map((l: any) => (
              <tr key={l.id}>
                <td className="px-3 py-2 num text-2xs text-muted">{l.entry_date}</td>
                <td className="px-3 py-2 text-2xs text-body">{l.description}</td>
                <td className="px-3 py-2 text-right num text-2xs">
                  {Number(l.debit_paisa) ? rs(l.debit_paisa) : ''}
                </td>
                <td className="px-3 py-2 text-right num text-2xs">
                  {Number(l.credit_paisa) ? rs(l.credit_paisa) : ''}
                </td>
                <td className="px-3 py-2 text-right num text-2xs font-medium text-primary">
                  {rs(l.balance_paisa)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line bg-raised">
              <td className="px-3 py-2 text-2xs font-semibold text-muted" colSpan={2}>
                {tr('Total')}
              </td>
              <td className="px-3 py-2 text-right num text-2xs font-semibold">
                {rs(d.totals.debit)}
              </td>
              <td className="px-3 py-2 text-right num text-2xs font-semibold">
                {rs(d.totals.credit)}
              </td>
              <td className="px-3 py-2 text-right num text-2xs font-semibold text-primary">
                {rs(d.closingPaisa)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </Modal>
  )
}

function TakePayment({ side, party, me, onClose, onDone }: {
  side: string; party: any; me: SessionUser; onClose: () => void; onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const due = Math.abs(Number(party.balance_paisa))

  return (
    <Modal title={side === 'customer' ? tr('Receive payment') : tr('Pay supplier')}
      hint={party.name} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || toPaisa(amount) <= 0} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.recordPayment({
                kind: side === 'customer' ? 'receipt' : 'payment',
                partyKind: side, partyRef: party.party_ref,
                amountPaisa: toPaisa(amount), method,
                reference: reference.trim() || null
              })
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Record it')}
        </button>
      </>}>
      <div className="card-tint p-3">
        <p className="text-2xs uppercase tracking-wide text-muted">
          {side === 'customer' ? tr('They owe') : tr('We owe')}
        </p>
        <p className="num text-2xl font-semibold text-primary">Rs {rs(due)}</p>
      </div>

      <Field label={tr('Amount')} span>
        <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00" className="field num mt-2 text-right text-lg" />
      </Field>
      <button onClick={() => setAmount(String(due / 100))}
        className="btn-ghost mt-1 text-2xs">{tr('Settle in full')}</button>

      <label className="label mt-3">{tr('How')}</label>
      <div className="grid grid-cols-4 gap-1">
        {['cash', 'cheque', 'bank', 'easypaisa'].map((m) => (
          <button key={m} onClick={() => setMethod(m)}
            className={`rounded-xl px-2 py-1.5 text-2xs capitalize ${
              method === m ? 'bg-brand text-white'
                : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
            {tr(m)}
          </button>
        ))}
      </div>

      <Field label={tr('Reference')} hint={tr('Cheque number, slip number')} span>
        <input value={reference} onChange={(e) => setReference(e.target.value)}
          className="field mt-2" />
      </Field>

      <p className="mt-3 text-2xs text-muted">
        {tr('A voucher number is issued and the ledger is posted at once.')} {me.displayName}
      </p>
      <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>
    </Modal>
  )
}
