import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { thumbUrl, KODI_IMG, type Item } from '../lib/library'
import { kodiPoster } from '../lib/servers'
import { thumbTick, progress, episodeLabel } from '../lib/store'
import { formatTime } from '../lib/parse'
import { Icon } from './icons'
import { downloads } from '../lib/downloads'
import { badgeFor } from '../lib/offline'

export function useThumb(it: Item | undefined) {
  const plain = it?.poster && !it.poster.startsWith(KODI_IMG) ? it.poster : null
  const [url, setUrl] = useState<string | null>(null)
  const tick = thumbTick.value
  useEffect(() => {
    if (!it || plain) return
    let live = true
    ;(it.poster ? kodiPoster(it) : thumbUrl(it.id)).then((u) => live && u && setUrl(u))
    return () => { live = false }
  }, [it?.id, tick])
  return plain ?? url
}

export function Card(props: {
  image?: string | null
  title: string
  sub?: string
  shape?: 'wide' | 'poster' | 'square'
  pct?: number
  icon?: string
  badge?: string
  onClick: () => void
  onMore?: (e: MouseEvent) => void
}) {
  const { image, title, sub, shape = 'wide', pct, icon = 'film', badge, onClick, onMore } = props
  const [loaded, setLoaded] = useState(false)
  const hold = useLongPress(onMore)
  return (
    <button class={`card ${shape}`} onClick={(e) => { if (hold.fired()) e.stopPropagation(); else onClick() }} onContextMenu={onMore ? (e) => { e.preventDefault(); onMore(e) } : undefined} title={title} {...hold.events}>
      <div class="art">
        {image ? <img src={image} alt="" loading="lazy" decoding="async" class={loaded ? 'in' : ''} onLoad={() => setLoaded(true)} /> : <div class="art-ph"><Icon name={icon} size={30} /></div>}
        {badge && <span class="badge">{badge}</span>}
        <span class="play-hint"><Icon name="play" size={22} /></span>
        {pct != null && pct > 0 && <div class="pbar"><div style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>}
      </div>
      <div class="meta">
        <div class="t1">{title}</div>
        {sub && <div class="t2">{sub}</div>}
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
  const sub = it.kind === 'book'
    ? [it.author, it.year].filter(Boolean).join(' · ') || 'Book'
    : it.show
    ? `${episodeLabel(it)} · ${it.title}`
    : [it.year, it.duration ? formatTime(it.duration) : null, it.origin !== 'local' ? originName(it) : null].filter(Boolean).join(' · ')
  return (
    <Card image={img} title={it.show ?? it.title} sub={sub} shape={it.kind === 'audio' ? 'square' : it.kind === 'book' || (it.poster && it.origin !== 'local') ? 'poster' : 'wide'}
      icon={it.kind === 'audio' ? 'music' : it.kind === 'book' ? 'book' : 'film'} pct={p && p.dur ? p.pos / p.dur : undefined} badge={badgeFor(downloads.value.get(it.id))}
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
export function VirtualGrid<T>({ list, min = 220, ratio = 9 / 16, extra = 54, render }: {
  list: T[]
  min?: number
  ratio?: number
  extra?: number
  render: (t: T) => ComponentChildren
}) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 12])
  const gap = 16

  useLayoutEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Phones fit three posters or two wide cards a row, as Streamyfin and Infuse do,
  // instead of one card the full width of the screen.
  const fit = w && w < 600 ? Math.min(min, ratio > 1 ? 100 : 150) : min
  const cols = Math.max(1, Math.floor((w + gap) / (fit + gap)))
  const cardW = w ? (w - gap * (cols - 1)) / cols : min
  const rowH = cardW * ratio + extra + gap
  const rows = Math.ceil(list.length / cols)

  useEffect(() => {
    const scroller = box.current!.closest('.main') as HTMLElement | null
    if (!scroller) return
    const update = () => {
      const top = box.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const start = Math.max(0, Math.floor(-top / rowH) - 3)
      const end = Math.min(rows, Math.ceil((-top + scroller.clientHeight) / rowH) + 3)
      setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]))
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [rowH, rows])

  const slice = list.slice(range[0] * cols, range[1] * cols)
  return (
    <div ref={box} class="vgrid" style={{ height: `${rows * rowH}px`, '--art-h': `${cardW * ratio}px` }}>
      <div class="vgrid-inner" style={{ transform: `translateY(${range[0] * rowH}px)`, gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {slice.map((t) => render(t))}
      </div>
    </div>
  )
}
