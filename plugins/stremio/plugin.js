// Stremio for Flick: sign in to bring your installed addons and library, browse and search their
// catalogs, open titles, and pick streams. Without an account it starts with Cinemeta and OpenSubtitles.
// Torrent streams play through the Stremio streaming server when it runs on the same computer.
// Addon protocol: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

const API = 'https://api.strem.io/api'
const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json'
const OPENSUBS = 'https://opensubtitles-v3.strem.io/manifest.json'
const LOCAL_SERVER = 'http://127.0.0.1:11470'
const TYPES = ['movie', 'series', 'channel', 'tv']

// ---------- the addon protocol ----------

export function normalizeAddonUrl(input) {
  let u = String(input).trim()
  if (u.startsWith('stremio://')) u = 'https://' + u.slice('stremio://'.length)
  if (!/\/manifest\.json(\?.*)?$/.test(u)) u = u.replace(/\/$/, '') + '/manifest.json'
  return u
}

export const base = (transportUrl) => transportUrl.replace(/\/manifest\.json(\?.*)?$/, '').replace(/\/$/, '')

function resource(m, name) {
  for (const r of m.resources ?? []) {
    if (typeof r === 'string' && r === name) return { types: m.types, idPrefixes: m.idPrefixes }
    if (r && typeof r === 'object' && r.name === name) return { types: r.types ?? m.types, idPrefixes: r.idPrefixes ?? m.idPrefixes }
  }
  return null
}

export function supports(a, res, type, id) {
  const r = resource(a.manifest, res)
  if (!r) return false
  if (r.types && !r.types.includes(type)) return false
  if (r.idPrefixes && r.idPrefixes.length && !r.idPrefixes.some((p) => id.startsWith(p))) return false
  return true
}

/** Catalogs that show without a required extra (search-only ones are skipped). */
export const browsable = (a) => (a.manifest.catalogs ?? []).filter((c) => !(c.extra ?? []).some((e) => e.isRequired && e.name !== 'skip'))
export const searchable = (a) => (a.manifest.catalogs ?? []).filter((c) => (c.extra ?? []).some((e) => e.name === 'search') || (c.extraSupported ?? []).includes('search'))

export function catalogUrl(a, c, extra) {
  const keys = Object.keys(extra ?? {})
  const ex = keys.length ? '/' + keys.map((k) => `${k}=${encodeURIComponent(extra[k])}`).join('&') : ''
  return `${base(a.transportUrl)}/catalog/${c.type}/${encodeURIComponent(c.id)}${ex}.json`
}

const kind = (t) => (t === 'tv' ? 'channel' : TYPES.includes(t) ? t : 'video')

export function toMeta(m) {
  return {
    id: m.id,
    type: kind(m.type),
    name: m.name,
    poster: m.poster,
    posterShape: m.posterShape,
    background: m.background,
    description: m.description,
    year: m.releaseInfo ?? m.year,
    runtime: m.runtime,
    genres: m.genres ?? m.genre,
    videos: m.videos?.map((v) => ({ id: v.id, title: v.title ?? v.name ?? `Episode ${v.episode ?? ''}`.trim(), season: v.season, episode: v.episode, released: v.released, thumbnail: v.thumbnail, overview: v.overview ?? v.description })),
  }
}

/** One Stremio stream as a Flick stream. */
export function toStream(s, addon, type, id, serverUp) {
  const title = [s.name, s.title ?? s.description ?? s.behaviorHints?.filename].filter(Boolean).join(' · ').replace(/\n/g, ' ')
  const subs = (s.subtitles ?? []).map((x) => ({ url: x.url, lang: x.lang ?? 'und' }))
  if (s.url) return { url: s.url, title, group: addon, needsDesktop: s.behaviorHints?.notWebReady || undefined, subs }
  if (s.infoHash) {
    if (serverUp) return { url: `${LOCAL_SERVER}/${s.infoHash}/${s.fileIdx ?? -1}`, title: `${title} · via Stremio server`, group: addon, subs }
    return { url: `https://web.stremio.com/#/detail/${type}/${encodeURIComponent(id)}`, title: `${title} · needs Stremio running on this computer`, group: addon, external: true }
  }
  if (s.ytId) return { url: `https://www.youtube.com/watch?v=${encodeURIComponent(s.ytId)}`, title: title || 'YouTube', group: addon, external: true }
  if (s.externalUrl && /^https:\/\//.test(s.externalUrl)) return { url: s.externalUrl, title: title || 'Opens on another site', group: addon, external: true }
  return null
}

// ---------- the account and addons ----------

async function api(ctx, method, body) {
  const r = await ctx.fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Stremio refused the request')
  return j.result
}

async function getJson(ctx, url) {
  const r = await ctx.fetch(url)
  if (!r.ok) throw new Error(`${url} answered ${r.status}`)
  return r.json()
}

async function manifest(ctx, url) {
  const m = await getJson(ctx, url)
  if (!m.id || !m.resources) throw new Error(`${url} is not a Stremio addon manifest`)
  return { transportUrl: url, manifest: m }
}

let cache = null
async function addons(ctx) {
  const authKey = await ctx.store.get('authKey')
  const extra = (Array.isArray(ctx.settings.addons) ? ctx.settings.addons : []).map(normalizeAddonUrl)
  const sig = JSON.stringify([authKey, extra])
  if (cache && cache.sig === sig && Date.now() - cache.at < 10 * 60_000) return cache.list
  let list = []
  if (authKey) {
    try { list = (await api(ctx, 'addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })).addons ?? [] } catch (e) { ctx.log('Could not read your Stremio addons:', e.message) }
  }
  if (!list.length) list = (await Promise.all([CINEMETA, OPENSUBS].map((u) => manifest(ctx, u).catch(() => null)))).filter(Boolean)
  for (const u of extra) {
    if (list.some((a) => a.transportUrl === u)) continue
    const a = await manifest(ctx, u).catch((e) => { ctx.log(e.message); return null })
    if (a) list.push(a)
  }
  cache = { sig, at: Date.now(), list }
  return list
}

let server = { up: false, at: 0 }
async function serverUp(ctx) {
  if (Date.now() - server.at < 15_000) return server.up
  let up = false
  try { up = (await ctx.fetch(`${LOCAL_SERVER}/settings`)).ok } catch { up = false }
  server = { up, at: Date.now() }
  return up
}

/** Catalog ids carry the addon and catalog, so a fresh sandbox can find them again. */
const catId = (a, c) => `${base(a.transportUrl)}|${c.type}|${c.id}`

// ---------- the plugin ----------

/** @type {import('../flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'dev.flick.stremio',
  name: 'Stremio',
  version: '1.0.0',
  author: 'Flick',
  description: 'Your Stremio addons, library and Continue Watching. Sign in, or start with Cinemeta and OpenSubtitles. Torrent streams play through the Stremio server on this computer.',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzdiNWJmNSIvPjxwYXRoIGQ9Ik0xMiA0bDcgNHY4bC03IDQtNy00Vjh6IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS42Ii8+PHBhdGggZD0iTTEwLjUgOXY2bDUtM3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4=',
  // Addons live on any host the user adds; the local server is listed by name.
  hosts: ['*', '127.0.0.1'],
  tools: [],
  settings: [
    { key: 'addons', label: 'Extra addon URLs', type: 'list', default: [], help: 'One manifest URL per line (https://.../manifest.json or stremio://...). Use only addons you chose.' },
  ],
  actions: [
    { id: 'signin', label: 'Sign in to Stremio', fields: [{ key: 'email', label: 'Email' }, { key: 'password', label: 'Password', type: 'password' }] },
    { id: 'addons', label: 'Show my addons', fields: [] },
    { id: 'signout', label: 'Sign out of Stremio', fields: [] },
  ],
  catalogs: [{ id: 'search', name: 'Search', type: 'movie', search: true }],

  async userCatalogs(ctx) {
    const list = await addons(ctx)
    return list.flatMap((a) => browsable(a).filter((c) => TYPES.includes(c.type)).map((c) => ({
      id: catId(a, c),
      name: `${c.name ?? c.id} · ${c.type === 'series' ? 'Series' : c.type === 'movie' ? 'Movies' : c.type}`,
      type: kind(c.type),
    }))).slice(0, 24)
  },

  async catalog(ctx, { id, search, skip = 0 }) {
    const list = await addons(ctx)
    if (search) {
      const seen = new Set()
      const out = []
      await Promise.all(list.flatMap((a) => searchable(a).map(async (c) => {
        try {
          const r = await getJson(ctx, catalogUrl(a, c, { search }))
          for (const m of r.metas ?? []) if (!seen.has(m.id)) { seen.add(m.id); out.push(toMeta(m)) }
        } catch { /* one addon down should not stop the rest */ }
      })))
      return { items: out.slice(0, 200), more: false }
    }
    const [b, type, cid] = id.split('|')
    const a = list.find((x) => base(x.transportUrl) === b)
    const c = a && (a.manifest.catalogs ?? []).find((x) => x.type === type && x.id === cid)
    if (!c) return { items: [], more: false }
    const r = await getJson(ctx, catalogUrl(a, c, skip ? { skip: String(skip) } : undefined))
    const metas = r.metas ?? []
    return { items: metas.map(toMeta), more: metas.length >= 50 }
  },

  async meta(ctx, { type, id }) {
    for (const a of (await addons(ctx)).filter((x) => supports(x, 'meta', type, id))) {
      try {
        const r = await getJson(ctx, `${base(a.transportUrl)}/meta/${type}/${encodeURIComponent(id)}.json`)
        if (r.meta) return toMeta(r.meta)
      } catch { /* try the next addon */ }
    }
    throw new Error('None of your addons describe this title.')
  },

  async streams(ctx, { type, id, videoId }) {
    const list = (await addons(ctx)).filter((a) => supports(a, 'stream', type, videoId))
    if (!list.length) {
      ctx.log('None of your addons offer streams for this title. Stream addons come from Stremio\'s addon catalog: sign in to use yours, or add one under Extra addon URLs.')
      return []
    }
    const up = await serverUp(ctx)
    const batches = await Promise.all(list.map(async (a) => {
      try {
        const r = await getJson(ctx, `${base(a.transportUrl)}/stream/${type}/${encodeURIComponent(videoId)}.json`)
        return (r.streams ?? []).map((s) => toStream(s, a.manifest.name, type, id, up)).filter(Boolean)
      } catch { return [] }
    }))
    return batches.flat()
  },

  async subtitles(ctx, { type, videoId }) {
    const out = []
    await Promise.all((await addons(ctx)).filter((a) => supports(a, 'subtitles', type, videoId)).map(async (a) => {
      try {
        const r = await getJson(ctx, `${base(a.transportUrl)}/subtitles/${type}/${encodeURIComponent(videoId)}.json`)
        for (const s of r.subtitles ?? []) out.push({ url: s.url, lang: s.lang ?? 'und' })
      } catch { /* optional */ }
    }))
    return out
  },

  async library(ctx) {
    const authKey = await ctx.store.get('authKey')
    if (!authKey) return []
    const r = await api(ctx, 'datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true })
    return r.filter((i) => !i.removed && !i.temp).map((i) => {
      const st = i.state ?? {}
      const m = { id: i._id, type: kind(i.type), name: i.name, poster: i.poster }
      if (st.timeOffset > 0) {
        m.progress = { pos: st.timeOffset / 1000, dur: (st.duration ?? 0) / 1000, at: Date.parse(st.lastWatched ?? i._mtime ?? '') || 0 }
        if (st.video_id) m.progress.videoId = st.video_id
      }
      return m
    })
  },

  async action(ctx, id, values) {
    if (id === 'signin') {
      const r = await api(ctx, 'login', { type: 'Login', email: values.email, password: values.password, facebook: false })
      await ctx.store.set('authKey', r.authKey)
      await ctx.store.set('email', r.user?.email ?? values.email)
      cache = null
      return { ok: true, message: `Signed in as ${r.user?.email ?? values.email}. Your addons and library are here now.` }
    }
    if (id === 'addons') {
      const list = await addons(ctx)
      return { ok: true, message: list.map((a) => `${a.manifest.name} ${a.manifest.version}`).join(', ') }
    }
    if (id === 'signout') {
      const authKey = await ctx.store.get('authKey')
      if (authKey) await api(ctx, 'logout', { type: 'Logout', authKey }).catch(() => {})
      await ctx.store.set('authKey', null)
      await ctx.store.set('email', null)
      cache = null
      return { ok: true, message: 'Signed out of Stremio.' }
    }
    return { ok: false, message: `Unknown action ${id}` }
  },
}
