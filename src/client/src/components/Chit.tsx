import { useEffect, useState } from 'react'
import { api, rs } from '../lib/api'
import { Modal, Badge, ErrorNote } from './ui'
import { Slip, SlipHeader, SlipRow, SlipItems, SlipTotal, SlipFooter, Rule } from './Slip'
import { printNow, applyPaper, loadPrinter } from '../lib/printer'
import { t as tr } from '../lib/prefs'

/**
 * The chit, as it comes off the roll printer.
 *
 * Preview first, always: a chit printed against the wrong visit sends the
 * patient to the wrong counter, and paper costs money in a place that counts
 * it. What is on screen is exactly what the printer produces.
 */
export function ChitPreview({ chitId, onClose, onPaid, canTakePayment = false }: {
  chitId: number
  onClose: () => void
  onPaid?: () => void
  /** Only the cash counter settles chits. Reception prints them. */
  canTakePayment?: boolean
}) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    applyPaper(loadPrinter('pharmacy').paper)
    api.chit(chitId).then(setData).catch((e: any) => setErr(e.message))
  }, [chitId])

  if (!data) {
    return (
      <Modal title={tr('Chit')} onClose={onClose}
        footer={<button onClick={onClose} className="btn-ghost">{tr('Close')}</button>}>
        {err ? <ErrorNote>{err}</ErrorNote> : <p className="text-2xs text-muted">{tr('Loading…')}</p>}
      </Modal>
    )
  }

  const { chit, lines, hospital, categoryLabel } = data

  return (
    <Modal title={`${categoryLabel} chit`} hint={chit.chit_no} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        {canTakePayment && chit.status === 'ordered' && onPaid && (
          <button disabled={busy} className="btn-ghost"
            onClick={async () => {
              setBusy(true)
              try { await api.payChit(chit.id); onPaid() }
              catch (e: any) { setErr(e.message) } finally { setBusy(false) }
            }}>
            {busy ? 'Saving…' : 'Take payment'}
          </button>
        )}
        <button onClick={() => printNow('pharmacy')} className="btn-primary">{tr('Print')}</button>
      </>}>
      <div className="mb-3 flex items-center justify-between">
        <Badge tone={chit.status === 'completed' ? 'ok' : chit.status === 'paid' ? 'primary' : 'warn'}>
          {tr(chit.status === 'ordered' ? 'unpaid' : chit.status)}
        </Badge>
        <span className="text-2xs text-muted">{loadPrinter('pharmacy').paper} · {tr('preview is exact')}</span>
      </div>
      <ErrorNote>{err}</ErrorNote>
      <ChitSlip chit={chit} lines={lines} hospital={hospital} categoryLabel={categoryLabel} />
    </Modal>
  )
}

export function ChitSlip({ chit, lines, hospital, categoryLabel }: {
  chit: any; lines: any[]; hospital: any; categoryLabel: string
}) {
  const s = loadPrinter('counter')
  const paid = chit.status === 'paid' || chit.status === 'completed'

  return (
    <Slip>
      {s.showLetterhead && <SlipHeader hospital={hospital} title={categoryLabel} />}

      {/*
        The status line is the first thing the department looks at, so it sits
        at the top in the largest type on the slip rather than in a footer.
        An unpaid chit should not normally be printed at all now that payment
        happens before printing, but if one is, it has to be unmistakable.
      */}
      <div className={`my-1 border-y border-black py-1 text-center text-[15px] font-bold ${
        paid ? '' : 'tracking-widest'}`}>
        {paid ? tr('PAID') : tr('NOT PAID — DO NOT PROCEED')}
      </div>

      <div>
        <SlipRow k={tr('Chit')} v={chit.chit_no} bold />
        <SlipRow k={tr('Date')} v={new Date(chit.paid_at ?? chit.created_at).toLocaleString('en-GB',
          { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} />
      </div>

      <Rule />

      <div>
        <SlipRow k={tr('Patient')} v={chit.patient_name} />
        <SlipRow k={tr('MRN')} v={chit.mrn} />
        <SlipRow k={tr('Token')} v={String(chit.token_no)} />
        {(chit.age_years != null || chit.gender) && (
          <SlipRow k={tr('Age/Sex')} v={[chit.age_years && `${chit.age_years}y`, chit.gender]
            .filter(Boolean).join(' / ')} />
        )}
        {chit.doctor_name && <SlipRow k={tr('Referred by')} v={chit.doctor_name} />}
      </div>

      <Rule />

      <SlipItems items={lines.map((l) => ({ name: l.service_name, total: Number(l.price_paisa) }))} />
      <SlipTotal label={tr('TOTAL')} amount={Number(chit.total_paisa)} />

      {paid ? (
        <>
          <div className="mt-1">
            <SlipRow k={tr('Paid')}
              v={new Date(chit.paid_at).toLocaleString('en-GB',
                { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} />
            {chit.pay_method && <SlipRow k={tr('Paid by')} v={tr(chit.pay_method)} />}
            {chit.paid_by && <SlipRow k={tr('Received by')} v={chit.paid_by} />}
          </div>

          {s.showFooter && (
            <SlipFooter>
              <p className="text-[12px] font-bold">
                {tr('Show this slip at')} {categoryLabel}
              </p>
              <p>{tr('Payment has been received. The department may proceed.')}</p>
            </SlipFooter>
          )}

          {/*
            Filled in by the department, not the counter. It is the only
            written record that the procedure actually happened, and the
            patient keeps a copy of it.
          */}
          <div className="mt-3 border-t border-dashed border-black pt-1 text-[10px]">
            <p className="font-bold">{tr('For department use')}</p>
            <div className="mt-2 flex justify-between gap-2">
              <span className="w-1/2 border-t border-black pt-0.5 text-center">
                {tr('Performed by')}
              </span>
              <span className="w-1/3 border-t border-black pt-0.5 text-center">
                {tr('Date')}
              </span>
            </div>
          </div>

          {chit.status === 'completed' && (
            <p className="mt-2 text-center text-[10px] font-bold">
              {tr('Completed')}
              {chit.completed_by && ` — ${chit.completed_by}`}
            </p>
          )}
        </>
      ) : (
        <SlipFooter>
          <p className="font-bold">{tr('Take this to the main counter and pay first.')}</p>
          <p>{tr('The department will not start until this reads PAID.')}</p>
        </SlipFooter>
      )}

      {Array.from({ length: s.feedLines }).map((_, i) => <div key={i}>&nbsp;</div>)}
    </Slip>
  )
}

/* ------------------------------------------------------------ sale receipt */

/**
 * A pharmacy bill on the same roll.
 *
 * Batch numbers and expiry go on the slip on purpose: a customer returning a
 * medicine, or a recall notice naming a batch, both need the paper to say
 * which batch actually left the shop.
 */
export function ReceiptPreview({ saleId, onClose }: { saleId: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [hospital, setHospital] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    applyPaper(loadPrinter('pharmacy').paper)
    api.ph.sale(saleId).then(setData).catch((e: any) => setErr(e.message))
    api.hospital().then(setHospital).catch(() => {})
  }, [saleId])

  return (
    <Modal title={tr('Receipt')} hint={data?.sale?.invoiceNo} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={() => printNow('pharmacy')} disabled={!data} className="btn-primary">{tr('Print')}</button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      {!data ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <>
          <p className="mb-3 text-right text-2xs text-muted">{loadPrinter('pharmacy').paper} · {tr('preview is exact')}</p>
          <ReceiptSlip sale={data.sale} items={data.items} hospital={hospital} />
        </>
      )}
    </Modal>
  )
}

export function ReceiptSlip({ sale, items, hospital }: {
  sale: any; items: any[]; hospital: any
}) {
  const change = Number(sale.paidPaisa ?? 0) - Number(sale.totalPaisa)
  return (
    <Slip>
      <SlipHeader hospital={hospital} title={tr('Pharmacy')} />

      <div className="mt-1">
        <SlipRow k="Bill" v={sale.invoiceNo} bold />
        <SlipRow k="Date" v={new Date(sale.soldAt).toLocaleString('en-GB',
          { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} />
        <SlipRow k="Served by" v={sale.cashierName ?? '—'} />
        {sale.customerName && <SlipRow k="Customer" v={sale.customerName} />}
        {sale.doctorName && <SlipRow k="Prescriber" v={sale.doctorName} />}
      </div>

      <Rule />

      <div className="space-y-1">
        {items.map((i: any) => (
          <div key={i.id}>
            <div className="truncate">{i.product_name ?? i.productName}</div>
            <div className="flex justify-between">
              <span className="pl-2">
                {i.display_qty ?? i.displayQty} x {rs(i.unit_price_paisa ?? i.unitPricePaisa)}
              </span>
              <span>{rs(i.line_total_paisa ?? i.lineTotalPaisa)}</span>
            </div>

          </div>
        ))}
      </div>

      <Rule />

      <SlipRow k="Subtotal" v={rs(sale.subtotalPaisa)} />
      {Number(sale.discountPaisa) > 0 && <SlipRow k="Discount" v={`-${rs(sale.discountPaisa)}`} />}
      {Number(sale.taxPaisa) > 0 && <SlipRow k="Tax" v={rs(sale.taxPaisa)} />}
      <SlipTotal label={tr('TOTAL')} amount={Number(sale.totalPaisa)} />

      <div className="mt-1">
        <SlipRow k={`Paid (${sale.payMethod})`} v={rs(sale.paidPaisa)} />
        {change > 0 && <SlipRow k="Change" v={rs(change)} bold />}
      </div>

      <SlipFooter>
        <p>{hospital?.receiptFooter ?? 'Get well soon.'}</p>
        <p className="mt-1">{tr('Keep this bill for any return or exchange.')}</p>
      </SlipFooter>
    </Slip>
  )
}
