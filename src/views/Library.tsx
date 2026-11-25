import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { items, playItem, shows, go, notify, reloadItems, progress, episodeLabel, clearProgress } from '../lib/store'
import { ItemCard, VirtualGrid, useThumb } from '../components/Card'
import { ShowCard } from './Home'
import { Icon } from '../components/icons'
import { addFolder, rescanAll, storeFiles, openFiles } from '../lib/actions'
import { getFolders, removeFolder, deleteStored, removeItems, type Folder, type Item } from '../lib/library'
import { formatBytes, formatTime } from '../lib/parse'
import { hasOpfs } from '../lib/platform'
import { downloads, cancelDownload, removeDownload } from '../lib/downloads'
import { canDownload, isSaved, save, badgeFor } from '../lib/offline'

type Tab = 'all' | 'movies' | 'shows' | 'music' | 'books' | 'stored' | 'downloads'
type Sort = 'added' | 'title' | 'year'

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

export function Library() {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('flick.tab') as Tab) || 'all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('added')
  const [folders, setFolders] = useState<Folder[]>([])
  const [showFolders, setShowFolders] = useState(false)
  const [menu, setMenu] = useState<{ it: Item; x: number; y: number } | null>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => { getFolders().then(setFolders) }, [items.value.length])
  useEffect(() => { try { sessionStorage.setItem('flick.tab', tab) } catch { /* ignore */ } }, [tab])

  // "/" jumps to search, like most fast apps.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea')) { e.preventDefault(); search.current?.focus() }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  const all = items.value
  const dl = downloads.value
  const list = useMemo(() => {
    const needle = norm(q.trim())
    let l = all.filter((i) => {
      if (tab === 'movies' && (i.kind !== 'video' || i.show)) return false
      if (tab === 'music' && i.kind !== 'audio') return false
      if (tab === 'books' && i.kind !== 'book') return false
      if (tab === 'stored' && i.origin !== 'stored') return false
      if (tab === 'downloads' && !isSaved(dl.get(i.id))) return false
      if (needle && !norm(`${i.title} ${i.show ?? ''} ${i.author ?? ''} ${i.year ?? ''} ${i.folder ?? ''}`).includes(needle)) return false
      return true
    })
    const by: Record<Sort, (a: Item, b: Item) => number> = {
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => (a.show ?? a.title).localeCompare(b.show ?? b.title, undefined, { numeric: true }) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    }
    l = l.sort(by[sort])
    return l
  }, [all, tab, q, sort, dl])

  const showGroups = useMemo(() => {
    const needle = norm(q.trim())
    return [...shows.value.values()].filter((eps) => !needle || norm(eps[0].show!).includes(needle))
      .sort((a, b) => a[0].show!.localeCompare(b[0].show!))
  }, [shows.value, q])

  const counts = {
    all: all.length,
    movies: all.filter((i) => i.kind === 'video' && !i.show).length,
    shows: shows.value.size,
    music: all.filter((i) => i.kind === 'audio').length,
    books: all.filter((i) => i.kind === 'book').length,
    stored: all.filter((i) => i.origin === 'stored').length,
    downloads: all.filter((i) => isSaved(dl.get(i.id))).length,
  }

  const posterMode = list.length > 0 && list.filter((i) => i.poster).length > list.length / 2

  const remove = async (it: Item) => {
    setMenu(null)
    if (it.origin === 'stored') {
      if (!confirm(`Delete "${it.title}" from Flick's storage? This removes the stored copy.`)) return
      await deleteStored(it)
    } else {
      await removeDownload(it.id).catch(() => {})
      await removeItems([it.id])
    }
    await reloadItems()
    notify('Removed.')
  }

  return (
    <div class="page" onClick={() => menu && setMenu(null)}>
      <header class="page-head">
        <h1>Library</h1>
        <div class="search">
          <Icon name="search" size={16} />
          <input ref={search} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Search your library" aria-label="Search library" />
          {!q && <kbd>/</kbd>}
        </div>
        <div class="head-actions">
          <button class="btn" onClick={addFolder}><Icon name="plus" size={16} /> Add folder</button>
          {hasOpfs && <button class="btn" onClick={storeFiles} title="Copy files into Flick so they are always here"><Icon name="download" size={16} /> Store files</button>}
          <button class="btn ghost" onClick={() => setShowFolders(!showFolders)} aria-expanded={showFolders}><Icon name="folder" size={16} /> Sources</button>
        </div>
      </header>

      {showFolders && (
        <div class="panel">
          <div class="panel-head">
            <h3>Folders</h3>
            <button class="btn ghost sm" onClick={async () => { notify('Rescanning…', 30000); const n = await rescanAll(); notify(`Rescanned ${n} files.`) }}><Icon name="refresh" size={14} /> Rescan</button>
          </div>
          {folders.length === 0 && <p class="dim">No folders yet. Add one and Flick indexes every video and song inside it.</p>}
          {folders.map((f) => (
            <div class="list-row">
              <Icon name="folder" size={16} />
              <div class="grow"><div>{f.name}</div><div class="small dim">{f.path ?? 'Browser folder access'} · {all.filter((i) => i.folder === f.name).length} files</div></div>
              <button class="btn ghost sm" onClick={async () => { await removeFolder(f); await reloadItems(); notify(`Removed ${f.name}. Your files are untouched.`) }}>Remove</button>
            </div>
          ))}
          <p class="small dim">Servers like Plex and Jellyfin live under <a href="#/servers">Servers</a>.</p>
        </div>
      )}

      <div class="toolbar">
        <div class="chips" role="tablist">
          {(['all', 'movies', 'shows', 'music', 'books', 'stored', 'downloads'] as Tab[]).filter((t) => !['books', 'stored', 'downloads'].includes(t) || counts[t] || tab === t).map((t) => (
            <button role="tab" aria-selected={tab === t} class={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)} <span>{counts[t]}</span>
            </button>
          ))}
        </div>
        {tab !== 'shows' && (
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)} aria-label="Sort">
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
          </select>
        )}
      </div>

      {all.length === 0 ? (
        <div class="empty">
          <Icon name="library" size={40} />
          <h2>Your library is empty</h2>
          <p>Add a folder of movies, shows or music. Flick finds every file, names it, groups episodes and makes thumbnails.</p>
          <div class="row">
            <button class="btn primary" onClick={addFolder}><Icon name="folder" size={16} /> Add a folder</button>
            <button class="btn" onClick={openFiles}>Just play a file</button>
          </div>
        </div>
      ) : tab === 'shows' ? (
        <VirtualGrid list={showGroups} render={(eps) => <ShowCard eps={eps} />} />
      ) : list.length === 0 ? (
        <p class="dim center">Nothing matches “{q}”.</p>
      ) : (
        <VirtualGrid list={list} min={posterMode ? 160 : 230} ratio={posterMode ? 1.5 : 9 / 16}
          render={(it) => <ItemCard it={it} onClick={() => playItem(it)} onMore={(e) => setMenu({ it, x: e.clientX, y: e.clientY })} />} />
      )}

      {menu && (
        <div class="ctx" style={{ left: `${Math.max(8, Math.min(menu.x, innerWidth - 308))}px`, top: `${Math.max(8, Math.min(menu.y, innerHeight - 300))}px` }} onClick={(e) => e.stopPropagation()}>
          <div class="ctx-title">{menu.it.title}</div>
          <div class="small dim">{[menu.it.folder, menu.it.size ? formatBytes(menu.it.size) : null, menu.it.duration ? formatTime(menu.it.duration) : null].filter(Boolean).join(' · ')}</div>
          <button onClick={() => { playItem(menu.it); setMenu(null) }}>{menu.it.kind === 'book' ? 'Read' : 'Play'}</button>
          {progress.value[menu.it.id] && <button onClick={() => { const it = menu.it; setMenu(null); clearProgress(it.id) }}>{menu.it.kind === 'book' ? 'Mark unread' : 'Mark unwatched'}</button>}
          {menu.it.show && <button onClick={() => go(`/show/${encodeURIComponent(menu.it.show!.toLowerCase())}`)}>Go to show</button>}
          <DownloadActions it={menu.it} done={() => setMenu(null)} />
          <button class="danger" onClick={() => remove(menu.it)}>{menu.it.origin === 'stored' ? 'Delete stored copy' : 'Remove from library'}</button>
        </div>
      )}
    </div>
  )
}

/** Download, cancel or remove buttons for one item's menu. */
export function DownloadActions({ it, done }: { it: Item; done: () => void }) {
  const d = downloads.value.get(it.id)
  if (!canDownload(it) && !d) return null
  const act = (f: () => Promise<unknown>) => () => { done(); f().catch((e) => notify((e as Error).message)) }
  if (d?.state === 'done') return <button onClick={act(async () => { await removeDownload(it.id); notify('Download removed.') })}>Remove download</button>
  if (d?.state === 'queued' || d?.state === 'downloading') return <button onClick={act(() => cancelDownload(it.id))}>Cancel download</button>
  return (
    <>
      {d?.state === 'failed' && d.error !== 'Canceled' && <div class="small err">{d.error}</div>}
      <button onClick={act(() => save([it]))}>{d ? 'Download again' : 'Download for offline'}</button>
    </>
  )
}

export function ShowPage({ name }: { name: string }) {
  const eps = shows.value.get(name) ?? []
  const [season, setSeason] = useState<number | null>(null)
  if (!eps.length) return <div class="page"><p class="dim">Show not found.</p><a href="#/library">Back to library</a></div>
  const seasons = [...new Set(eps.map((e) => e.season ?? 1))].sort((a, b) => a - b)
  const cur = season ?? seasons[0]
  const list = eps.filter((e) => (e.season ?? 1) === cur)
  // Resume where you left off: the first episode that is started or not finished.
  const nextUp = eps.find((e) => { const p = progress.value[e.id]; return !p || !p.dur || p.pos < p.dur * 0.93 }) ?? eps[0]
  const savable = list.filter(canDownload)
  const left = savable.filter((e) => !isSaved(downloads.value.get(e.id)))
  return (
    <div class="page">
      <button class="btn ghost sm" onClick={() => history.back()}><Icon name="left" size={16} /> Back</button>
      <header class="show-head">
        <div>
          <h1>{eps[0].show}</h1>
          <p class="dim">{seasons.length} season{seasons.length > 1 ? 's' : ''} · {eps.length} episodes</p>
        </div>
        <div class="row">
          <button class="btn primary lg" onClick={() => playItem(nextUp)}><Icon name="play" size={18} /> {progress.value[nextUp.id] ? 'Resume' : 'Play'} {episodeLabel(nextUp)}</button>
          {savable.length > 0 && (
            <button class="btn lg" disabled={!left.length} onClick={() => save(left)}>
              <Icon name="download" size={18} /> {left.length ? `Download season ${cur}` : `Season ${cur} saved`}
            </button>
          )}
        </div>
      </header>
      {seasons.length > 1 && (
        <div class="chips">
          {seasons.map((s) => <button class={`chip ${s === cur ? 'on' : ''}`} onClick={() => setSeason(s)}>Season {s}</button>)}
        </div>
      )}
      <div class="episodes">
        {list.map((e) => <Episode it={e} />)}
      </div>
    </div>
  )
}

function Episode({ it }: { it: Item }) {
  const img = useThumb(it)
  const p = progress.value[it.id]
  const pct = p && p.dur ? p.pos / p.dur : 0
  const saved = badgeFor(downloads.value.get(it.id))
  return (
    <button class="episode" onClick={() => playItem(it)}>
      <div class="art">
        {img ? <img src={img} alt="" loading="lazy" /> : <div class="art-ph"><Icon name="film" size={24} /></div>}
        {pct > 0 && <div class="pbar"><div style={{ width: `${pct * 100}%` }} /></div>}
      </div>
      <div class="ep-meta">
        <div class="t2">Episode {it.episode}</div>
        <div class="t1">{it.title}</div>
        {(it.duration || saved) && <div class="small dim">{[it.duration ? formatTime(it.duration) : null, pct > 0.93 ? 'Watched' : null, saved].filter(Boolean).join(' · ')}</div>}
      </div>
    </button>
  )
}
