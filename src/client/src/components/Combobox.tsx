import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { t as tr } from '../lib/prefs'

/**
 * A type-ahead picker for a long list.
 *
 * A plain <select> was the wrong control for this. The formula list runs to
 * twelve hundred entries; the server capped its reply at three hundred and the
 * browser then asked somebody to scroll a dropdown looking for Cetirizine.
 * Typing three letters is the only workable way in.
 *
 * The search runs on the server, so the whole list is reachable rather than
 * only the first page of it.
 */
export function Combobox({ value, label, placeholder, onPick, search, onCreate }: {
  /** The chosen id, or 0 for nothing. */
  value: number
  /** What to show when something is chosen. */
  label?: string | null
  placeholder?: string
  onPick: (id: number, label: string) => void
  /** Returns candidates for what has been typed. */
  search: (q: string) => Promise<{ id: number; name: string; product_count?: number }[]>
  /** Offered when nothing matches, so a missing entry can be added in place. */
  onCreate?: (name: string) => Promise<{ id: number; name: string }>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      setBusy(true)
      search(q).then((r) => { setRows(r); setActive(0) })
        .catch(() => setRows([])).finally(() => setBusy(false))
    }, 140)
    return () => clearTimeout(timer)
  }, [q, open])

  // Close when the click lands anywhere else.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  async function create() {
    if (!onCreate || !q.trim()) return
    const made = await onCreate(q.trim())
    onPick(made.id, made.name)
    setOpen(false); setQ('')
  }

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => { setOpen((v) => !v); setQ('') }}
        className="field flex w-full items-center gap-2 text-left">
        <span className={`min-w-0 flex-1 truncate ${value ? 'text-heading' : 'text-muted'}`}>
          {value && label ? label : (placeholder ?? tr('Choose one'))}
        </span>
        {value > 0 && (
          <span onClick={(e) => { e.stopPropagation(); onPick(0, '') }}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-raised hover:text-bad">
            <X size={13} />
          </span>
        )}
        <ChevronDown size={14}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="anim-fade absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-2xl
                        border-2 border-line bg-card shadow-pop">
          <div className="flex items-center gap-2 border-b-2 border-divide px-3 py-2">
            <Search size={14} className="shrink-0 text-muted" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const r = rows[active]
                  if (r) { onPick(r.id, r.name); setOpen(false); setQ('') }
                  else if (onCreate) create()
                }
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder={tr('Type a few letters')}
              className="w-full bg-transparent text-sm text-heading outline-none" />
            {busy && <span className="loading-bar w-10" />}
          </div>

          <ul className="max-h-60 overflow-auto">
            {rows.length === 0 && !busy && (
              <li className="px-3 py-3 text-center">
                <p className="text-2xs text-muted">
                  {q.trim() ? tr('Nothing matches that') : tr('Start typing to search')}
                </p>
                {onCreate && q.trim().length > 1 && (
                  <button onClick={create} className="btn-ghost mt-2 text-2xs">
                    {tr('Add')} “{q.trim()}”
                  </button>
                )}
              </li>
            )}
            {rows.map((r, i) => (
              <li key={r.id}>
                <button type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => { onPick(r.id, r.name); setOpen(false); setQ('') }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    i === active ? 'bg-primary/10' : 'hover:bg-raised'}`}>
                  <span className="min-w-0 flex-1 truncate text-sm text-heading">{r.name}</span>
                  {r.product_count != null && r.product_count > 0 && (
                    <span className="num shrink-0 text-2xs text-muted">
                      {r.product_count} {tr('brands')}
                    </span>
                  )}
                  {r.id === value && <Check size={14} className="shrink-0 text-primary" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
