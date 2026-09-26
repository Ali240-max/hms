import { useEffect, useRef, type ReactNode } from 'react'
import { animate, motion, useReducedMotion } from 'framer-motion'

/**
 * The motion system, in one place.
 *
 * Ported from a gym manager that was built to impress in a ten minute demo.
 * A hospital screen is looked at for eight hours with a patient waiting, so
 * the timings below are the shipped values with the clinical ones shortened,
 * and the rules at the bottom of this file are the part that matters more
 * than any curve.
 *
 * One easing curve for everything with a duration. Mixing curves is what
 * makes an interface feel assembled from spare parts.
 */
export const EASE = [0.16, 1, 0.3, 1] as const

export const DUR = {
  /** Dropdowns and popovers, which open while somebody is mid-task. */
  pop: 0.16,
  /** Between screens. */
  page: 0.22,
  /** A card or row arriving. */
  item: 0.45,
  /** A bar filling. */
  bar: 0.9,
  /**
   * Counting figures.
   *
   * 1.1s in the original. Cut to 0.4s here: a receptionist reads the number,
   * they do not watch it arrive, and by the third patient of the morning a
   * long count is just a wait.
   */
  count: 0.4,
  /** A ring or gauge. 1.4s in the original, for the same reason. */
  gauge: 0.6
} as const

export const SPRING = {
  /** Tab pills and the sidebar marker: quick, no overshoot. */
  pill: { type: 'spring', stiffness: 500, damping: 38 } as const,
  /** Dialogs and bottom sheets. */
  sheet: { type: 'spring', stiffness: 380, damping: 34 } as const,
  /** Toasts. */
  toast: { type: 'spring', stiffness: 420, damping: 32 } as const
}

/* ------------------------------------------------------------ entrances */

/**
 * A list or grid whose children arrive one after another.
 *
 * Deliberately NOT used on a patient queue, a lab work list or a result
 * table. Those are read under time pressure and must paint at once; dealing
 * them out like cards means the row somebody is looking for is still on its
 * way. Management screens, reports and dashboards only.
 */
export function Stagger({ children, className, step = 0.05 }: {
  children: ReactNode; className?: string; step?: number
}) {
  return (
    <motion.div className={className} initial="hidden" animate="show"
      variants={{ show: { transition: { staggerChildren: step } } }}>
      {children}
    </motion.div>
  )
}

export const staggerItem = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.item, ease: EASE } }
}

/** A screen arriving. In from below, out upwards, so it reads as forward. */
export const pageIn = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: DUR.page, ease: EASE }
}

/** A dropdown. Short and flat. */
export const popIn = {
  initial: { opacity: 0, y: -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.98 },
  transition: { duration: DUR.pop }
}

/* -------------------------------------------------------------- figures */

/**
 * A figure that counts to its value.
 *
 * **Administrative figures only.** Takings, admissions, stock counts, bills
 * raised. Never a vital sign, a dose, a lab result or a stock level somebody
 * is about to dispense against: a potassium of 6.1 counting up through 3.5
 * shows a safe number on the way to an unsafe one, and a clinician glancing
 * at the right moment reads the wrong value. Those render at their final
 * figure immediately, which is what the plain <span> in Stat does.
 *
 * Written to the DOM through a ref rather than React state. A 0.4s count at
 * 60fps is two dozen renders per figure, and a dashboard carries six of them.
 * This way React renders once.
 */
export function AnimatedNumber({ value, format = (n: number) => Math.round(n).toLocaleString('en-PK'), duration = DUR.count }: {
  value: number
  format?: (n: number) => string
  duration?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(0)
  const reduce = useReducedMotion()

  useEffect(() => {
    if (!ref.current) return
    if (reduce) { ref.current.textContent = format(value); return }
    const controls = animate(prev.current, value, {
      duration, ease: EASE,
      onUpdate: (v) => { if (ref.current) ref.current.textContent = format(v) }
    })
    // Counting from the previous figure, not from zero: 146 to 147 should not
    // sweep the whole way up again.
    prev.current = value
    // Stopping on change keeps two animations from fighting over one element.
    return () => controls.stop()
  }, [value, duration, reduce, format])

  return <span ref={ref}>{format(0)}</span>
}

/* --------------------------------------------------------------- haptics */

/**
 * A short tap on navigation only.
 *
 * Never on scrolling, typing or saving. Something a person does two hundred
 * times a shift must not buzz two hundred times.
 */
export const tapBuzz = () => { try { navigator.vibrate?.(8) } catch { /* ignore */ } }
