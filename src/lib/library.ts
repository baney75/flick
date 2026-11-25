// The library: folders, stored media, remote servers, all as one fast list of items.

import * as db from './db'
import { kindOf, parseName, type Kind, SUB_EXT, ext } from './parse'
import { isDesktop, invoke, fileUrl, onDesktopEvent, type ScanEntry, type Probe } from './platform'

export type Source =
  | { t: 'path'; path: string }
  | { t: 'handle'; root: string; rel: string }
  | { t: 'opfs'; name: string }
  | { t: 'url'; url: string; fallback?: string }
  | { t: 'session'; key: string }

export type Origin = 'local' | 'stored' | 'jellyfin' | 'plex'

export interface Item {
  id: string
  title: string
  kind: Kind
  src: Source
  origin: Origin
  size: number
  mtime: number
  addedAt: number
  duration?: number
  show?: string
  season?: number
  episode?: number
  year?: number
  folder?: string
  poster?: string
  server?: string
}

export interface Folder {
  id: string
  name: string
  path?: string
  handle?: FileSystemDirectoryHandle
  session?: boolean
}

export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// ---- session files (browsers without persistent folder access) ----
const sessionFiles = new Map<string, File>()

export function sessionFile(file: File): Source {
  const key = hash(`${file.name}:${file.size}:${file.lastModified}`)
  sessionFiles.set(key, file)
  return { t: 'session', key }
}

export function itemFromFile(file: File, src: Source, origin: Origin, folder?: string): Item | null {
  const kind = kindOf(file.name)
  if (!kind) return null
  const p = parseName(file.name)
  const key = src.t === 'handle' ? `${src.root}/${src.rel}` : src.t === 'opfs' ? `opfs:${src.name}` : `s:${file.name}:${file.size}`
  return {
    id: hash(key), kind, src, origin, folder,
    title: p.title, show: p.show, season: p.season, episode: p.episode, year: p.year,
    size: file.size, mtime: file.lastModified, addedAt: Date.now(),
  }
}

function itemFromEntry(e: ScanEntry, folder: string): Item | null {
  const kind = kindOf(e.name)
  if (!kind) return null
  const p = parseName(e.name)
  return {
    id: hash(e.path), kind, src: { t: 'path', path: e.path }, origin: 'local', folder,
    title: p.title, show: p.show, season: p.season, episode: p.episode, year: p.year,
    size: e.size, mtime: e.mtime, addedAt: Date.now(),
  }
}

// ---- folders ----

export async function getFolders(): Promise<Folder[]> {
  return (await db.get<Folder[]>('kv', 'folders')) ?? []
}

async function saveFolders(f: Folder[]) {
  // Session folders hold no handle worth keeping; drop them on save.
  await db.put('kv', 'folders', f.filter((x) => !x.session))
}

async function walkHandle(dir: FileSystemDirectoryHandle, root: string, prefix: string, out: Item[], folderName: string) {
  for await (const [name, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${name}` : name
    if (h.kind === 'directory') {
      await walkHandle(h as FileSystemDirectoryHandle, root, rel, out, folderName)
    } else if (kindOf(name)) {
      const file = await (h as FileSystemFileHandle).getFile()
      const it = itemFromFile(file, { t: 'handle', root, rel }, 'local', folderName)
      if (it) out.push(it)
    }
  }
}

export async function scanFolder(f: Folder, files?: File[]): Promise<Item[]> {
  const out: Item[] = []
  if (f.path && isDesktop) {
    const entries = await invoke<ScanEntry[]>('scan_folder', { path: f.path })
    for (const e of entries) {
      const it = itemFromEntry(e, f.name)
      if (it) out.push(it)
    }
  } else if (f.handle) {
    await walkHandle(f.handle, f.id, '', out, f.name)
  } else if (files) {
    for (const file of files) {
      const it = itemFromFile(file, sessionFile(file), 'local', f.name)
      if (it) out.push(it)
    }
  }
  return out
}

/** Merge a fresh scan into the stored items, keeping durations and add dates. */
export async function mergeScan(folderName: string, scanned: Item[], persist = true): Promise<Item[]> {
  const existing = await allItems()
  const prev = new Map(existing.map((i) => [i.id, i]))
  const keepIds = new Set(scanned.map((i) => i.id))
  const merged = scanned.map((s) => {
    const p = prev.get(s.id)
    return p ? { ...s, addedAt: p.addedAt, duration: p.duration } : s
  })
  if (persist) {
    const gone = existing.filter((i) => i.folder === folderName && i.origin === 'local' && !keepIds.has(i.id)).map((i) => i.id)
    await db.delMany('items', gone)
    await db.putMany('items', merged.map((i) => [i.id, i]))
  }
  return merged
}

export async function addFolder(f: Folder): Promise<void> {
  const folders = await getFolders()
  if (!folders.some((x) => x.id === f.id)) folders.push(f)
  await saveFolders(folders)
}

export async function removeFolder(f: Folder): Promise<void> {
  const folders = (await getFolders()).filter((x) => x.id !== f.id)
  await saveFolders(folders)
  const items = await allItems()
  await db.delMany('items', items.filter((i) => i.folder === f.name && i.origin === 'local').map((i) => i.id))
}

export async function allItems(): Promise<Item[]> {
  return db.all<Item>('items')
}

export async function saveItems(items: Item[]) {
  await db.putMany('items', items.map((i) => [i.id, i]))
}

export async function removeItems(ids: string[]) {
  await db.delMany('items', ids)
  await db.delMany('thumbs', ids)
}

// ---- stored media (copied into the app's private storage) ----

export async function storeFile(file: File, onProgress?: (done: number) => void): Promise<Item | null> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('media', { create: true })
  const name = `${Date.now().toString(36)}-${file.name}`
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  let done = 0
  const reader = file.stream().getReader()
  for (;;) {
    const { value, done: end } = await reader.read()
    if (end) break
    await w.write(value)
    done += value.byteLength
    onProgress?.(done / file.size)
  }
  await w.close()
  navigator.storage.persist?.().catch(() => {})
  const it = itemFromFile(file, { t: 'opfs', name }, 'stored', 'Stored in Flick')
  if (it) await saveItems([it])
  return it
}

export async function deleteStored(it: Item) {
  if (it.src.t !== 'opfs') return
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('media', { create: true })
  await dir.removeEntry(it.src.name).catch(() => {})
  await removeItems([it.id])
}

// ---- resolving a source to something the <video> element can play ----

async function handleFile(src: Extract<Source, { t: 'handle' }>): Promise<File> {
  const folders = await getFolders()
  const f = folders.find((x) => x.id === src.root)
  if (!f?.handle) throw new Error('That folder is no longer connected. Add it again in Library.')
  const h = f.handle as FileSystemDirectoryHandle & {
    queryPermission?(o: object): Promise<PermissionState>
    requestPermission?(o: object): Promise<PermissionState>
  }
  if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted') {
    if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') throw new Error('Flick needs permission to read that folder.')
  }
  const parts = src.rel.split('/')
  let dir: FileSystemDirectoryHandle = h
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p)
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile()
}

export async function sourceFile(src: Source): Promise<File | null> {
  if (src.t === 'session') return sessionFiles.get(src.key) ?? null
  if (src.t === 'handle') return handleFile(src)
  if (src.t === 'opfs') {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('media')
    return (await dir.getFileHandle(src.name)).getFile()
  }
  return null
}

export interface Resolved { url: string; revoke?: () => void; file?: File; sidecarSubs?: { name: string; text: string }[] }

export async function resolve(src: Source, onStatus?: (s: string) => void): Promise<Resolved> {
  if (src.t === 'url') return { url: src.url }
  if (src.t === 'path') {
    const probe = await invoke<Probe>('probe', { path: src.path }).catch(() => null)
    let path = src.path
    if (probe && !probe.playable) {
      onStatus?.('Converting for playback')
      const off = await onDesktopEvent<{ path: string; pct: number }>('prepare-progress', (p) => {
        if (p.path === src.path) onStatus?.(`Converting for playback ${Math.round(p.pct)}%`)
      })
      try { path = await invoke<string>('prepare', { path: src.path }) } finally { off() }
    }
    const subs = await invoke<{ name: string; text: string }[]>('sidecar_subs', { path: src.path }).catch(() => [])
    return { url: await fileUrl(path), sidecarSubs: subs }
  }
  const file = await sourceFile(src)
  if (!file) throw new Error('This file was opened in an earlier session. Open it again, or store it in Flick to keep it.')
  const url = URL.createObjectURL(file)
  let sidecarSubs: { name: string; text: string }[] | undefined
  if (src.t === 'handle') sidecarSubs = await findHandleSubs(src).catch(() => undefined)
  return { url, file, revoke: () => URL.revokeObjectURL(url), sidecarSubs }
}

async function findHandleSubs(src: Extract<Source, { t: 'handle' }>) {
  const folders = await getFolders()
  const f = folders.find((x) => x.id === src.root)
  if (!f?.handle) return []
  const parts = src.rel.split('/')
  let dir: FileSystemDirectoryHandle = f.handle
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p)
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '')
  const out: { name: string; text: string }[] = []
  for await (const [name, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === 'file' && SUB_EXT.includes(ext(name)) && name.startsWith(stem)) {
      out.push({ name, text: await (await (h as FileSystemFileHandle).getFile()).text() })
    }
  }
  return out
}

// ---- thumbnails ----

const thumbUrls = new Map<string, string>()

export async function thumbUrl(id: string): Promise<string | null> {
  const hit = thumbUrls.get(id)
  if (hit) return hit
  const blob = await db.get<Blob>('thumbs', id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  thumbUrls.set(id, url)
  return url
}

function frameFromVideo(url: string): Promise<{ blob: Blob | null; duration: number }> {
  return new Promise((resolveP) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    v.playsInline = true
    let settled = false
    const finish = (blob: Blob | null) => {
      if (settled) return
      settled = true
      const duration = isFinite(v.duration) ? v.duration : 0
      v.removeAttribute('src')
      v.load()
      resolveP({ blob, duration })
    }
    const timer = setTimeout(() => finish(null), 8000)
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(Math.max(v.duration * 0.12, 1), 120) || 1
    }
    v.onseeked = () => {
      clearTimeout(timer)
      const w = 400
      const h = Math.round((v.videoHeight / v.videoWidth) * w) || 225
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(v, 0, 0, w, h)
      c.toBlob((b) => finish(b), 'image/jpeg', 0.78)
    }
    v.onerror = () => { clearTimeout(timer); finish(null) }
    v.src = url
  })
}

/** Make a thumbnail and read the duration. Returns the duration it found. */
export async function makeThumb(it: Item): Promise<number | undefined> {
  if (it.kind !== 'video' || it.poster) return
  if (it.src.t === 'path') {
    const r = await invoke<{ duration: number; jpeg: number[] | null }>('thumbnail', { path: it.src.path }).catch(() => null)
    if (!r) return
    if (r.jpeg?.length) await db.put('thumbs', it.id, new Blob([new Uint8Array(r.jpeg)], { type: 'image/jpeg' }))
    return r.duration || undefined
  }
  const file = await sourceFile(it.src).catch(() => null)
  if (!file) return
  const url = URL.createObjectURL(file)
  try {
    const { blob, duration } = await frameFromVideo(url)
    if (blob) await db.put('thumbs', it.id, blob)
    return duration || undefined
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function hasThumb(id: string): Promise<boolean> {
  return !!(await db.get<Blob>('thumbs', id))
}

export const _test = { itemFromEntry }
