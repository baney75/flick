// What the screens need from downloads: which items can be saved, a short status,
// whether the device is online, and removing watched downloads when the setting asks.

import { signal, effect } from '@preact/signals'
import type { Item } from './library'
import { isDesktop } from './platform'
import { downloads, download, removeDownload, type Download } from './downloads'
import { progress, settings, notify } from './store'

/** Server items can be saved. Kodi needs the app, which sends the Kodi login. */
export function canDownload(it: Item): boolean {
  if (it.src.t === 'kodi') return isDesktop
  return it.src.t === 'url' && (it.origin === 'jellyfin' || it.origin === 'plex')
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
  const ok = list.filter(canDownload)
  for (const it of ok) await download(it).catch((e) => notify((e as Error).message))
  if (ok.length) notify(ok.length === 1 ? `Downloading ${ok[0].title}. It plays offline when done.` : `Downloading ${ok.length} items.`)
}

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine)

const WATCHED = 0.93

/** Item ids whose download is done and whose progress says watched. */
export function watchedDownloads(rows: Map<string, Download>, prog: Record<string, { pos: number; dur: number }>): string[] {
  return [...rows.values()].filter((d) => {
    const p = prog[d.id]
    return d.state === 'done' && !!p?.dur && p.pos / p.dur >= WATCHED
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
