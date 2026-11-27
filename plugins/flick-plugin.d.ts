// Types for Flick plugins, API version 1. The contract in words: docs/PLUGINS.md.
// In a plugin: /** @type {import('./flick-plugin').Plugin} */ export default { ... }

export type MetaType = 'movie' | 'series' | 'video' | 'channel' | 'audio' | 'audiobook' | 'book'
export type Platform = 'web' | 'desktop' | 'mobile'

export interface Field {
  key: string
  label: string
  type?: 'text' | 'password' | 'select' | 'toggle' | 'list'
  options?: string[]
  default?: string | boolean | string[]
  /** Never synced, never in a setup link. A password field is always secret. */
  secret?: boolean
  help?: string
}

export interface Action { id: string; label: string; fields?: Field[] }
export interface Catalog { id: string; name: string; type: MetaType; search?: boolean }

export interface Video { id: string; title: string; season?: number; episode?: number; released?: string; thumbnail?: string; overview?: string }
export interface Meta {
  id: string
  type: MetaType
  name: string
  poster?: string
  posterShape?: 'poster' | 'square' | 'landscape'
  background?: string
  description?: string
  year?: string
  genres?: string[]
  runtime?: string
  /** One line under the name on a card: a channel, an author. */
  subtitle?: string
  /** Up to 4 short facts (40 characters each) on a card and the title page: "1.2M views", "3 years ago". */
  badges?: string[]
  videos?: Video[]
  progress?: { pos: number; dur: number; at: number; videoId?: string }
}
export interface Sub { url: string; lang: string; label?: string }
/** A torrent the desktop app plays behind its VPN gate, or through a debrid service. */
export interface Torrent {
  /** 40 hex characters. */
  infoHash: string
  /** The file to play, 0 or more; the largest video when absent. */
  fileIdx?: number
  /** At most 50 udp://, http:// or https:// trackers. */
  trackers?: string[]
}
/** A stream has a `url`, or a `torrent` in its place. */
export interface Stream {
  url?: string
  torrent?: Torrent
  title?: string
  quality?: string
  kind?: 'video' | 'audio' | 'book'
  subs?: Sub[]
  needsDesktop?: true
  /** Opens in the browser instead of the player. https only. */
  external?: true
  /** Streams with the same group show under one filter chip. */
  group?: string
}

export interface FetchResponse { status: number; ok: boolean; headers: Record<string, string>; text(): Promise<string>; json(): Promise<any> }
export interface Ctx {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse>
  store: { get(key: string): Promise<any>; set(key: string, value: unknown): Promise<void> }
  settings: Readonly<Record<string, any>>
  platform: Platform
  tools: Record<string, Record<string, (...args: any[]) => Promise<any>>>
  log(...args: unknown[]): void
}

export interface Plugin {
  api: 1
  kind?: 'source'
  id: string
  name: string
  version: string
  author?: string
  description?: string
  icon?: string
  hosts?: string[]
  tools?: 'ytdlp'[]
  platforms?: Platform[]
  settings?: Field[]
  actions?: Action[]
  catalogs: Catalog[]
  /** Optional: the current catalog rows, when they depend on the user (their addons, their account). */
  userCatalogs?(ctx: Ctx): Promise<Catalog[]>
  catalog(ctx: Ctx, args: { id: string; type: MetaType; search?: string; skip?: number }): Promise<{ items: Meta[]; more?: boolean } | Meta[]>
  meta(ctx: Ctx, args: { type: MetaType; id: string }): Promise<Meta>
  streams(ctx: Ctx, args: { type: MetaType; id: string; videoId: string }): Promise<Stream[]>
  subtitles?(ctx: Ctx, args: { type: MetaType; id: string; videoId: string }): Promise<Sub[]>
  library?(ctx: Ctx): Promise<Meta[]>
  /** The user's addon URLs, for Flick to offer debrid keys found in them. Only the bundled Stremio plugin is asked. */
  addonUrls?(ctx: Ctx): Promise<string[]>
  action?(ctx: Ctx, id: string, values: Record<string, any>): Promise<{ ok: boolean; message?: string }>
  /** Addons inside this source (Stremio's addons). All five or none; Flick calls each only on a tap. */
  extensions?(ctx: Ctx): Promise<Extension[]>
  extensionCatalog?(ctx: Ctx, args: { search?: string }): Promise<(Extension & { installed: boolean })[]>
  /** Read the addon at an address so the user can confirm it. Must not save anything. */
  inspectExtension?(ctx: Ctx, args: { url: string }): Promise<Extension & { installed: boolean }>
  addExtension?(ctx: Ctx, args: { url: string }): Promise<ExtensionResult>
  removeExtension?(ctx: Ctx, args: { id: string }): Promise<ExtensionResult>
  progress?(ctx: Ctx, args: { type: MetaType; id: string; videoId: string; pos: number; dur: number }): Promise<void>
}

/** One addon. `url` is https:// or stremio://; `removable: false` hides Remove (a protected addon). */
export interface Extension { id: string; name: string; description?: string; logo?: string; url: string; types?: string[]; removable: boolean }
/** `settings` sets this plugin's own declared, non-secret settings (like a list of addon URLs) when ok. */
export interface ExtensionResult { ok: boolean; message?: string; settings?: Record<string, string | boolean | string[]> }

/** A torrent as Flick hands it to a service: nothing else about the title or the user. */
export interface Torrent { infoHash: string; fileIdx?: number; name?: string }
export type AccountResult = { ok: true; name: string; plan?: string; expires?: string } | { ok: false; message: string }
export type ResolveResult = { url: string } | { wait: { pct?: number; message: string } } | { error: string }

/** A service plugin (a debrid service): turns a torrent into an https link on its own hosts. */
export interface ServicePlugin {
  api: 1
  kind: 'service'
  provides: 'debrid'[]
  id: string
  name: string
  version: string
  author?: string
  description?: string
  icon?: string
  /** Named hosts only, never `*`: the API and the download hosts. */
  hosts: string[]
  /** The hosts its download links come from; each also in `hosts`. A stream on one of these needs the VPN gate. */
  debridHosts: string[]
  /** True when playback is only an https download from the service's own servers, so it may play with no VPN. */
  vpnOptional?: boolean
  platforms?: Platform[]
  settings?: Field[]
  actions?: Action[]
  /** Checks the key in ctx.settings. */
  account(ctx: Ctx): Promise<AccountResult>
  /** The lowercase infoHashes (of at most 100 asked) already on the service. Return [] when it cannot tell. */
  cached(ctx: Ctx, hashes: string[]): Promise<string[]>
  /** An https link on `hosts`, or `wait` while the service fetches it (Flick asks again every 3 s, up to 10 min). */
  resolve(ctx: Ctx, torrent: Torrent): Promise<ResolveResult>
  action?(ctx: Ctx, id: string, values: Record<string, any>): Promise<{ ok: boolean; message?: string }>
}

export interface Theme {
  flick: 'theme'
  api: 1
  id: string
  name: string
  version: string
  author?: string
  light: { bg: string; surface: string; fg: string; dim: string; line: string; accent: string }
  dark: { bg: string; surface: string; fg: string; dim: string; line: string; accent: string }
  radius?: number
  font?: string
}
