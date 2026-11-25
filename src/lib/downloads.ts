// Offline downloads: a server file saved on the device, played from there online or offline.
// The apps stream it in the shell; the website streams it into OPFS downloads/<id>.<ext>.

import { signal } from '@preact/signals'
import * as db from './db'
import type { Item, Source } from './library'
import { isDesktop, invoke, onDesktopEvent } from './platform'
import { kodiAuth } from './servers'
import { ext as extOf, VIDEO_EXT, AUDIO_EXT } from './parse'

export interface Download {
  id: string
  state: 'queued' | 'downloading' | 'done' | 'failed'
  done: number
  total: number
  at: number
  local?: Source
  error?: string
  /** The unfinished file, so a removed download deletes it too. */
  part?: Source
}

export const BROWSER_BLOCKED = 'This server does not allow downloads in the browser. Use the Flick app.'
const DIR = 'downloads'

/** Every download by item id. Progress lands here about 4 times a second. */
export const downloads = signal<Map<string, Download>>(new Map())

const rows = new Map<string, Download>()
const dirty = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let last = 0

function flush() {
  timer = null
  last = Date.now()
  downloads.value = new Map(rows)
  for (const id of dirty) {
    const r = rows.get(id)
    if (r) db.put('downloads', id, r).catch(() => {})
  }
  dirty.clear()
}

/** Records a row. State changes publish and save now; progress waits for the next 250 ms tick. */
async function set(row: Download, now = false) {
  rows.set(row.id, row)
  if (now) {
    dirty.delete(row.id)
    await db.put('downloads', row.id, row)
    if (timer) clearTimeout(timer)
    flush()
    return
  }
  dirty.add(row.id)
  if (timer) return
  const wait = 250 - (Date.now() - last)
  if (wait <= 0) flush()
  else timer = setTimeout(flush, wait)
}

async function forget(id: string) {
  rows.delete(id)
  dirty.delete(id)
  await db.del('downloads', id)
  downloads.value = new Map(rows)
}

export async function getDownload(id: string): Promise<Download | undefined> {
  return rows.get(id) ?? db.get<Download>('downloads', id)
}

export async function allDownloads(): Promise<Download[]> {
  return db.all<Download>('downloads')
}

// ---- the queue: one download at a time, the rest wait in order ----

const queue: Item[] = []
const active = new Set<string>()
let running: { id: string; stop: AbortController; finished: Promise<void> } | null = null
let idle: (() => void)[] = []

export async function download(it: Item): Promise<void> {
  if (it.src.t !== 'url' && it.src.t !== 'kodi') throw new Error('Only files from a media server can be downloaded.')
  const cur = await getDownload(it.id)
  if (active.has(it.id) || cur?.state === 'done') return
  active.add(it.id)
  await set({ id: it.id, state: 'queued', done: cur?.done ?? 0, total: cur?.total ?? 0, at: Date.now(), part: cur?.part }, true)
  queue.push(it)
  pump()
}

function pump() {
  if (running) return
  const it = queue.shift()
  if (!it) {
    for (const f of idle) f()
    idle = []
    return
  }
  const stop = new AbortController()
  const finished = run(it, stop.signal).finally(() => {
    running = null
    active.delete(it.id)
    pump()
  })
  running = { id: it.id, stop, finished }
}

async function run(it: Item, signal: AbortSignal) {
  const row = () => rows.get(it.id)!
  const progress = (done: number, total: number, part?: Source) => {
    // A late shell event must not touch a row that already finished.
    if (rows.get(it.id)?.state === 'downloading') set({ ...row(), done, total, ...(part ? { part } : {}) })
  }
  try {
    await set({ ...row(), state: 'downloading', error: undefined }, true)
    const local = isDesktop ? await viaShell(it, progress) : await viaBrowser(it, signal, progress)
    if (rows.has(it.id)) await set({ ...row(), state: 'done', local, part: undefined, done: Math.max(row().done, row().total) }, true)
  } catch (e) {
    if (!rows.has(it.id)) return
    const error = signal.aborted ? 'Canceled' : e instanceof Error ? e.message : String(e)
    await set({ ...row(), state: 'failed', error }, true)
  }
}

/** Stops a download. Its partial file stays, so downloading it again resumes. */
export async function cancelDownload(id: string): Promise<void> {
  const i = queue.findIndex((x) => x.id === id)
  if (i >= 0) {
    queue.splice(i, 1)
    active.delete(id)
    const r = rows.get(id)
    if (r) await set({ ...r, state: 'failed', error: 'Canceled' }, true)
    return
  }
  if (running?.id !== id) return
  running.stop.abort()
  if (isDesktop) await invoke('download_cancel', { id }).catch(() => {})
  await running?.finished
}

/** Stops the download if needed, then deletes its file and its row. */
export async function removeDownload(id: string): Promise<void> {
  await cancelDownload(id)
  const r = await getDownload(id)
  for (const src of [r?.local, r?.part]) if (src) await deleteLocal(src).catch(() => {})
  await forget(id)
}

/** Starts again what was queued or downloading when the app last closed. */
export async function resumeDownloads(): Promise<void> {
  const saved = await allDownloads()
  for (const r of saved) if (!rows.has(r.id)) rows.set(r.id, r)
  downloads.value = new Map(rows)
  for (const r of saved.filter((x) => x.state === 'queued' || x.state === 'downloading').sort((a, b) => a.at - b.at)) {
    const it = await db.get<Item>('items', r.id)
    if (it) await download(it)
    else await set({ ...r, state: 'failed', error: 'This item is no longer in the library.' }, true)
  }
}

/** The local copy of a finished download, or null. A missing file drops the row. */
export async function localFor(id: string): Promise<Source | null> {
  const r = await getDownload(id)
  if (r?.state !== 'done' || !r.local) return null
  if (await exists(r.local)) return r.local
  await forget(id)
  return null
}

// ---- files ----

/** The extension from the URL's file name, or "bin" when it names none (the shell sniffs one). */
export function pickExt(url: string): string {
  let path = url
  try { path = decodeURIComponent(new URL(url).pathname) } catch { /* keep the raw URL */ }
  const e = extOf(path.split('/').pop() ?? '')
  return VIDEO_EXT.includes(e) || AUDIO_EXT.includes(e) ? e : 'bin'
}

async function opfsDir() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true })
}

async function exists(src: Source): Promise<boolean> {
  if (src.t === 'path') return invoke<boolean>('download_exists', { path: src.path }).catch(() => false)
  if (src.t !== 'opfs') return false
  return (await opfsDir()).getFileHandle(src.name).then(() => true, () => false)
}

async function deleteLocal(src: Source) {
  if (src.t === 'path') await invoke('download_remove', { path: src.path })
  else if (src.t === 'opfs') await (await opfsDir()).removeEntry(src.name)
}

type Progress = (done: number, total: number, part?: Source) => void

async function viaShell(it: Item, progress: Progress): Promise<Source> {
  const src = it.src as Extract<Source, { t: 'url' | 'kodi' }>
  // The Kodi login goes to the shell as arguments; the URL never carries it.
  const [user, pass] = src.t === 'kodi' ? await kodiAuth(src.server) : ['', '']
  const off = await onDesktopEvent<{ id: string; done: number; total: number; part: string }>('download-progress', (p) => {
    if (p.id === it.id) progress(p.done, p.total, { t: 'path', path: p.part })
  })
  try {
    const path = await invoke<string>('download', { id: it.id, url: src.url, user, pass, ext: pickExt(src.url) })
    return { t: 'path', path }
  } catch (e) {
    throw new Error(String(e))
  } finally {
    off()
  }
}

async function viaBrowser(it: Item, signal: AbortSignal, progress: Progress): Promise<Source> {
  // Kodi needs Basic auth, which only the shell can send for a file this size.
  if (it.src.t !== 'url') throw new Error(BROWSER_BLOCKED)
  navigator.storage.persist?.().catch(() => {})
  const name = `${it.id}.${pickExt(it.src.url)}`
  const fh = await (await opfsDir()).getFileHandle(name, { create: true })
  const part: Source = { t: 'opfs', dir: DIR, name }
  await fetchInto(it.src.url, fh, signal, (d, t) => progress(d, t, part))
  return part
}

function rangeTotal(cr: string | null): number | null {
  const n = Number(cr?.split('/')[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Streams `url` into a file handle, resuming from the file's size when the server answers 206. */
export async function fetchInto(url: string, fh: FileSystemFileHandle, signal: AbortSignal, onProgress: (done: number, total: number) => void) {
  const have = (await fh.getFile()).size
  let r: Response
  try {
    r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal })
  } catch (e) {
    if (signal.aborted) throw e
    // A CORS refusal and a dropped network look the same to fetch.
    throw new Error(navigator.onLine === false ? 'You are offline. Try again when you are back online.' : BROWSER_BLOCKED)
  }
  if (r.status === 416 && have && rangeTotal(r.headers.get('content-range')) === have) return
  if (!r.ok || !r.body) throw new Error(`The server said ${r.status}`)
  const resume = r.status === 206
  const len = Number(r.headers.get('content-length')) || 0
  // Content-Range is often hidden from scripts cross-origin, so fall back to what is left plus what we have.
  const total = resume ? (rangeTotal(r.headers.get('content-range')) ?? have + len) : len
  const w = await fh.createWritable({ keepExistingData: resume })
  let done = resume ? have : 0
  if (resume) await w.seek(have)
  const reader = r.body.getReader()
  try {
    for (;;) {
      const { value, done: end } = await reader.read()
      if (signal.aborted) {
        reader.cancel().catch(() => {})
        throw new Error('Canceled')
      }
      if (end) break
      await w.write(value)
      done += value.byteLength
      onProgress(done, total)
    }
  } finally {
    // Close, not abort, even on failure: the bytes so far are what the next try resumes from.
    await w.close()
  }
  if (total && done < total) throw new Error('The download stopped early. Try again to resume.')
  onProgress(done, Math.max(total, done))
}

export const _test = {
  /** Resolves once the queue is empty and nothing runs. */
  idle: () => new Promise<void>((res) => (running || queue.length ? idle.push(res) : res())),
  reset() {
    rows.clear()
    dirty.clear()
    downloads.value = new Map()
  },
}
