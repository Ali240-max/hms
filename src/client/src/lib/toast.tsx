import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react'
import { SPRING } from './motion'

/**
 * Small confirmations, bottom right.
 *
 * The gym app this came from flooded the whole panel green after a check-in.
 * That is wrong here: a green wash over a screen hides whatever was on it,
 * and on a clinical screen the thing it hides might be the reason somebody
 * was looking. A corner message confirms the action and leaves the data
 * readable.
 *
 * They rise in and leave sideways. Leaving on a different axis than they
 * arrived on stops a queue of them looking like it is folding in on itself.
 * At most four at a time, because a stack taller than that covers the corner
 * of the screen people actually work in.
 *
 * `aria-live="polite"` so a screen reader announces them without interrupting.
 */

type Tone = 'ok' | 'warn' | 'bad' | 'info'
type Toast = { id: number; text: string; tone: Tone }

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {})

export const useToast = () => useContext(Ctx)

const ICON = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, info: Info }
const COLOUR = {
  ok: 'text-ok border-ok/40', warn: 'text-warn border-warn/40',
  bad: 'text-bad border-bad/40', info: 'text-primary border-primary/40'
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])

  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((all) => [...all, { id, text, tone }].slice(-4))
    setTimeout(() => setItems((all) => all.filter((t) => t.id !== id)), 3800)
  }, [])

  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite"
        className="no-print pointer-events-none fixed right-4 z-[60] flex flex-col items-end gap-2"
        style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const Icon = ICON[t.tone]
            return (
              <motion.div key={t.id} layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 40 }}
                transition={SPRING.toast}
                className={`pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl
                            border-2 bg-card px-4 py-3 text-sm shadow-card ${COLOUR[t.tone]}`}>
                <Icon size={16} className="mt-0.5 shrink-0" />
                <span className="flex-1 text-body">{t.text}</span>
                <button onClick={() => setItems((all) => all.filter((x) => x.id !== t.id))}
                  className="shrink-0 text-muted transition-colors hover:text-heading">
                  <X size={14} />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  )
}
