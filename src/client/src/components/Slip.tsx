import type { ReactNode } from 'react'
import { rs } from '../lib/api'

/**
 * An 80mm thermal slip.
 *
 * Chits and pharmacy bills both come out of the same roll printers, so they
 * are built from the same primitives rather than styled twice. The measurement
 * that matters is the printable width: an 80mm roll gives about 72mm of paper,
 * which at a normal monospace size is 42 characters. Everything here is sized
 * against that, so what the screen shows is what the paper gets.
 *
 * Monospace throughout, because columns on a receipt have to line up when the
 * printer renders it as plain text, and because it is what people here already
 * recognise as a bill.
 */

export const SLIP_WIDTH = '72mm'

export function Slip({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <div className="print-area bg-white font-mono text-[11px] leading-tight text-black"
        style={{ width: SLIP_WIDTH, padding: '3mm' }}>
        {children}
      </div>
    </div>
  )
}

/** Letterhead. Centred, name slightly larger, everything else small. */
export function SlipHeader({ hospital, title }: { hospital: any; title?: string }) {
  return (
    <header className="text-center">
      <h1 className="text-[15px] font-bold uppercase tracking-wide">{hospital?.name ?? 'Hospital'}</h1>
      {hospital?.tagline && <p className="text-[10px]">{hospital.tagline}</p>}
      {hospital?.address && <p className="text-[10px]">{hospital.address}</p>}
      {(hospital?.phone || hospital?.email) && (
        <p className="text-[10px]">{[hospital.phone, hospital.email].filter(Boolean).join('  ')}</p>
      )}
      {hospital?.ntn && <p className="text-[10px]">NTN {hospital.ntn}</p>}
      {title && (
        <p className="mt-1 border-y border-dashed border-black py-0.5 text-[12px] font-bold uppercase">
          {title}
        </p>
      )}
    </header>
  )
}

/** A dashed rule, the way a receipt separates its sections. */
export const Rule = () => <div className="my-1 border-t border-dashed border-black" />

/** label ....... value, on one line. */
export function SlipRow({ k, v, bold }: { k: string; v: ReactNode; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'text-[12px] font-bold' : ''}`}>
      <span className="shrink-0">{k}</span>
      <span className="truncate text-right">{v}</span>
    </div>
  )
}

/**
 * Line items.
 *
 * Name on its own line and the maths indented beneath it, rather than four
 * columns squeezed across 42 characters. Medicine names here are long
 * ("Augmentin 625mg tab") and truncating them makes a bill nobody can check.
 */
export function SlipItems({ items }: {
  items: { name: string; qty?: string | number; unit?: number; total: number }[]
}) {
  return (
    <div className="space-y-1">
      {items.map((it, i) => (
        <div key={i}>
          <div className="truncate">{it.name}</div>
          <div className="flex justify-between">
            <span className="pl-2">
              {it.qty != null && it.unit != null
                ? `${it.qty} x ${rs(it.unit)}`
                : it.qty != null ? String(it.qty) : ''}
            </span>
            <span>{rs(it.total)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function SlipTotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="mt-1 flex justify-between border-t border-black pt-1 text-[14px] font-bold">
      <span>{label}</span>
      <span>Rs {rs(amount)}</span>
    </div>
  )
}

export function SlipFooter({ children }: { children: ReactNode }) {
  return <footer className="mt-2 text-center text-[10px]">{children}</footer>
}

/**
 * A stamp box for an unpaid chit.
 *
 * The cashier signs here, and the department looks for the signature as well
 * as checking the screen. Paper and record back each other up; neither alone
 * is trusted.
 */
export function SlipStamp({ label }: { label: string }) {
  return (
    <div className="mt-3 flex justify-end">
      <div className="w-28 border-t border-black pt-0.5 text-center text-[10px]">{label}</div>
    </div>
  )
}
