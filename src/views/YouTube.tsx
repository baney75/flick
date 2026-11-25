import { useState } from 'preact/hooks'
import { items, play, playItem, notify, reloadItems } from '../lib/store'
import { Card } from '../components/Card'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'
import { formatTime } from '../lib/parse'
import { ytSearch, ytResolve, ytSave, type YtResult } from '../lib/youtube'

export function YouTube() {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<YtResult[] | null>(null)

  if (!isDesktop) {
    return (
      <div class="page">
        <header class="page-head"><h1>YouTube</h1></header>
        <div class="empty">
          <Icon name="youtube" size={44} />
          <h2>YouTube needs the desktop app</h2>
          <p>The Flick app for Mac, Windows and Linux searches YouTube, plays videos in Flick and saves them for offline play.</p>
        </div>
      </div>
    )
  }

  const search = async (e: Event) => {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    try { setResults(await ytSearch(q.trim())) } catch (err) { notify((err as Error).message ?? String(err), 6000) }
    setBusy(false)
  }

  return (
    <div class="page">
      <header class="page-head">
        <h1>YouTube</h1>
        <form class="search" onSubmit={search}>
          <Icon name="search" size={16} />
          <input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Search YouTube" aria-label="Search YouTube" />
        </form>
      </header>
      {busy && <div class="status inline"><span class="spinner" /> Searching</div>}
      {results && !results.length && <p class="dim">No results for “{q}”.</p>}
      {results && <div class="yt-grid">{results.map((r) => <YtCard key={r.id} r={r} />)}</div>}
    </div>
  )
}

function YtCard({ r }: { r: YtResult }) {
  const [pct, setPct] = useState<number | null>(null)
  const saved = items.value.find((i) => i.folder === 'YouTube' && i.src.t === 'path' && i.src.path.endsWith(`/${r.id}.mp4`))

  const open = async () => {
    if (saved) return playItem(saved)
    notify('Finding the stream…')
    try {
      const s = await ytResolve(r.id)
      play({ key: 'yt:' + r.id, url: s.url, title: s.title || r.title, subtitle: s.channel || r.channel, kind: 'video', poster: s.thumbnail || r.thumbnail,
        ref: { t: 'url', url: 'https://www.youtube.com/watch?v=' + r.id } })
    } catch (err) { notify((err as Error).message ?? String(err), 6000) }
  }

  const save = async () => {
    setPct(0)
    try {
      await ytSave(r, setPct)
      await reloadItems()
      notify(`Saved “${r.title}” to your library.`)
    } catch (err) { notify((err as Error).message ?? String(err), 6000) }
    setPct(null)
  }

  return (
    <div class="yt-cell">
      <Card image={r.thumbnail} title={r.title} sub={r.channel} badge={r.duration ? formatTime(r.duration) : undefined} onClick={open} />
      <button class="btn ghost sm" onClick={save} disabled={!!saved || pct != null}>
        <Icon name={saved ? 'check' : 'download'} size={14} />
        {saved ? 'Saved for offline' : pct != null ? `Saving ${Math.round(pct)}%` : 'Save for offline'}
      </button>
    </div>
  )
}
