// App-wide state as signals. Views read these; actions here write them.

import { signal, computed } from '@preact/signals'
import * as db from './db'
import type { Item, Source } from './library'
import { inProgress } from './continue'
import { allItems, makeThumb, hasThumb, saveItems, localEpub, KODI_IMG } from './library'
import { defaultPrefs, type StreamPrefs } from './prefs'

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
/** theme is light or dark mode; look is an installed theme's id, or '' for Flick's own colors. */
export interface Settings extends StreamPrefs { autoplayNext: boolean; speed: number; volume: number; skipSeconds: number; theme: 'system' | 'dark' | 'light'; look: string; removeWatched: boolean
  /** Debrid services' order, by plugin id; and whether they need the VPN gate too (SPEC-debrid rule 10). */
  serviceOrder: string[]; debridNeedsVpn: boolean }
/** Settings saved before a key existed load that key's default. */
export function settingsFrom(raw: string | null, langs: readonly string[]): Settings {
  const defaults: Settings = { autoplayNext: true, speed: 1, volume: 1, skipSeconds: 10, theme: 'system', look: '', removeWatched: false, serviceOrder: [], debridNeedsVpn: false, ...defaultPrefs(langs) }
  try { return { ...defaults, ...JSON.parse(raw || '{}') } } catch { return defaults }
}
function loadSettings(): Settings {
  let raw: string | null = null
  try { raw = localStorage.getItem('flick.settings') } catch { /* storage blocked: defaults */ }
  return settingsFrom(raw, typeof navigator === 'undefined' ? [] : navigator.languages ?? [])
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
    // A photo is done once it has a date, with or without a thumbnail (HEIC in Chrome has none).
    const photo = i.kind === 'photo' && i.taken === undefined
    if ((i.kind === 'video' || photo || localEpub(i)) && !i.poster && !queued.has(i.id)) {
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
        if (it.kind === 'photo') {
          await makeThumb(it)
          // A file from a folder this browser keeps only for the visit stays out of storage. Only the date is
          // written, onto the record as it is now, so a rescan or removal while the thumbnail was made wins.
          const now = it.src.t === 'session' ? undefined : await db.get<Item>('items', it.id)
          if (now) await saveItems([{ ...now, taken: it.taken }])
          thumbTick.value++
        } else if (!(await hasThumb(it.id)) || (it.kind === 'video' && !it.duration)) {
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
  | { t: 'plugin'; p: string; type: string; id: string; videoId: string }
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
    .filter(([, p]) => inProgress(p))
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
  /** The subtitle language to turn on at the start, when the audio is not one the user listed. */
  subLang?: string
  startAt?: number
  ref: Ref
  next?: () => PlayRequest | null
  /** Called with the position each time the player saves it (a plugin syncs it back). */
  onSave?: (pos: number, dur: number) => void
  /** Stream from the source even when a downloaded copy exists (the user chose the server). */
  stream?: boolean
  /** A debrid stream: the player shows the service, its speed and the VPN state. */
  via?: import('./readout').Via
  /** A torrent the built-in engine plays: no scrub preview, so the only reader is at the playhead. */
  peers?: boolean
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
  // Photos open in the Photos viewer, never the player.
  if (i.kind === 'photo') return
  if (i.kind === 'book') return go(`/read/${encodeURIComponent(i.id)}`)
  if (i.kind === 'audiobook') return go(`/listen/${encodeURIComponent(i.id)}`)
  play(itemRequest(i))
}
