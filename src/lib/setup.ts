// Setup links: one payload that adds addons, servers, folders and settings after the user taps Connect.
// Link form: https://flick-player.pages.dev/#/setup?c=<base64url(JSON)>

import { settings, setSettings, stremioExtra, saveStremio, loadStremio, reloadItems, type Settings } from './store'
import { CINEMETA, OPENSUBS, fetchManifest, normalizeAddonUrl } from './stremio'
import { getServers, saveServer, syncServer, plexManual, flickConnect, type Server } from './servers'
import { isDesktop } from './platform'
import { addFolderPath } from './actions'
import { installed, prepare, install, absolute, type Candidate } from './plugins/registry'

export const SETUP_BASE = 'https://flick-player.pages.dev/#/setup?c='
const MAX_ADDONS = 50
const MAX_SERVERS = 20
const MAX_FOLDERS = 50
const MAX_PLUGINS = 20

export interface SetupServer { type: 'jellyfin' | 'plex' | 'flick'; name?: string; url: string; token: string; userId?: string }
export interface Setup { v: 1; stremioAddons?: string[]; plugins?: string[]; servers?: SetupServer[]; folders?: string[]; settings?: Partial<Settings> }
export interface SetupResult { label: string; ok: boolean; detail?: string }

function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function encodeSetup(obj: Setup): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)))
}

export function decodeSetup(str: string): Setup {
  let json: string
  try {
    const b64 = str.trim().replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    json = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    throw new Error('This setup link is damaged: it is not valid base64url.')
  }
  let obj: unknown
  try { obj = JSON.parse(json) } catch { throw new Error('This setup link is damaged: it is not valid JSON.') }
  return validateSetup(obj)
}

function isHttp(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === 'http:' || p === 'https:'
  } catch { return false }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined)

function strList(x: unknown, what: string, max: number): string[] | undefined {
  if (x === undefined) return undefined
  if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new Error(`${what} must be a list of strings.`)
  if (x.length > max) throw new Error(`A setup can hold at most ${max} ${what.toLowerCase()}.`)
  return x as string[]
}

/** Check a parsed payload and keep only the fields Flick knows. Throws a plain-words error. */
export function validateSetup(obj: unknown): Setup {
  if (!isObj(obj)) throw new Error('A setup must be a JSON object.')
  if (obj.v !== 1) throw new Error(`This setup uses version ${String(obj.v)}; this Flick reads version 1. Update Flick.`)
  const out: Setup = { v: 1 }

  const addons = strList(obj.stremioAddons, 'Stremio addons', MAX_ADDONS)
  if (addons) {
    out.stremioAddons = addons.map((a) => {
      const u = normalizeAddonUrl(a)
      if (!isHttp(u)) throw new Error(`Addon address must start with http or https: ${a}`)
      return u
    })
  }

  const plugins = strList(obj.plugins, 'Plugins', MAX_PLUGINS)
  if (plugins) {
    out.plugins = plugins.map((u) => {
      const url = u.trim()
      if (!/^https:\/\//i.test(url) && !/^\/plugins\/[\w.-]+$/.test(url)) throw new Error(`Plugin address must start with https: ${u}`)
      return url
    })
  }

  if (obj.servers !== undefined) {
    if (!Array.isArray(obj.servers)) throw new Error('Servers must be a list.')
    if (obj.servers.length > MAX_SERVERS) throw new Error(`A setup can hold at most ${MAX_SERVERS} servers.`)
    out.servers = obj.servers.map((s: unknown) => {
      if (!isObj(s)) throw new Error('Each server must be an object.')
      if ('password' in s || 'pw' in s) throw new Error('Setups never carry passwords. Use a server token instead.')
      if (s.type !== 'jellyfin' && s.type !== 'plex' && s.type !== 'flick') throw new Error('Server type must be "jellyfin", "plex" or "flick".')
      const url = str(s.url)?.replace(/\/+$/, '')
      if (!url || !isHttp(url)) throw new Error(`Server address must start with http or https: ${String(s.url)}`)
      const token = str(s.token)
      if (!token) throw new Error(`The server at ${url} needs a token.`)
      if (s.type === 'flick' && !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error(`The Flick server at ${url} has a damaged access code.`)
      const userId = str(s.userId)
      if (s.type === 'jellyfin' && !userId) throw new Error(`The Jellyfin server at ${url} needs a userId.`)
      const srv: SetupServer = { type: s.type, url, token }
      if (str(s.name)) srv.name = str(s.name)
      if (userId) srv.userId = userId
      return srv
    })
  }

  const folders = strList(obj.folders, 'Folders', MAX_FOLDERS)
  if (folders) out.folders = folders.map((f) => f.trim()).filter(Boolean)

  if (obj.settings !== undefined) {
    if (!isObj(obj.settings)) throw new Error('Settings must be an object.')
    const s = obj.settings
    const st: Partial<Settings> = {}
    const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && x >= lo && x <= hi
    if (typeof s.autoplayNext === 'boolean') st.autoplayNext = s.autoplayNext
    if (num(s.speed, 0.25, 4)) st.speed = s.speed as number
    if (num(s.volume, 0, 1)) st.volume = s.volume as number
    if (num(s.skipSeconds, 1, 120)) st.skipSeconds = s.skipSeconds as number
    if (s.theme === 'system' || s.theme === 'dark' || s.theme === 'light') st.theme = s.theme
    if (Object.keys(st).length) out.settings = st
  }
  return out
}

/** Plain words for the settings in a setup, for the review screen. */
export function describeSettings(s: Partial<Settings>): string {
  const parts: string[] = []
  if (s.autoplayNext !== undefined) parts.push(`next episode plays on its own: ${s.autoplayNext ? 'on' : 'off'}`)
  if (s.speed !== undefined) parts.push(`speed ${s.speed}x`)
  if (s.volume !== undefined) parts.push(`volume ${Math.round(s.volume * 100)}%`)
  if (s.skipSeconds !== undefined) parts.push(`skip ${s.skipSeconds} seconds`)
  if (s.theme !== undefined) parts.push(`theme ${s.theme}`)
  return parts.join(', ')
}

async function toServer(s: SetupServer): Promise<Server> {
  if (s.type === 'plex') return { ...(await plexManual(s.url, s.token)), name: s.name ?? 'Plex' }
  if (s.type === 'flick') return flickConnect(s.url, s.token)
  const info = await fetch(`${s.url}/System/Info/Public`).then((r) => r.json()).catch(() => null)
  if (!info?.Id) throw new Error('No Jellyfin or Emby server answered at that address.')
  return { id: `jf-${info.Id}`, type: 'jellyfin', name: s.name ?? info.ServerName ?? 'Jellyfin', url: s.url, token: s.token, userId: s.userId }
}

/** Apply a validated setup. Each item succeeds or fails on its own. Plugins read for the review are reused. */
export async function applySetup(p: Setup, reviewed: Record<string, Candidate> = {}): Promise<SetupResult[]> {
  const out: SetupResult[] = []
  for (const u of p.plugins ?? []) {
    try {
      const rec = await install(reviewed[u] ?? (await prepare({ url: u })))
      out.push({ label: `Plugin: ${rec.manifest.name} ${rec.manifest.version}`, ok: true })
    } catch (e) {
      out.push({ label: `Plugin at ${u}`, ok: false, detail: (e as Error).message })
    }
  }
  if (p.stremioAddons?.length) {
    const added: string[] = []
    for (const u of p.stremioAddons) {
      try {
        const a = await fetchManifest(u)
        added.push(u)
        out.push({ label: `Stremio addon: ${a.manifest.name}`, ok: true })
      } catch (e) {
        out.push({ label: `Stremio addon at ${u}`, ok: false, detail: (e as Error).message })
      }
    }
    const extra = await stremioExtra()
    const next = [...extra, ...added.filter((u) => !extra.includes(u))]
    if (next.length !== extra.length) await saveStremio({ extra: next })
    await loadStremio()
  }
  for (const s of p.servers ?? []) {
    const label = `${s.type === 'plex' ? 'Plex' : s.type === 'flick' ? 'Flick' : 'Jellyfin'} server at ${s.url}`
    try {
      const srv = await toServer(s)
      await saveServer(srv)
      const n = await syncServer(srv)
      out.push({ label, ok: true, detail: `${n} items` })
    } catch (e) {
      out.push({ label, ok: false, detail: (e as Error).message })
    }
  }
  for (const f of p.folders ?? []) {
    const label = `Folder ${f}`
    if (!isDesktop) { out.push({ label, ok: false, detail: 'Folders by path need the desktop app.' }); continue }
    try {
      const n = await addFolderPath(f)
      out.push({ label, ok: true, detail: `${n} files` })
    } catch (e) {
      out.push({ label, ok: false, detail: (e as Error).message })
    }
  }
  if (p.settings) {
    setSettings(p.settings)
    out.push({ label: `Settings: ${describeSettings(p.settings)}`, ok: true })
  }
  await reloadItems()
  return out
}

/** A setup from this device: added addons, servers and settings. Folders stay local. */
export async function currentSetup(addonUrls: string[]): Promise<Setup> {
  const defaults = [CINEMETA, OPENSUBS]
  const extra = await stremioExtra()
  const urls = [...new Set([...addonUrls, ...extra])].filter((u) => !defaults.includes(u) && isHttp(u)).slice(0, MAX_ADDONS)
  // Setup files do not carry Kodi yet.
  const servers = (await getServers()).filter((s): s is Server & { type: SetupServer['type'] } => s.type !== 'kodi').slice(0, MAX_SERVERS).map(({ type, name, url, token, userId }) => (userId ? { type, name, url, token, userId } : { type, name, url, token }))
  const out: Setup = { v: 1, settings: { ...settings.value } }
  if (urls.length) out.stremioAddons = urls
  const plugins = installed.value.filter((x) => x.url).map((x) => absolute(x.url!)).slice(0, MAX_PLUGINS)
  if (plugins.length) out.plugins = plugins
  if (servers.length) out.servers = servers
  return out
}
