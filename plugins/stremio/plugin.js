// Stremio for Flick: sign in to bring your installed addons and library, browse and search their
// catalogs, open titles, and pick streams. Without an account it starts with Cinemeta and OpenSubtitles.
// Torrent streams (infoHash) are left out: Flick plays a torrent only through its own engine, behind
// the VPN gate, and never through the Stremio streaming server.
// Addon protocol: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

const API = 'https://api.strem.io/api'
const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json'
const OPENSUBS = 'https://opensubtitles-v3.strem.io/manifest.json'
const TYPES = ['movie', 'series', 'channel', 'tv']
// Stremio's own Addons page lists its Official and Community addons from Cinemeta's addon_catalog
// resource: https://v3-cinemeta.strem.io/manifest.json declares addonCatalogs { type: 'all', id:
// 'official' } and { type: 'all', id: 'community' } (read 2026-11-26). Each answers { addons: [{
// transportUrl, transportName, manifest, flags? }] }, the shape in
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/addon_catalog.md
const ADDON_CATALOGS = ['official', 'community'].map((id) => `https://v3-cinemeta.strem.io/addon_catalog/all/${id}.json`)
// Addons Stremio never lets the user remove: PROTECTED_URLS in
// https://github.com/Stremio/stremio-official-addons/blob/master/official-addons-v2/scripts/build.js
// (Cinemeta and the local files addon). An account's copy also says so in flags.protected.
const PROTECTED = ['com.linvo.cinemeta', 'org.stremio.local']

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

/** A stream URL Flick plays from an addon: http(s) on a public host. A loopback or private host
 * (a Stremio streaming server, a LAN torrent server) or a magnet link would play a torrent around
 * the VPN gate. */
export function publicUrl(u) {
  let url
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return false
  const v4 = h.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128)) return false
  }
  if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(h)) return false
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return false
  return true
}

/** One Stremio stream as a Flick stream, or null for one Flick doesn't play (a torrent). */
export function toStream(s, addon) {
  const title = [s.name, s.title ?? s.description ?? s.behaviorHints?.filename].filter(Boolean).join(' · ').replace(/\n/g, ' ')
  const subs = (s.subtitles ?? []).map((x) => ({ url: x.url, lang: x.lang ?? 'und' }))
  if (s.url) return publicUrl(s.url) ? { url: s.url, title, group: addon, needsDesktop: s.behaviorHints?.notWebReady || undefined, subs } : null
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

const extraUrls = (ctx) => (Array.isArray(ctx.settings.addons) ? ctx.settings.addons : []).map(normalizeAddonUrl)
const collection = async (ctx, authKey) => (await api(ctx, 'addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })).addons ?? []
/**
 * The account's collection, to write back changed. A reply with no list is refused, so a bad read never
 * overwrites the account; an empty one starts from Cinemeta and OpenSubtitles, as Stremio's apps do.
 */
async function collectionToWrite(ctx, authKey) {
  const r = await api(ctx, 'addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })
  if (!Array.isArray(r?.addons)) throw new Error('Could not read your Stremio addons, so nothing was changed.')
  if (r.addons.length) return r.addons
  const defaults = await Promise.all([CINEMETA, OPENSUBS].map((u) => manifest(ctx, u)))
  return defaults.map((a) => ({ ...a, flags: { official: true, protected: PROTECTED.includes(a.manifest.id) } }))
}

let cache = null
/** Every addon Flick uses, and where each came from: the account, the built-in pair, or the addons setting. */
async function load(ctx) {
  const authKey = await ctx.store.get('authKey')
  const extra = extraUrls(ctx)
  const sig = JSON.stringify([authKey, extra])
  if (cache && cache.sig === sig && Date.now() - cache.at < 10 * 60_000) return cache
  let list = []
  const from = new Map()
  if (authKey) {
    try { list = await collection(ctx, authKey) } catch (e) { ctx.log('Could not read your Stremio addons:', e.message) }
    for (const a of list) from.set(a.transportUrl, 'account')
  }
  if (!list.length) {
    list = (await Promise.all([CINEMETA, OPENSUBS].map((u) => manifest(ctx, u).catch(() => null)))).filter(Boolean)
    for (const a of list) from.set(a.transportUrl, 'default')
  }
  for (const u of extra) {
    if (list.some((a) => a.transportUrl === u)) continue
    const a = await manifest(ctx, u).catch((e) => { ctx.log(e.message); return null })
    if (a) { list.push(a); from.set(u, 'setting') }
  }
  cache = { sig, at: Date.now(), list, from }
  return cache
}
const addons = async (ctx) => (await load(ctx)).list

const isProtected = (a) => a.flags?.protected === true || PROTECTED.includes(a.manifest?.id)
const row = (a, removable) => ({
  id: a.manifest.id, name: a.manifest.name ?? a.manifest.id, description: a.manifest.description, logo: a.manifest.logo,
  url: a.transportUrl, types: a.manifest.types, removable,
})
/** An address the user gave, as Stremio stores it (https, ending in manifest.json); null for anything else. */
function addonAddress(input) {
  const raw = String(input ?? '').trim()
  if (!/^(https|stremio):\/\//i.test(raw)) return null
  const u = normalizeAddonUrl(raw.replace(/^stremio:\/\//i, 'stremio://'))
  return /^https:\/\/[^/?#]+/i.test(u) ? u : null
}
const BAD_ADDRESS = 'An addon address must start with https:// or stremio://.'

let catalogCache = null
/** Stremio's Official and Community addon lists, Official first, each addon once. */
async function addonCatalog(ctx) {
  if (catalogCache && Date.now() - catalogCache.at < 60 * 60_000) return catalogCache.list
  const lists = await Promise.all(ADDON_CATALOGS.map((u) => getJson(ctx, u).then((r) => r.addons ?? []).catch((e) => { ctx.log(e.message); return [] })))
  const seen = new Set()
  const list = lists.flat().filter((a) => a?.manifest?.id && a.transportUrl && !seen.has(a.manifest.id) && seen.add(a.manifest.id))
  if (list.length) catalogCache = { at: Date.now(), list }
  return list
}

/** The Addons list: each addon once, removable when it came from the setting or is the account's own. */
async function installedRows(ctx) {
  const { list, from } = await load(ctx)
  const seen = new Set()
  return list.filter((a) => !seen.has(a.manifest.id) && seen.add(a.manifest.id)).map((a) => {
    const f = from.get(a.transportUrl)
    return row(a, f === 'setting' || (f === 'account' && !isProtected(a)))
  })
}

/** Catalog ids carry the addon and catalog, so a fresh sandbox can find them again. */
const catId = (a, c) => `${base(a.transportUrl)}|${c.type}|${c.id}`

// ---------- the plugin ----------

/** @type {import('../flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'dev.flick.stremio',
  name: 'Stremio',
  version: '1.2.0',
  author: 'Flick',
  description: 'Your Stremio addons, library and Continue Watching. Sign in, or start with Cinemeta and OpenSubtitles.',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzdiNWJmNSIvPjxwYXRoIGQ9Ik0xMiA0bDcgNHY4bC03IDQtNy00Vjh6IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS42Ii8+PHBhdGggZD0iTTEwLjUgOXY2bDUtM3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4=',
  // Addons live on any host the user adds. Not this computer: no local streaming server.
  hosts: ['*'],
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

  async streams(ctx, { type, videoId }) {
    const list = (await addons(ctx)).filter((a) => supports(a, 'stream', type, videoId))
    if (!list.length) {
      ctx.log('None of your addons offer streams for this title. Stream addons come from Stremio\'s addon catalog: sign in to use yours, or add one under Extra addon URLs.')
      return []
    }
    const batches = await Promise.all(list.map(async (a) => {
      try {
        const r = await getJson(ctx, `${base(a.transportUrl)}/stream/${type}/${encodeURIComponent(videoId)}.json`)
        const all = r.streams ?? []
        const out = all.map((s) => toStream(s, a.manifest.name)).filter(Boolean)
        if (!out.length && all.some((s) => s.infoHash)) ctx.log(`${a.manifest.name} offers only torrent streams. Flick plays torrents with its own engine and a VPN on, which isn't here yet.`)
        return out
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

  /** The user's addon URLs, so Flick can offer a debrid key set up in one (Torrentio's torbox=...). */
  async addonUrls(ctx) {
    return (await addons(ctx)).map((a) => a.transportUrl).filter((u) => /^https:\/\//i.test(u))
  },

  // ---------- addons (docs/PLUGINS.md, "Addons") ----------

  /** Signed in: the account's addons, then any from the addons setting. Signed out: Cinemeta, OpenSubtitles and the setting. */
  extensions: installedRows,

  async extensionCatalog(ctx, { search } = {}) {
    const mine = await installedRows(ctx)
    const q = String(search ?? '').trim().toLowerCase()
    return (await addonCatalog(ctx))
      .filter((a) => !q || [a.manifest.name, a.manifest.id, a.manifest.description].some((t) => typeof t === 'string' && t.toLowerCase().includes(q)))
      .slice(0, 500)
      .map((a) => {
        // Removable only when Addons would offer Remove for it; a row not added yet has nothing to remove.
        const have = mine.find((m) => m.url === a.transportUrl || m.id === a.manifest.id)
        return { ...row(a, have?.removable ?? false), installed: !!have }
      })
  },

  /** Reads the manifest so the user sees what they are adding. Saves nothing. */
  async inspectExtension(ctx, { url }) {
    const u = addonAddress(url)
    if (!u) throw new Error(BAD_ADDRESS)
    const a = await manifest(ctx, u)
    const mine = await addons(ctx)
    return { ...row(a, true), installed: mine.some((m) => m.transportUrl === u) }
  },

  /** Signed in, into the account (one addonCollectionSet, so Stremio's own apps get it too); signed out, into the addons setting. */
  async addExtension(ctx, { url }) {
    const u = addonAddress(url)
    if (!u) return { ok: false, message: BAD_ADDRESS }
    const a = await manifest(ctx, u)
    const name = a.manifest.name ?? a.manifest.id
    const authKey = await ctx.store.get('authKey')
    if (!authKey) {
      const extra = extraUrls(ctx)
      if (extra.includes(u)) return { ok: true, message: `${name} is already added.` }
      // As signed in: a new configuration of an addon in the setting replaces the old one in place.
      const { list, from } = await load(ctx)
      const old = new Set(list.filter((x) => x.manifest.id === a.manifest.id && from.get(x.transportUrl) === 'setting').map((x) => x.transportUrl))
      if (!old.size) return { ok: true, message: `Added ${name}.`, settings: { addons: [...extra, u] } }
      const next = []
      for (const x of extra) if (!old.has(x)) next.push(x); else if (!next.includes(u)) next.push(u)
      return { ok: true, message: `Added ${name}.`, settings: { addons: next } }
    }
    const old = await collectionToWrite(ctx, authKey)
    if (old.some((x) => x.transportUrl === u)) return { ok: true, message: `${name} is already in your Stremio account.` }
    const same = old.findIndex((x) => x.manifest?.id === a.manifest.id)
    if (same >= 0 && isProtected(old[same])) return { ok: false, message: `${name} is built into Stremio and cannot be replaced.` }
    // Like Stremio's own apps: a second copy of one addon (a new configuration) replaces the first in place.
    const next = [...old]
    const desc = { transportUrl: u, manifest: a.manifest, flags: { official: false, protected: false } }
    if (same >= 0) next[same] = desc
    else next.push(desc)
    await api(ctx, 'addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: next })
    cache = null
    return { ok: true, message: `Added ${name} to your Stremio account.` }
  },

  async removeExtension(ctx, { id }) {
    const { list, from } = await load(ctx)
    const extra = extraUrls(ctx)
    const fromSetting = list.filter((a) => a.manifest.id === id && from.get(a.transportUrl) === 'setting').map((a) => a.transportUrl)
    const out = {}
    const authKey = await ctx.store.get('authKey')
    let name = list.find((a) => a.manifest.id === id)?.manifest.name ?? id
    if (authKey) {
      const old = await collectionToWrite(ctx, authKey)
      const hit = old.filter((x) => x.manifest?.id === id)
      if (hit.some(isProtected)) return { ok: false, message: `${hit[0].manifest.name ?? id} is built into Stremio and cannot be removed.` }
      if (hit.length) {
        name = hit[0].manifest.name ?? name
        await api(ctx, 'addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: old.filter((x) => x.manifest?.id !== id) })
        out.account = true
      }
    }
    if (fromSetting.length) out.settings = { addons: extra.filter((u) => !fromSetting.includes(u)) }
    if (!out.account && !out.settings) return { ok: false, message: `${name} is not one you can remove here.` }
    cache = null
    return { ok: true, message: `Removed ${name}.`, ...(out.settings ? { settings: out.settings } : {}) }
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
