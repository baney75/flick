// Stremio: account sign-in, the user's installed addons, their library, and the addon protocol.
// Protocol reference: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

const API = 'https://api.strem.io/api'
export const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json'
export const OPENSUBS = 'https://opensubtitles-v3.strem.io/manifest.json'
export const LOCAL_SERVER = 'http://127.0.0.1:11470'

export interface ManifestResource { name: string; types?: string[]; idPrefixes?: string[] }
export interface CatalogDef { type: string; id: string; name?: string; extra?: { name: string; isRequired?: boolean; options?: string[] }[]; extraSupported?: string[] }
export interface Manifest {
  id: string
  name: string
  version: string
  description?: string
  logo?: string
  types: string[]
  idPrefixes?: string[]
  resources: (string | ManifestResource)[]
  catalogs: CatalogDef[]
}
export interface Addon { transportUrl: string; manifest: Manifest }

export interface MetaPreview { id: string; type: string; name: string; poster?: string; posterShape?: string; releaseInfo?: string; imdbRating?: string; description?: string }
export interface Video { id: string; title?: string; name?: string; season?: number; episode?: number; released?: string; thumbnail?: string; overview?: string }
export interface Meta extends MetaPreview { background?: string; logo?: string; genres?: string[]; runtime?: string; cast?: string[]; director?: string[]; videos?: Video[]; year?: string }
export interface Stream {
  url?: string
  ytId?: string
  infoHash?: string
  fileIdx?: number
  externalUrl?: string
  name?: string
  title?: string
  description?: string
  behaviorHints?: { notWebReady?: boolean; bingeGroup?: string; filename?: string; videoSize?: number; proxyHeaders?: unknown }
  subtitles?: Sub[]
}
export interface Sub { id?: string; url: string; lang: string }
export interface LibraryItem {
  _id: string
  name: string
  type: string
  poster?: string
  removed?: boolean
  temp?: boolean
  _mtime?: string
  state?: { timeOffset?: number; duration?: number; video_id?: string; lastWatched?: string; timesWatched?: number }
}

async function api<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Stremio refused the request')
  return j.result as T
}

export async function login(email: string, password: string): Promise<{ authKey: string; email: string }> {
  const r = await api<{ authKey: string; user: { email: string } }>('login', { type: 'Login', email, password, facebook: false })
  return { authKey: r.authKey, email: r.user?.email ?? email }
}

export async function logout(authKey: string) {
  await api('logout', { type: 'Logout', authKey }).catch(() => {})
}

export async function accountAddons(authKey: string | null): Promise<Addon[]> {
  const r = await api<{ addons: Addon[] }>('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })
  return r.addons
}

export async function accountLibrary(authKey: string): Promise<LibraryItem[]> {
  const r = await api<LibraryItem[]>('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true })
  return r.filter((i) => !i.removed && !i.temp)
}

/** Items with a saved position, newest first: Stremio's own "Continue Watching". */
export function continueWatching(lib: LibraryItem[]): LibraryItem[] {
  return lib
    .filter((i) => (i.state?.timeOffset ?? 0) > 0)
    .sort((a, b) => Date.parse(b.state?.lastWatched ?? b._mtime ?? '0') - Date.parse(a.state?.lastWatched ?? a._mtime ?? '0'))
}

export function base(transportUrl: string): string {
  return transportUrl.replace(/\/manifest\.json(\?.*)?$/, '').replace(/\/$/, '')
}

export function normalizeAddonUrl(input: string): string {
  let u = input.trim()
  if (u.startsWith('stremio://')) u = 'https://' + u.slice('stremio://'.length)
  if (!/\/manifest\.json(\?.*)?$/.test(u)) u = u.replace(/\/$/, '') + '/manifest.json'
  return u
}

export async function fetchManifest(transportUrl: string): Promise<Addon> {
  const r = await fetch(transportUrl)
  if (!r.ok) throw new Error(`Addon returned ${r.status}`)
  const manifest = (await r.json()) as Manifest
  if (!manifest.id || !manifest.resources) throw new Error('That URL is not a Stremio addon manifest')
  return { transportUrl, manifest }
}

function resource(m: Manifest, name: string): ManifestResource | null {
  for (const r of m.resources) {
    if (typeof r === 'string' && r === name) return { name, types: m.types, idPrefixes: m.idPrefixes }
    if (typeof r === 'object' && r.name === name) return { name, types: r.types ?? m.types, idPrefixes: r.idPrefixes ?? m.idPrefixes }
  }
  return null
}

export function supports(a: Addon, res: string, type: string, id: string): boolean {
  const r = resource(a.manifest, res)
  if (!r) return false
  if (r.types && !r.types.includes(type)) return false
  if (r.idPrefixes && r.idPrefixes.length && !r.idPrefixes.some((p) => id.startsWith(p))) return false
  return true
}

const cache = new Map<string, Promise<unknown>>()
async function getJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<T>
    })
    cache.set(url, p)
    p.catch(() => cache.delete(url))
  }
  return p
}

export function catalogUrl(a: Addon, c: CatalogDef, extra?: Record<string, string>): string {
  const ex = extra && Object.keys(extra).length
    ? '/' + Object.entries(extra).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : ''
  return `${base(a.transportUrl)}/catalog/${c.type}/${encodeURIComponent(c.id)}${ex}.json`
}

/** Catalogs that can show without a required extra (search-only catalogs are skipped). */
export function browsable(a: Addon): CatalogDef[] {
  return (a.manifest.catalogs ?? []).filter((c) => !(c.extra ?? []).some((e) => e.isRequired && e.name !== 'skip'))
}

export function searchable(a: Addon): CatalogDef[] {
  return (a.manifest.catalogs ?? []).filter((c) => (c.extra ?? []).some((e) => e.name === 'search') || (c.extraSupported ?? []).includes('search'))
}

export async function catalog(a: Addon, c: CatalogDef, extra?: Record<string, string>): Promise<MetaPreview[]> {
  const r = await getJson<{ metas: MetaPreview[] }>(catalogUrl(a, c, extra))
  return r.metas ?? []
}

export async function meta(addons: Addon[], type: string, id: string): Promise<Meta | null> {
  for (const a of addons.filter((x) => supports(x, 'meta', type, id))) {
    try {
      const r = await getJson<{ meta: Meta }>(`${base(a.transportUrl)}/meta/${type}/${encodeURIComponent(id)}.json`)
      if (r.meta) return r.meta
    } catch { /* try the next addon */ }
  }
  return null
}

export interface SourcedStream extends Stream { addon: string }

/** Ask every addon that can answer, and hand back results as each one arrives. */
export function streams(addons: Addon[], type: string, videoId: string, onBatch: (s: SourcedStream[]) => void): Promise<void> {
  const jobs = addons
    .filter((a) => supports(a, 'stream', type, videoId))
    .map(async (a) => {
      try {
        const r = await getJson<{ streams: Stream[] }>(`${base(a.transportUrl)}/stream/${type}/${encodeURIComponent(videoId)}.json`)
        onBatch((r.streams ?? []).map((s) => ({ ...s, addon: a.manifest.name })))
      } catch { /* an addon being down should not block the rest */ }
    })
  return Promise.all(jobs).then(() => {})
}

export async function subtitles(addons: Addon[], type: string, videoId: string): Promise<Sub[]> {
  const out: Sub[] = []
  await Promise.all(addons.filter((a) => supports(a, 'subtitles', type, videoId)).map(async (a) => {
    try {
      const r = await getJson<{ subtitles: Sub[] }>(`${base(a.transportUrl)}/subtitles/${type}/${encodeURIComponent(videoId)}.json`)
      out.push(...(r.subtitles ?? []))
    } catch { /* optional */ }
  }))
  return out
}

let serverUp: boolean | null = null
export async function localServerUp(): Promise<boolean> {
  if (serverUp !== null) return serverUp
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1200)
    const r = await fetch(`${LOCAL_SERVER}/settings`, { signal: ctl.signal })
    clearTimeout(t)
    serverUp = r.ok
  } catch {
    serverUp = false
  }
  setTimeout(() => (serverUp = null), 15000)
  return serverUp
}

export type Playable =
  | { kind: 'play'; url: string }
  | { kind: 'external'; url: string; why: string }

/** Decide how to play a stream: directly, through the local Stremio server, or by handing off. */
export async function playable(s: Stream, type: string, id: string): Promise<Playable> {
  if (s.url) return { kind: 'play', url: s.url }
  if (s.infoHash) {
    if (await localServerUp()) {
      const idx = s.fileIdx ?? -1
      return { kind: 'play', url: `${LOCAL_SERVER}/${s.infoHash}/${idx}` }
    }
    return { kind: 'external', url: `stremio:///detail/${type}/${id}`, why: 'Torrent streams need the Stremio app or its streaming server running on this computer.' }
  }
  if (s.ytId) return { kind: 'external', url: `https://www.youtube.com/watch?v=${s.ytId}`, why: 'Opens on YouTube.' }
  if (s.externalUrl) return { kind: 'external', url: s.externalUrl, why: 'This addon links out to another site.' }
  return { kind: 'external', url: `stremio:///detail/${type}/${id}`, why: 'Open in Stremio.' }
}

export function streamLabel(s: Stream): { name: string; detail: string } {
  const name = (s.name ?? '').replace(/\n/g, ' ').trim()
  const detail = (s.title ?? s.description ?? s.behaviorHints?.filename ?? '').trim()
  return { name, detail }
}
