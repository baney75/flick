// App-wide state as signals. Views read these; actions here write them.

import { signal, computed } from '@preact/signals'
import * as db from './db'
import { announce } from './sync/bus'
import type { Item, Source } from './library'
import { allItems, makeThumb, hasThumb, saveItems, KODI_IMG } from './library'
import type { Addon, LibraryItem } from './stremio'
import { CINEMETA, OPENSUBS, accountAddons, accountLibrary, fetchManifest } from './stremio'

// ---------- routing ----------
export const route = signal(location.hash.slice(1) || '/')
addEventListener('hashchange', () => (route.value = location.hash.slice(1) || '/'))
export function go(path: string) {
  location.hash = path
}

// ---------- toasts ----------
export const toast = signal<{ text: string; id: number } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function notify(text: string, ms = 3200) {
  toast.value = { text, id: Date.now() }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), ms)
}

// ---------- settings ----------
export interface Settings { autoplayNext: boolean; speed: number; volume: number; skipSeconds: number; theme: 'system' | 'dark' | 'light'; removeWatched: boolean }
const defaults: Settings = { autoplayNext: true, speed: 1, volume: 1, skipSeconds: 10, theme: 'system', removeWatched: false }
function loadSettings(): Settings {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('flick.settings') || '{}') } } catch { return defaults }
}
export const settings = signal<Settings>(loadSettings())
export function setSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch }
  try { localStorage.setItem('flick.settings', JSON.stringify(settings.value)) } catch { /* private mode */ }
}

// ---------- library ----------
export const items = signal<Item[]>([])
export const loaded = signal(false)
export const thumbTick = signal(0)

export async function reloadItems() {
  items.value = await allItems()
  loaded.value = true
  queueThumbs(items.value)
}

export const shows = computed(() => {
  const m = new Map<string, Item[]>()
  for (const i of items.value) if (i.show && i.kind === 'video') {
    const k = i.show.toLowerCase()
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(i)
  }
  for (const list of m.values()) list.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
  return m
})

// Thumbnails: a small background queue, two at a time, so scrolling stays smooth.
const thumbQueue: Item[] = []
let thumbRunning = 0
const queued = new Set<string>()
export function queueThumbs(list: Item[]) {
  for (const i of list) {
    if (i.kind === 'video' && !i.poster && !queued.has(i.id)) {
      queued.add(i.id)
      thumbQueue.push(i)
    }
  }
  pump()
}
function pump() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const it = thumbQueue.shift()!
    thumbRunning++
    ;(async () => {
      try {
        if (!(await hasThumb(it.id)) || !it.duration) {
          const dur = await makeThumb(it)
          if (dur && !it.duration) {
            it.duration = dur
            await saveItems([it])
          }
          thumbTick.value++
        }
      } catch { /* one bad file should not stop the queue */ }
      thumbRunning--
      pump()
    })()
  }
}

// ---------- watch progress ----------
export type Ref =
  | { t: 'item'; id: string }
  | { t: 'stremio'; type: string; id: string; videoId: string }
  | { t: 'url'; url: string }

export interface Progress {
  pos: number
  dur: number
  at: number
  title: string
  subtitle?: string
  poster?: string
  /** Set for books: pos and dur are pages, not seconds. */
  book?: boolean
  ref: Ref
}

export const progress = signal<Record<string, Progress>>({})
export async function loadProgress() {
  const rows = await db.entries<Progress>('progress')
  progress.value = Object.fromEntries(rows)
}
export async function saveProgress(key: string, p: Progress) {
  progress.value = { ...progress.value, [key]: p }
  await db.put('progress', key, p)
}
export async function clearProgress(key: string) {
  const next = { ...progress.value }
  delete next[key]
  progress.value = next
  await db.del('progress', key)
}

export const continueList = computed(() =>
  Object.entries(progress.value)
    .filter(([, p]) => p.book ? p.pos > 1 && p.pos < p.dur : p.pos > 15 && (!p.dur || p.pos < p.dur * 0.93))
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 24),
)

// ---------- the player ----------
export interface SubTrack { label: string; lang?: string; url: string }

export interface PlayRequest {
  key: string
  title: string
  subtitle?: string
  kind: 'video' | 'audio'
  src?: Source
  url?: string
  fallbackUrl?: string
  poster?: string
  subs?: SubTrack[]
  startAt?: number
  ref: Ref
  next?: () => PlayRequest | null
}

export const nowPlaying = signal<PlayRequest | null>(null)

export function play(req: PlayRequest) {
  const saved = progress.value[req.key]
  if (req.startAt === undefined && saved && saved.dur && saved.pos < saved.dur * 0.93) req.startAt = saved.pos
  nowPlaying.value = req
}

export function episodeLabel(i: Pick<Item, 'season' | 'episode' | 'show'>) {
  if (i.season == null && i.episode == null) return ''
  return `S${i.season ?? 1} E${i.episode ?? 0}`
}

export function itemRequest(i: Item): PlayRequest {
  const list = i.show ? shows.value.get(i.show.toLowerCase()) : undefined
  const idx = list ? list.findIndex((x) => x.id === i.id) : -1
  return {
    key: i.id,
    title: i.show ? `${i.show}` : i.title,
    subtitle: i.show ? `${episodeLabel(i)} · ${i.title}` : i.year ? String(i.year) : undefined,
    kind: i.kind === 'audio' ? 'audio' : 'video',
    src: i.src,
    fallbackUrl: i.src.t === 'url' ? i.src.fallback : undefined,
    poster: i.poster?.startsWith(KODI_IMG) ? undefined : i.poster,
    ref: { t: 'item', id: i.id },
    next: list && idx >= 0 && idx < list.length - 1 ? () => itemRequest(list[idx + 1]) : undefined,
  }
}

/** Plays media, or opens a book in the reader. */
export function playItem(i: Item) {
  if (i.kind === 'book') return go(`/read/${encodeURIComponent(i.id)}`)
  play(itemRequest(i))
}

// ---------- Stremio ----------
export interface StremioState { authKey: string | null; email: string | null; addons: Addon[]; library: LibraryItem[]; ready: boolean }
export const stremio = signal<StremioState>({ authKey: null, email: null, addons: [], library: [], ready: false })

export async function loadStremio() {
  const saved = await db.get<{ authKey: string | null; email: string | null; extra: string[] }>('kv', 'stremio')
  const authKey = saved?.authKey ?? null
  let addons: Addon[] = []
  let library: LibraryItem[] = []
  try {
    addons = authKey ? await accountAddons(authKey) : []
    if (authKey) library = await accountLibrary(authKey)
  } catch (e) {
    notify(`Stremio: ${(e as Error).message}`)
  }
  if (!addons.length) {
    addons = await Promise.all([CINEMETA, OPENSUBS].map((u) => fetchManifest(u).catch(() => null))).then((a) => a.filter(Boolean) as Addon[])
  }
  for (const url of saved?.extra ?? []) {
    if (addons.some((a) => a.transportUrl === url)) continue
    const a = await fetchManifest(url).catch(() => null)
    if (a) addons.push(a)
  }
  stremio.value = { authKey, email: saved?.email ?? null, addons, library, ready: true }
}

export async function saveStremio(patch: { authKey?: string | null; email?: string | null; extra?: string[] }) {
  const saved = (await db.get<{ authKey: string | null; email: string | null; extra: string[] }>('kv', 'stremio')) ?? { authKey: null, email: null, extra: [] }
  await db.put('kv', 'stremio', { ...saved, ...patch })
  if (patch.extra) announce('addons')
}

export async function stremioExtra(): Promise<string[]> {
  return ((await db.get<{ extra: string[] }>('kv', 'stremio'))?.extra) ?? []
}

export function openStremioRef(r: { type: string; id: string; videoId: string }) {
  const v = r.videoId && r.videoId !== r.id ? `?v=${encodeURIComponent(r.videoId)}` : ''
  go(`/stremio/${r.type}/${encodeURIComponent(r.id)}${v}`)
}
