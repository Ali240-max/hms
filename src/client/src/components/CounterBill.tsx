import { useEffect, useState } from 'react'
import { api, rs } from '../lib/api'
import { Modal, ErrorNote } from './ui'
import { Slip, SlipHeader, SlipRow, SlipTotal, SlipFooter, Rule } from './Slip'
import { loadPrinter, printNow, applyPaper } from '../lib/printer'
import { t as tr } from '../lib/prefs'

/** A main-counter invoice, on the same roll as everything else. */
export function CounterBillPreview({ billId, onClose }: { billId: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const s = loadPrinter('counter')

  useEffect(() => {
    applyPaper(s.paper)
    api.counterBill(billId).then(setData).catch((e: any) => setErr(e.message))
  }, [billId])

  return (
    <Modal title={tr('Receipt')} hint={data?.bill?.bill_no} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={() => printNow('counter')} disabled={!data} className="btn-primary">
          {tr('Print')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      {!data ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <>
          <p className="mb-3 text-right text-2xs text-muted">
            {s.paper} · {tr('preview is exact')}
          </p>
          <CounterBillSlip bill={data.bill} items={data.items} hospital={data.hospital} />
        </>
      )}
    </Modal>
  )
}

export function CounterBillSlip({ bill, items, hospital }: {
  bill: any; items: any[]; hospital: any
}) {
  const s = loadPrinter('counter')
  const isConsult = bill.kind === 'consultation'
  return (
    <Slip>
      {s.showLetterhead && (
        <SlipHeader hospital={hospital}
          title={isConsult ? tr('Consultation fee') : tr('Tests and scans')} />
      )}

      <div className="mt-1">
        <SlipRow k={tr('Bill')} v={bill.bill_no} bold />
        <SlipRow k={tr('Date')} v={new Date(bill.created_at).toLocaleString('en-GB',
          { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} />
        <SlipRow k={tr('Cashier')} v={bill.cashier_name ?? '—'} />
      </div>

      <Rule />

      <div>
        <SlipRow k={tr('Patient')} v={bill.patient_name ?? '—'} />
        <SlipRow k={tr('MRN')} v={bill.mrn ?? '—'} />
        {bill.token_no != null && <SlipRow k={tr('Token')} v={String(bill.token_no)} />}
        {bill.doctor_name && <SlipRow k={tr('Doctor')} v={bill.doctor_name} />}
      </div>

      <Rule />

      <div className="space-y-1">
        {items.map((i: any) => (
          <div key={i.id} className="flex justify-between gap-2">
            <span className="min-w-0 flex-1 truncate">{i.description}</span>
            <span className="shrink-0">{rs(i.amount_paisa)}</span>
          </div>
        ))}
      </div>

      {Number(bill.discount_paisa) > 0 && (
        <div className="mt-1">
          <SlipRow k={tr('Subtotal')} v={rs(bill.subtotal_paisa)} />
          <SlipRow k={tr('Discount')} v={`-${rs(bill.discount_paisa)}`} />
        </div>
      )}

      <SlipTotal label={tr('TOTAL')} amount={Number(bill.total_paisa)} />

      <div className="mt-1">
        <SlipRow k={`${tr('Paid')} (${tr(bill.pay_method)})`} v={rs(bill.tendered_paisa)} />
        {Number(bill.change_paisa) > 0 && (
          <SlipRow k={tr('Change')} v={rs(bill.change_paisa)} bold />
        )}
      </div>

      {s.showFooter && (
        <SlipFooter>
          {isConsult
            ? <p>{tr('Take this slip to the OPD counter.')}</p>
            : <p>{tr('Show this slip at the department.')}</p>}
          {hospital?.receiptFooter && <p className="mt-1">{hospital.receiptFooter}</p>}
        </SlipFooter>
      )}

      {/* Blank lines so the tear-off does not cut through the total. */}
      {Array.from({ length: s.feedLines }).map((_, i) => <div key={i}>&nbsp;</div>)}
    </Slip>
  )
}
