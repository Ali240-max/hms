import { create } from 'zustand'
import type { SearchHit } from './api'

export type CartLine = {
  key: string
  productId: number
  name: string
  unitLabel: string
  subUnitLabel: string | null
  packSize: number
  allowLoose: boolean
  soldAs: 'pack' | 'unit'
  schedule: SearchHit['schedule']
  taxRateBp: number
  qty: number
  unitPricePaisa: number
  discountPaisa: number
  /** What FEFO will pick, shown before the operator commits. */
  batchNo: string | null
  expiryDate: string | null
  /** Base sub-units on the shelf, not packs. */
  availableBase: number
}

type CartState = {
  lines: CartLine[]
  customerName: string
  doctorName: string
  payMethod: 'cash' | 'card' | 'easypaisa' | 'jazzcash' | 'credit'
  add: (hit: SearchHit, qty?: number) => void
  setQty: (key: string, qty: number) => void
  setSoldAs: (key: string, soldAs: 'pack' | 'unit') => void
  setDiscount: (key: string, paisa: number) => void
  remove: (key: string) => void
  clear: () => void
  set: (patch: Partial<Pick<CartState, 'customerName' | 'doctorName' | 'payMethod'>>) => void
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  customerName: '',
  doctorName: '',
  payMethod: 'cash',

  add: (hit, qty = 1) =>
    set((s) => {
      // Same product sold as a pack and as loose tablets are two lines: they
      // carry different prices and the customer sees them separately.
      const existing = s.lines.find((l) => l.productId === hit.id && l.soldAs === 'pack')
      if (existing) {
        return {
          lines: s.lines.map((l) =>
            l.key === existing.key ? { ...l, qty: Math.min(l.qty + qty, maxFor(l)) } : l
          )
        }
      }
      const packSize = Math.max(1, hit.pack_size ?? 1)
      return {
        lines: [
          ...s.lines,
          {
            key: `${hit.id}-${Date.now()}`,
            productId: hit.id,
            name: hit.name,
            unitLabel: hit.unit_label,
            subUnitLabel: hit.sub_unit_label ?? null,
            packSize,
            allowLoose: !!hit.allow_loose && packSize > 1,
            soldAs: 'pack',
            schedule: hit.schedule,
            taxRateBp: hit.tax_rate_bp,
            qty,
            unitPricePaisa: Number(hit.price_paisa ?? 0),
            discountPaisa: 0,
            batchNo: hit.batch_no,
            expiryDate: hit.expiry_date,
            availableBase: hit.total_qty
          }
        ]
      }
    }),

  setQty: (key, qty) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.key === key ? { ...l, qty: Math.max(1, Math.min(qty, maxFor(l))) } : l
      )
    })),

  setSoldAs: (key, soldAs) =>
    set((s) => ({
      lines: s.lines.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, soldAs }
        return { ...next, qty: Math.max(1, Math.min(l.qty, maxFor(next))) }
      })
    })),

  setDiscount: (key, paisa) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, discountPaisa: Math.max(0, paisa) } : l))
    })),

  remove: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),
  clear: () => set({ lines: [], customerName: '', doctorName: '', payMethod: 'cash' }),
  set: (patch) => set(patch)
}))

/**
 * Price of one loose sub-unit. Must match unitPriceFromPack on the server
 * exactly, including the round-up, or the screen and the receipt disagree.
 */
export function effectivePrice(l: CartLine): number {
  if (l.soldAs === 'pack' || l.packSize <= 1) return l.unitPricePaisa
  return Math.ceil(l.unitPricePaisa / l.packSize)
}

/**
 * How many of the chosen thing can still be sold. Packs are limited to whole
 * packs on the shelf; a batch holding 15 of a 10-strip has one sellable strip.
 */
export function maxFor(l: CartLine): number {
  return l.soldAs === 'pack' ? Math.floor(l.availableBase / l.packSize) : l.availableBase
}

/**
 * Mirrors the server's line-level rounding exactly. If the screen and the
 * receipt disagree by one paisa, the operator stops trusting the screen.
 */
export function totals(lines: CartLine[]) {
  let gross = 0
  let discount = 0
  let tax = 0
  for (const l of lines) {
    const g = l.qty * effectivePrice(l)
    const net = Math.max(0, g - l.discountPaisa)
    gross += g
    discount += l.discountPaisa
    tax += Math.round((net * l.taxRateBp) / 10000)
  }
  return { gross, discount, tax, total: gross - discount + tax }
}
