// The EPUB reader: one chapter at a time in a sandboxed frame, paged like a book, with the place remembered.

import { useEffect, useRef, useState } from 'preact/hooks'
import { saveProgress, go, thumbTick, type Progress } from '../lib/store'
import * as db from '../lib/db'
import { resolve, hasThumb, type Item } from '../lib/library'
import { openEpub, chapterPage, coverBlob, toPos, fromPos, type Book, type PageColor } from '../lib/epub'
import { PAGE_COLORS, savedColor, saveColor, chapterLeft } from '../lib/pagecolor'
import { Icon } from '../components/icons'

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const setPref = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export function EpubReader({ it }: { it: Item }) {
  const [book, setBook] = useState<Book | null>(null)
  const [err, setErr] = useState('')
  const [tries, setTries] = useState(0)
  const [at, setAt] = useState<{ chapter: number; start: number | 'end' | string }>({ chapter: 0, start: 0 })
  const [pos, setPos] = useState({ page: 0, pages: 1 })
  const [doc, setDoc] = useState('')
  const [size, setSize] = useState(() => Number(pref('flick.reader.size', '100')))
  const [color, setColor] = useState<PageColor>(savedColor)
  const [toc, setToc] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  // Each layout gets a number the frame echoes back, so a frame that is being replaced can't move the place.
  const gen = useRef(0)
  // The layout whose frame has reported its place. Until the newest one has, a turn waits in `held`:
  // posted now, it would reach the frame being replaced and be lost (#168). The newest turn wins.
  const ready = useRef(0)
  const held = useRef(0)
  const place = (a: typeof at) => { ready.current = -1; setAt(a) }

  useEffect(() => {
    let live = true
    let revoke: (() => void) | undefined
    resolve(it.src, undefined, it.id, true)
      .then(async (r) => {
        revoke = r.revoke
        const buf = r.file ? await r.file.arrayBuffer() : await fetch(r.url).then((x) => { if (!x.ok) throw new Error(`The server said ${x.status}`); return x.arrayBuffer() })
        const [b, saved] = await Promise.all([openEpub(buf), db.get<Progress>('progress', it.id).catch(() => undefined)])
        if (!live) return
        const p = fromPos(saved?.pos, b.spine.length)
        setAt({ chapter: p.chapter, start: p.frac })
        setBook(b)
        // The cover becomes the poster in the library.
        if (!(await hasThumb(it.id))) {
          const c = await coverBlob(b).catch(() => null)
          if (c) { await db.put('thumbs', it.id, c); thumbTick.value++ }
        }
      })
      .catch((e) => live && setErr((e as Error).message || 'This book could not be opened.'))
    return () => { live = false; revoke?.() }
  }, [it.id, tries])

  // Lay out the chapter again when the place, the type size or the colors change.
  useEffect(() => {
    if (!book) return
    let live = true
    const g = ++gen.current
    chapterPage(book, at.chapter, { start: at.start, size, color, gen: g }).then((h) => live && setDoc(h), (e) => live && setErr((e as Error).message))
    return () => { live = false }
  }, [book, at, size, color])

  const leave = () => (history.length > 1 ? history.back() : go('/library'))
  const turn = (d: number) => {
    if (ready.current !== gen.current) { held.current = d; return }
    frame.current?.contentWindow?.postMessage({ t: 'turn', d }, '*')
  }
  const jump = (path: string, frag: string) => {
    const i = book?.spine.indexOf(path) ?? -1
    if (i >= 0) place({ chapter: i, start: frag || 0 })
    setToc(false)
  }
  const key = (k: string, shift: boolean) => {
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(k)) turn(shift && k === ' ' ? -1 : 1)
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(k)) turn(-1)
    else if (k === 'Home') place({ chapter: 0, start: 0 })
    else if (k === 'Escape') toc ? setToc(false) : leave()
  }

  // Messages from the chapter frame. Only that frame's window is listened to, and only known shapes.
  useEffect(() => {
    const m = (e: MessageEvent) => {
      if (!book || e.source !== frame.current?.contentWindow || typeof e.data !== 'object' || !e.data || e.data.g !== gen.current) return
      const d = e.data as { t: string; page?: number; pages?: number; d?: number; key?: string; shift?: boolean; href?: string }
      if (d.t === 'pos' && Number.isInteger(d.page) && Number.isInteger(d.pages)) {
        setPos({ page: d.page!, pages: d.pages! })
        if (ready.current !== gen.current) {
          ready.current = gen.current
          const h = held.current
          held.current = 0
          if (h) turn(h)
        }
        const last = at.chapter === book.spine.length - 1 && d.page === d.pages! - 1
        const p = last ? book.spine.length + 1 : toPos(at.chapter, d.page!, d.pages!)
        saveProgress(it.id, { pos: p, dur: book.spine.length + 1, book: true, at: Date.now(), title: it.title, subtitle: it.author, ref: { t: 'item', id: it.id } }).catch(() => {})
      } else if (d.t === 'edge' && (d.d === 1 || d.d === -1)) {
        const c = at.chapter + d.d
        if (c >= 0 && c < book.spine.length) place({ chapter: c, start: d.d > 0 ? 0 : 'end' })
      } else if (d.t === 'key' && typeof d.key === 'string') key(d.key, !!d.shift)
      else if (d.t === 'link' && typeof d.href === 'string') jump(d.href.split('#')[0], d.href.split('#')[1] ?? '')
    }
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,select')) return
      if ([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) e.preventDefault()
      key(e.key, e.shiftKey)
    }
    addEventListener('message', m)
    addEventListener('keydown', k)
    return () => { removeEventListener('message', m); removeEventListener('keydown', k) }
  }, [book, at, toc])

  const resize = (d: number) => { const s = Math.min(200, Math.max(70, size + d)); setSize(s); setPref('flick.reader.size', String(s)); place({ ...at, start: pos.page / pos.pages }) }
  const recolor = (c: PageColor) => { setColor(c); saveColor(c); place({ ...at, start: pos.page / pos.pages }) }
  const chapterName = book && [...book.toc].reverse().find((t) => t.path === book.spine[at.chapter])?.label

  return (
    <div class={`reader epub ${color}`}>
      <header class="reader-bar">
        <button class="btn ghost sm" onClick={leave} aria-label="Back"><Icon name="left" size={18} /></button>
        <div class="reader-title"><div class="t1">{it.title}</div><div class="t2">{chapterName ?? it.author}</div></div>
        {book && <span class="reader-page small dim" aria-live="polite">{`Page ${pos.page + 1} of ${pos.pages}`}</span>}
        {book && book.toc.length > 0 && <button class="btn ghost sm" onClick={() => setToc(!toc)} aria-expanded={toc}>Contents</button>}
        <button class="btn ghost sm" onClick={() => resize(-10)} aria-label="Smaller text">A-</button>
        <button class="btn ghost sm" onClick={() => resize(10)} aria-label="Larger text">A+</button>
        <ColorPicker color={color} onPick={recolor} />
      </header>
      <div class="reader-stage">
        {err ? (
          <div class="center">
            <p class="err">{err}</p>
            <button class="btn primary" onClick={() => { setErr(''); setTries((t) => t + 1) }}>Try again</button>
          </div>
        ) : !doc ? <span class="spinner" aria-label="Opening" /> : (
          // No allow-same-origin: the book runs in an opaque origin and cannot reach Flick's storage.
          <iframe ref={frame} class="epub-frame" title="Book page" sandbox="allow-scripts" srcdoc={doc} onLoad={() => frame.current?.focus()} />
        )}
        {toc && book && (
          <nav class="epub-toc panel" aria-label="Contents">
            {book.toc.map((t) => <button style={{ paddingLeft: `${12 + t.depth * 14}px` }} onClick={() => jump(t.path, t.frag)}>{t.label}</button>)}
          </nav>
        )}
      </div>
      {book && <footer class="chapter-left">{chapterLeft(pos.page, pos.pages)}</footer>}
    </div>
  )
}

/** Day, Paper and Night as one small segmented control. */
export function ColorPicker({ color, onPick }: { color: PageColor; onPick: (c: PageColor) => void }) {
  return (
    <div class="page-colors" role="radiogroup" aria-label="Page color">
      {PAGE_COLORS.map((c) => (
        <button role="radio" aria-checked={color === c.id} class={`swatch-btn ${c.id} ${color === c.id ? 'on' : ''}`} title={c.label} aria-label={c.label} onClick={() => onPick(c.id)}>Aa</button>
      ))}
    </div>
  )
}
