import { useState, type ComponentType, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { t as tr } from '../lib/prefs'

/**
 * The navigation rail.
 *
 * Tabs across the top ran out of room the moment a module grew past six of
 * them — the pharmacy has eleven, and on a 1366-wide screen, which is what
 * most of these counters have, the last few scrolled off where nobody found
 * them. A rail down the side has room for twenty and keeps them all legible.
 *
 * It collapses to icons on a narrow screen and can be pinned shut by hand,
 * because a lab technician entering results wants the width.
 */

export type NavItem = {
  id: string
  label: string
  /** Drawn when given; the glyph is the fallback. */
  icon?: ComponentType<{ size?: number | string; className?: string }>
  /** One or two characters, used where no icon is supplied. */
  glyph: string
  /** Optional count shown on the right, for work waiting. */
  badge?: number
  /** Puts a labelled divider above this item. */
  section?: string
}

export function Sidebar({ items, active, onSelect, title, subtitle, footer }: {
  items: NavItem[]
  active: string
  onSelect: (id: string) => void
  title: string
  subtitle?: string
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(true)

  return (
    <nav className={`no-print relative flex shrink-0 flex-col overflow-hidden
                     border-r-2 border-line transition-[width] duration-200 ease-out
                     ${open ? 'w-56' : 'w-16'}`}
      style={{
        /*
         * A quiet vertical gradient rather than a flat panel.
         *
         * Two stops of the same hue, a few percent apart — enough to separate
         * the rail from the working area without turning into decoration that
         * competes with the data. Built from the theme tokens so it follows
         * light, slate and dark without a second definition.
         */
        backgroundImage:
          'linear-gradient(180deg, rgb(var(--c-card)) 0%, rgb(var(--c-raised)) 60%, rgb(var(--c-tint-a)) 100%)'
      }}>

      {/* ---------------------------------------------------------- brand */}
      <div className="flex items-center gap-2.5 px-3 py-3.5">
        <span className="tile shrink-0 shadow-sm"
          style={{
            backgroundImage:
              'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-accent)) 100%)'
          }}>
          {title.slice(0, 1)}
        </span>
        {open && (
          <span className="anim-fade min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight text-heading">
              {tr(title)}
            </span>
            {subtitle && (
              <span className="block truncate text-2xs leading-tight text-muted">{subtitle}</span>
            )}
          </span>
        )}
      </div>

      {/* ----------------------------------------------------------- items */}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {items.map((item) => {
          const on = item.id === active
          return (
            <li key={item.id}>
              {item.section && open && (
                <p className="px-2 pb-1 pt-3 text-[0.6rem] font-semibold uppercase
                              tracking-wider text-muted">
                  {tr(item.section)}
                </p>
              )}
              <button onClick={() => onSelect(item.id)} title={tr(item.label)}
                className={`group relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2
                            text-left transition-all duration-150
                            ${on ? 'font-medium text-white shadow-sm'
                                 : 'text-body hover:bg-card/70 hover:translate-x-0.5'}`}
                style={on ? {
                  backgroundImage:
                    'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-accent)) 100%)'
                } : undefined}>

                {/*
                  A bar on the selected item, so the active row is readable
                  even when the gradient is subtle in the dark theme.
                */}
                {on && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-white/70" />
                )}

                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-2xs
                                  font-semibold transition-colors
                                  ${on ? 'bg-white/20 text-white'
                                       : 'bg-raised text-muted group-hover:text-primary'}`}>
                  {item.icon ? <item.icon size={15} /> : item.glyph}
                </span>

                {open && (
                  <span className="min-w-0 flex-1 truncate text-2xs">{tr(item.label)}</span>
                )}

                {open && item.badge != null && item.badge > 0 && (
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 num text-[0.6rem]
                                    font-semibold ${
                    on ? 'bg-white/25 text-white' : 'bg-primary/15 text-primary'}`}>
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {footer && open && <div className="anim-fade px-3 pb-2">{footer}</div>}

      {/*
        A round handle on the edge of the rail rather than a bar across the
        foot. It reads as something to grab, sits where the eye already is when
        the rail is in the way, and stops the rail ending in a grey slab.
      */}
      <div className="relative h-3">
        <button onClick={() => setOpen((v) => !v)}
          title={open ? tr('Collapse') : tr('Expand')}
          aria-label={open ? tr('Collapse') : tr('Expand')}
          className="group absolute -top-4 right-2 grid h-8 w-8 place-items-center
                     rounded-full border-2 border-line bg-card text-muted shadow-sm
                     transition-all duration-200 hover:scale-110 hover:border-primary
                     hover:text-white active:scale-95">
          <span className="absolute inset-0 rounded-full opacity-0 transition-opacity
                           duration-200 group-hover:opacity-100"
            style={{
              backgroundImage:
                'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-accent)) 100%)'
            }} />
          <ChevronLeft size={15}
            className={`relative transition-transform duration-300
                        ${open ? '' : 'rotate-180'}`} />
        </button>
      </div>
    </nav>
  )
}
