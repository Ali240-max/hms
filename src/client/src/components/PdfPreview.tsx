import { useEffect, useRef, useState } from 'react'
import { X, Download, Printer, FileText, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../lib/api'
import { Modal, ErrorNote } from './ui'
import { t as tr } from '../lib/prefs'

/**
 * Shows a document before anyone commits it to paper or disk.
 *
 * The pages are drawn by us onto canvases rather than handed to the browser's
 * PDF viewer in an iframe. That was the first attempt and it failed on the
 * machines that matter: Chrome and Edge both carry a setting called "download
 * PDFs instead of automatically opening them", and where it is on — which is
 * common on shared hospital machines, because somebody once turned it on — an
 * iframe pointed at a PDF downloads the file and leaves the frame blank. The
 * preview showed nothing, the file landed in Downloads unasked, and printing
 * from the empty frame produced a blank sheet.
 *
 * Rendering it ourselves takes that setting out of the picture entirely. What
 * the technician sees is what will print, on every machine, whatever their
 * browser has been configured to do.
 */
export function PdfPreview({ path, title, filename, onClose }: {
  /** API path without /api, query string included if it needs one. */
  path: string
  title: string
  filename?: string
  onClose: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const holder = useRef<HTMLDivElement>(null)
  const docRef = useRef<any>(null)

  const name = filename ?? `${title.replace(/[^\w]+/g, '-').toLowerCase()}.pdf`

  /* The ticket, so the browser may fetch the file without a header. */
  useEffect(() => {
    const [pathname, query] = path.split('?')
    api.documentTicket(pathname)
      .then(({ ticket }) =>
        setUrl(`/api${pathname}?${query ? query + '&' : ''}ticket=${encodeURIComponent(ticket)}`))
      .catch((e: any) => { setErr(e.message); setBusy(false) })
  }, [path])

  /* Load it and draw every page. */
  useEffect(() => {
    if (!url) return
    let cancelled = false

    async function draw() {
      try {
        const pdfjs: any = await import('pdfjs-dist')
        /*
         * The worker is bundled alongside rather than fetched from a CDN. A
         * hospital LAN has no internet, and a viewer that silently needs one
         * is a viewer that works in testing and nowhere else.
         */
        pdfjs.GlobalWorkerOptions.workerSrc =
          new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

        const doc = await pdfjs.getDocument({ url }).promise
        if (cancelled) return
        docRef.current = doc
        setPages(doc.numPages)

        const box = holder.current
        if (!box) return
        box.innerHTML = ''

        for (let n = 1; n <= doc.numPages; n++) {
          const pdfPage = await doc.getPage(n)
          if (cancelled) return

          // Rendered at twice the display size so text stays crisp on the
          // high-resolution screens some of these desks have.
          const viewport = pdfPage.getViewport({ scale: 2 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className =
            'mx-auto mb-4 w-full max-w-[820px] rounded-xl border-2 border-line bg-white shadow-card'
          canvas.dataset.page = String(n)
          box.appendChild(canvas)

          await pdfPage.render({
            canvasContext: canvas.getContext('2d')!, viewport,
            // pdf.js 5 wants the canvas named explicitly.
            canvas
          }).promise
        }
        if (!cancelled) setBusy(false)
      } catch (e: any) {
        if (!cancelled) { setErr(e?.message ?? 'Could not draw the document'); setBusy(false) }
      }
    }

    draw()
    return () => { cancelled = true }
  }, [url])

  /** Scroll to a page rather than swapping it, so the whole report stays readable. */
  function goto(n: number) {
    const next = Math.min(Math.max(n, 1), pages || 1)
    setPage(next)
    holder.current?.querySelector<HTMLCanvasElement>(`canvas[data-page="${next}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /**
   * Printing opens the file in its own tab.
   *
   * Printing the canvases would print pictures of the pages — heavier, softer,
   * and at the mercy of the browser's own margins. A real tab hands the PDF to
   * the print dialog as a PDF, which is what a report should be.
   */
  function print() {
    if (!url) return
    const tab = window.open(url, '_blank')
    if (!tab) { setErr(tr('Allow pop-ups for this site to print.')); return }
  }

  return (
    <Modal title={title} wide onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost inline-flex items-center gap-1.5">
          <X size={14} /> {tr('Close')}
        </button>
        {url && !err && (
          <>
            <a href={url} download={name}
              className="btn-ghost inline-flex items-center gap-1.5">
              <Download size={14} /> {tr('Download')}
            </a>
            <button onClick={print} className="btn-primary inline-flex items-center gap-1.5">
              <Printer size={14} /> {tr('Print')}
            </button>
          </>
        )}
      </>}>

      <ErrorNote>{err}</ErrorNote>

      {pages > 1 && (
        <div className="mb-3 flex items-center justify-center gap-3">
          <button onClick={() => goto(page - 1)} disabled={page <= 1}
            className="btn-ghost px-2 py-1 disabled:opacity-40">
            <ChevronLeft size={14} />
          </button>
          <span className="num text-2xs text-muted">
            {tr('Page')} {page} {tr('of')} {pages}
          </span>
          <button onClick={() => goto(page + 1)} disabled={page >= pages}
            className="btn-ghost px-2 py-1 disabled:opacity-40">
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {busy && !err && (
        <div className="flex h-[40vh] flex-col items-center justify-center gap-3 text-muted">
          <FileText size={32} className="animate-pulse" />
          <p className="text-2xs">{tr('Preparing the document…')}</p>
          <div className="loading-bar w-48" />
        </div>
      )}

      <div ref={holder} className={`max-h-[68vh] overflow-auto rounded-xl bg-screen p-3 ${
        busy ? 'hidden' : 'anim-fade'}`} />

      {!busy && !err && (
        <p className="mt-2 text-2xs text-muted">
          {tr('Check the dates and the totals before printing.')}
        </p>
      )}
    </Modal>
  )
}
