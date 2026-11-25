// Media servers: Jellyfin (and Emby, same API), Plex and Kodi. Items come back as library Items.

import type { Item, Source } from './library'
import { hash, prepared, thumbUrl, KODI_IMG } from './library'
import * as db from './db'
import { invoke, fileUrl } from './platform'

export interface Server {
  id: string
  type: 'jellyfin' | 'plex' | 'kodi'
  name: string
  url: string
  token: string
  userId?: string
}

const VERSION = '0.1.0'

export function deviceId(): string {
  let id = localStorage.getItem('flick.device')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('flick.device', id)
  }
  return id
}

export async function getServers(): Promise<Server[]> {
  return (await db.get<Server[]>('kv', 'servers')) ?? []
}

export async function saveServer(s: Server) {
  const list = (await getServers()).filter((x) => x.id !== s.id)
  list.push(s)
  await db.put('kv', 'servers', list)
}

export async function removeServer(s: Server) {
  await db.put('kv', 'servers', (await getServers()).filter((x) => x.id !== s.id))
  const items = await db.all<Item>('items')
  await db.delMany('items', items.filter((i) => i.server === s.id).map((i) => i.id))
}

function cleanUrl(u: string) {
  u = u.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(u)) u = 'http://' + u
  return u
}

// ---------------- Jellyfin ----------------

function jfAuth(token?: string) {
  const t = token ? `, Token="${token}"` : ''
  return `MediaBrowser Client="Flick", Device="${navigator.platform || 'Web'}", DeviceId="${deviceId()}", Version="${VERSION}"${t}`
}

export async function jellyfinLogin(url: string, username: string, password: string): Promise<Server> {
  url = cleanUrl(url)
  const info = await fetch(`${url}/System/Info/Public`).then((r) => r.json()).catch(() => null)
  if (!info) throw new Error('No Jellyfin or Emby server answered at that address.')
  const r = await fetch(`${url}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: jfAuth(), 'X-Emby-Authorization': jfAuth() },
    body: JSON.stringify({ Username: username, Pw: password }),
  })
  if (r.status === 401) throw new Error('Wrong username or password.')
  if (!r.ok) throw new Error(`Server said ${r.status}`)
  const j = await r.json()
  return { id: `jf-${info.Id}`, type: 'jellyfin', name: info.ServerName || 'Jellyfin', url, token: j.AccessToken, userId: j.User.Id }
}

interface JfItem {
  Id: string; Name: string; Type: string; ProductionYear?: number; RunTimeTicks?: number
  SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number; DateCreated?: string
  ImageTags?: { Primary?: string }; SeriesId?: string; SeriesPrimaryImageTag?: string; MediaType?: string; Album?: string
}

export async function jellyfinItems(s: Server): Promise<Item[]> {
  const q = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Episode,Audio,MusicVideo,Video',
    Fields: 'DateCreated,ParentId',
    EnableImageTypes: 'Primary',
    ImageTypeLimit: '1',
    Limit: '20000',
  })
  const r = await fetch(`${s.url}/Users/${s.userId}/Items?${q}`, { headers: { Authorization: jfAuth(s.token), 'X-Emby-Authorization': jfAuth(s.token) } })
  if (!r.ok) throw new Error(`${s.name} said ${r.status}`)
  const j = (await r.json()) as { Items: JfItem[] }
  return j.Items.map((x) => {
    const audio = x.Type === 'Audio' || x.MediaType === 'Audio'
    const img = x.ImageTags?.Primary
      ? `${s.url}/Items/${x.Id}/Images/Primary?maxHeight=480&quality=85&tag=${x.ImageTags.Primary}`
      : x.SeriesId && x.SeriesPrimaryImageTag ? `${s.url}/Items/${x.SeriesId}/Images/Primary?maxHeight=480&quality=85` : undefined
    const direct = `${s.url}/${audio ? 'Audio' : 'Videos'}/${x.Id}/stream?static=true&api_key=${s.token}`
    const hls = audio
      ? `${s.url}/Audio/${x.Id}/universal?api_key=${s.token}&Container=mp3,aac,m4a,flac,webma,webm,wav,ogg&TranscodingContainer=mp3&AudioCodec=mp3`
      : `${s.url}/Videos/${x.Id}/master.m3u8?api_key=${s.token}&MediaSourceId=${x.Id}&VideoCodec=h264&AudioCodec=aac&MaxStreamingBitrate=40000000&TranscodingMaxAudioChannels=2`
    const it: Item = {
      id: hash(`${s.id}:${x.Id}`),
      title: x.Name,
      kind: audio ? 'audio' : 'video',
      src: { t: 'url', url: direct, fallback: hls },
      origin: 'jellyfin',
      server: s.id,
      folder: s.name,
      size: 0,
      mtime: x.DateCreated ? Date.parse(x.DateCreated) : 0,
      addedAt: x.DateCreated ? Date.parse(x.DateCreated) : Date.now(),
      duration: x.RunTimeTicks ? x.RunTimeTicks / 1e7 : undefined,
      year: x.ProductionYear,
      poster: img,
    }
    if (x.Type === 'Episode') {
      it.show = x.SeriesName
      it.season = x.ParentIndexNumber
      it.episode = x.IndexNumber
    }
    return it
  })
}

// ---------------- Plex ----------------

const PLEX_HEADERS = () => ({
  Accept: 'application/json',
  'X-Plex-Product': 'Flick',
  'X-Plex-Version': VERSION,
  'X-Plex-Client-Identifier': deviceId(),
  'X-Plex-Platform': 'Web',
})

/** Plex sign-in with a PIN: opens plex.tv, then waits for the user to approve. */
export async function plexPinLogin(onLink: (url: string) => void, signal?: AbortSignal): Promise<string> {
  const pin = await fetch('https://plex.tv/api/v2/pins?strong=true', { method: 'POST', headers: PLEX_HEADERS() }).then((r) => r.json())
  const params = new URLSearchParams({ clientID: deviceId(), code: pin.code, 'context[device][product]': 'Flick' })
  onLink(`https://app.plex.tv/auth#?${params}`)
  for (let i = 0; i < 300; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    await new Promise((r) => setTimeout(r, 2000))
    const p = await fetch(`https://plex.tv/api/v2/pins/${pin.id}`, { headers: PLEX_HEADERS() }).then((r) => r.json())
    if (p.authToken) return p.authToken
  }
  throw new Error('Plex sign-in timed out.')
}

interface PlexResource { name: string; clientIdentifier: string; provides: string; accessToken?: string; connections: { uri: string; local: boolean; relay: boolean }[] }

export async function plexServers(token: string): Promise<Server[]> {
  const r = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', { headers: { ...PLEX_HEADERS(), 'X-Plex-Token': token } })
  if (!r.ok) throw new Error(`plex.tv said ${r.status}`)
  const list = (await r.json()) as PlexResource[]
  const out: Server[] = []
  for (const res of list.filter((x) => x.provides.includes('server'))) {
    const tok = res.accessToken || token
    // Prefer a secure direct connection, then any direct, then the relay.
    const conns = [...res.connections].sort((a, b) => Number(a.relay) - Number(b.relay) || Number(b.uri.startsWith('https')) - Number(a.uri.startsWith('https')))
    for (const c of conns) {
      try {
        const ok = await fetch(`${c.uri}/identity`, { headers: { ...PLEX_HEADERS(), 'X-Plex-Token': tok }, signal: AbortSignal.timeout(2500) })
        if (ok.ok) { out.push({ id: `plex-${res.clientIdentifier}`, type: 'plex', name: res.name, url: c.uri, token: tok }); break }
      } catch { /* next connection */ }
    }
  }
  return out
}

export async function plexManual(url: string, token: string): Promise<Server> {
  url = cleanUrl(url)
  const r = await fetch(`${url}/identity`, { headers: { ...PLEX_HEADERS(), 'X-Plex-Token': token } })
  if (!r.ok) throw new Error(`No Plex server answered (${r.status}).`)
  const j = await r.json()
  return { id: `plex-${j.MediaContainer.machineIdentifier}`, type: 'plex', name: 'Plex', url, token }
}

interface PlexMeta {
  ratingKey: string; title: string; type: string; year?: number; duration?: number; thumb?: string; grandparentThumb?: string
  grandparentTitle?: string; parentIndex?: number; index?: number; addedAt?: number; Media?: { Part: { key: string; size?: number }[] }[]
}

export async function plexItems(s: Server): Promise<Item[]> {
  const h = { ...PLEX_HEADERS(), 'X-Plex-Token': s.token }
  const secs = await fetch(`${s.url}/library/sections`, { headers: h }).then((r) => r.json())
  const out: Item[] = []
  for (const sec of secs.MediaContainer.Directory ?? []) {
    const type = sec.type === 'show' ? '&type=4' : sec.type === 'artist' ? '&type=10' : ''
    const r = await fetch(`${s.url}/library/sections/${sec.key}/all?${type.slice(1)}`, { headers: h }).then((x) => x.json())
    for (const m of (r.MediaContainer.Metadata ?? []) as PlexMeta[]) {
      const part = m.Media?.[0]?.Part?.[0]
      if (!part) continue
      const audio = m.type === 'track'
      const thumb = m.thumb || m.grandparentThumb
      const it: Item = {
        id: hash(`${s.id}:${m.ratingKey}`),
        title: m.title,
        kind: audio ? 'audio' : 'video',
        src: {
          t: 'url',
          url: `${s.url}${part.key}?X-Plex-Token=${s.token}`,
          fallback: audio ? undefined : `${s.url}/video/:/transcode/universal/start.m3u8?path=${encodeURIComponent('/library/metadata/' + m.ratingKey)}&protocol=hls&directPlay=0&directStream=1&X-Plex-Token=${s.token}&X-Plex-Client-Identifier=${deviceId()}&X-Plex-Product=Flick`,
        },
        origin: 'plex',
        server: s.id,
        folder: s.name,
        size: part.size ?? 0,
        mtime: (m.addedAt ?? 0) * 1000,
        addedAt: (m.addedAt ?? Date.now() / 1000) * 1000,
        duration: m.duration ? m.duration / 1000 : undefined,
        year: m.year,
        poster: thumb ? `${s.url}/photo/:/transcode?width=320&height=480&minSize=1&url=${encodeURIComponent(thumb)}&X-Plex-Token=${s.token}` : undefined,
      }
      if (m.type === 'episode') {
        it.show = m.grandparentTitle
        it.season = m.parentIndex
        it.episode = m.index
      }
      out.push(it)
    }
  }
  return out
}

// ---------------- Kodi ----------------
// Kodi's web server sends no CORS headers, so JSON-RPC goes through the desktop shell (kodi_rpc).
// <video> and <img> cannot send Basic auth headers, and Chromium blocks a login inside subresource URLs,
// so media URLs never carry it. The shell sends it instead: prepare (ffmpeg) for media, kodi_image for art.

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)))
const unb64 = (t: string) => new TextDecoder().decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0)))

function kodiLogin(s: Server): [string, string] {
  if (!s.token) return ['', '']
  const t = unb64(s.token)
  const i = t.indexOf(':')
  return [t.slice(0, i), t.slice(i + 1)]
}

function kodiRpc<T>(url: string, user: string, pass: string, method: string, params: object = {}): Promise<T> {
  // The shell rejects with a plain string; callers expect an Error.
  return invoke<T>('kodi_rpc', { url, user, pass, method, params }).catch((e) => { throw new Error(String(e)) })
}

export async function kodiConnect(url: string, user: string, pass: string): Promise<Server> {
  url = cleanUrl(url)
  await kodiRpc(url, user, pass, 'JSONRPC.Ping')
  const labels = await kodiRpc<Record<string, string>>(url, user, pass, 'XBMC.GetInfoLabels', { labels: ['System.FriendlyName'] }).catch(() => null)
  const name = labels?.['System.FriendlyName'] || 'Kodi'
  return { id: `kodi-${hash(url)}`, type: 'kodi', name, url, token: user ? b64(`${user}:${pass}`) : '' }
}

type KodiArt = Record<string, string | undefined>
export interface KodiMovie { movieid: number; title: string; year?: number; runtime?: number; file: string; art?: KodiArt; dateadded?: string }
export interface KodiEpisode { episodeid: number; title: string; showtitle?: string; season?: number; episode?: number; runtime?: number; file: string; art?: KodiArt; dateadded?: string }
export interface KodiSong { songid: number; title: string; artist?: string[]; album?: string; duration?: number; file: string; thumbnail?: string }
export interface KodiLibrary { movies?: KodiMovie[]; episodes?: KodiEpisode[]; songs?: KodiSong[] }

/** Maps Kodi JSON-RPC results to library Items. Pure, so tests run without a Kodi box. */
export function kodiMap(s: Server, lib: KodiLibrary): Item[] {
  const base = s.url
  // With a password, the poster is a marker that Card resolves through kodi_image.
  const art = (a?: string) => (a ? `${s.token ? KODI_IMG : `${base}/image/`}${encodeURIComponent(a)}` : undefined)
  const when = (d?: string) => {
    const t = d ? Date.parse(d.replace(' ', 'T')) : NaN
    return Number.isNaN(t) ? 0 : t
  }
  const make = (type: string, id: number, title: string, file: string, kind: Item['kind'], duration?: number, added?: string, poster?: string): Item => ({
    id: hash(`${s.id}:${type}:${id}`),
    title,
    kind,
    src: { t: 'kodi', server: s.id, url: `${base}/vfs/${encodeURIComponent(file)}` },
    origin: 'kodi',
    server: s.id,
    folder: s.name,
    size: 0,
    mtime: when(added),
    addedAt: when(added) || Date.now(),
    duration: duration || undefined,
    poster: art(poster),
  })
  const out: Item[] = []
  for (const m of lib.movies ?? []) {
    if (!m.file) continue
    const it = make('movie', m.movieid, m.title, m.file, 'video', m.runtime, m.dateadded, m.art?.poster || m.art?.thumb)
    if (m.year) it.year = m.year
    out.push(it)
  }
  for (const e of lib.episodes ?? []) {
    if (!e.file) continue
    const a = e.art
    const it = make('episode', e.episodeid, e.title, e.file, 'video', e.runtime, e.dateadded, a?.['tvshow.poster'] || a?.['season.poster'] || a?.thumb)
    it.show = e.showtitle
    it.season = e.season
    it.episode = e.episode
    out.push(it)
  }
  for (const t of lib.songs ?? []) {
    if (!t.file) continue
    out.push(make('song', t.songid, t.title, t.file, 'audio', t.duration, undefined, t.thumbnail))
  }
  return out
}

export async function kodiItems(s: Server): Promise<Item[]> {
  const [user, pass] = kodiLogin(s)
  const call = <T>(method: string, properties: string[]) => kodiRpc<T>(s.url, user, pass, method, { properties })
  const [m, e, t] = await Promise.all([
    call<KodiLibrary>('VideoLibrary.GetMovies', ['title', 'year', 'runtime', 'file', 'art', 'dateadded']),
    call<KodiLibrary>('VideoLibrary.GetEpisodes', ['title', 'showtitle', 'season', 'episode', 'runtime', 'file', 'art', 'dateadded']),
    call<KodiLibrary>('AudioLibrary.GetSongs', ['title', 'artist', 'album', 'duration', 'file', 'thumbnail']),
  ])
  return kodiMap(s, { movies: m.movies, episodes: e.episodes, songs: t.songs })
}

const kodiServer = async (id?: string) => (await getServers()).find((x) => x.id === id)

// What the web view plays without a remux.
const NATIVE = /\.(mp4|m4v|mov|webm|mp3|m4a|aac|flac|wav|ogg|opus)$/i

/** A playable URL for a Kodi file: the plain URL when it can, else a local MP4 from prepare. */
export async function kodiResolve(src: Extract<Source, { t: 'kodi' }>, onStatus?: (s: string) => void): Promise<string> {
  const s = await kodiServer(src.server)
  if (!s?.token && NATIVE.test(decodeURIComponent(src.url))) return src.url
  const ff = await invoke<{ ffmpeg: string | null }>('ffmpeg_status').catch(() => ({ ffmpeg: null }))
  if (!ff.ffmpeg) throw new Error(kodiNeedsFfmpeg(!!s?.token))
  const [user, pass] = s ? kodiLogin(s) : ['', '']
  return fileUrl(await prepared(src.url, onStatus, user, pass))
}

/** Why a Kodi file cannot play on a computer without ffmpeg, in words the person can act on. */
export function kodiNeedsFfmpeg(hasPassword: boolean): string {
  return hasPassword
    ? 'This Kodi has a password, so Flick plays its files through ffmpeg. Install ffmpeg (brew install ffmpeg on a Mac), or turn off the Kodi web server password.'
    : 'This file needs a quick convert, which uses ffmpeg. Install ffmpeg (brew install ffmpeg on a Mac) to play MKV and AVI files from Kodi.'
}

/** Fetches a password-protected Kodi poster once, then serves it from the thumbs store. */
export async function kodiPoster(it: Item): Promise<string | null> {
  const hit = await thumbUrl(it.id)
  if (hit || !it.poster?.startsWith(KODI_IMG)) return hit
  const s = await kodiServer(it.server)
  if (!s) return null
  const [user, pass] = kodiLogin(s)
  const data = await invoke<string>('kodi_image', { url: `${s.url}/image/${it.poster.slice(KODI_IMG.length)}`, user, pass }).catch(() => null)
  if (!data) return null
  const [head, body] = data.split(',', 2)
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  await db.put('thumbs', it.id, new Blob([bytes], { type: head.slice(5, head.indexOf(';')) }))
  return thumbUrl(it.id)
}

export async function syncServer(s: Server): Promise<number> {
  const items = s.type === 'jellyfin' ? await jellyfinItems(s) : s.type === 'kodi' ? await kodiItems(s) : await plexItems(s)
  const existing = await db.all<Item>('items')
  const keep = new Set(items.map((i) => i.id))
  await db.delMany('items', existing.filter((i) => i.server === s.id && !keep.has(i.id)).map((i) => i.id))
  await db.putMany('items', items.map((i) => [i.id, i]))
  return items.length
}
