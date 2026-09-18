import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Modal, ErrorNote } from './ui'
import { loadPrinter, applyPaper } from '../lib/printer'
import { t as tr } from '../lib/prefs'

/**
 * Dosage labels, one per medicine, stuck on the box the patient carries home.
 *
 * The reason these exist: a printed bill lists what was sold, but the patient
 * reads the box, not the bill. Half the people collecting medicines here
 * cannot read English, and "1 TDS" means nothing to anyone outside a hospital.
 * A label that says صبح / دوپہر / شام with the boxes ticked is understood by
 * someone who cannot read either script, because the position of the tick
 * carries the meaning.
 *
 * Urdu and English both appear on every label rather than one or the other,
 * so the same sticker works for the patient and for whoever checks the box
 * later — a nurse, a relative, or a doctor at the next visit.
 */

type Label = {
  name: string
  strength?: string | null
  qty: string
  slots: { morning: boolean; noon: boolean; evening: boolean }
  days?: string | null
  instructions?: string | null
  frequency?: string | null
}

/** Standard shorthand back into ticks, so a label matches the prescription. */
function slotsFor(frequency: string | null | undefined) {
  switch ((frequency ?? '').toUpperCase()) {
    case 'TDS': case 'QID': return { morning: true, noon: true, evening: true }
    case 'BD': return { morning: true, noon: false, evening: true }
    case 'OD': return { morning: true, noon: false, evening: false }
    default: return { morning: false, noon: false, evening: false }
  }
}

export function LabelSheet({ labels, hospital }: { labels: Label[]; hospital?: any }) {
  return (
    <div className="print-area bg-white text-black">
      <div className="flex flex-wrap gap-[2mm]">
        {labels.map((l, i) => <OneLabel key={i} l={l} hospital={hospital} />)}
      </div>
    </div>
  )
}

/**
 * A single 50 x 25 mm label.
 *
 * Sized in millimetres rather than pixels because it has to come out of the
 * printer at exactly the size of the physical sticker; anything scaled by the
 * browser lands off the edge of the die-cut.
 */
function OneLabel({ l, hospital }: { l: Label; hospital?: any }) {
  const none = !l.slots.morning && !l.slots.noon && !l.slots.evening
  return (
    <div className="label-sticker overflow-hidden border border-black/25"
      style={{ width: '50mm', height: '25mm', padding: '1.5mm' }}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[8pt] font-bold leading-tight">
          {l.name}{l.strength ? ` ${l.strength}` : ''}
        </span>
        <span className="shrink-0 text-[6pt]">{l.qty}</span>
      </div>

      {none ? (
        <div className="mt-[0.6mm] text-[7pt] leading-tight">
          {l.frequency === 'SOS' || !l.frequency
            ? <>As needed · <span style={{ fontFamily: '"Noto Nastaliq Urdu", serif' }}>ضرورت پر</span></>
            : l.frequency}
        </div>
      ) : (
        <div className="mt-[0.6mm] flex gap-[1mm]">
          {([
            ['morning', 'Morning', 'صبح'],
            ['noon', 'Noon', 'دوپہر'],
            ['evening', 'Evening', 'شام']
          ] as const).map(([key, en, ur]) => {
            const on = l.slots[key]
            return (
              <div key={key}
                className={`flex-1 border text-center leading-none ${
                  on ? 'border-black bg-black text-white' : 'border-black/30 text-black/35'}`}
                style={{ padding: '0.6mm 0' }}>
                <div className="text-[5.5pt] font-bold">{on ? '\u2713' : '\u2717'}</div>
                <div className="text-[5pt]">{en}</div>
                <div className="text-[6pt]" style={{ fontFamily: '"Noto Nastaliq Urdu", serif' }}>
                  {ur}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-[0.6mm] flex items-end justify-between gap-1 text-[5.5pt] leading-tight">
        <span className="truncate">
          {l.days ? `${l.days} days · ` : ''}{l.instructions ?? ''}
        </span>
        <span className="shrink-0 truncate opacity-70">{hospital?.name ?? ''}</span>
      </div>
    </div>
  )
}

/**
 * Offered after a sale.
 *
 * Built from the prescription where there is one, because that is where the
 * timing lives. A walk-in sale has no prescription, so those labels carry the
 * name and quantity only rather than inventing a dose — a wrong dosage label
 * is worse than none.
 */
export function LabelPreview({ saleId, visitId, onClose }: {
  saleId: number; visitId?: number | null; onClose: () => void
}) {
  const [labels, setLabels] = useState<Label[] | null>(null)
  const [hospital, setHospital] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    applyPaper(loadPrinter('pharmacy').paper)
    api.hospital().then(setHospital).catch(() => {})

    async function build() {
      const sale = await api.ph.sale(saleId)
      const items: any[] = sale.items ?? []

      let byProduct = new Map<number, any>()
      let byName = new Map<string, any>()
      if (visitId) {
        const pres = await api.prescription(visitId).catch(() => null)
        for (const it of pres?.items ?? []) {
          if (it.product_id) byProduct.set(it.product_id, it)
          byName.set(String(it.drug_name).toLowerCase().trim(), it)
        }
      }

      return items.map((i): Label => {
        const name = i.product_name ?? i.productName ?? ''
        const p = byProduct.get(i.product_id) ?? byName.get(name.toLowerCase().trim())
        return {
          name,
          strength: null,
          qty: `${i.display_qty ?? i.displayQty} ${i.sub_unit_label ?? i.unit_label ?? ''}`.trim(),
          slots: slotsFor(p?.frequency),
          frequency: p?.frequency ?? null,
          days: p?.duration_days ? String(p.duration_days) : null,
          instructions: p?.instructions ?? p?.dose ?? null
        }
      })
    }

    build().then(setLabels).catch((e: any) => setErr(e.message))
  }, [saleId, visitId])

  return (
    <Modal title={tr('Medicine labels')} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Close')}</button>
        <button onClick={() => window.print()} disabled={!labels?.length} className="btn-primary">
          {tr('Print labels')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      {!labels ? <p className="text-2xs text-muted">{tr('Loading…')}</p>
        : labels.length === 0 ? <p className="text-2xs text-muted">{tr('Nothing to label')}</p> : (
        <>
          <p className="mb-3 text-2xs text-muted">
            {tr('50 x 25 mm labels, one per medicine. Set the label roll as the default printer before printing these.')}
          </p>
          <LabelSheet labels={labels} hospital={hospital} />
        </>
      )}
    </Modal>
  )
}
