// What the screens need from downloads: which items can be saved, a short status,
// whether the device is online, and removing watched downloads when the setting asks.

import { signal, effect } from '@preact/signals'
import type { Item } from './library'
import { isDesktop } from './platform'
import { downloads, download, downloadStream, removeDownload, localFor, type Download, type Saved } from './downloads'
import { progress, settings, notify, play, type PlayRequest } from './store'

/** Server items can be saved. Kodi needs the app, which sends the Kodi login. */
export function canDownload(it: Item): boolean {
  // Photos never leave the device or the person's own server, so they are never downloaded.
  if (it.parts || it.kind === 'photo') return false
  if (it.src.t === 'kodi') return isDesktop
  return it.src.t === 'url' && (it.origin === 'jellyfin' || it.origin === 'plex' || it.origin === 'flick')
}

/** The card badge for a download: Offline, a percent, Queued or Failed. */
export function badgeFor(d: Download | undefined): string | undefined {
  if (!d) return undefined
  if (d.state === 'done') return 'Offline'
  if (d.state === 'queued') return 'Queued'
  if (d.state === 'failed') return d.error === 'Canceled' ? undefined : 'Failed'
  return d.total ? `${Math.floor((d.done / d.total) * 100)}%` : 'Starting'
}

/** True when the download finished or is on its way. */
export const isSaved = (d: Download | undefined) => !!d && d.state !== 'failed'

/** Queues items for download and says so; errors show as a notice. */
export async function save(list: Item[]) {
  let queued = 0
  let error = ''
  for (const it of list.filter(canDownload)) {
    try { await download(it); queued++ } catch (e) { error = (e as Error).message }
  }
  if (error) notify(queued ? `Downloading ${queued}. One could not start: ${error}` : error)
  else if (queued) notify(queued === 1 ? 'Downloading. It plays offline when done.' : `Downloading ${queued} items.`)
}

/** Saves a plugin stream the viewer picked and says so. */
export async function saveStream(saved: Saved) {
  try {
    await downloadStream(saved)
    notify('Downloading. It plays offline when done.')
  } catch (e) { notify((e as Error).message) }
}

/** Plays a saved plugin title from its file, under the title's own progress key. Needs no network. */
export async function playSaved(d: Download, extra: Partial<PlayRequest> = {}): Promise<boolean> {
  const s = d.saved
  const local = s ? await localFor(d.id) : null
  if (!s || !local) { notify('This download is no longer on this device.'); return false }
  play({ key: s.key, title: s.title, subtitle: s.subtitle, kind: s.kind, src: local, poster: s.poster, ref: s.ref, ...extra })
  return true
}

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine)

const WATCHED = 0.93

/** Item ids whose download is done and that were watched after the download started. */
export function watchedDownloads(rows: Map<string, Download>, prog: Record<string, { pos: number; dur: number; at: number }>): string[] {
  return [...rows.values()].filter((d) => {
    const p = prog[d.saved?.key ?? d.id]
    return d.state === 'done' && !!p?.dur && p.pos / p.dur >= WATCHED && p.at > d.at
  }).map((d) => d.id)
}

/** Keeps `online` current and removes watched downloads while the setting is on. */
export function startOffline() {
  addEventListener('online', () => { online.value = true })
  addEventListener('offline', () => { online.value = false })
  effect(() => {
    if (!settings.value.removeWatched) return
    for (const id of watchedDownloads(downloads.value, progress.value)) removeDownload(id).catch(() => {})
  })
}
