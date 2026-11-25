// Media servers: Jellyfin (and Emby, same API) and Plex. Items come back as library Items.

import type { Item } from './library'
import { hash } from './library'
import * as db from './db'

export interface Server {
  id: string
  type: 'jellyfin' | 'plex'
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

export async function syncServer(s: Server): Promise<number> {
  const items = s.type === 'jellyfin' ? await jellyfinItems(s) : await plexItems(s)
  const existing = await db.all<Item>('items')
  const keep = new Set(items.map((i) => i.id))
  await db.delMany('items', existing.filter((i) => i.server === s.id && !keep.has(i.id)).map((i) => i.id))
  await db.putMany('items', items.map((i) => [i.id, i]))
  return items.length
}
