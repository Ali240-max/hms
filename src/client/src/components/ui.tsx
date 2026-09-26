import { Inbox } from 'lucide-react'
import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { AnimatedNumber, DUR, SPRING, tapBuzz } from '../lib/motion'
import type { ReactNode } from 'react'

export function Card({ title, hint, action, tint, className = '', children }: {
  title?: string; hint?: string; action?: ReactNode; tint?: boolean
  className?: string; children: ReactNode
}) {
  return (
    <section className={`${tint ? 'card-tint' : 'card'} anim-in p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {hint && <p className="mt-0.5 text-2xs text-muted">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * A headline figure. Numeric results are primary or accent, never near-black.
 *
 * `count` opts the figure into counting up, and is opt-in on purpose. Money
 * taken today, bills raised, patients registered: fine, and the movement
 * draws the eye to what changed. A vital sign, a dose, a lab result or a
 * stock level somebody is about to dispense against: never. A potassium of
 * 6.1 counting up through 3.5 shows a safe number on its way to an unsafe
 * one, and a clinician glancing at the wrong moment reads the wrong value.
 *
 * Left alone the figure simply appears, which is right for everything
 * clinical.
 */
export function Stat({ label, value, sub, tone = 'primary', count }: {
  label: string; value: string; sub?: ReactNode; tone?: 'primary' | 'accent' | 'ok' | 'warn' | 'bad'
  /** Administrative figures only. */
  count?: number
}) {
  const colour = {
    primary: 'text-primary', accent: 'text-accent',
    ok: 'text-ok', warn: 'text-warn', bad: 'text-bad'
  }[tone]
  return (
    <div className="card lift anim-in p-4">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 num text-2xl font-semibold ${colour}`}>
        {count != null ? <AnimatedNumber value={count} /> : value}
      </div>
      {sub && <div className="mt-1 text-2xs text-muted">{sub}</div>}
    </div>
  )
}

export function Field({ label, hint, span, children }: {
  label: string; hint?: string; span?: boolean; children: ReactNode
}) {
  return (
    <label className={`block ${span ? 'sm:col-span-2' : ''}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  )
}

export function Badge({ children, tone = 'muted' }: {
  children: ReactNode; tone?: 'muted' | 'primary' | 'ok' | 'warn' | 'bad'
}) {
  const cls = {
    muted: 'border-line bg-screen text-muted',
    primary: 'border-primary/25 bg-primary/10 text-primary',
    ok: 'border-ok/25 bg-ok/10 text-ok',
    warn: 'border-warn/25 bg-warn/10 text-warn',
    bad: 'border-bad/25 bg-bad/10 text-bad'
  }[tone]
  // `whitespace-nowrap` keeps "2 on the bench" from breaking across two lines
  // inside its own pill; the row it sits in wraps instead.
  return (
    <span className={`inline-block whitespace-nowrap rounded-lg border px-1.5 py-0.5
                      text-2xs font-medium ${cls}`}>
      {children}
    </span>
  )
}

/**
 * A dialog on a desktop, a bottom sheet on a phone, from one component.
 *
 * The difference is two Tailwind breakpoints, not two code paths: `items-end`
 * on a phone and `sm:items-center` above it. A counter clerk on a desktop and
 * a doctor on a phone in a ward get the shape each expects without the
 * screens knowing which is which.
 *
 * Details that decide whether it feels native or like a web page in a frame:
 *
 * `max-h-[92dvh]` rather than `vh`. On Android `vh` ignores the browser
 * toolbar, and the footer buttons end up underneath it where nobody can press
 * Save.
 *
 * The small grey bar is signalling. People try to drag it, so it drags, and
 * `dragElastic` gives downwards only: a sheet that also stretches upwards
 * feels loose. It closes at 90px of travel or a flick, which is what Android
 * itself uses.
 *
 * Body scroll is locked while it is open, or the page behind scrolls under a
 * finger that missed the sheet.
 */
export function Modal({ title, hint, wide, onClose, children, footer }: {
  title: string; hint?: string; wide?: boolean; onClose: () => void
  children: ReactNode; footer?: ReactNode
}) {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-auto p-0
                    sm:items-start sm:p-6">
      <motion.div
        className="absolute inset-0 bg-heading/40 backdrop-blur-[2px]"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: DUR.pop }}
        onClick={onClose} />

      <motion.div role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 30, scale: 0.98 }}
        transition={SPRING.sheet}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        dragListener={false}
        onDragEnd={(_, i) => { if (i.offset.y > 90 || i.velocity.y > 500) onClose() }}
        className={`panel relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl
                    sm:my-4 sm:max-h-none sm:rounded-2xl
                    ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>

        {/* Only the handle drags, so a text selection inside does not close it. */}
        <motion.div
          drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.6 }}
          onDragEnd={(_, i) => { if (i.offset.y > 90 || i.velocity.y > 500) onClose() }}
          className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 cursor-grab rounded-full bg-line
                     active:cursor-grabbing sm:hidden" />

        <header className="no-print flex shrink-0 items-start justify-between border-b
                           border-divide px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {hint && <p className="mt-0.5 text-2xs text-muted">{hint}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="rounded-md px-2 text-lg leading-none text-muted transition-colors
                       hover:bg-screen hover:text-heading active:scale-90">
            &times;
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="no-print flex shrink-0 justify-end gap-2 border-t border-divide
                             px-5 [&>*]:flex-1 sm:[&>*]:flex-none"
            style={{ paddingTop: '0.75rem', paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            {footer}
          </footer>
        )}
      </motion.div>
    </div>
  )
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="anim-in flex flex-col items-center justify-center px-6 py-16 text-center">
      <Inbox size={34} className="mb-3 text-muted/50" />
      <p className="text-sm font-medium text-heading">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-2xs text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Th({ children, w, right }: { children?: ReactNode; w?: string; right?: boolean }) {
  return (
    <th className={`${w ?? ''} px-3 py-2 text-2xs font-medium uppercase tracking-wide text-muted ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <p className="rounded-xl border border-bad/25 bg-bad/5 px-3 py-2 text-2xs text-bad">{children}</p>
  )
}

/**
 * A thin sweeping bar, for when something is on its way.
 *
 * Indeterminate on purpose: the server reports no progress, and a percentage
 * that invents one, races to ninety and stops is worse than none.
 */
export function LoadingBar() {
  return <div className="loading-bar my-2" aria-hidden />
}

/**
 * The shape of a table before its rows arrive.
 *
 * Holding the space stops the screen jumping when data lands, which is the
 * thing that makes an interface feel unsteady. Better than a spinner because
 * it says how much is coming, not merely that something is.
 */
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 py-3" aria-hidden>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c}
              className={`skeleton h-4 ${c === 0 ? 'flex-[2]' : 'flex-1'}`}
              style={{ opacity: 1 - r * 0.12 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * A row of tab pills with the highlight sliding between them.
 *
 * The pill is its own absolutely positioned element behind the label rather
 * than the button's background, and the label sits above it, so the highlight
 * travels underneath the text instead of over it.
 *
 * `id` namespaces the shared layout, and it matters: two tab rows on one
 * screen sharing an id fight over a single pill, and it flies across the page
 * between them.
 */
export function Tabs({ tabs, value, onChange, id = 'tabs', className = '' }: {
  tabs: { value: string; label: string; count?: number; icon?: any }[]
  value: string
  onChange: (v: string) => void
  id?: string
  className?: string
}) {
  return (
    <div role="tablist"
      className={`flex max-w-full gap-1 overflow-x-auto rounded-xl bg-raised p-1 ${className}`}>
      {tabs.map((t) => {
        const on = t.value === value
        const Icon = t.icon
        return (
          <button key={t.value} role="tab" aria-selected={on}
            onClick={() => { tapBuzz(); onChange(t.value) }}
            className={`relative whitespace-nowrap rounded-lg px-3.5 py-1.5 text-2xs font-medium
                        transition-colors active:scale-[0.97]
                        ${on ? 'text-heading' : 'text-muted hover:text-body'}`}>
            {on && (
              <motion.span layoutId={`${id}-pill`} transition={SPRING.pill}
                className="absolute inset-0 rounded-lg border-2 border-line bg-card shadow-sm" />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon size={13} />}
              {t.label}
              {t.count != null && (
                <span className="rounded-md bg-screen px-1.5 num text-[0.6rem] text-muted">
                  {t.count}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
