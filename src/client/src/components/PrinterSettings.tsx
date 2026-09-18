import { useState } from 'react'
import { Card, Field } from './ui'
import { loadPrinter, savePrinter, applyPaper, DEFAULTS, PAPER_WIDTH,
         type PrinterSettings as P, type PaperWidth } from '../lib/printer'
import { t as tr } from '../lib/prefs'

/**
 * Print setup for one counter.
 *
 * Shared by the pharmacy till and the main counter, which have different
 * hardware and are stored separately for that reason.
 */
export function PrinterSettingsCard({ module, label }: { module: string; label: string }) {
  const [s, setS] = useState<P>(() => loadPrinter(module))
  const [saved, setSaved] = useState(false)

  function set(patch: Partial<P>) {
    const next = { ...s, ...patch }
    setS(next)
    savePrinter(module, next)
    applyPaper(next.paper)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  return (
    <Card title={tr('Printing')} hint={label}
      action={saved ? <span className="text-2xs text-ok">{tr('Saved')}</span> : undefined}>
      {/*
        Said plainly rather than hidden, because someone will look for a
        printer dropdown here and not find one.
      */}
      <div className="card-tint mb-4 p-3">
        <p className="text-2xs text-body">
          {tr('Which printer is used comes from Windows, not from here — a web page is not allowed to choose a device. Set the roll printer as the default printer on this PC and every slip will go to it.')}
        </p>
        <p className="mt-1 text-2xs text-muted">
          {tr('Windows: Settings, Bluetooth and devices, Printers and scanners, pick the printer, Set as default. Turn off "Let Windows manage my default printer" first.')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Paper')} hint={`${tr('Printable width')}: ${PAPER_WIDTH[s.paper]}`}>
          <select value={s.paper} onChange={(e) => set({ paper: e.target.value as PaperWidth })}
            className="field">
            <option value="58mm">{tr('58mm roll')}</option>
            <option value="80mm">{tr('80mm roll')}</option>
            <option value="A4">{tr('A4 sheet')}</option>
          </select>
        </Field>

        <Field label={tr('Copies')} hint={tr('Two is usual where one goes in the file')}>
          <select value={s.copies} onChange={(e) => set({ copies: Number(e.target.value) })}
            className="field num">
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>

        <Field label={tr('Blank lines at the end')} hint={tr('So the tear-off misses the total')}>
          <select value={s.feedLines} onChange={(e) => set({ feedLines: Number(e.target.value) })}
            className="field num">
            {[0, 1, 2, 3, 4, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-4 space-y-2 border-t border-divide pt-3">
        <Toggle checked={s.autoPrint} onChange={(v) => set({ autoPrint: v })}
          label={tr('Skip the preview and print straight away')}
          hint={tr('Faster at a busy window, but a wrong bill is printed before anyone sees it')} />
        <Toggle checked={s.showLetterhead} onChange={(v) => set({ showLetterhead: v })}
          label={tr('Print the hospital letterhead')}
          hint={tr('Turn off if you use pre-printed paper')} />
        <Toggle checked={s.showFooter} onChange={(v) => set({ showFooter: v })}
          label={tr('Print the footer message')} />
      </div>

      <button onClick={() => { setS({ ...DEFAULTS }); savePrinter(module, DEFAULTS) }}
        className="btn-ghost mt-4 text-2xs">
        {tr('Reset to defaults')}
      </button>

      <p className="mt-3 text-2xs text-muted">
        {tr('These settings apply to this computer only.')}
      </p>
    </Card>
  )
}

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-current text-primary" />
      <span className="min-w-0">
        <span className="block text-sm text-body">{label}</span>
        {hint && <span className="block text-2xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}
