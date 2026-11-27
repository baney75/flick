// A source plugin's page (catalog rows, search, its library) and title page (details, seasons and
// episodes, streams). Everything shown came through the sandbox and the validator.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { go, play, notify, progress, nowPlaying } from '../lib/store'
import { Card, Row } from '../components/Card'
import { Icon } from '../components/icons'
import { isDesktop, isMobileApp } from '../lib/platform'
import { downloads, savedId, cancelDownload, removeDownload, type Saved } from '../lib/downloads'
import { saveStream, playSaved, badgeFor } from '../lib/offline'
import { callPlugin } from '../lib/plugins/runtime'
import { installed } from '../lib/plugins/registry'
import { sources, sourceById, searchAll, titlePath, progressKey, libraries, loadLibrary, continueOf, type Source, type Found } from '../lib/plugins/use'
import { isBuiltinType, type CatalogDef, type Meta, type Stream, type TitleActionDef, type Video } from '../lib/plugins/validate'
import { sections, qualityOf, hdrOf, sizeOf, downloadable } from '../lib/plugins/streams'
import { rank, pickLine, subLangFor, needsGate, type Ranked } from '../lib/pick'
import { streamCandidates } from '../lib/candidates'
import { cancelFetch, canStart, serviceTag, wantsGate } from '../lib/debrid-play'
import { DebridWait, playTorrent, useCached } from './Debrid'
import { viaOf } from '../lib/readout'
import { ctxNow, current, debridNow, deviceFor, holdGate, NO_ENGINE_YET, prefsNow, releaseGate, serviceName, shutFor, tap, watchGate } from '../lib/picking'
import { resumeOf, unfinished } from '../lib/plugins/resume'
import { formatTime } from '../lib/parse'
import { langCode } from '../lib/release'

type Shape = NonNullable<Meta['posterShape']>
const cardShape = (s?: Shape) => (s === 'landscape' ? 'wide' : s === 'square' ? 'square' : 'poster')
const pctOf = (m: Meta) => (m.progress?.dur ? m.progress.pos / m.progress.dur : undefined)
const openMeta = (rec: Source, m: Meta) => go(titlePath(rec.id, m.type, m.id, m.progress?.videoId && m.type === 'series' ? m.progress.videoId : undefined))

/** `shape` overrides the item's own posterShape, for a Library shelf's layout. */
export function MetaCard({ rec, m, shape }: { rec: Source; m: Meta; shape?: Shape }) {
  const s = shape ?? m.posterShape
  const wide = s === 'landscape'
  return <Card image={m.poster} title={m.name} sub={m.subtitle ?? m.year} info={m.badges?.join(' · ')} time={wide ? m.runtime : undefined} wrap={wide}
    target={rec.manifest.titleActions.length ? JSON.stringify({ type: m.type, id: m.id }) : undefined}
    shape={cardShape(s)} pct={pctOf(m)} onClick={() => openMeta(rec, m)} />
}

/** One row of a Library shelf with the list layout: thumbnail, name, subtitle, badges. */
export function ShelfRow({ rec, m }: { rec: Source; m: Meta }) {
  const pct = pctOf(m)
  return (
    <button class="shelf-row" onClick={() => openMeta(rec, m)}>
      <div class="art">
        {m.poster ? <img src={m.poster} alt="" loading="lazy" /> : <div class="art-ph"><Icon name="film" size={20} /></div>}
        {pct != null && pct > 0 && <div class="pbar"><div style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>}
      </div>
      <div class="grow">
        <div class="t1">{m.name}</div>
        {(m.subtitle ?? m.year) && <div class="small dim">{m.subtitle ?? m.year}</div>}
        {m.badges && <div class="small dim">{m.badges.join(' · ')}</div>}
      </div>
    </button>
  )
}

/** The title actions running now, by actionKey(): a second press waits for the first to finish. */
export const acting = signal<ReadonlySet<string>>(new Set())
export const actionKey = (rec: Source, t: { type: string; id: string }, a: TitleActionDef) => JSON.stringify([rec.id, t.type, t.id, a.id])

/** Run one of a plugin's titleActions on a title; returns whether it is now on, or null when it failed or was already running. */
export async function runTitleAction(rec: Source, t: { type: string; id: string }, a: TitleActionDef): Promise<boolean | null> {
  const k = actionKey(rec, t, a)
  if (acting.value.has(k)) return null
  acting.value = new Set([...acting.value, k])
  try {
    const r = await callPlugin(rec, 'titleAction', [{ type: t.type, id: t.id, action: a.id }])
    notify(r.message ?? `${a.label}: ${r.ok ? (r.on ? 'on' : 'off') : 'failed'}`)
    return r.ok ? r.on : null
  } catch (e) {
    notify(`${a.label}: ${(e as Error).message}`)
    return null
  } finally {
    const next = new Set(acting.value)
    next.delete(k)
    acting.value = next
  }
}

/**
 * A plugin's titleActions keys: on a title page they act on that title, on the plugin's page on the
 * focused card. Never while typing, with a modifier, or while the player is open.
 */
export function useTitleKeys(rec: Source | undefined, target: () => { type: string; id: string } | null, done?: (a: TitleActionDef, on: boolean) => void) {
  useEffect(() => {
    const acts = rec?.manifest.titleActions.filter((a) => a.key) ?? []
    if (!rec || !acts.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || nowPlaying.value || e.defaultPrevented) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return
      const a = acts.find((x) => x.key === e.key.toLowerCase())
      const t = a && target()
      if (!a || !t) return
      e.preventDefault()
      runTitleAction(rec, t, a).then((on) => { if (on !== null) done?.(a, on) })
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [rec?.sha256, target, done])
}

/** `/` focuses the page's search box, unless the user is typing or the player is open. */
function useSlashSearch(input: { current: HTMLInputElement | null }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || nowPlaying.value || !input.current) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      input.current.focus()
      input.current.select()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

/** The title the focused card stands for, when it is one of this plugin's cards. */
function focusedTitle(): { type: string; id: string } | null {
  const raw = (document.activeElement as HTMLElement | null)?.closest?.('[data-target]')?.getAttribute('data-target')
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

export function PluginIcon({ rec, size = 20 }: { rec: { manifest: object }; size?: number }) {
  const icon = (rec.manifest as { icon?: string }).icon
  return icon ? <img class="plugin-icon" src={icon} alt="" width={size} height={size} /> : <Icon name="plug" size={size} />
}

/** Every installed source as a tile: the phone's way in when the bar has no room for each one. */
export function SourcesPage() {
  const list = sources.value
  return (
    <div class="page">
      <h1>Sources</h1>
      {list.length === 0 && <p class="dim">No sources yet. Add one in <a href="#/settings">Settings</a>.</p>}
      <div class="source-tiles">
        {list.map((p) => (
          <a class="source-tile" href={`#/p/${encodeURIComponent(p.id)}`} onClick={(e) => { e.preventDefault(); go(`/p/${encodeURIComponent(p.id)}`) }}>
            <PluginIcon rec={p} size={36} />
            <span class="source-name">{p.manifest.name}</span>
            {p.manifest.description && <span class="small dim source-desc">{p.manifest.description}</span>}
          </a>
        ))}
      </div>
    </div>
  )
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

/** A source's browsable catalogs: its manifest's plus any it lists at run time. null while loading. */
export function useCatalogs(rec: Source | undefined): CatalogDef[] | null {
  const [rows, setRows] = useState<CatalogDef[] | null>(null)
  useEffect(() => {
    if (!rec) return
    const fixed = rec.manifest.catalogs.filter((c) => !c.search)
    if (!rec.manifest.has.userCatalogs) { setRows(fixed); return }
    callPlugin(rec, 'userCatalogs', []).then((l) => setRows([...fixed, ...l.filter((c) => !c.search)])).catch(() => setRows(fixed))
  }, [rec?.sha256, JSON.stringify(rec?.settings)])
  return rows
}

export function PluginPage({ id }: { id: string }) {
  const rec = sourceById(id)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Found[] | null>(null)
  const [searching, setSearching] = useState(false)
  // A grid shows one list of results: each title once, though two catalogs found it.
  const flat = [...new Map((results ?? []).flatMap((f) => f.items).map((m) => [`${m.type}|${m.id}`, m])).values()]
  useEffect(() => { if (rec) loadLibrary(rec) }, [rec?.id])
  const rows = useCatalogs(rec)
  useTitleKeys(rec, focusedTitle)
  const input = useRef<HTMLInputElement>(null)
  useSlashSearch(input)
  if (!rec) return <Missing id={id} />
  const name = rec.manifest.name
  const grid = rec.manifest.layout === 'grid'
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

  const lib = libraries.value[rec.id]?.items ?? []
  const cont = continueOf(lib)
  return (
    <div class="page">
      <header class="page-head">
        <h1 class="with-icon"><PluginIcon rec={rec} size={28} /> {name}</h1>
        {canSearch && (
          <form class="search" onSubmit={run}>
            <Icon name="search" size={16} />
            <input ref={input} value={q} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setQ(v); if (!v) setResults(null) }} placeholder={`Search ${name}`} aria-label={`Search ${name}`} />
          </form>
        )}
      </header>
      {results ? (
        (grid ? !flat.length : results.length === 0)
          ? <p class="dim">{searching ? <><span class="spinner sm" /> Searching</> : `No results for "${q}".`}</p>
          : grid ? <div class="video-grid">{flat.map((m) => <MetaCard rec={rec} m={m} />)}</div>
          : results.map((f) => (
            <section class="row-section">
              <div class="row-head"><h2>{`${f.catalog.name} · ${f.catalog.type}`}</h2><span class="dim small">{f.items.length}</span></div>
              <div class="result-grid">{f.items.map((m) => <MetaCard rec={rec} m={m} />)}</div>
            </section>
          ))
      ) : (
        <>
          {cont.length > 0 && <Row title="Continue watching">{cont.slice(0, 30).map((m) => <MetaCard rec={rec} m={m} />)}</Row>}
          {lib.length > 0 && <Row title="Library">{lib.slice(0, 60).map((m) => <MetaCard rec={rec} m={m} />)}</Row>}
          {rows === null && <div class="status inline"><span class="spinner" /> Loading</div>}
          {grid ? rows && <GridTabs key={rec.id} rec={rec} rows={rows} /> : (rows ?? []).map((c) => <CatalogRow key={`${rec.sha256}|${c.type}|${c.id}`} rec={rec} c={c} />)}
        </>
      )}
    </div>
  )
}

const rowKey = (c: CatalogDef) => `${c.type}|${c.id}`
const tabKey = (rec: Source) => `flick.grid.${rec.id}`

/** A grid-layout plugin's catalogs: one chip each, the chosen one as a grid. Opens on this session's last pick. */
function GridTabs({ rec, rows }: { rec: Source; rows: CatalogDef[] }) {
  const [tab, setTab] = useState<string | null>(() => { try { return sessionStorage.getItem(tabKey(rec)) } catch { return null } })
  // With nothing picked, an empty catalog (For You before anything played) steps to the next one.
  const [skipped, setSkipped] = useState<string[]>([])
  const picked = rows.find((c) => rowKey(c) === tab)
  const cur = picked ?? rows.find((c) => !skipped.includes(rowKey(c))) ?? rows[0]
  if (!cur) return null
  const pick = (c: CatalogDef) => {
    setTab(rowKey(c))
    try { sessionStorage.setItem(tabKey(rec), rowKey(c)) } catch { /* private mode */ }
  }
  return (
    <>
      <div class="chips" role="tablist">
        {rows.map((c) => <button class={`chip ${c === cur ? 'on' : ''}`} role="tab" aria-selected={c === cur} onClick={() => pick(c)}>{c.name}</button>)}
      </div>
      <CatalogGrid key={`${rec.sha256}|${rowKey(cur)}`} rec={rec} c={cur} onEmpty={picked ? undefined : () => setSkipped((l) => [...l, rowKey(cur)])} />
    </>
  )
}

function CatalogGrid({ rec, c, onEmpty }: { rec: Source; c: CatalogDef; onEmpty?: () => void }) {
  const [items, setItems] = useState<Meta[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Where the next page starts: what the plugin has sent so far, repeats included.
  const [offset, setOffset] = useState(0)
  const load = async (skip: number) => {
    setBusy(true)
    try {
      const r = await callPlugin(rec, 'catalog', [{ id: c.id, type: c.type, skip }])
      const seen = new Set((skip ? items ?? [] : []).map((m) => m.id))
      const next = [...(skip ? items ?? [] : []), ...r.items.filter((m) => !seen.has(m.id))]
      setItems(next)
      setOffset(skip + r.items.length)
      // A page of only repeats ends Show more, so a feed that loops never shows it forever.
      setMore(r.more && next.length > (skip ? items?.length ?? 0 : 0))
      setErr('')
      if (!next.length) onEmpty?.()
    } catch (e) {
      setErr((e as Error).message)
      if (!skip) setItems([])
    }
    setBusy(false)
  }
  useEffect(() => { load(0) }, [])
  if (items === null) return <div class="video-grid">{Array.from({ length: 8 }, () => <div class="card wide skeleton"><div class="art" /></div>)}</div>
  if (!items.length) return <p class="dim">{err ? `${rec.manifest.name}: ${err}` : `Nothing in ${c.name} yet.`}</p>
  return (
    <>
      <div class="video-grid">{items.map((m) => <MetaCard rec={rec} m={m} />)}</div>
      {err && <p class="dim">{rec.manifest.name}: {err}</p>}
      {more && <button class="btn more-grid" disabled={busy} onClick={() => load(offset)}>{busy ? <span class="spinner sm" /> : null} Show more</button>}
    </>
  )
}

export function CatalogRow({ rec, c, title, action }: { rec: Source; c: CatalogDef; title?: string; action?: ComponentChildren }) {
  const [items, setItems] = useState<Meta[] | null>(null)
  useEffect(() => { callPlugin(rec, 'catalog', [{ id: c.id, type: c.type, skip: 0 }]).then((r) => setItems(r.items)).catch(() => setItems([])) }, [])
  if (items && !items.length) return null
  return (
    <Row title={title ?? c.name} action={action}>
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
  const [marks, setMarks] = useState<string[]>([])
  const mark = useCallback((a: TitleActionDef, on: boolean) => setMarks((l) => (on ? [...new Set([...l, a.id])] : l.filter((x) => x !== a.id))), [])
  // No title for the keys until its meta (and so its marks) has loaded.
  const here = useCallback(() => (meta ? { type, id } : null), [type, id, meta])
  useTitleKeys(rec, here, mark)

  useEffect(() => {
    if (!rec) return
    callPlugin(rec, 'meta', [{ type, id }]).then((m) => {
      setMeta(m)
      setMarks(m.marks ?? [])
      const vids = m.videos ?? []
      // With no episode asked for, open where the user left off.
      const back = videoId ? null : resumeOf(progress.value, rec.id, id, vids)
      const pick = videoId ?? back?.videoId
      if (vids.length > 1) {
        const cur = pick ? vids.find((v) => v.id === pick) : null
        setSeason(cur?.season ?? vids.find((v) => (v.season ?? 0) > 0)?.season ?? vids[0].season ?? 0)
        if (back) setVid(back.videoId)
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
  // meta() may leave out the facts its library item carries.
  const facts = meta.facts ?? libraries.value[rec.id]?.items.find((m) => m.id === meta.id)?.facts

  return (
    <div class="page detail">
      {meta.background && <div class="backdrop" style={{ backgroundImage: `url("${meta.background.replace(/"/g, '%22')}")` }} />}
      <button class="btn ghost sm" onClick={() => history.back()}><Icon name="left" size={16} /> Back</button>
      <div class="detail-head">
        {meta.poster && <img class="detail-poster" src={meta.poster} alt="" />}
        <div class="detail-info">
          <h1>{meta.name}</h1>
          <div class="facts">{[meta.year, meta.runtime, ...(meta.badges ?? []), ...(meta.genres ?? []).slice(0, 3)].filter(Boolean).map((f) => <span>{f}</span>)}</div>
          {rec.manifest.titleActions.length > 0 && (
            <div class="title-acts">
              {rec.manifest.titleActions.map((a) => {
                const on = marks.includes(a.id)
                return (
                  <button class={`btn sm${on ? ' on' : ''}`} aria-pressed={on} disabled={acting.value.has(actionKey(rec, { type, id }, a))} title={a.key ? `${a.label} (${a.key.toUpperCase()})` : a.label}
                    onClick={() => runTitleAction(rec, { type, id }, a).then((r) => { if (r !== null) mark(a, r) })}>
                    {on && <Icon name="check" size={14} />}{a.label}{a.key && <kbd>{a.key.toUpperCase()}</kbd>}
                  </button>
                )
              })}
            </div>
          )}
          {meta.description && <p class="desc">{meta.description}</p>}
          {facts && <div class="facts-list title-facts">{facts.map((f) => <div><span class="dim">{f.label}</span> {f.value}</div>)}</div>}
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

const dlKind = (s: Stream) => downloadable(s, { desktop: isDesktop, mobile: isMobileApp })

const epLabel = (v?: Video) => (v && v.season != null && v.episode != null ? `S${v.season} E${v.episode}` : '')

function Streams({ rec, meta, videoId, video }: { rec: Source; meta: Meta; videoId: string; video?: Video }) {
  const [list, setList] = useState<Stream[] | null>(null)
  const [err, setErr] = useState('')
  const [group, setGroup] = useState('all')
  const [opened, setOpened] = useState<string[]>([])
  const [dlId, setDlId] = useState<string | null>(null)
  useEffect(() => {
    callPlugin(rec, 'streams', [{ type: meta.type, id: meta.id, videoId }]).then(setList).catch((e) => { setErr((e as Error).message); setList([]) })
  }, [videoId])
  const key = progressKey(rec.id, videoId)
  useEffect(() => { savedId(key).then(setDlId) }, [key])
  // On a grid-layout plugin a title opened from the keyboard plays with one more Enter.
  useEffect(() => {
    if (list === null || rec.manifest.layout !== 'grid') return
    const on = document.activeElement
    if (!on || on === document.body) document.querySelector<HTMLElement>('.streams .play-best')?.focus({ preventScroll: true })
  }, [list === null])
  const dl = dlId ? downloads.value.get(dlId) : undefined

  const groups = [...new Set((list ?? []).map((s) => s.group).filter(Boolean))] as string[]
  const shown = (list ?? []).filter((s) => group === 'all' || s.group === group)
  const ref = { t: 'plugin' as const, p: rec.id, type: meta.type, id: meta.id, videoId }

  const label = video ? [epLabel(video), video.title].filter(Boolean).join(' · ') : meta.year
  let sent = 0
  const onSave = rec.manifest.has.progress ? (pos: number, dur: number) => {
    // Tell the source at most every 30 seconds; the player saves locally every 5.
    if (Date.now() - sent < 30_000) return
    sent = Date.now()
    callPlugin(rec, 'progress', [{ type: meta.type, id: meta.id, videoId, pos, dur }]).catch(() => {})
  } : undefined

  const save = (s: Stream) => {
    const saved: Saved = { key, plugin: rec.id, title: meta.name, subtitle: label, poster: video?.thumbnail ?? meta.background ?? meta.poster, kind: s.kind === 'audio' ? 'audio' : 'video', url: s.url!, ref }
    saveStream(saved)
  }

  const last = progress.value[key]
  const resumeAt = unfinished(last) ? last.pos : 0
  // Rank this video's streams by the user's languages, quality and this device (SPEC-best-stream).
  const ctx = ctxNow()
  const cached = useCached(list)
  const cands = streamCandidates(key, shown, { audiobook: meta.type === 'audiobook', episode: meta.type === 'series', debrid: debridNow(cached ?? {}) })
  // Only a title with a stream behind the VPN gate asks the gate anything.
  const gated = (r?: Ranked) => !!r && needsGate(r.c, ctx.vpnForDebrid)
  const anyGated = wantsGate(cands)
  useEffect(() => { if (anyGated) watchGate() }, [anyGated])
  const rows = rank(cands, prefsNow(), deviceFor(), ctx)
  const streamOf = (r: Ranked) => shown[Number(r.c.id.slice(r.c.id.lastIndexOf('#') + 1))]
  const rowOf = new Map(rows.map((r) => [streamOf(r), r]))
  const shutBy = (r?: Ranked) => shutFor(r, ctx.vpnForDebrid)
  // Play starts a stream with a url, or a torrent a debrid service takes; the built-in engine is P6's.
  const best = rows.find((r) => !r.blocked && !shutBy(r) && canStart(r, streamOf(r))) ?? null
  const top = best ? streamOf(best) : null

  const start = async (s: Stream, startAt?: number) => {
    const t = tap()
    // Any newer tap ends a service's wait for an older one.
    cancelFetch()
    // A stream behind the VPN gate never opens on a tap while the gate fails, nor outside its hold.
    const r = rowOf.get(s)
    const shut = shutBy(r)
    if (shut) { notify(shut); return }
    // A torrent has no url to open: a debrid service gives it one, else it waits for the engine.
    let url = s.url
    if (!url && r && canStart(r, s)) {
      try { url = (await playTorrent(key, s, r)) ?? undefined } catch (e) { if (current(t)) notify((e as Error).message); return }
      if (!url || !current(t)) return
    }
    if (!url) { notify(r?.blocked ?? NO_ENGINE_YET); return }
    if (s.external) { window.open(url, '_blank', 'noopener'); return }
    if (s.kind === 'book') {
      go(`/read-url?u=${encodeURIComponent(url)}&t=${encodeURIComponent(meta.name)}&r=${encodeURIComponent(JSON.stringify(ref))}`)
      return
    }
    const subs = [...(s.subs ?? [])]
    if (rec.manifest.has.subtitles) subs.push(...(await callPlugin(rec, 'subtitles', [{ type: meta.type, id: meta.id, videoId }]).catch(() => [])))
    // The subtitle the pick turns on comes first, then the device's languages.
    const subLang = subLangFor(rowOf.get(s), prefsNow(), subs.flatMap((x) => langCode(x.lang) ?? []))
    const langs = navigator.languages.map((l) => l.slice(0, 2))
    const want = (x: { lang: string }) => (subLang && langCode(x.lang) === subLang ? 2 : 0) + Number(langs.some((l) => x.lang.startsWith(l)))
    subs.sort((a, b) => want(b) - want(a))
    // The hold comes last, with nothing awaited between it and play, so a drop cannot slip between.
    if (gated(r)) {
      const g = await holdGate(key, t)
      if (!g.ok) { if (current(t)) notify(g.message || 'Turn on your VPN'); return }
    } else {
      // A newer tap plays instead of this one.
      if (!current(t)) return
      releaseGate()
    }
    const via = r && viaOf(r, serviceName)
    play({
      key,
      title: meta.name,
      subtitle: label,
      kind: s.kind === 'audio' ? 'audio' : 'video',
      url,
      // A service's link is a plain https file: an MKV takes the desktop's convert path (SPEC-debrid rule 5).
      ...(s.torrent ? { src: { t: 'url' as const, url } } : {}),
      ...(via ? { via } : {}),
      poster: video?.thumbnail ?? meta.background ?? meta.poster,
      subs: subs.slice(0, 12).map((x) => ({ label: x.label ?? x.lang, lang: x.lang, url: x.url })),
      ref,
      startAt,
      onSave,
      ...(subLang ? { subLang } : {}),
    })
  }

  const secs = sections(rows.map(streamOf))
  // One download per title: rows offer Download until one is queued, running or saved.
  const free = !dl || dl.state === 'failed'
  const row = (s: Stream) => {
    const q = qualityOf(s), hdr = hdrOf(s), size = sizeOf(s)
    const how = dlKind(s)
    // On the website no stream host is contacted before a tap (a debrid link acts on the account);
    // a host that refuses the browser fails the download with the message to use the Flick app.
    // Downloading a gated stream would fetch it outside the gate's hold, so those rows play only.
    const canSave = free && how !== null && !gated(rowOf.get(s))
    const shut = shutBy(rowOf.get(s))
    const why = shut ?? rowOf.get(s)?.blocked
    const tag = why || !cached ? undefined : serviceTag(s, rowOf.get(s)?.c, serviceName)
    return (
      <div class={`stream-item${why ? ' blocked' : ''}`}>
        <button class="stream" aria-disabled={shut ? 'true' : undefined} onClick={() => start(s)}>
          <div class="stream-name">{s.group ?? rec.manifest.name}</div>
          <div class="stream-detail">{s.title ?? ''}</div>
          <div class="stream-tags">
            {q !== 'Other' && <span class="q">{q}</span>}
            {hdr && <span class="q">{hdr}</span>}
            {size && <span>{size}</span>}
            {s.kind === 'book' && <span>Book</span>}
            {s.external && !shut && <span>Opens in your browser</span>}
            {tag && <span class={rowOf.get(s)?.c.via === 'debrid-cached' ? 'ok' : undefined}>{tag}</span>}
            {why && (shut || !s.external) && <span class="warn">{why}</span>}
            </div>
          <Icon name={s.external ? 'external' : 'play'} size={18} class="stream-go" />
        </button>
      {canSave && <button class="btn ghost sm stream-dl" onClick={() => save(s)} aria-label={`Download ${s.title ?? meta.name}`}><Icon name="download" size={16} /> Download</button>}
      </div>
    )
  }

  // A plugin's own kind with nothing to play (a recipe) is its title page: facts and description only.
  if (list?.length === 0 && !err && !dl && !isBuiltinType(meta.type)) return null
  return (
    <section class="streams">
      <div class="row-head">
        <h2>Streams{video ? ` · ${epLabel(video) || video.title}` : ''}</h2>
        {list === null && <span class="spinner sm" />}
        {dl?.state === 'done'
          ? <button class="btn primary play-best" onClick={() => playSaved(dl, { onSave })}><Icon name="play" size={16} /> {resumeAt ? `Resume downloaded ${formatTime(resumeAt)}` : 'Play downloaded'}</button>
          : top ? <><button class="btn primary play-best" onClick={() => start(top)}><Icon name="play" size={16} /> {resumeAt ? `Resume ${formatTime(resumeAt)}` : 'Play'}</button><span class="pick-line small dim">{pickLine(best!, serviceName)}</span></>
            : rows[0] && <p class="pick-why small">{shutBy(rows[0]) ?? rows[0].blocked ?? NO_ENGINE_YET}</p>}
        {(dl?.state === 'done' || top) && resumeAt > 0 && <button class="btn ghost start-over" onClick={() => (dl?.state === 'done' ? playSaved(dl, { onSave, startAt: 0 }) : start(top!, 0))}>Start over</button>}
      </div>
      <DebridWait streamKey={key} />
      {dl && !(dl.state === 'failed' && dl.error === 'Canceled' && !dl.part) && (
        <p class="dl-status small">
          {dl.state === 'done' ? 'Downloaded. Plays offline.' : dl.error === 'Canceled' ? 'Download canceled. Download again to resume.' : dl.state === 'failed' ? `Download failed: ${dl.error}` : dl.state === 'queued' ? 'Waiting to download' : `Downloading ${badgeFor(dl)}`}
          {dl.state === 'done' || dl.state === 'failed'
            ? <button class="btn ghost sm" onClick={async () => { await removeDownload(dl.id); notify('Download removed.') }}>Remove download</button>
            : <button class="btn ghost sm" onClick={() => cancelDownload(dl.id)}>Cancel</button>}
        </p>
      )}
      {groups.length > 1 && (
        <div class="chips">
          <button class={`chip ${group === 'all' ? 'on' : ''}`} onClick={() => setGroup('all')}>All <span>{list!.length}</span></button>
          {groups.map((g) => <button class={`chip ${group === g ? 'on' : ''}`} onClick={() => setGroup(g)}>{g} <span>{list!.filter((s) => s.group === g).length}</span></button>)}
        </div>
      )}
      {list && list.length === 0 && <p class="dim">{err ? `${rec.manifest.name}: ${err}` : 'No streams for this one.'}</p>}
      {secs.map((sec) => {
        const all = opened.includes(sec.quality) || sec.streams.length <= 4
        return (
          <div class="stream-sec">
            {(secs.length > 1 || sec.quality !== 'Other') && <h3 class="stream-q">{sec.quality} <span>{sec.streams.length}</span></h3>}
            <div class="stream-list">{(all ? sec.streams : sec.streams.slice(0, 3)).map(row)}</div>
            {!all && <button class="btn ghost sm more" onClick={() => setOpened([...opened, sec.quality])}>Show {sec.streams.length - 3} more</button>}
          </div>
        )
      })}
    </section>
  )
}
