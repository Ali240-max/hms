import { useCallback, useEffect, useState } from 'react'
import { Search, Printer, Receipt, FileText, Tags } from 'lucide-react'
import { api, rs, today, type SessionUser } from '../../lib/api'
import { Card, Empty, ErrorNote, Modal, Stat, Tabs, Th, SkeletonRows } from '../../components/ui'
import { ChitPreview } from '../../components/Chit'
import { CounterBillPreview } from '../../components/CounterBill'
import { t as tr } from '../../lib/prefs'

/**
 * Everything the counter has taken, searchable, and printable again.
 *
 * Patients lose chits. Somebody books with a doctor, walks out, and is back at
 * the window ten minutes later with nothing in their hand, and until now the
 * only answer was to raise a second chit — which charges them twice and leaves
 * two records of one visit.
 *
 * Searching by name, MRN, phone or bill number and printing the same document
 * again solves it without creating anything new. Nothing here writes: it finds
 * and it reprints.
 */
export function CounterHistory({ me }: { me: SessionUser }) {
  const [kind, setKind] = useState('all')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [chit, setChit] = useState<number | null>(null)
  const [bill, setBill] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.counterBills({ q, kind, from, to })
      .then(setData).catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [q, kind, from, to])

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  const rows: any[] = data?.rows ?? data ?? []
  const totals = data?.totals

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={tr('Bills found')} value={String(rows.length)} count={rows.length} />
        <Stat label={tr('Collected')} value={`Rs ${rs(totals?.total_paisa ?? 0)}`} tone="accent" />
        <Stat label={tr('Cash')} value={`Rs ${rs(totals?.cash_paisa ?? 0)}`} tone="ok" />
      </div>

      <Card title={tr('Bills and chits')}
        hint={tr('Find anything the counter has taken and print it again. Nothing new is created.')}>
        <ErrorNote>{err}</ErrorNote>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="relative min-w-56 flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Name, MRN, phone or bill number')} className="field pl-9" />
          </div>
          <label className="text-2xs text-muted">
            {tr('From')}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="field num ml-1.5 w-36 py-1.5 text-2xs" />
          </label>
          <label className="text-2xs text-muted">
            {tr('To')}
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="field num ml-1.5 w-36 py-1.5 text-2xs" />
          </label>
        </div>

        <Tabs id="counter-history" value={kind} onChange={setKind} className="mb-3 w-fit"
          tabs={[
            { value: 'all', label: tr('Everything') },
            { value: 'consultation', label: tr('Consultations'), icon: Receipt },
            { value: 'chit', label: tr('Chits'), icon: FileText }
          ]} />

        {loading ? <SkeletonRows rows={6} cols={5} />
          : rows.length === 0 ? (
            <Empty title={tr('Nothing matches that')}
              hint={tr('Widen the dates, or search by the patient name instead of the number.')} />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-36">{tr('Bill')}</Th><Th>{tr('Patient')}</Th>
                  <Th w="w-28">{tr('For')}</Th><Th w="w-28">{tr('Taken by')}</Th>
                  <Th w="w-28" right>{tr('Amount')}</Th><Th w="w-32" right />
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped anim-rows">
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2">
                      <span className="num text-2xs text-primary">{b.bill_no}</span>
                      <span className="block num text-2xs text-muted">
                        {new Date(b.created_at).toLocaleString('en-GB',
                          { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{b.patient_name ?? '—'}</span>
                      <span className="block num text-2xs text-muted">
                        {b.mrn}{b.token_no ? ` · ${tr('token')} ${b.token_no}` : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{tr(b.kind)}</td>
                    <td className="px-3 py-2 text-2xs text-muted">{b.cashier_name ?? '—'}</td>
                    <td className="px-3 py-2 text-right num font-medium text-primary">
                      {rs(b.total_paisa)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {/*
                        Reprints the document that already exists. It does not
                        raise a new one, so a patient who lost their chit is
                        not charged a second time and the day's takings still
                        reconcile.
                      */}
                      <button
                        onClick={() => b.chit_id ? setChit(b.chit_id) : setBill(b.id)}
                        className="btn-ghost inline-flex items-center gap-1.5 px-2 py-1 text-2xs">
                        <Printer size={13} /> {tr('Print again')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {chit && <ChitPreview chitId={chit} onClose={() => setChit(null)} />}
      {bill && <CounterBillPreview billId={bill} onClose={() => setBill(null)} />}
    </div>
  )
}

/* ---------------------------------------------------------------- labels */

/**
 * Printing labels for a patient.
 *
 * Both sheets go on plain A4 and both are sized in centimetres, because the
 * sizes they were specified in are impossible as inches: three columns of
 * 6.1in is 18.3in across a sheet 8.27in wide. As centimetres they land on
 * 20.9 x 29.5 of a 21 x 29.7 page, which is what die-cut sticker paper is.
 */
export function PatientLabels({ patient, visitId, onClose }: {
  patient: any; visitId?: number | null; onClose: () => void
}) {
  const [from, setFrom] = useState(1)
  const [diagnosis, setDiagnosis] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function grab(path: string, name: string) {
    setBusy(true); setErr(null)
    try {
      const [pathname, query] = path.split('?')
      const { ticket } = await api.documentTicket(pathname)
      const a = document.createElement('a')
      a.href = `/api${pathname}?${query ? query + '&' : ''}download=1` +
        `&ticket=${encodeURIComponent(ticket)}`
      a.download = name
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={tr('Print labels')} hint={`${patient.name} · ${patient.mrn}`} onClose={onClose}
      footer={<button onClick={onClose} className="btn-ghost">{tr('Close')}</button>}>
      <ErrorNote>{err}</ErrorNote>

      <div className="rounded-xl border-2 border-line p-3">
        <p className="text-sm font-medium text-heading">{tr('Patient stickers')}</p>
        <p className="mt-0.5 text-2xs text-muted">
          {tr('21 to a sheet, three across and seven down, 6.1 x 3.5 cm each. Hospital name, patient name, age, MRN and address.')}
        </p>

        {/*
          Part-used sheets are the normal case once a roll has been broken
          into, so printing can start at any position rather than wasting
          whatever is left.
        */}
        <label className="mt-3 block text-2xs text-muted">
          {tr('Start at sticker')}
          <input type="number" min={1} max={21} value={from}
            onChange={(e) => setFrom(Math.min(21, Math.max(1, Number(e.target.value) || 1)))}
            className="field num ml-2 w-20 py-1 text-2xs" />
          <span className="ml-2">{tr('so a part-used sheet is not wasted')}</span>
        </label>

        <button disabled={busy}
          onClick={() => grab(`/patients/${patient.id}/stickers/pdf?from=${from}`,
            `${patient.mrn}-stickers.pdf`)}
          className="btn-primary mt-3 inline-flex items-center gap-1.5">
          <Tags size={14} /> {busy ? tr('Preparing…') : tr('Download sticker sheet')}
        </button>
      </div>

      {visitId && (
        <div className="mt-4 rounded-xl border-2 border-line p-3">
          <p className="text-sm font-medium text-heading">{tr('Ward labels')}</p>
          <p className="mt-0.5 text-2xs text-muted">
            {tr('Three to a sheet: bed and door at 14.5 x 7 cm, and a smaller one at 9.5 x 4.7 cm for the file.')}
          </p>

          <label className="mt-3 block text-2xs text-muted">
            {tr('Diagnosis, if there is one yet')}
            <input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)}
              placeholder={tr('Left blank it prints a dash, to be written in by hand')}
              className="field mt-1 text-2xs" />
          </label>

          <button disabled={busy}
            onClick={() => grab(
              `/visits/${visitId}/ward-labels/pdf?diagnosis=${encodeURIComponent(diagnosis)}`,
              `${patient.mrn}-ward-labels.pdf`)}
            className="btn-primary mt-3 inline-flex items-center gap-1.5">
            <Tags size={14} /> {busy ? tr('Preparing…') : tr('Download ward labels')}
          </button>
        </div>
      )}

      <p className="mt-4 text-2xs text-muted">
        {tr('Both print on plain A4 at 100% scale. Do not let the printer "fit to page", or every measurement shifts.')}
      </p>
    </Modal>
  )
}
