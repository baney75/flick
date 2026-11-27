// The book reader: one page at a time, sized to the window, so even a 1,000 page PDF opens at once.
// pdf.js loads only when a book opens, so the rest of Flick stays as fast to start as before.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { items, loaded, saveProgress, go, type Progress, type Ref } from '../lib/store'
import * as db from '../lib/db'
import { resolve, srcName, type Item } from '../lib/library'
import { clampPage, ext } from '../lib/parse'
import { Icon } from '../components/icons'
import { useEscape } from '../lib/escape'
import { EpubReader, ColorPicker } from './EpubReader'
import { savedColor, saveColor } from '../lib/pagecolor'
import type { PageColor } from '../lib/epub'

type Pdf = import('pdfjs-dist').PDFDocumentProxy

async function openPdf(url: string): Promise<Pdf> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const base: string = import.meta.env.VITE_PDFJS_BASE
  return pdfjs.getDocument({
    url,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  }).promise
}

/** 'epub' or 'pdf': from the file name, or when there is none (a server link), from the file's first bytes. */
async function bookFormat(it: Item): Promise<string> {
  const e = ext(srcName(it.src))
  if (e === 'epub' || e === 'pdf') return e
  const r = await resolve(it.src, undefined, it.id, true).catch(() => null)
  const head = !r ? '' : r.file ? await r.file.slice(0, 2).text() : await fetch(r.url, { headers: { Range: 'bytes=0-1' } }).then((x) => x.text()).catch(() => '')
  r?.revoke?.()
  return head.startsWith('PK') ? 'epub' : 'pdf'
}

/** A book from a plugin stream: a URL, a title and the progress Ref to save under. */
export interface BookLink { url: string; title: string; key: string; ref: Ref }

export function Reader({ id, link }: { id: string; link?: BookLink }) {
  const it = link ? undefined : items.value.find((i) => i.id === id)
  const [fmt, setFmt] = useState('')
  useEffect(() => { if (it) bookFormat(it).then(setFmt) }, [it?.id])
  if (it && fmt === 'epub') return <EpubReader it={it} />
  if (it && !fmt) return <div class="reader"><div class="reader-stage"><span class="spinner" aria-label="Opening" /></div></div>
  return <PdfReader id={id} link={link} />
}

function PdfReader({ id, link }: { id: string; link?: BookLink }) {
  const found = items.value.find((i) => i.id === id)
  const it = link ? { id: link.key, title: link.title, author: undefined as string | undefined } : found
  const [pdf, setPdf] = useState<Pdf | null>(null)
  const [err, setErr] = useState('')
  // Bumped by Try again: after a reload, a folder needs a click before the browser lets Flick read it again.
  const [tries, setTries] = useState(0)
  const [page, setPage] = useState(1)
  const [color, setColor] = useState<PageColor>(savedColor)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    if (!it) return
    let live = true
    let revoke: (() => void) | undefined
    ;(link ? Promise.resolve({ url: link.url, revoke: undefined }) : resolve(found!.src, undefined, found!.id, true))
      .then(async (r) => {
        if (!live) return r.revoke?.()
        revoke = r.revoke
        // Read the saved page from the database, not the progress signal, which may not have loaded yet after a reload.
        const [d, saved] = await Promise.all([openPdf(r.url), db.get<Progress>('progress', it.id).catch(() => undefined)])
        if (!live) return void d.loadingTask.destroy()
        setPage(clampPage(saved?.pos ?? 1, d.numPages))
        setPdf(d)
      })
      .catch((e) => live && setErr((e as Error).message || 'This book could not be opened.'))
    return () => { live = false; revoke?.() }
  }, [it?.id, tries])

  useEffect(() => () => { pdf?.loadingTask.destroy() }, [pdf])

  // Watch the stage from the moment it mounts: after a reload it appears only once the library has loaded.
  const ro = useRef<ResizeObserver | null>(null)
  const stage = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) return
    ro.current = new ResizeObserver(([e]) => setSize((s) => (s.w === e.contentRect.width && s.h === e.contentRect.height ? s : { w: e.contentRect.width, h: e.contentRect.height })))
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])

  // A book opened from a link or a fresh tab has no page to go back to.
  const leave = () => (history.length > 1 ? history.back() : go('/library'))
  useEscape(true, leave, true)

  // Draw the page to fit the stage, sharp on high-density screens.
  useEffect(() => {
    if (!pdf || !size.w || !canvas.current) return
    let task: { cancel(): void; promise: Promise<void> } | null = null
    let live = true
    pdf.getPage(clampPage(page, pdf.numPages)).then((pg) => {
      if (!live) return
      const base = pg.getViewport({ scale: 1 })
      const scale = Math.min(size.w / base.width, size.h / base.height)
      const vp = pg.getViewport({ scale: scale * devicePixelRatio })
      const c = canvas.current!
      c.width = Math.floor(vp.width)
      c.height = Math.floor(vp.height)
      c.style.width = `${Math.floor(vp.width / devicePixelRatio)}px`
      c.style.height = `${Math.floor(vp.height / devicePixelRatio)}px`
      task = pg.render({ canvas: c, viewport: vp })
      task.promise.catch(() => {})
      // Warm the next page so turning is instant.
      if (page < pdf.numPages) pdf.getPage(page + 1).catch(() => {})
    })
    return () => { live = false; task?.cancel() }
  }, [pdf, page, size.w, size.h])

  // Remember the page, so the book opens where you left it and shows in Continue.
  useEffect(() => {
    if (!pdf || !it) return
    saveProgress(it.id, { pos: page, dur: pdf.numPages, book: true, at: Date.now(), title: it.title, subtitle: it.author, ref: link?.ref ?? { t: 'item', id: it.id } }).catch(() => {})
  }, [pdf, page])

  const turn = (d: number) => pdf && setPage((p) => clampPage(p + d, pdf.numPages))

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input')) return
      if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); turn(e.shiftKey && e.key === ' ' ? -1 : 1) }
      else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); turn(-1) }
      else if (e.key === 'Home') setPage(1)
      else if (e.key === 'End' && pdf) setPage(pdf.numPages)
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [pdf])

  const recolor = (c: PageColor) => { setColor(c); saveColor(c) }

  if (!it && !loaded.value) return <div class="reader"><div class="reader-stage"><span class="spinner" aria-label="Opening" /></div></div>
  if (!it) return <div class="page"><p class="dim">This book is not in your library.</p><a href="#/library">Back to library</a></div>

  return (
    <div class={`reader ${color}`}>
      <header class="reader-bar">
        <button class="btn ghost sm" onClick={leave} aria-label="Back"><Icon name="left" size={18} /></button>
        <div class="reader-title"><div class="t1">{it.title}</div>{it.author && <div class="t2">{it.author}</div>}</div>
        {pdf && (
          <label class="reader-page">
            <input type="number" min={1} max={pdf.numPages} value={page} aria-label="Page"
              onChange={(e) => setPage(clampPage(Number((e.target as HTMLInputElement).value), pdf.numPages))} />
            <span>of {pdf.numPages}</span>
          </label>
        )}
        <ColorPicker color={color} onPick={recolor} />
      </header>
      <div class="reader-stage" ref={stage} onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        turn(e.clientX - r.left < r.width / 3 ? -1 : 1)
      }}>
        {err ? (
          <div class="center" onClick={(e) => e.stopPropagation()}>
            <p class="err">{err}</p>
            <button class="btn primary" onClick={() => { setErr(''); setTries((t) => t + 1) }}>Try again</button>
          </div>
        ) : !pdf ? <span class="spinner" aria-label="Opening" /> : <canvas ref={canvas} />}
      </div>
    </div>
  )
}
