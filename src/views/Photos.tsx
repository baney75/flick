// The Photos tab: photos and the home videos beside them, by month, newest first, and a full-window viewer.
// The grid shows only small thumbnails; a full picture loads only in the viewer. Nothing here uploads or syncs.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useThumb } from '../components/Card'
import { Icon } from '../components/icons'
import { byMonth, monthLabel, takenAt } from '../lib/photos'
import { resolve, type Item } from '../lib/library'

type Row = { t: 'head'; key: string; n: number } | { t: 'tiles'; items: Item[]; first: number }

const GAP = 4
const HEAD = 52
const dateOf = (i: Item) => new Date(takenAt(i)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Month header rows and rows of square tiles; `first` is the index of a row's first tile in the whole list. */
export function photoRows(list: Item[], cols: number): Row[] {
  const rows: Row[] = []
  let at = 0
  for (const g of byMonth(list)) {
    rows.push({ t: 'head', key: g.key, n: g.items.length })
    for (let i = 0; i < g.items.length; i += cols) rows.push({ t: 'tiles', items: g.items.slice(i, i + cols), first: at + i })
    at += g.items.length
  }
  return rows
}

export function Photos({ list }: { list: Item[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [open, setOpen] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // byMonth keeps the list's order, so the viewer walks the same order as the grid.
  const ordered = useMemo(() => byMonth(list).flatMap((g) => g.items), [list])
  const cols = Math.max(3, Math.floor((w + GAP) / (150 + GAP)))
  const tile = w ? (w - GAP * (cols - 1)) / cols : 150
  const rows = useMemo(() => photoRows(ordered, cols), [ordered, cols])
  const tops = useMemo(() => {
    const t: number[] = []
    let y = 0
    for (const r of rows) { t.push(y); y += r.t === 'head' ? HEAD : tile + GAP }
    t.push(y)
    return t
  }, [rows, tile])

  useEffect(() => {
    const scroller = box.current!.closest('.main') as HTMLElement | null
    const update = () => {
      const top = scroller ? box.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0
      const view = scroller?.clientHeight ?? innerHeight
      const from = -top - view, to = -top + 2 * view
      let s = 0
      while (s < rows.length && tops[s + 1] < from) s++
      let e = s
      while (e < rows.length && tops[e] < to) e++
      setRange((r) => (r[0] === s && r[1] === e ? r : [s, e]))
    }
    update()
    scroller?.addEventListener('scroll', update, { passive: true })
    return () => scroller?.removeEventListener('scroll', update)
  }, [rows, tops])

  return (
    <div class="photos" ref={box} style={{ height: `${tops[rows.length]}px` }}>
      {rows.slice(range[0], range[1]).map((r, n) => {
        const top = tops[range[0] + n]
        return r.t === 'head'
          ? <h2 class="photos-month" key={r.key} style={{ top: `${top}px` }}>{monthLabel(r.key)} <span>{r.n}</span></h2>
          : <div class="photos-row" key={r.first} style={{ top: `${top}px`, gridTemplateColumns: `repeat(${cols}, ${tile}px)`, gap: `${GAP}px` }}>
              {r.items.map((it, k) => <PhotoTile key={it.id} it={it} onOpen={() => setOpen(r.first + k)} />)}
            </div>
      })}
      {open !== null && ordered[open] && <PhotoViewer list={ordered} at={open} onMove={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** A file with no picture the web view can show (a HEIC in Chrome): its name and date, not a broken image. */
function FileTile({ it }: { it: Item }) {
  return (
    <div class="photo-file">
      <Icon name={it.kind === 'video' ? 'film' : 'file'} size={22} />
      <div class="photo-file-name">{it.title}</div>
      <div class="small dim">{dateOf(it)}</div>
    </div>
  )
}

function PhotoTile({ it, onOpen }: { it: Item; onOpen: () => void }) {
  const thumb = useThumb(it)
  const [tries, setTries] = useState(0)
  const [bad, setBad] = useState(false)
  // A busy server answers 503 for a moment, so a server thumbnail gets a few tries before it is given up.
  const url = thumb && tries ? `${thumb}&r=${tries}` : thumb
  const fail = () => {
    if (it.poster && tries < 3) setTimeout(() => setTries((n) => n + 1), 800 * (tries + 1))
    else setBad(true)
  }
  // A local photo has a date once its thumbnail was tried; with no thumbnail then, the web view cannot read it.
  const settled = it.kind === 'photo' && (!!it.poster || it.taken !== undefined)
  return (
    <button class="photo-tile" onClick={onOpen} aria-label={`${it.kind === 'video' ? 'Video' : 'Photo'} ${it.title}, ${dateOf(it)}`}>
      {url && !bad ? <img src={url} alt="" loading="lazy" decoding="async" onError={fail} />
        : bad || settled ? <FileTile it={it} /> : <span class="photo-wait" />}
      {it.kind === 'video' && <span class="photo-play"><Icon name="play" size={16} /></span>}
    </button>
  )
}

export function PhotoViewer({ list, at, onMove, onClose }: { list: Item[]; at: number; onMove: (i: number) => void; onClose: () => void }) {
  const it = list[at]
  // Both are kept with the id they belong to, so a move never shows one item's file, or its error, for another.
  const [got, setGot] = useState<{ id: string; url: string } | null>(null)
  const [badId, setBadId] = useState<string | null>(null)
  const src = got?.id === it.id ? got.url : null
  const bad = badId === it.id
  const down = useRef<number | null>(null)
  const move = (d: number) => { const n = at + d; if (n >= 0 && n < list.length) onMove(n) }

  useEffect(() => {
    let live = true
    let revoke: (() => void) | undefined
    const id = it.id
    resolve(it.src, undefined, undefined, true)
      .then((r) => { if (live) { revoke = r.revoke; setGot({ id, url: r.url }) } else r.revoke?.() })
      .catch(() => live && setBadId(id))
    return () => { live = false; revoke?.() }
  }, [it.id])

  // Taken before the app's own keys, so Escape closes the viewer instead of leaving the page.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (!d && e.key !== 'Escape') return
      e.preventDefault(); e.stopImmediatePropagation()
      if (d) move(d)
      else onClose()
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  })

  return (
    <div class="photo-viewer" role="dialog" aria-modal="true" aria-label={it.title}
      onPointerDown={(e) => { down.current = (e.target as HTMLElement).tagName === 'VIDEO' ? null : e.clientX }}
      onPointerUp={(e) => { const dx = down.current === null ? 0 : e.clientX - down.current; down.current = null; if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1) }}>
      <div class="photo-viewer-bar">
        <span>{at + 1} of {list.length} · {dateOf(it)}</span>
        <button class="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
      </div>
      <div class="photo-viewer-stage">
        {bad ? <FileTile it={it} />
          : !src ? null
          : it.kind === 'video' ? <video key={it.id} src={src} controls autoplay playsInline />
          : <img key={it.id} src={src} alt={it.title} draggable={false} onError={() => setBadId(it.id)} />}
      </div>
      {at > 0 && <button class="photo-nav prev" onClick={() => move(-1)} aria-label="Previous"><Icon name="left" size={26} /></button>}
      {at < list.length - 1 && <button class="photo-nav next" onClick={() => move(1)} aria-label="Next"><Icon name="left" size={26} /></button>}
    </div>
  )
}
