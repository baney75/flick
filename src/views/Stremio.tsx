import { useEffect, useMemo, useState } from 'preact/hooks'
import { stremio, loadStremio, saveStremio, stremioExtra, notify, go, play } from '../lib/store'
import * as S from '../lib/stremio'
import { Card, Row, VirtualGrid } from '../components/Card'
import { Icon } from '../components/icons'
import { hash } from '../lib/library'

type Tab = 'discover' | 'library' | 'addons'

export function Stremio() {
  const st = stremio.value
  const [tab, setTab] = useState<Tab>('discover')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ addon: string; type: string; metas: S.MetaPreview[] }[] | null>(null)

  useEffect(() => { if (!st.ready) loadStremio() }, [])

  const runSearch = async (term: string) => {
    if (!term.trim()) { setResults(null); return }
    const out: { addon: string; type: string; metas: S.MetaPreview[] }[] = []
    await Promise.all(st.addons.flatMap((a) => S.searchable(a).map(async (c) => {
      try {
        const metas = await S.catalog(a, c, { search: term.trim() })
        if (metas.length) out.push({ addon: a.manifest.name, type: c.type, metas })
      } catch { /* skip */ }
    })))
    setResults(out)
  }

  return (
    <div class="page">
      <header class="page-head">
        <h1>Stremio</h1>
        <form class="search" onSubmit={(e) => { e.preventDefault(); runSearch(q) }}>
          <Icon name="search" size={16} />
          <input value={q} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setQ(v); if (!v) setResults(null) }} placeholder="Search movies and shows" aria-label="Search Stremio" />
        </form>
        <div class="head-actions">
          {st.authKey ? <span class="pill"><Icon name="check" size={14} /> {st.email}</span> : null}
        </div>
      </header>

      {!st.authKey && <LinkCard />}

      <div class="chips">
        {(['discover', 'library', 'addons'] as Tab[]).map((t) => (
          <button class={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)} disabled={t === 'library' && !st.authKey}>
            {t === 'discover' ? 'Discover' : t === 'library' ? `My Stremio library${st.library.length ? ` ${st.library.length}` : ''}` : `Addons ${st.addons.length}`}
          </button>
        ))}
      </div>

      {!st.ready && <div class="status inline"><span class="spinner" /> Loading your addons</div>}

      {results ? (
        results.length === 0 ? <p class="dim">No results for “{q}”.</p> : results.map((r) => (
          <Row title={`${r.addon} · ${r.type}`}>
            {r.metas.map((m) => <MetaCard m={m} />)}
          </Row>
        ))
      ) : tab === 'discover' ? <Discover /> : tab === 'library' ? <StLibrary /> : <Addons />}
    </div>
  )
}

function MetaCard({ m }: { m: S.MetaPreview }) {
  return <Card image={m.poster} title={m.name} sub={[m.releaseInfo, m.imdbRating ? `★ ${m.imdbRating}` : null].filter(Boolean).join(' · ')}
    shape={m.posterShape === 'landscape' ? 'wide' : m.posterShape === 'square' ? 'square' : 'poster'}
    onClick={() => go(`/stremio/${m.type}/${encodeURIComponent(m.id)}`)} />
}

function LinkCard() {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await S.login(email, pw)
      await saveStremio({ authKey: r.authKey, email: r.email })
      setPw('')
      await loadStremio()
      notify('Stremio linked. Your addons and library are here now.')
    } catch (e2) {
      setErr((e2 as Error).message)
    }
    setBusy(false)
  }
  return (
    <div class="panel link-card">
      <div class="grow">
        <h3>Link your Stremio account</h3>
        <p class="dim">Bring in your installed addons, your library and Continue Watching. Your password goes only to Stremio; Flick keeps just the sign-in key on this device.</p>
      </div>
      <form class="link-form" onSubmit={submit}>
        <input type="email" required autocomplete="username" placeholder="Stremio email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        <input type="password" required autocomplete="current-password" placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <button class="btn primary" disabled={busy}>{busy ? 'Linking…' : 'Link'}</button>
        {err && <p class="err">{err}</p>}
      </form>
    </div>
  )
}

function Discover() {
  const st = stremio.value
  const rows = useMemo(() => st.addons.flatMap((a) => S.browsable(a).map((c) => ({ a, c }))).slice(0, 24), [st.addons])
  return <>{rows.map(({ a, c }) => <CatalogRow key={`${a.transportUrl}|${c.type}|${c.id}`} a={a} c={c} />)}</>
}

function CatalogRow({ a, c }: { a: S.Addon; c: S.CatalogDef }) {
  const [metas, setMetas] = useState<S.MetaPreview[] | null>(null)
  useEffect(() => { S.catalog(a, c).then(setMetas).catch(() => setMetas([])) }, [])
  if (metas && !metas.length) return null
  const label = `${c.name ?? c.id} · ${c.type === 'series' ? 'Series' : c.type === 'movie' ? 'Movies' : c.type}`
  return (
    <Row title={label} action={<span class="small dim">{a.manifest.name}</span>}>
      {metas ? metas.slice(0, 30).map((m) => <MetaCard m={m} />) : Array.from({ length: 8 }, () => <div class="card poster skeleton"><div class="art" /></div>)}
    </Row>
  )
}

function StLibrary() {
  const lib = stremio.value.library
  const [type, setType] = useState<'all' | 'movie' | 'series'>('all')
  const list = useMemo(() => lib.filter((l) => type === 'all' || l.type === type).sort((a, b) => Date.parse(b._mtime ?? '0') - Date.parse(a._mtime ?? '0')), [lib, type])
  if (!lib.length) return <p class="dim">Your Stremio library is empty. Add titles in Stremio and they show up here.</p>
  return (
    <>
      <div class="chips">
        {(['all', 'movie', 'series'] as const).map((t) => <button class={`chip ${type === t ? 'on' : ''}`} onClick={() => setType(t)}>{t === 'all' ? 'All' : t === 'movie' ? 'Movies' : 'Series'}</button>)}
      </div>
      <VirtualGrid list={list} min={150} ratio={1.5} render={(l) => (
        <Card image={l.poster} title={l.name} shape="poster" pct={l.state?.duration ? (l.state.timeOffset ?? 0) / l.state.duration : 0}
          onClick={() => go(`/stremio/${l.type}/${encodeURIComponent(l._id)}${l.state?.video_id && l.type === 'series' ? `?v=${encodeURIComponent(l.state.video_id)}` : ''}`)} />
      )} />
    </>
  )
}

function Addons() {
  const st = stremio.value
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const u = S.normalizeAddonUrl(url)
      await S.fetchManifest(u)
      const extra = await stremioExtra()
      if (!extra.includes(u)) await saveStremio({ extra: [...extra, u] })
      await loadStremio()
      setUrl('')
      notify('Addon added.')
    } catch (e2) {
      notify((e2 as Error).message)
    }
    setBusy(false)
  }
  const signOut = async () => {
    if (st.authKey) await S.logout(st.authKey)
    await saveStremio({ authKey: null, email: null })
    await loadStremio()
    notify('Signed out of Stremio.')
  }
  const removeExtra = async (u: string) => {
    await saveStremio({ extra: (await stremioExtra()).filter((x) => x !== u) })
    await loadStremio()
  }
  return (
    <div class="panel">
      <form class="url-form" onSubmit={add}>
        <Icon name="link" size={16} />
        <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="Addon URL (https://…/manifest.json or stremio://…)" aria-label="Addon URL" />
        <button class="btn" disabled={busy || !url.trim()}>Add</button>
      </form>
      {st.addons.map((a) => <AddonRow a={a} onRemove={removeExtra} />)}
      <p class="small dim">{st.authKey ? 'Addons from your Stremio account sync from Stremio. Install or remove them there.' : 'Without an account Flick starts with Cinemeta and OpenSubtitles.'}</p>
      {st.authKey && <button class="btn ghost" onClick={signOut}>Sign out of Stremio</button>}
    </div>
  )
}

function AddonRow({ a, onRemove }: { a: S.Addon; onRemove: (u: string) => void }) {
  const [extra, setExtra] = useState(false)
  useEffect(() => { stremioExtra().then((x) => setExtra(x.includes(a.transportUrl))) }, [a.transportUrl])
  const res = a.manifest.resources.map((r) => (typeof r === 'string' ? r : r.name)).join(', ')
  return (
    <div class="list-row">
      {a.manifest.logo ? <img class="addon-logo" src={a.manifest.logo} alt="" /> : <Icon name="stremio" size={18} />}
      <div class="grow"><div>{a.manifest.name} <span class="small dim">v{a.manifest.version}</span></div><div class="small dim">{res}</div></div>
      {extra && <button class="btn ghost sm" onClick={() => onRemove(a.transportUrl)}>Remove</button>}
    </div>
  )
}

// ------------------------------------------------------------------
// Title page: details, episodes and streams.
// ------------------------------------------------------------------

export function StremioDetail({ type, id, videoId }: { type: string; id: string; videoId?: string }) {
  const st = stremio.value
  const [meta, setMeta] = useState<S.Meta | null | undefined>(undefined)
  const [season, setSeason] = useState<number | null>(null)
  const [vid, setVid] = useState<string | null>(videoId ?? (type === 'movie' ? id : null))

  useEffect(() => { if (!st.ready) loadStremio() }, [])
  useEffect(() => {
    if (!st.ready) return
    S.meta(st.addons, type, id).then((m) => {
      setMeta(m)
      if (m?.videos?.length && type !== 'movie') {
        const cur = videoId ? m.videos.find((v) => v.id === videoId) : null
        setSeason(cur?.season ?? m.videos.find((v) => (v.season ?? 0) > 0)?.season ?? m.videos[0].season ?? 1)
        // Single-video items (channels, tv) can stream from their one video.
        if (!videoId && m.videos.length === 1) setVid(m.videos[0].id)
      } else if (type !== 'series' && !vid) setVid(id)
    })
  }, [st.ready, type, id])

  if (meta === undefined) return <div class="page"><div class="status inline"><span class="spinner" /> Loading</div></div>
  if (meta === null) return (
    <div class="page">
      <p class="dim">None of your addons describe this title.</p>
      <a class="btn" href={`stremio:///detail/${type}/${id}`}>Open in Stremio</a>
    </div>
  )

  const seasons = [...new Set((meta.videos ?? []).map((v) => v.season ?? 0))].filter((s) => s > 0).sort((a, b) => a - b)
  const hasSpecials = (meta.videos ?? []).some((v) => (v.season ?? 0) === 0)
  if (hasSpecials) seasons.push(0)
  const eps = (meta.videos ?? []).filter((v) => (v.season ?? 0) === (season ?? 1)).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
  const curVideo = meta.videos?.find((v) => v.id === vid)

  return (
    <div class="page detail">
      {meta.background && <div class="backdrop" style={{ backgroundImage: `url("${meta.background}")` }} />}
      <button class="btn ghost sm" onClick={() => history.back()}><Icon name="left" size={16} /> Back</button>
      <div class="detail-head">
        {meta.poster && <img class="detail-poster" src={meta.poster} alt="" />}
        <div class="detail-info">
          {meta.logo ? <img class="detail-logo" src={meta.logo} alt={meta.name} /> : <h1>{meta.name}</h1>}
          <div class="facts">
            {[meta.releaseInfo ?? meta.year, meta.runtime, meta.imdbRating ? `★ ${meta.imdbRating}` : null, ...(meta.genres ?? []).slice(0, 3)].filter(Boolean).map((f) => <span>{f}</span>)}
          </div>
          {meta.description && <p class="desc">{meta.description}</p>}
          {meta.cast?.length ? <p class="small dim">With {meta.cast.slice(0, 4).join(', ')}</p> : null}
          <div class="row">
            <a class="btn ghost" href={`stremio:///detail/${type}/${encodeURIComponent(id)}${vid && vid !== id ? `/${encodeURIComponent(vid)}` : ''}`}><Icon name="external" size={16} /> Open in Stremio</a>
          </div>
        </div>
      </div>

      {type !== 'movie' && (meta.videos?.length ?? 0) > 1 && (
        <section>
          <div class="chips">
            {seasons.map((s) => <button class={`chip ${s === season ? 'on' : ''}`} onClick={() => setSeason(s)}>{s === 0 ? 'Specials' : `Season ${s}`}</button>)}
          </div>
          <div class="episodes compact">
            {eps.map((v) => (
              <button class={`episode ${v.id === vid ? 'sel' : ''}`} onClick={() => setVid(v.id)}>
                <div class="art">{v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <div class="art-ph"><Icon name="film" size={20} /></div>}</div>
                <div class="ep-meta">
                  <div class="t2">Episode {v.episode}{v.released ? ` · ${new Date(v.released).toLocaleDateString()}` : ''}</div>
                  <div class="t1">{v.title ?? v.name ?? `Episode ${v.episode}`}</div>
                  {v.overview && <div class="small dim clamp2">{v.overview}</div>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {vid && <Streams type={type} id={id} videoId={vid} meta={meta} video={curVideo} />}
    </div>
  )
}

function Streams({ type, id, videoId, meta, video }: { type: string; id: string; videoId: string; meta: S.Meta; video?: S.Video }) {
  const st = stremio.value
  const [list, setList] = useState<S.SourcedStream[]>([])
  const [done, setDone] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const [serverUp, setServerUp] = useState<boolean | null>(null)

  useEffect(() => {
    setList([])
    setDone(false)
    S.localServerUp().then(setServerUp)
    S.streams(st.addons, type, videoId, (batch) => setList((l) => [...l, ...batch])).then(() => setDone(true))
  }, [videoId, st.addons])

  const streamAddons = st.addons.filter((a) => S.supports(a, 'stream', type, videoId))
  const groups = [...new Set(list.map((s) => s.addon))]
  const shown = list.filter((s) => filter === 'all' || s.addon === filter)

  const start = async (s: S.SourcedStream) => {
    const p = await S.playable(s, type, id)
    if (p.kind === 'external') {
      notify(p.why)
      window.open(p.url, '_blank')
      return
    }
    const subs = [...(s.subtitles ?? [])]
    const extra = await S.subtitles(st.addons, type, videoId).catch(() => [])
    subs.push(...extra)
    const langs = navigator.languages.map((l) => l.slice(0, 2))
    // Show the viewer's languages first.
    subs.sort((a, b) => Number(langs.some((l) => b.lang?.startsWith(l))) - Number(langs.some((l) => a.lang?.startsWith(l))))
    play({
      key: `st:${videoId}`,
      title: meta.name,
      subtitle: video ? `S${video.season} E${video.episode} · ${video.title ?? video.name ?? ''}` : meta.releaseInfo,
      kind: 'video',
      url: p.url,
      poster: video?.thumbnail ?? meta.background ?? meta.poster,
      subs: subs.slice(0, 12).map((x) => ({ label: `${x.lang}${x.id ? '' : ''}`, lang: x.lang, url: x.url })),
      ref: { t: 'stremio', type, id, videoId },
    })
  }

  return (
    <section class="streams">
      <div class="row-head"><h2>Streams{video ? ` · S${video.season} E${video.episode}` : ''}</h2>{!done && <span class="spinner sm" />}</div>
      {streamAddons.length === 0 && (
        <div class="panel">
          <p>None of your addons offer streams for this title.</p>
          <p class="dim small">Stremio addons that provide streams come from Stremio's addon catalog. Link your account to use the ones you have, or add an addon URL under Addons. Flick never adds stream sources on its own.</p>
        </div>
      )}
      {groups.length > 1 && (
        <div class="chips">
          <button class={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All <span>{list.length}</span></button>
          {groups.map((g) => <button class={`chip ${filter === g ? 'on' : ''}`} onClick={() => setFilter(g)}>{g} <span>{list.filter((s) => s.addon === g).length}</span></button>)}
        </div>
      )}
      {done && streamAddons.length > 0 && list.length === 0 && <p class="dim">No streams found for this one.</p>}
      <div class="stream-list">
        {shown.map((s) => {
          const l = S.streamLabel(s)
          const torrent = !!s.infoHash && !s.url
          return (
            <button class="stream" onClick={() => start(s)} key={hash(JSON.stringify([s.url, s.infoHash, s.fileIdx, s.ytId, s.externalUrl, s.addon]))}>
              <div class="stream-name">{l.name || s.addon}</div>
              <div class="stream-detail">{l.detail}</div>
              <div class="stream-tags">
                <span>{s.addon}</span>
                {torrent && <span class={serverUp ? 'ok' : 'warn'}>{serverUp ? 'Via Stremio server' : 'Needs Stremio running'}</span>}
                {s.externalUrl && <span>Opens externally</span>}
                {s.behaviorHints?.notWebReady && <span class="warn">May need desktop app</span>}
              </div>
              <Icon name="play" size={18} class="stream-go" />
            </button>
          )
        })}
      </div>
    </section>
  )
}
