import { useCallback, useEffect, useRef, useState } from 'react'
import { api, rs, toPaisa, type SessionUser } from '../../lib/api'
import { Card, Empty, ErrorNote, Stat } from '../../components/ui'
import { CounterBillPreview } from '../../components/CounterBill'
import { ChitPreview } from '../../components/Chit'
import { loadPrinter } from '../../lib/printer'
import { t as tr } from '../../lib/prefs'

export type BillTarget =
  | { kind: 'consultation'; visitId: number }
  | { kind: 'chit'; chitId: number }

const METHODS = ['cash', 'card', 'easypaisa', 'jazzcash'] as const

/**
 * The main counter till.
 *
 * Laid out like the pharmacy till on purpose: the same cash-received box in
 * the same place, the same change display, the same one big button. Staff move
 * between these two windows, and a counter that behaves differently for no
 * reason is a counter where mistakes get made.
 *
 * Completing the bill is the moment things change — the invoice is written and
 * the patient joins the queue, or the chit becomes payable at the department.
 * Nothing happens before that button.
 */
export function CounterBilling({ me, target, onDone, onCancel }: {
  me: SessionUser
  target: BillTarget | null
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<any>(null)
  const [tendered, setTendered] = useState('')
  const [method, setMethod] = useState<string>('cash')
  const [discount, setDiscount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const cashBox = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!target) { setDraft(null); return }
    setErr(null); setDone(null); setTendered(''); setDiscount('')
    const load = target.kind === 'consultation'
      ? api.draftForVisit(target.visitId)
      : api.draftForChit(target.chitId)
    load.then((d) => { setDraft(d); setTimeout(() => cashBox.current?.focus(), 50) })
      .catch((e: any) => setErr(e.message))
  }, [target])

  const subtotal = draft ? Number(draft.totalPaisa) : 0
  const off = Math.min(toPaisa(discount), subtotal)
  const total = subtotal - off
  const paid = method === 'cash' ? toPaisa(tendered) : total
  const change = paid - total
  const canComplete = !!draft && (method !== 'cash' || toPaisa(tendered) >= total)

  const complete = useCallback(async () => {
    if (!target || !draft) return
    setBusy(true); setErr(null)
    try {
      const r = await api.completeBill({
        kind: target.kind,
        visitId: target.kind === 'consultation' ? target.visitId : undefined,
        chitId: target.kind === 'chit' ? target.chitId : undefined,
        payMethod: method,
        tenderedPaisa: method === 'cash' ? toPaisa(tendered) : total,
        discountPaisa: off
      })
      setDone(r)
      // At a busy window the preview is a step; the setting decides.
      if (loadPrinter('counter').autoPrint) setPreview(r.bill.id)
    } catch (e: any) {
      setErr(e.message ?? 'Could not complete the bill')
    } finally { setBusy(false) }
    // tendered has to be in here, or the closure keeps the old value and every
    // bill records zero cash received. This exact bug shipped once already.
  }, [target, draft, method, tendered, total, off])

  if (!target) {
    return (
      <div className="p-5">
        <Card title={tr('Billing')}>
          <Empty title={tr('Nothing to bill')}
            hint={tr('Register a patient or open a chit, and it lands here ready to take payment.')} />
        </Card>
      </div>
    )
  }

  if (done) {
    const isConsult = done.bill.kind === 'consultation'
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel w-full max-w-md p-6 text-center">
          <p className="text-2xs uppercase tracking-wide text-muted">{tr('Bill complete')}</p>
          <p className="num mt-1 text-4xl font-semibold text-primary">
            Rs {rs(done.bill.total_paisa)}
          </p>
          <p className="num mt-1 text-sm text-muted">{done.bill.bill_no}</p>

          {Number(done.bill.change_paisa) > 0 && (
            <div className="mt-4 rounded-2xl border-2 border-ok/30 bg-ok/5 p-4">
              <p className="text-2xs uppercase tracking-wide text-ok">{tr('Change to give')}</p>
              <p className="num text-3xl font-semibold text-ok">Rs {rs(done.bill.change_paisa)}</p>
            </div>
          )}

          <p className="mt-4 text-2xs text-body">
            {isConsult
              ? tr('The patient is now in the queue. Send them to the OPD counter.')
              : tr('Give the patient the chit. They can take it to the department now.')}
          </p>

          {/*
            For a chit the slip that matters is the chit itself: it is what the
            patient carries to the department and what the department checks.
            Printing a separate payment receipt as well would give them two
            pieces of paper where one does the job.
          */}
          <button onClick={() => setPreview(done.bill.id)} className="btn-ghost mt-5 w-full">
            {isConsult ? tr('Print receipt') : tr('Print chit')}
          </button>
          <button onClick={() => { setDone(null); onDone() }} className="btn-primary mt-2 w-full">
            {tr('Next patient')}
          </button>
        </div>

        {preview && (isConsult
          ? <CounterBillPreview billId={preview} onClose={() => setPreview(null)} />
          : <ChitPreview chitId={done.bill.chit_id} onClose={() => setPreview(null)} />
        )}
      </div>
    )
  }

  const v = draft?.visit

  return (
    <div className="grid h-full min-h-0 gap-4 p-4 lg:grid-cols-[1fr_360px]">
      <div className="flex min-h-0 flex-col gap-4">
        <Card title={draft ? v.patient_name : tr('Loading…')}
          hint={draft ? `${v.mrn} · ${tr('Token')} ${v.token_no}` : undefined}
          action={<button onClick={onCancel} className="btn-ghost py-1.5 text-2xs">{tr('Cancel')}</button>}>
          <ErrorNote>{err}</ErrorNote>
          {draft && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label={tr('Patient')} value={v.patient_name}
                  sub={[v.age_years && `${v.age_years}y`, v.gender].filter(Boolean).join(' · ')} />
                <Stat label={tr('Doctor')} value={v.doctor_name ?? '—'} sub={draft.kind === 'chit'
                  ? tr('Referred by') : (v.department ?? '')} />
                <Stat label={tr('Type')}
                  value={draft.kind === 'consultation' ? tr('Consultation') : tr('Tests and scans')} />
              </div>

              <table className="mt-4 w-full">
                <thead className="thead-strip">
                  <tr>
                    <th className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted">
                      {tr('Item')}
                    </th>
                    <th className="w-32 px-3 py-2 text-right text-2xs font-medium uppercase tracking-wide text-muted">
                      {tr('Amount')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divide rows-striped anim-rows">
                  {draft.items.map((it: any, i: number) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-sm text-heading">{it.description}</td>
                      <td className="px-3 py-2 text-right num text-sm">{rs(it.amountPaisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      </div>

      <div className="flex min-h-0 flex-col gap-4">
        <div className="card p-4">
          <label className="label">{tr('Payment')}</label>
          <div className="grid grid-cols-2 gap-1">
            {METHODS.map((m) => (
              <button key={m} onClick={() => setMethod(m)}
                className={`rounded-xl px-2 py-1.5 text-2xs capitalize ${
                  method === m ? 'bg-brand text-white'
                               : 'border-2 border-line bg-card text-muted hover:bg-raised'}`}>
                {tr(m)}
              </button>
            ))}
          </div>

          <label className="label mt-3">{tr('Discount')}</label>
          <input value={discount} onChange={(e) => setDiscount(e.target.value)}
            placeholder="0.00" className="field num text-right" />

          {method === 'cash' && (
            <>
              <label className="label mt-3">{tr('Cash received')}</label>
              <input ref={cashBox} value={tendered} onChange={(e) => setTendered(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canComplete) complete() }}
                placeholder="0.00" className="field num text-right text-lg" />
              {toPaisa(tendered) > 0 && (
                <p className={`mt-1 text-right num text-2xs ${change >= 0 ? 'text-ok' : 'text-bad'}`}>
                  {change >= 0
                    ? `${tr('Change to give')} Rs ${rs(change)}`
                    : `${tr('Short by')} Rs ${rs(-change)}`}
                </p>
              )}
            </>
          )}
        </div>

        <div className="panel mt-auto p-4">
          <dl className="space-y-1 text-sm">
            <Row k={tr('Subtotal')} v={rs(subtotal)} />
            {off > 0 && <Row k={tr('Discount')} v={`-${rs(off)}`} />}
            <div className="flex justify-between border-t-2 border-divide pt-2 text-lg font-semibold">
              <dt>{tr('Total')}</dt>
              <dd className="num text-primary">Rs {rs(total)}</dd>
            </div>
          </dl>
          <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>
          <button onClick={complete} disabled={!canComplete || busy}
            className="btn-primary mt-3 w-full py-3">
            {busy ? tr('Saving…') : tr('Complete bill')}
          </button>
          <p className="mt-2 text-center text-2xs text-muted">
            {draft?.kind === 'consultation'
              ? tr('The patient joins the queue when this is completed.')
              : tr('The department can start once this is completed.')}
          </p>
          <p className="mt-1 text-center text-2xs text-muted">{me.displayName}</p>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd className="num text-body">{v}</dd>
    </div>
  )
}
