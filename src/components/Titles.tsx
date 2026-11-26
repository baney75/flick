// Cards and the source chooser for titles that come from more than one place.

import { useLayoutEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { Card, ItemCard, useThumb } from './Card'
import { Icon } from './icons'
import { ShowCard } from '../views/Home'
import { go, play, playItem, itemRequest, progress } from '../lib/store'
import { formatBytes, formatTime } from '../lib/parse'
import { titlePath, progressKey } from '../lib/plugins/use'
import { ranked, srcKey, srcName, badgeOf, latestProgress, pickedFor, remember, type Src, type Title } from '../lib/titles'
import type { Item } from '../lib/library'

/** Plays or opens one source of a title. */
export function openSrc(s: Src) {
  if (s.t === 'show') return go(`/show/${encodeURIComponent(s.name.toLowerCase())}`)
  if (s.t === 'plugin') {
    const ep = s.m.progress?.videoId && s.m.type === 'series' ? s.m.progress.videoId : undefined
    return go(titlePath(s.p, s.m.type, s.m.id, ep))
  }
  // The server row of a downloaded title streams; every other item row plays as it always has.
  if (s.stream) return play({ ...itemRequest(s.it), stream: true })
  playItem(s.it)
}

const choosing = signal<Title | null>(null)

/** One source opens straight away; two or more open the chooser. */
export function openTitle(t: Title) {
  if (t.srcs.length === 1) return openSrc(t.srcs[0])
  choosing.value = t
}

export function TitleCard({ t, onMore }: { t: Title; onMore?: (it: Item, e: MouseEvent) => void }) {
  const only = t.srcs.length === 1 ? t.srcs[0] : null
  if (only?.t === 'item') return <ItemCard it={only.it} onClick={() => openSrc(only)} onMore={onMore && ((e) => onMore(only.it, e))} />
  if (only?.t === 'show') return <ShowCard eps={only.eps} />
  return <MergedCard t={t} />
}

function MergedCard({ t }: { t: Title }) {
  const first = t.srcs.find((s) => s.t !== 'plugin')
  const it = first?.t === 'item' ? first.it : first?.t === 'show' ? first.eps[0] : undefined
  const thumb = useThumb(it)
  const meta = t.srcs.find((s): s is Extract<Src, { t: 'plugin' }> => s.t === 'plugin')?.m
  const pct = latestProgress(t, progress.value, (p, m) => progress.value[progressKey(p, m.id)])
  const shows = t.type === 'show'
  return (
    <Card image={it?.poster ? thumb : meta?.poster ?? thumb} title={t.name} sub={[t.year, shows ? 'Show' : null].filter(Boolean).join(' · ') || undefined}
      shape={it && !it.poster ? 'wide' : 'poster'} pct={pct} badge={badgeOf(t)} onClick={() => openTitle(t)} />
  )
}

function detail(s: Src): string {
  if (s.t === 'plugin') return [s.m.year, 'Opens its title page'].filter(Boolean).join(' · ')
  if (s.t === 'show') {
    const seasons = new Set(s.eps.map((e) => e.season ?? 1)).size
    return `${seasons > 1 ? `${seasons} seasons · ` : ''}${s.eps.length} episodes`
  }
  return [s.it.size > 1 ? formatBytes(s.it.size) : null, s.it.duration ? formatTime(s.it.duration) : null, s.it.folder].filter(Boolean).join(' · ')
}

/** The chooser: one row per source, best first, the first one focused. Mounted once by the app. */
export function SourceSheet() {
  const t = choosing.value
  const firstRow = useRef<HTMLButtonElement>(null)
  // A layout effect, so the first row has focus as soon as the sheet shows.
  useLayoutEffect(() => {
    if (!t) return
    firstRow.current?.focus()
    // Capture phase: Escape closes the sheet and stops there, before the app's Back handler sees it.
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); choosing.value = null } }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [t])
  if (!t) return null
  const rows = ranked(t.srcs, pickedFor(t.key))
  const pick = (s: Src) => { remember(t.key, srcKey(s)); choosing.value = null; openSrc(s) }
  return (
    <div class="sheet-back" role="dialog" aria-modal="true" aria-label={`Play ${t.name} from`} onClick={() => { choosing.value = null }}>
      <div class="sheet panel source-sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{t.name}{t.year ? ` (${t.year})` : ''}</h3>
        <p class="small dim">Choose where to play it from.</p>
        {rows.map((s, i) => (
          <button class="list-row source-row" ref={i === 0 ? firstRow : undefined} onClick={() => pick(s)}>
            <Icon name={s.t === 'plugin' ? 'plug' : s.t === 'item' && s.dl ? 'download' : 'play'} size={16} />
            <div class="grow"><div>{srcName(s)}</div><div class="small dim">{detail(s)}</div></div>
          </button>
        ))}
        <div class="row end"><button class="btn ghost" onClick={() => { choosing.value = null }}>Cancel</button></div>
      </div>
    </div>
  )
}
