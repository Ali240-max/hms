import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Badge, Card, Empty, Th } from '../../components/ui'
import { t as tr } from '../../lib/prefs'

/**
 * Prescriptions waiting to be filled.
 *
 * Opening one loads its medicines into the till. Lines the doctor wrote as free
 * text, or that are out of stock, are flagged rather than dropped silently:
 * the pharmacist needs to see what could not be filled.
 */
export function Prescriptions({ onFill }: {
  onFill: (p: { visitId: number; patientId: number; patientName: string; doctorName: string; items: any[] }) => void
}) {
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.pharmacyQueue(q).then(setRows).finally(() => setLoading(false))
  }, [q])
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  useEffect(() => {
    // The queue moves while the pharmacist is standing there.
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (openId == null) { setDetail(null); return }
    api.prescription(openId).then(setDetail).catch(() => setDetail(null))
  }, [openId])

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_400px]">
      <Card title={tr('Prescriptions to fill')}
        hint={loading ? 'Loading…' : `${rows.length} waiting`}
        action={
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Name, MRN, token or phone')}
            className="field w-64 py-1.5 text-2xs" />
        }>
        {rows.length === 0 && !loading ? (
          <Empty title={q ? `Nobody matching "${q}"` : 'Nothing waiting'}
            hint={q
              ? 'Clear the search to see the whole queue.'
              : 'Prescriptions appear here as soon as a doctor saves a consultation.'} />
        ) : (
          <table className="w-full">
            <thead className="thead-strip">
              <tr><Th w="w-20">{tr('Token')}</Th><Th>{tr('Patient')}</Th><Th w="w-44">{tr('Doctor')}</Th>
                <Th w="w-20" right>{tr('Items')}</Th><Th w="w-24">{tr('Waiting')}</Th></tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped anim-rows">
              {rows.map((p) => {
                const mins = Math.round((Date.now() - new Date(p.prescribed_at).getTime()) / 60000)
                return (
                  <tr key={p.visit_id} onClick={() => setOpenId(p.visit_id)}
                    className={`cursor-pointer hover:bg-screen ${openId === p.visit_id ? 'bg-primary/5' : ''}`}>
                    <td className="px-3 py-2 num text-sm font-medium text-primary">{p.token_no}</td>
                    <td className="px-3 py-2">
                      <span className="text-sm text-heading">{p.patient_name}</span>
                      <span className="block num text-2xs text-muted">{p.mrn}</span>
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{p.doctor_name}</td>
                    <td className="px-3 py-2 text-right num text-2xs">{p.pending_items}</td>
                    <td className="px-3 py-2">
                      <Badge tone={mins > 30 ? 'warn' : undefined}>
                        {mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} hr`}
                      </Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={detail ? detail.prescription.patient_name : 'Prescription'}
        hint={detail
          ? `${detail.prescription.mrn} · token ${detail.prescription.token_no} · ${detail.prescription.doctor_name}`
          : 'Pick one from the list'}>
        {!detail ? (
          <Empty title={tr('Nothing selected')} />
        ) : (
          <>
            {detail.prescription.diagnosis && (
              <div className="card-tint mb-3 p-3">
                <p className="text-2xs uppercase tracking-wide text-muted">{tr('Diagnosis')}</p>
                <p className="text-sm text-heading">{detail.prescription.diagnosis}</p>
              </div>
            )}
            {detail.prescription.allergies && (
              <div className="mb-3 rounded-xl border border-bad/25 bg-bad/5 p-3">
                <p className="text-2xs uppercase tracking-wide text-bad">{tr('Allergies')}</p>
                <p className="text-sm text-bad">{detail.prescription.allergies}</p>
              </div>
            )}
            <ul className="divide-y divide-divide">
              {detail.items.map((i: any) => (
                <li key={i.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-heading">{i.drug_name}</p>
                    <p className="text-2xs text-muted">
                      {[i.dose, i.frequency, i.duration_days && `${i.duration_days} days`]
                        .filter(Boolean).join(' · ')}
                    </p>
                    {!i.product_id && (
                      <p className="text-2xs text-warn">{tr('Written by hand — not linked to a shelf item')}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="num text-2xs text-muted">
                      {i.qty_dispensed}/{i.qty_prescribed}
                    </span>
                    <Badge tone={i.status === 'dispensed' ? 'ok' : i.status === 'partial' ? 'warn' : undefined}>
                      {tr(i.status)}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>

            <button
              onClick={() => onFill({
                visitId: detail.prescription.visit_id,
                patientId: detail.prescription.patient_id,
                patientName: detail.prescription.patient_name,
                doctorName: detail.prescription.doctor_name ?? '',
                items: detail.items.filter((i: any) => i.status !== 'dispensed')
              })}
              className="btn-primary mt-4 w-full">
              {tr('Fill this at the counter')}
            </button>
            <p className="mt-2 text-2xs text-muted">
              Opens the till with these medicines already on the bill. Anything out of
              stock is flagged there rather than added.
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
