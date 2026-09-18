import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Modal, ErrorNote } from './ui'
import { t as tr } from '../lib/prefs'

/**
 * The prescription slip.
 *
 * Printed for a patient who is buying medicines somewhere else. Plenty of
 * hospitals have no pharmacy of their own, or a patient simply prefers their
 * usual shop, and the system should not make that awkward — the doctor writes
 * the prescription once and it either goes to the pharmacy inside or onto
 * paper for one outside.
 *
 * Laid out as a nuskha rather than as a receipt: large drug names, the timing
 * spelled out in both scripts, and enough white space that a pharmacist can
 * read it across a counter. A5, because that is what these are written on.
 */

const SLOTS = [
  { key: 'morning', en: 'Morning', ur: 'صبح' },
  { key: 'noon', en: 'Noon', ur: 'دوپہر' },
  { key: 'evening', en: 'Evening', ur: 'شام' }
] as const

function slotsFor(frequency: string | null | undefined) {
  switch ((frequency ?? '').toUpperCase()) {
    case 'TDS': case 'QID': return { morning: true, noon: true, evening: true }
    case 'BD': return { morning: true, noon: false, evening: true }
    case 'OD': return { morning: true, noon: false, evening: false }
    default: return { morning: false, noon: false, evening: false }
  }
}

export function NuskhaPreview({ visitId, draft, onClose }: {
  visitId?: number
  /**
   * The list as it stands on screen.
   *
   * A doctor may want the slip before finishing the consultation — the
   * patient is standing there and the pharmacy is across the road. Reading it
   * back from the server would print an empty sheet, because nothing has been
   * saved yet. So a draft wins when one is given, and the saved copy is used
   * only for reprinting a visit that is already closed.
   */
  draft?: any
  onClose: () => void
}) {
  const [data, setData] = useState<any>(draft ?? null)
  const [hospital, setHospital] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!draft && visitId) {
      api.prescription(visitId).then(setData).catch((e: any) => setErr(e.message))
    }
    api.hospital().then(setHospital).catch(() => {})
  }, [visitId, draft])

  return (
    <Modal title={tr('Prescription')} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={() => window.print()} disabled={!data} className="btn-primary">
          {tr('Print')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      {!data ? <p className="text-2xs text-muted">{tr('Loading…')}</p> : (
        <>
          <p className="mb-3 text-2xs text-muted">
            {tr('For a patient buying medicines outside. Set the paper to A5 in the print dialog.')}
          </p>
          <Nuskha data={data} hospital={hospital} />
        </>
      )}
    </Modal>
  )
}

export function Nuskha({ data, hospital }: { data: any; hospital: any }) {
  const p = data.prescription ?? {}
  const items: any[] = data.items ?? []

  return (
    <div className="print-area nuskha mx-auto bg-white p-6 text-black"
      style={{ width: '148mm' }}>
      <header className="border-b-2 border-black pb-2 text-center">
        <h1 className="text-lg font-bold uppercase">{hospital?.name ?? 'Hospital'}</h1>
        {hospital?.address && <p className="text-[9pt]">{hospital.address}</p>}
        {hospital?.phone && <p className="text-[9pt]">{hospital.phone}</p>}
      </header>

      <div className="mt-2 flex justify-between gap-4 border-b border-black pb-2 text-[9pt]">
        <div>
          <p><span className="font-bold">{p.patient_name}</span></p>
          <p>{p.mrn}
            {p.age_years != null && ` · ${p.age_years} yrs`}
            {p.gender && ` · ${p.gender}`}
          </p>
        </div>
        <div className="text-right">
          <p>{p.doctor_name ?? ''}</p>
          <p>{p.visit_at
            ? new Date(p.visit_at).toLocaleDateString('en-GB',
                { day: '2-digit', month: 'short', year: 'numeric' })
            : new Date().toLocaleDateString('en-GB')}</p>
        </div>
      </div>

      {p.diagnosis && (
        <p className="mt-2 text-[9pt]">
          <span className="font-bold">Dx:</span> {p.diagnosis}
        </p>
      )}
      {p.allergies && (
        <p className="mt-1 border border-black px-2 py-1 text-[9pt] font-bold">
          Allergies: {p.allergies}
        </p>
      )}

      {/* The Rx symbol is what makes a slip read as a prescription here. */}
      <p className="mt-3 text-2xl font-bold leading-none" style={{ fontFamily: 'serif' }}>&#8478;</p>

      <ol className="mt-1 space-y-3">
        {items.map((it, i) => {
          const s = slotsFor(it.frequency)
          const none = !s.morning && !s.noon && !s.evening
          return (
            <li key={it.id ?? i} className="border-b border-dashed border-black/40 pb-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12pt] font-bold">{i + 1}. {it.drug_name}</span>
                <span className="shrink-0 text-[9pt]">
                  {it.qty_prescribed > 1 ? `× ${it.qty_prescribed}` : ''}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-4 text-[9pt]">
                {it.dose && <span>{it.dose}</span>}
                {none ? (
                  <span>{it.frequency === 'STAT' ? 'At once' : 'As needed'}
                    <span className="mr-1 ml-2" style={{ fontFamily: '"Noto Nastaliq Urdu", serif' }}>
                      ضرورت پر
                    </span>
                  </span>
                ) : (
                  <span className="flex gap-2">
                    {SLOTS.filter((sl) => s[sl.key]).map((sl) => (
                      <span key={sl.key} className="border border-black px-1.5">
                        {sl.en}
                        <span className="ml-1" style={{ fontFamily: '"Noto Nastaliq Urdu", serif' }}>
                          {sl.ur}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
                {it.duration_days && <span>{it.duration_days} days</span>}
              </div>
              {it.instructions && (
                <p className="pl-4 text-[8.5pt] italic">{it.instructions}</p>
              )}
            </li>
          )
        })}
      </ol>

      {p.advice && (
        <div className="mt-3 text-[9pt]">
          <span className="font-bold">Advice: </span>{p.advice}
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <div className="w-44 border-t border-black pt-1 text-center text-[9pt]">
          {p.doctor_name ?? ''}
          <span className="block text-[8pt]">{p.specialisation ?? 'Signature'}</span>
        </div>
      </div>

      <p className="mt-3 text-center text-[7.5pt]">
        {hospital?.receiptFooter ?? ''}
      </p>
    </div>
  )
}
