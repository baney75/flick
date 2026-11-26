// A source plugin's page (catalog rows, search, its library) and title page (details, seasons and
// episodes, streams). Everything shown came through the sandbox and the validator.

import { useEffect, useState } from 'preact/hooks'
import { go, play, notify } from '../lib/store'
import { Card, Row } from '../components/Card'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'
import { callPlugin } from '../lib/plugins/runtime'
import { installed } from '../lib/plugins/registry'
import { sourceById, searchAll, titlePath, progressKey, libraries, loadLibrary, continueOf, type Source, type Found } from '../lib/plugins/use'
import type { CatalogDef, Meta, Stream, Video } from '../lib/plugins/validate'

const shape = (m: Meta) => (m.posterShape === 'landscape' ? 'wide' : m.posterShape === 'square' ? 'square' : 'poster')

export function MetaCard({ rec, m }: { rec: Source; m: Meta }) {
  const pct = m.progress?.dur ? m.progress.pos / m.progress.dur : undefined
  const ep = m.progress?.videoId && m.type === 'series' ? m.progress.videoId : undefined
  return <Card image={m.poster} title={m.name} sub={m.year} shape={shape(m)} pct={pct} onClick={() => go(titlePath(rec.id, m.type, m.id, ep))} />
}

export function PluginIcon({ rec, size = 20 }: { rec: { manifest: object }; size?: number }) {
  const icon = (rec.manifest as { icon?: string }).icon
  return icon ? <img class="plugin-icon" src={icon} alt="" width={size} height={size} /> : <Icon name="plug" size={size} />
}

function Missing({ id }: { id: string }) {
  const known = installed.value.find((p) => p.id === id)
  return (
    <div class="page">
      <p class="dim">{known ? `${known.manifest.name} is turned off.` : 'This plugin is not installed.'}</p>
      <a class="btn" href="#/settings">Open Settings</a>
    </div>
  )
}

export function PluginPage({ id }: { id: string }) {
  const rec = sourceById(id)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Found[] | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => { if (rec) loadLibrary(rec) }, [rec?.id])
  if (!rec) return <Missing id={id} />
  const name = rec.manifest.name
  const canSearch = rec.manifest.catalogs.some((c) => c.search)

  const run = async (e: Event) => {
    e.preventDefault()
    if (!q.trim()) { setResults(null); return }
    const out: Found[] = []
    setResults([])
    setSearching(true)
    await searchAll(q.trim(), (f) => { out.push(f); setResults([...out]) }, rec)
    setSearching(false)
  }

  const lib = libraries.value[rec.id] ?? []
  const cont = continueOf(lib)
  return (
    <div class="page">
      <header class="page-head">
        <h1 class="with-icon"><PluginIcon rec={rec} size={28} /> {name}</h1>
        {canSearch && (
          <form class="search" onSubmit={run}>
            <Icon name="search" size={16} />
            <input value={q} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setQ(v); if (!v) setResults(null) }} placeholder={`Search ${name}`} aria-label={`Search ${name}`} />
          </form>
        )}
      </header>
      {results ? (
        results.length === 0
          ? <p class="dim">{searching ? <><span class="spinner sm" /> Searching</> : `No results for "${q}".`}</p>
          : results.map((f) => <Row title={`${f.catalog.name} · ${f.catalog.type}`}>{f.items.map((m) => <MetaCard rec={rec} m={m} />)}</Row>)
      ) : (
        <>
          {cont.length > 0 && <Row title="Continue watching">{cont.slice(0, 30).map((m) => <MetaCard rec={rec} m={m} />)}</Row>}
          {lib.length > 0 && <Row title="Library">{lib.slice(0, 60).map((m) => <MetaCard rec={rec} m={m} />)}</Row>}
          {rec.manifest.catalogs.filter((c) => !c.search).map((c) => <CatalogRow key={`${rec.sha256}|${c.type}|${c.id}`} rec={rec} c={c} />)}
        </>
      )}
    </div>
  )
}

function CatalogRow({ rec, c }: { rec: Source; c: CatalogDef }) {
  const [items, setItems] = useState<Meta[] | null>(null)
  useEffect(() => { callPlugin(rec, 'catalog', [{ id: c.id, type: c.type, skip: 0 }]).then((r) => setItems(r.items)).catch(() => setItems([])) }, [])
  if (items && !items.length) return null
  return (
    <Row title={c.name}>
      {items ? items.map((m) => <MetaCard rec={rec} m={m} />) : Array.from({ length: 8 }, () => <div class="card poster skeleton"><div class="art" /></div>)}
    </Row>
  )
}

// ------------------------------------------------------------------
// Title page
// ------------------------------------------------------------------

export function PluginTitle({ p, type, id, videoId }: { p: string; type: string; id: string; videoId?: string }) {
  const rec = sourceById(p)
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined)
  const [err, setErr] = useState('')
  const [season, setSeason] = useState<number | null>(null)
  const [vid, setVid] = useState<string | null>(videoId ?? null)

  useEffect(() => {
    if (!rec) return
    callPlugin(rec, 'meta', [{ type, id }]).then((m) => {
      setMeta(m)
      const vids = m.videos ?? []
      if (vids.length > 1) {
        const cur = videoId ? vids.find((v) => v.id === videoId) : null
        setSeason(cur?.season ?? vids.find((v) => (v.season ?? 0) > 0)?.season ?? vids[0].season ?? 0)
      } else if (!videoId) setVid(vids[0]?.id ?? id)
    }).catch((e) => { setErr((e as Error).message); setMeta(null) })
  }, [rec?.sha256, type, id])

  if (!rec) return <Missing id={p} />
  if (meta === undefined) return <div class="page"><div class="status inline"><span class="spinner" /> Loading</div></div>
  if (meta === null) return <div class="page"><button class="btn ghost sm" onClick={() => history.back()}><Icon name="left" size={16} /> Back</button><p class="dim">{rec.manifest.name} could not open this title. {err}</p></div>

  const vids = meta.videos ?? []
  const seasons = [...new Set(vids.map((v) => v.season ?? 0))].filter((s) => s > 0).sort((a, b) => a - b)
  if (vids.some((v) => (v.season ?? 0) === 0)) seasons.push(0)
  const eps = vids.filter((v) => (v.season ?? 0) === (season ?? 0)).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
  const cur = vids.find((v) => v.id === vid)

  return (
    <div class="page detail">
      {meta.background && <div class="backdrop" style={{ backgroundImage: `url("${meta.background.replace(/"/g, '%22')}")` }} />}
      <button class="btn ghost sm" onClick={() => history.back()}><Icon name="left" size={16} /> Back</button>
      <div class="detail-head">
        {meta.poster && <img class="detail-poster" src={meta.poster} alt="" />}
        <div class="detail-info">
          <h1>{meta.name}</h1>
          <div class="facts">{[meta.year, meta.runtime, ...(meta.genres ?? []).slice(0, 3)].filter(Boolean).map((f) => <span>{f}</span>)}</div>
          {meta.description && <p class="desc">{meta.description}</p>}
          <p class="small dim"><PluginIcon rec={rec} size={14} /> {rec.manifest.name}</p>
        </div>
      </div>

      {vids.length > 1 && (
        <section>
          {seasons.length > 1 && (
            <div class="chips">
              {seasons.map((s) => <button class={`chip ${s === season ? 'on' : ''}`} onClick={() => setSeason(s)}>{s === 0 ? 'Specials' : `Season ${s}`}</button>)}
            </div>
          )}
          <div class="episodes compact">
            {eps.map((v) => (
              <button class={`episode ${v.id === vid ? 'sel' : ''}`} onClick={() => setVid(v.id)}>
                <div class="art">{v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <div class="art-ph"><Icon name="film" size={20} /></div>}</div>
                <div class="ep-meta">
                  <div class="t2">{v.episode != null ? `Episode ${v.episode}` : ''}{v.released ? ` · ${new Date(v.released).toLocaleDateString()}` : ''}</div>
                  <div class="t1">{v.title}</div>
                  {v.overview && <div class="small dim clamp2">{v.overview}</div>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {vid && <Streams key={vid} rec={rec} meta={meta} videoId={vid} video={cur} />}
    </div>
  )
}

const epLabel = (v?: Video) => (v && v.season != null && v.episode != null ? `S${v.season} E${v.episode}` : '')

function Streams({ rec, meta, videoId, video }: { rec: Source; meta: Meta; videoId: string; video?: Video }) {
  const [list, setList] = useState<Stream[] | null>(null)
  const [err, setErr] = useState('')
  const [group, setGroup] = useState('all')
  useEffect(() => {
    callPlugin(rec, 'streams', [{ type: meta.type, id: meta.id, videoId }]).then(setList).catch((e) => { setErr((e as Error).message); setList([]) })
  }, [videoId])

  const groups = [...new Set((list ?? []).map((s) => s.group).filter(Boolean))] as string[]
  const shown = (list ?? []).filter((s) => group === 'all' || s.group === group)
  const ref = { t: 'plugin' as const, p: rec.id, type: meta.type, id: meta.id, videoId }

  const start = async (s: Stream) => {
    if (s.external) { window.open(s.url, '_blank', 'noopener'); return }
    if (s.url.startsWith('flick-tool:')) { notify('This stream needs a desktop tool this Flick does not have yet.'); return }
    if (s.kind === 'book') {
      go(`/read-url?u=${encodeURIComponent(s.url)}&t=${encodeURIComponent(meta.name)}&r=${encodeURIComponent(JSON.stringify(ref))}`)
      return
    }
    const subs = [...(s.subs ?? [])]
    if (rec.manifest.has.subtitles) subs.push(...(await callPlugin(rec, 'subtitles', [{ type: meta.type, id: meta.id, videoId }]).catch(() => [])))
    const langs = navigator.languages.map((l) => l.slice(0, 2))
    subs.sort((a, b) => Number(langs.some((l) => b.lang.startsWith(l))) - Number(langs.some((l) => a.lang.startsWith(l))))
    let sent = 0
    play({
      key: progressKey(rec.id, videoId),
      title: meta.name,
      subtitle: video ? [epLabel(video), video.title].filter(Boolean).join(' · ') : meta.year,
      kind: s.kind === 'audio' ? 'audio' : 'video',
      url: s.url,
      poster: video?.thumbnail ?? meta.background ?? meta.poster,
      subs: subs.slice(0, 12).map((x) => ({ label: x.label ?? x.lang, lang: x.lang, url: x.url })),
      ref,
      onSave: rec.manifest.has.progress ? (pos, dur) => {
        // Tell the source at most every 30 seconds; the player saves locally every 5.
        if (Date.now() - sent < 30_000) return
        sent = Date.now()
        callPlugin(rec, 'progress', [{ type: meta.type, id: meta.id, videoId, pos, dur }]).catch(() => {})
      } : undefined,
    })
  }

  return (
    <section class="streams">
      <div class="row-head"><h2>Streams{video ? ` · ${epLabel(video) || video.title}` : ''}</h2>{list === null && <span class="spinner sm" />}</div>
      {groups.length > 1 && (
        <div class="chips">
          <button class={`chip ${group === 'all' ? 'on' : ''}`} onClick={() => setGroup('all')}>All <span>{list!.length}</span></button>
          {groups.map((g) => <button class={`chip ${group === g ? 'on' : ''}`} onClick={() => setGroup(g)}>{g} <span>{list!.filter((s) => s.group === g).length}</span></button>)}
        </div>
      )}
      {list && list.length === 0 && <p class="dim">{err ? `${rec.manifest.name}: ${err}` : 'No streams for this one.'}</p>}
      <div class="stream-list">
        {shown.map((s) => (
          <button class="stream" onClick={() => start(s)}>
            <div class="stream-name">{s.quality ?? s.group ?? rec.manifest.name}</div>
            <div class="stream-detail">{s.title ?? ''}</div>
            <div class="stream-tags">
              {s.group && <span>{s.group}</span>}
              {s.kind === 'book' && <span>Book</span>}
              {s.external && <span>Opens in your browser</span>}
              {s.needsDesktop && !isDesktop && <span class="warn">May need the desktop app</span>}
            </div>
            <Icon name={s.external ? 'external' : 'play'} size={18} class="stream-go" />
          </button>
        ))}
      </div>
    </section>
  )
}
