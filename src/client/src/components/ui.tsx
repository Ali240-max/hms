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

/** Numeric results are primary or accent, never near-black. */
export function Stat({ label, value, sub, tone = 'primary' }: {
  label: string; value: string; sub?: ReactNode; tone?: 'primary' | 'accent' | 'ok' | 'warn' | 'bad'
}) {
  const colour = {
    primary: 'text-primary', accent: 'text-accent',
    ok: 'text-ok', warn: 'text-warn', bad: 'text-bad'
  }[tone]
  return (
    <div className="card lift anim-in p-4">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</div>
      {/*
        Keyed on the value so React remounts the figure when it changes, which
        replays the animation. A number that moves without moving is easy to
        miss on a screen someone only glances at.
      */}
      <div key={value} className={`anim-pop mt-1 num text-2xl font-semibold ${colour}`}>
        {value}
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
  return <span className={`rounded-lg border px-1.5 py-0.5 text-2xs font-medium ${cls}`}>{children}</span>
}

export function Modal({ title, hint, wide, onClose, children, footer }: {
  title: string; hint?: string; wide?: boolean; onClose: () => void
  children: ReactNode; footer?: ReactNode
}) {
  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-start justify-center overflow-auto
                    bg-heading/30 p-6 backdrop-blur-[2px]"
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`panel anim-pop my-4 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <header className="no-print flex items-start justify-between border-b border-divide px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {hint && <p className="mt-0.5 text-2xs text-muted">{hint}</p>}
          </div>
          <button onClick={onClose}
            className="rounded-md px-2 text-lg leading-none text-muted hover:bg-screen hover:text-heading">
            &times;
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="no-print flex justify-end gap-2 border-t border-divide px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="anim-in flex flex-col items-center justify-center px-6 py-16 text-center">
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
