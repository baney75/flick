import { useEffect, useState } from 'preact/hooks'
import { items, continueList, playItem, go, shows, type Progress } from '../lib/store'
import { Card, ItemCard, Row, useThumb } from '../components/Card'
import { Icon } from '../components/icons'
import { addFolder, openFiles, openUrl, playPaths } from '../lib/actions'
import { isDesktop } from '../lib/platform'
import { online } from '../lib/offline'
import { downloads } from '../lib/downloads'
import { sources, searchAll, openPluginRef, libraries, loadLibrary, continueOf, type Found } from '../lib/plugins/use'
import { MetaCard, PluginIcon, CatalogRow, useCatalogs } from './Plugin'
import { HOME_ROWS_PER_SOURCE } from '../lib/nav'
import { addYouTube, installed, offersYouTube } from '../lib/plugins/registry'
import { sessionSet } from '../lib/session'

export function ResumeCard({ k, p }: { k: string; p: Progress }) {
  const ref = p.ref
  const it = ref.t === 'item' ? items.value.find((i) => i.id === ref.id) : undefined
  const thumb = useThumb(it)
  const click = () => {
    if (p.ref.t === 'item') { if (it) playItem(it) }
    else if (p.ref.t === 'plugin') openPluginRef(p.ref)
    else if (p.ref.t === 'url' && p.ref.url) {
      if (p.ref.url.startsWith('/')) playPaths([p.ref.url])
      else openUrl(p.ref.url)
    }
  }
  return <Card key={k} image={p.poster ?? thumb} title={p.title} sub={p.subtitle} pct={p.dur ? p.pos / p.dur : 0} shape="wide" onClick={click} />
}

export function Home() {
  const [url, setUrl] = useState('')
  const all = items.value
  const cont = continueList.value.filter(([, p]) => p.ref.t !== 'url' || p.ref.url)
  const recent = [...all].filter((i) => i.kind === 'video').sort((a, b) => b.addedAt - a.addedAt).slice(0, 24)
  const music = all.filter((i) => i.kind === 'audio').slice(0, 24)
  const showList = [...shows.value.values()].slice(0, 20)
  const srcs = sources.value
  const plCont = srcs.map((rec) => ({ rec, list: continueOf(libraries.value[rec.id]?.items ?? []).slice(0, 20) })).filter((x) => x.list.length)
  const empty = !all.length && !cont.length && !plCont.length && !srcs.length
  useEffect(() => { for (const rec of srcs) loadLibrary(rec) }, [srcs.map((r) => r.id).join()])

  const saved = [...downloads.value.values()].filter((d) => d.state === 'done').length
  const toDownloads = () => {
    sessionSet('flick.tab', 'downloads')
    go('/library')
  }

  return (
    <div class="page">
      <PluginSearch />
      {!online.value && (
        <div class="offline-note" role="status">
          <Icon name="download" size={16} />
          <span>{saved ? `You're offline. ${saved > 1 ? `Your ${saved} downloads still play.` : 'Your download still plays.'}` : "You're offline. Downloads you save play without a connection."}</span>
          {saved > 0 && <button class="btn sm" onClick={toDownloads}>Open downloads</button>}
        </div>
      )}
      {empty ? (
        <div class="welcome">
          <div class="welcome-mark"><Icon name="play" size={34} /></div>
          <h1>Drop anything here to play it.</h1>
          <p>Flick plays your videos and music the moment you open them, keeps your place, and turns your folders into a library.</p>
          <div class="welcome-actions">
            <button class="btn primary lg" onClick={openFiles}><Icon name="file" size={18} /> Open a file</button>
            <button class="btn lg" onClick={addFolder}><Icon name="folder" size={18} /> Add a folder</button>
            <button class="btn lg" onClick={() => go('/settings/plugins')}><Icon name="plug" size={18} /> Add plugins</button>
            <button class="btn lg" onClick={() => go('/servers')}><Icon name="server" size={18} /> Connect a server</button>
          </div>
          <form class="url-form" onSubmit={(e) => { e.preventDefault(); openUrl(url) }}>
            <Icon name="link" size={16} />
            <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Or paste a video or stream URL (MP4, HLS .m3u8)" aria-label="Stream URL" />
            <button class="btn" disabled={!url.trim()}>Play</button>
          </form>
          {!isDesktop && <p class="small dim">Tip: the Mac app also plays MKV, AVI and HEVC files and opens straight from Finder.</p>}
        </div>
      ) : (
        <>
          <header class="page-head">
            <h1>Home</h1>
            <div class="head-actions">
              <button class="btn" onClick={openFiles}><Icon name="file" size={16} /> Open</button>
              <button class="btn" onClick={addFolder}><Icon name="plus" size={16} /> Add folder</button>
            </div>
          </header>
          {cont.length > 0 && (
            <Row title="Continue watching">{cont.map(([k, p]) => <ResumeCard k={k} p={p} />)}</Row>
          )}
          {plCont.map(({ rec, list }) => (
            <Row title={`Continue on ${rec.manifest.name}`} action={<a class="link" href={`#/p/${encodeURIComponent(rec.id)}`}>{rec.manifest.name}</a>}>
              {list.map((m) => <MetaCard rec={rec} m={m} />)}
            </Row>
          ))}
          {recent.length > 0 && (
            <Row title="Recently added" action={<a class="link" href="#/library">See all</a>}>
              {recent.map((it) => <ItemCard it={it} onClick={() => playItem(it)} />)}
            </Row>
          )}
          {showList.length > 0 && (
            <Row title="Shows">
              {showList.map((eps) => <ShowCard eps={eps} />)}
            </Row>
          )}
          {music.length > 0 && (
            <Row title="Music">{music.map((it) => <ItemCard it={it} onClick={() => playItem(it)} />)}</Row>
          )}
          {srcs.map((rec) => <SourceRows key={`${rec.id}|${rec.sha256}`} rec={rec} />)}
        </>
      )}
    </div>
  )
}

/** A source plugin's first catalogs on Home, each titled "<Plugin> · <Catalog>" with See all to its page. */
function SourceRows({ rec }: { rec: import('../lib/plugins/use').Source }) {
  const path = `/p/${encodeURIComponent(rec.id)}`
  const rows = useCatalogs(rec) ?? []
  const see = <a class="link" href={`#${path}`} onClick={(e) => { e.preventDefault(); go(path) }}>See all</a>
  return (
    <>
      {rows.slice(0, HOME_ROWS_PER_SOURCE).map((c) => (
        <CatalogRow key={`${c.type}|${c.id}`} rec={rec} c={c} title={`${rec.manifest.name} · ${c.name}`} action={see} />
      ))}
    </>
  )
}

export function ShowCard({ eps }: { eps: import('../lib/library').Item[] }) {
  const first = eps[0]
  const thumb = useThumb(first)
  const seasons = new Set(eps.map((e) => e.season ?? 1)).size
  return <Card image={thumb} title={first.show!} sub={`${seasons > 1 ? `${seasons} seasons · ` : ''}${eps.length} episodes`}
    shape="wide" onClick={() => go(`/show/${encodeURIComponent(first.show!.toLowerCase())}`)} />
}

/**
 * Searches every enabled plugin catalog marked search. Hidden when no plugin can search, except on the
 * desktop before YouTube is installed: then the results end with "Search YouTube too" (rule 13).
 */
function PluginSearch() {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [busy, setBusy] = useState(false)
  // null: nothing pending; '': installing; anything else: why the install failed.
  const [adding, setAdding] = useState<string | null>(null)
  const offer = offersYouTube(isDesktop, installed.value)
  if (!offer && !sources.value.some((r) => r.manifest.catalogs.some((c) => c.search))) return null
  const search = async (term: string) => {
    const out: Found[] = []
    setFound([])
    setBusy(true)
    await searchAll(term, (f) => { out.push(f); setFound([...out]) })
    setBusy(false)
  }
  const run = (e: Event) => {
    e.preventDefault()
    if (!q.trim()) { setFound(null); return }
    void search(q.trim())
  }
  const addYt = async () => {
    setAdding('')
    try { await addYouTube() } catch (e) { setAdding(e instanceof Error ? e.message : String(e)); return }
    setAdding(null)
    await search(q.trim())
  }
  return (
    <div class="home-search">
      <form class="search" onSubmit={run}>
        <Icon name="search" size={16} />
        <input value={q} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setQ(v); if (!v) setFound(null) }} placeholder="Search your plugins" aria-label="Search your plugins" />
      </form>
      {found && (found.length === 0
        ? <p class="dim">{busy ? 'Searching' : `No results for "${q}".`}</p>
        : found.map((f) => (
          <Row title={`${f.rec.manifest.name} · ${f.catalog.name}`} action={<PluginIcon rec={f.rec} size={16} />}>
            {f.items.map((m) => <MetaCard rec={f.rec} m={m} />)}
          </Row>
        )))}
      {found && offer && (
        <div class="yt-offer">
          <button class="btn" disabled={adding === ''} onClick={addYt}>{adding === '' ? 'Adding YouTube' : 'Search YouTube too'}</button>
          {adding && <p class="dim">{adding}</p>}
        </div>
      )}
    </div>
  )
}
