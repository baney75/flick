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
  videos?: Video[]
  progress?: { pos: number; dur: number; at: number; videoId?: string }
}
export interface Sub { url: string; lang: string; label?: string }
export interface Stream {
  url: string
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
  catalog(ctx: Ctx, args: { id: string; type: MetaType; search?: string; skip?: number }): Promise<{ items: Meta[]; more?: boolean } | Meta[]>
  meta(ctx: Ctx, args: { type: MetaType; id: string }): Promise<Meta>
  streams(ctx: Ctx, args: { type: MetaType; id: string; videoId: string }): Promise<Stream[]>
  subtitles?(ctx: Ctx, args: { type: MetaType; id: string; videoId: string }): Promise<Sub[]>
  library?(ctx: Ctx): Promise<Meta[]>
  action?(ctx: Ctx, id: string, values: Record<string, any>): Promise<{ ok: boolean; message?: string }>
  progress?(ctx: Ctx, args: { type: MetaType; id: string; videoId: string; pos: number; dur: number }): Promise<void>
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
