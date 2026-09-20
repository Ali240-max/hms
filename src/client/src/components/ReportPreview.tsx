import { useEffect, useState } from 'react'
import { X, Download, Printer } from 'lucide-react'
import { api, rs } from '../lib/api'
import { Modal } from './ui'
import { t as tr } from '../lib/prefs'

/**
 * A report, on screen, before anyone commits it to paper.
 *
 * Drawn as HTML from the rows the screen already has, not as a PDF in a
 * frame. Two reasons, both learned the hard way:
 *
 * A browser whose built-in PDF viewer is switched off — a setting plenty of
 * people have on — downloads the file instead of displaying it, so the frame
 * stayed blank and the document landed in Downloads without being asked for.
 * Nothing in an iframe can prevent that.
 *
 * And printing a frame that holds a PDF prints the viewer, not the document,
 * which is where the blank page came from. Printing this preview prints what
 * is actually on the screen.
 *
 * The PDF is still the real artefact; it is fetched when Download is pressed,
 * which is also when it should be generated.
 */
export function ReportPreview({ data, path, filename, onClose }: {
  /** The same shape the reports screen already holds. */
  data: any
  /** API path of the PDF, query string included. */
  path: string
  filename: string
  onClose: () => void
}) {
  const [hospital, setHospital] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.hospital().then(setHospital).catch(() => {}) }, [])

  const cols = data.columns as any[]
  const totals = data.totals ?? {}
  const hasTotals = (data.totalKeys ?? []).length > 0

  /** Download the real PDF, which is generated only now. */
  async function download() {
    setBusy(true)
    try {
      const [pathname, query] = path.split('?')
      const { ticket } = await api.documentTicket(pathname)
      const url = `/api${pathname}?${query ? query + '&' : ''}download=1` +
        `&ticket=${encodeURIComponent(ticket)}`
      // A real anchor, so the browser saves it under a sensible name.
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally { setBusy(false) }
  }

  return (
    <Modal title={data.title} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost inline-flex items-center gap-1.5">
          <X size={14} /> {tr('Close')}
        </button>
        <button onClick={() => window.print()}
          className="btn-ghost inline-flex items-center gap-1.5">
          <Printer size={14} /> {tr('Print')}
        </button>
        <button onClick={download} disabled={busy}
          className="btn-primary inline-flex items-center gap-1.5">
          <Download size={14} /> {busy ? tr('Preparing…') : tr('Download PDF')}
        </button>
      </>}>

      <p className="no-print mb-3 text-2xs text-muted">
        {tr('Check the dates and the totals. Print sends this page to the printer; Download saves a PDF.')}
      </p>

      {/*
        Laid out like the printed copy so what is on screen is what comes out:
        same columns, same order, same totals.
      */}
      <div className="print-area max-h-[65vh] overflow-auto rounded-xl border-2 border-line
                      bg-white p-6 text-black">
        <header className="border-b-2 border-black pb-2 text-center">
          <h1 className="text-lg font-bold uppercase">{hospital?.name ?? 'Hospital'}</h1>
          <p className="text-[11pt]">{data.title}</p>
          {data.window && (
            <p className="num text-[9pt]">
              {tr('From')} {data.window.from} &nbsp;&nbsp; {tr('To')} {data.window.to}
            </p>
          )}
        </header>

        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              {cols.map((c) => (
                <th key={c.key}
                  className={`px-1.5 py-1 text-[8.5pt] font-bold uppercase ${
                    c.money || c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr><td colSpan={cols.length} className="py-6 text-center text-[9pt]">
                {tr('Nothing to report for this period')}
              </td></tr>
            )}
            {data.rows.map((row: any, i: number) => (
              <tr key={i} className="border-b border-black/15">
                {cols.map((c) => (
                  <td key={c.key}
                    className={`px-1.5 py-1 text-[9pt] ${
                      c.money || c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {c.money ? rs(row[c.key]) : (row[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot>
              <tr className="border-t-2 border-black font-bold">
                {cols.map((c, i) => (
                  <td key={c.key}
                    className={`px-1.5 py-1.5 text-[9pt] ${
                      c.money || c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {(data.totalKeys ?? []).includes(c.key)
                      ? (c.money ? rs(totals[c.key]) : totals[c.key])
                      : i === 0 ? tr('Grand Total') : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>

        <p className="mt-4 text-[7.5pt]">
          {tr('Printed')} {new Date().toLocaleString('en-GB')}
        </p>
      </div>
    </Modal>
  )
}
