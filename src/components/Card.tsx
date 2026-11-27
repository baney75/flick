import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks'
import { Fragment, type ComponentChildren } from 'preact'
import { thumbUrl, KODI_IMG, type Item } from '../lib/library'
import { kodiPoster } from '../lib/servers'
import { thumbTick, progress, episodeLabel } from '../lib/store'
import { formatTime } from '../lib/parse'
import { Icon } from './icons'
import { downloads } from '../lib/downloads'
import { badgeFor } from '../lib/offline'

export function useThumb(it: Item | undefined) {
  const plain = it?.poster && !it.poster.startsWith(KODI_IMG) ? it.poster : null
  // The URL is kept with the id it is for: a card given another item shows nothing until that item's
  // own image is found, never the image of the item it showed before.
  const [got, setGot] = useState<{ id: string; url: string } | null>(null)
  const tick = thumbTick.value
  useEffect(() => {
    if (!it || plain) return
    let live = true
    const id = it.id
    ;(it.poster ? kodiPoster(it) : thumbUrl(id)).then((u) => live && u && setGot({ id, url: u }))
    return () => { live = false }
  }, [it?.id, tick])
  return plain ?? (got && got.id === it?.id ? got.url : null)
}

/** A grid's rows hold the items from `from` on; the items in [vis[0], vis[1]) are on screen. */
type GridRows = HTMLDivElement & { from?: number; vis?: [number, number] }

/**
 * A loaded card image fades in, unless it loaded in a row the grid drew ahead of the scroll: nobody sees that
 * fade, and WebKit drops frames running one on every card a fast scroll brings in. The grid says which items
 * are on screen, so this reads no layout, and it sets the classes itself, so a load re-renders nothing.
 */
function shown(img: HTMLImageElement) {
  const cell = img.closest('.vgrid-inner > *')
  const rows = cell?.parentElement as GridRows | null | undefined
  const i = rows?.vis && rows.from != null ? rows.from + Array.prototype.indexOf.call(rows.children, cell) : -1
  img.classList.add(...(rows?.vis && (i < rows.vis[0] || i >= rows.vis[1]) ? ['in', 'now'] : ['in']))
}

export function Card(props: {
  image?: string | null
  title: string
  sub?: string
  shape?: 'wide' | 'poster' | 'square'
  pct?: number
  icon?: string
  badge?: string
  /** A length on the thumbnail's corner, like a video site's. */
  time?: string
  /** A third line of short facts. */
  info?: string
  /** Give the title two lines. */
  wrap?: boolean
  /** What this card is, for keys that act on the focused card. */
  target?: string
  onClick: () => void
  onMore?: (e: MouseEvent) => void
}) {
  const { image, title, sub, shape = 'wide', pct, icon = 'film', badge, time, info, wrap, target, onClick, onMore } = props
  const hold = useLongPress(onMore)
  return (
    <button class={`card ${shape}`} data-target={target} onClick={(e) => { if (hold.fired()) e.stopPropagation(); else onClick() }} onContextMenu={onMore ? (e) => { e.preventDefault(); onMore(e) } : undefined} title={title} {...hold.events}>
      <div class="art">
        {image ? <img src={image} alt="" loading="lazy" decoding="async" onLoad={(e) => shown(e.currentTarget)} /> : <div class="art-ph"><Icon name={icon} size={30} /></div>}
        {badge && <span class="badge">{badge}</span>}
        {time && <span class="card-time">{time}</span>}
        <span class="play-hint"><Icon name="play" size={22} /></span>
        {pct != null && pct > 0 && <div class="pbar"><div style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>}
      </div>
      <div class="meta">
        <div class={wrap ? 't1 clamp2' : 't1'}>{title}</div>
        {sub && <div class="t2">{sub}</div>}
        {info && <div class="t2 card-info">{info}</div>}
      </div>
    </button>
  )
}

/**
 * Holding a card on a touch screen opens its menu. iPhone Safari never fires contextmenu,
 * so without this the menu (and Download) is out of reach there.
 */
function useLongPress(onMore?: (e: MouseEvent) => void) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const done = useRef(false)
  const start = useRef<[number, number]>([0, 0])
  const clear = () => { if (t.current) clearTimeout(t.current); t.current = null }
  return {
    fired: () => { const f = done.current; done.current = false; return f },
    events: onMore ? {
      onPointerDown: (e: PointerEvent) => {
        done.current = false
        if (e.pointerType !== 'touch') return
        start.current = [e.clientX, e.clientY]
        t.current = setTimeout(() => { done.current = true; onMore(new MouseEvent('contextmenu', { clientX: start.current[0], clientY: start.current[1] })) }, 500)
      },
      onPointerMove: (e: PointerEvent) => { if (Math.hypot(e.clientX - start.current[0], e.clientY - start.current[1]) > 10) clear() },
      onPointerUp: clear,
      onPointerCancel: clear,
    } : {},
  }
}

export function ItemCard({ it, onClick, onMore }: { it: Item; onClick: () => void; onMore?: (e: MouseEvent) => void }) {
  const img = useThumb(it)
  const p = progress.value[it.id]
  const sub = it.kind === 'book' || it.kind === 'audiobook'
    ? [it.author, it.year].filter(Boolean).join(' · ') || 'Book'
    : it.show
    ? `${episodeLabel(it)} · ${it.title}`
    : [it.year, it.duration ? formatTime(it.duration) : null, it.origin !== 'local' ? originName(it) : null].filter(Boolean).join(' · ')
  return (
    <Card image={img} title={it.show ?? it.title} sub={sub} shape={it.kind === 'audio' || it.kind === 'audiobook' ? 'square' : it.kind === 'book' || (it.poster && it.origin !== 'local') ? 'poster' : 'wide'}
      icon={it.kind === 'audio' ? 'music' : it.kind === 'book' || it.kind === 'audiobook' ? 'book' : 'film'} pct={p && p.dur ? p.pos / p.dur : undefined} badge={badgeFor(downloads.value.get(it.id))}
      onClick={onClick} onMore={onMore} />
  )
}

export function originName(it: Item) {
  return it.origin === 'stored' ? 'Stored' : it.origin === 'jellyfin' ? 'Jellyfin' : it.origin === 'plex' ? 'Plex' : it.origin === 'kodi' ? 'Kodi' : it.origin === 'flick' ? 'Flick server' : 'Local'
}

/** A horizontal row that scrolls, with a heading. */
export function Row({ title, children, action }: { title: string; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <section class="row-section">
      <div class="row-head"><h2>{title}</h2>{action}</div>
      <div class="hrow">{children}</div>
    </section>
  )
}

/**
 * Only renders the rows on screen, so a library of 50,000 files scrolls as fast as one of 50.
 * The scroll container is the app's main pane.
 */
/**
 * A long list, one row a line, with only the rows near the screen in the page, as VirtualGrid does for
 * cards. Every row must be the same height: the first row in the page sets it, and is read again when
 * the rows resize (a larger text size). A list shelf's rows are: the thumbnail sets their height.
 */
export function VirtualList<T>({ list, gap = 4, class: cls, keyOf, render }: {
  list: T[]
  gap?: number
  class?: string
  /** Each row's key: a scroll then moves the rows it keeps instead of giving each one another item. */
  keyOf: (t: T) => string
  render: (t: T) => ComponentChildren
}) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 30])

  useLayoutEffect(() => {
    const el = inner.current!
    const read = () => {
      const first = el.firstElementChild as HTMLElement | null
      if (first) setRowH(first.offsetHeight + gap)
    }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [gap])

  useEffect(() => {
    const el = box.current!
    const scroller = el.closest('.main') as HTMLElement | null
    if (!scroller || !rowH) return
    // As in VirtualGrid: a closed screen's listener can still hear a scroll after the list is gone.
    const update = () => {
      if (!el.isConnected) return
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const start = Math.max(0, Math.floor(-top / rowH) - 8)
      const end = Math.min(list.length, Math.ceil((-top + scroller.clientHeight) / rowH) + 8)
      setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]))
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [rowH, list.length])

  const [a, b] = rowH ? range : [0, 30]
  return (
    <div ref={box} style={rowH ? { height: `${Math.max(0, list.length * rowH - gap)}px` } : undefined}>
      <div ref={inner} class={cls} style={{ transform: `translateY(${a * rowH}px)`, gap: `${gap}px` }}>
        {list.slice(a, b).map((t) => <Fragment key={keyOf(t)}>{render(t)}</Fragment>)}
      </div>
    </div>
  )
}

export function VirtualGrid<T>({ list, min = 220, ratio = 9 / 16, extra = 54, keyOf, render }: {
  list: T[]
  min?: number
  ratio?: number
  extra?: number
  /** Each cell's key: a scroll then moves the cards it keeps instead of giving each one another item. */
  keyOf: (t: T) => string
  render: (t: T) => ComponentChildren
}) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<GridRows>(null)
  const [w, setW] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 12])
  // A row's height as drawn, once a row is in the page. The estimate below is only for the first frame:
  // the cards' text is a few px off it, and every row the window moved would shift the grid by that much.
  const [drawn, setDrawn] = useState(0)
  const gap = 16

  useLayoutEffect(() => {
    const el = box.current!
    // The grid's width follows the pane it scrolls in. Observing the grid itself would also hear its height,
    // which changes as the row height below is measured, inside that observer's own callback: WebKit then
    // drops the notification and reports a ResizeObserver loop.
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el.closest('.main') ?? el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Phones fit three posters or two wide cards a row, as Streamyfin and Infuse do,
  // instead of one card the full width of the screen.
  const fit = w && w < 600 ? Math.min(min, ratio > 1 ? 100 : 150) : min
  const cols = Math.max(1, Math.floor((w + gap) / (fit + gap)))
  const cardW = w ? (w - gap * (cols - 1)) / cols : min
  const rowH = drawn || cardW * ratio + extra + gap
  const rows = Math.ceil(list.length / cols)
  const shown = Math.ceil(Math.min(list.length, range[1] * cols) / cols) - range[0]

  useLayoutEffect(() => {
    const el = inner.current!
    const read = () => {
      if (shown <= 0) return
      const h = (el.offsetHeight + gap) / shown
      setDrawn((d) => (Math.abs(d - h) < 0.5 ? d : h))
    }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [shown, cols])

  useEffect(() => {
    const el = box.current!
    const scroller = el.closest('.main') as HTMLElement | null
    if (!scroller) return
    // Preact runs a closed screen's effect cleanups after the next paint, so this listener can still hear
    // a pane scroll once the grid is gone. Then there is nothing to window.
    const update = () => {
      if (!el.isConnected) return
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const first = Math.max(0, Math.floor(-top / rowH)), past = Math.ceil((-top + scroller.clientHeight) / rowH)
      inner.current!.vis = [first * cols, past * cols]
      const start = Math.max(0, first - 3)
      const end = Math.min(rows, past + 3)
      setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]))
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [rowH, rows, cols])
  useLayoutEffect(() => { inner.current!.from = range[0] * cols })

  const slice = list.slice(range[0] * cols, range[1] * cols)
  return (
    <div ref={box} class="vgrid" style={{ height: `${rows * rowH}px`, '--art-h': `${cardW * ratio}px` }}>
      <div ref={inner} class="vgrid-inner" style={{ transform: `translateY(${range[0] * rowH}px)`, gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {slice.map((t) => <Fragment key={keyOf(t)}>{render(t)}</Fragment>)}
      </div>
    </div>
  )
}
