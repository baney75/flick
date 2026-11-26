import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { items, loaded, playItem, shows, go, notify, reloadItems, progress, episodeLabel, clearProgress } from '../lib/store'
import { ItemCard, VirtualGrid, useThumb } from '../components/Card'
import { TitleCard } from '../components/Titles'
import { buildTitles, type Title } from '../lib/titles'
import { sources, libraries, loadLibrary } from '../lib/plugins/use'
import { Icon } from '../components/icons'
import { addFolder, rescanAll, storeFiles, openFiles } from '../lib/actions'
import { getFolders, removeFolder, deleteStored, removeItems, type Folder, type Item } from '../lib/library'
import { formatBytes, formatTime } from '../lib/parse'
import { hasOpfs } from '../lib/platform'
import { downloads, cancelDownload, removeDownload } from '../lib/downloads'
import { canDownload, isSaved, save, badgeFor } from '../lib/offline'
import { photoSet } from '../lib/photos'
import { Photos } from './Photos'

type Tab = 'all' | 'movies' | 'shows' | 'music' | 'books' | 'audiobooks' | 'photos' | 'stored' | 'downloads'
type Sort = 'added' | 'title' | 'year'

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

// A grid cell: a title (a movie or show, from one place or several) or any other item.
type Entry = Item | Title
const isTitle = (x: Entry): x is Title => 'srcs' in x
const nameOf = (x: Entry) => isTitle(x) ? x.name : x.show ?? x.title
const posterOf = (x: Entry) => isTitle(x)
  ? x.srcs.some((s) => s.t === 'plugin' ? s.m.poster : s.t === 'item' ? s.it.poster : s.eps[0].poster)
  : !!x.poster

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
  // Source plugins' own libraries (a Stremio library) sit beside the files and servers.
  useEffect(() => { for (const r of sources.value) loadLibrary(r) }, [sources.value])

  // "/" jumps to search, like most fast apps.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea')) { e.preventDefault(); search.current?.focus() }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  // Photos have their own tab and are in no other (All, Movies, Shows, Music).
  const all = useMemo(() => items.value.filter((i) => i.kind !== 'photo'), [items.value])
  const photos = useMemo(() => photoSet(items.value), [items.value])
  const dl = downloads.value
  const libs = useMemo(() => sources.value.filter((r) => r.manifest.has.library)
    .map((r) => ({ p: r.id, pname: r.manifest.name, list: libraries.value[r.id] ?? [] })), [sources.value, libraries.value])
  const titles = useMemo(() => buildTitles(all.filter((i) => i.kind === 'video' && !i.show), shows.value, libs, (id) => isSaved(dl.get(id))),
    [all, shows.value, libs, dl])
  const list = useMemo(() => {
    const needle = norm(q.trim())
    let l: Entry[] = tab === 'all' ? [...titles, ...all.filter((i) => i.kind !== 'video')]
      : tab === 'movies' ? titles.filter((t) => t.type === 'movie')
      : tab === 'shows' ? titles.filter((t) => t.type === 'show')
      : all.filter((i) => {
        if (tab === 'music' && i.kind !== 'audio') return false
        if (tab === 'books' && i.kind !== 'book') return false
        if (tab === 'audiobooks' && i.kind !== 'audiobook') return false
        if (tab === 'stored' && i.origin !== 'stored') return false
        if (tab === 'downloads' && !isSaved(dl.get(i.id))) return false
        return true
      })
    if (needle) l = l.filter((x) => norm(isTitle(x) ? `${x.name} ${x.year ?? ''} ${x.srcs.map((s) => s.t === 'item' ? s.it.folder ?? '' : '').join(' ')}` : `${x.title} ${x.show ?? ''} ${x.author ?? ''} ${x.year ?? ''} ${x.folder ?? ''}`).includes(needle))
    const ep = (x: Entry) => isTitle(x) ? [0, 0] : [x.season ?? 0, x.episode ?? 0]
    const by: Record<Sort, (a: Entry, b: Entry) => number> = {
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }) || ep(a)[0] - ep(b)[0] || ep(a)[1] - ep(b)[1],
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    }
    // Shows stay in name order, as they always have.
    return l.sort(by[tab === 'shows' ? 'title' : sort])
  }, [all, titles, tab, q, sort, dl])

  const movieCount = titles.filter((t) => t.type === 'movie').length
  const showCount = titles.filter((t) => t.type === 'show').length
  const counts = {
    all: titles.length + all.filter((i) => i.kind !== 'video').length,
    movies: movieCount,
    shows: showCount,
    music: all.filter((i) => i.kind === 'audio').length,
    books: all.filter((i) => i.kind === 'book').length,
    audiobooks: all.filter((i) => i.kind === 'audiobook').length,
    photos: photos.length,
    stored: all.filter((i) => i.origin === 'stored').length,
    downloads: all.filter((i) => isSaved(dl.get(i.id))).length,
  }

  // A library of only photos opens on Photos, and a Photos tab with none left goes back to All.
  useEffect(() => {
    if (!loaded.value) return
    if (tab === 'photos' && !photos.length) setTab('all')
    else if (tab === 'all' && counts.all === 0 && photos.length) setTab('photos')
  }, [loaded.value, tab, photos.length, counts.all])
  const shownPhotos = useMemo(() => {
    const needle = norm(q.trim())
    return needle ? photos.filter((i) => norm(`${i.title} ${i.folder ?? ''}`).includes(needle)) : photos
  }, [photos, q])

  // Books are tall like posters even without a cover, so they share the poster grid.
  const posterMode = list.length > 0 && (list.every((i) => !isTitle(i) && i.kind === 'book') || list.filter(posterOf).length > list.length / 2)

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
          {(['all', 'movies', 'shows', 'music', 'books', 'audiobooks', 'photos', 'stored', 'downloads'] as Tab[]).filter((t) => !['books', 'audiobooks', 'photos', 'stored', 'downloads'].includes(t) || counts[t] || tab === t).map((t) => (
            <button role="tab" aria-selected={tab === t} class={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)} <span>{counts[t]}</span>
            </button>
          ))}
        </div>
        {tab !== 'shows' && tab !== 'photos' && (
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)} aria-label="Sort">
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
          </select>
        )}
      </div>

      {counts.all === 0 && !photos.length ? (
        <div class="empty">
          <Icon name="library" size={40} />
          <h2>Your library is empty</h2>
          <p>Add a folder of movies, shows or music. Flick finds every file, names it, groups episodes and makes thumbnails.</p>
          <div class="row">
            <button class="btn primary" onClick={addFolder}><Icon name="folder" size={16} /> Add a folder</button>
            <button class="btn" onClick={openFiles}>Just play a file</button>
          </div>
        </div>
      ) : tab === 'photos' ? (
        shownPhotos.length ? <Photos list={shownPhotos} /> : <p class="dim center">Nothing matches “{q}”.</p>
      ) : list.length === 0 ? (
        <p class="dim center">Nothing matches “{q}”.</p>
      ) : (
        <VirtualGrid list={list} min={posterMode ? 160 : 230} ratio={posterMode ? 1.5 : 9 / 16}
          render={(x) => isTitle(x)
            ? <TitleCard t={x} onMore={(it, e) => setMenu({ it, x: e.clientX, y: e.clientY })} />
            : <ItemCard it={x} onClick={() => playItem(x)} onMore={(e) => setMenu({ it: x, x: e.clientX, y: e.clientY })} />} />
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
