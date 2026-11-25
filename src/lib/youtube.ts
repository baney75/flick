// YouTube on the desktop app: yt-dlp searches, finds a stream, and saves videos for offline play.

import { invoke, onDesktopEvent } from './platform'
import { hash, saveItems, type Item } from './library'

export interface YtResult { id: string; title: string; channel: string; duration: number; thumbnail: string }
export interface YtStream { url: string; title: string; channel: string; duration: number; thumbnail: string }

interface RawEntry {
  id?: string
  title?: string
  channel?: string | null
  uploader?: string | null
  duration?: number | null
  thumbnails?: { url: string; width?: number }[]
}

/** Turns `yt-dlp ytsearch25:... --flat-playlist -J` output into results. Skips channels and playlists. */
export function parseSearch(json: { entries?: RawEntry[] } | null): YtResult[] {
  const out: YtResult[] = []
  for (const e of json?.entries ?? []) {
    if (!e.id || !/^[\w-]{11}$/.test(e.id) || !e.title) continue
    const thumbs = [...(e.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    out.push({
      id: e.id,
      title: e.title,
      channel: e.channel || e.uploader || '',
      duration: e.duration ?? 0,
      thumbnail: thumbs[0]?.url ?? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    })
  }
  return out
}

export async function ytSearch(query: string): Promise<YtResult[]> {
  return parseSearch(await invoke('yt_search', { query }))
}

export function ytResolve(id: string): Promise<YtStream> {
  return invoke<YtStream>('yt_resolve', { id })
}

/** Saves the video as MP4 and adds it to the library in a "YouTube" folder. */
export async function ytSave(r: YtResult, onPct: (pct: number) => void): Promise<Item> {
  const off = await onDesktopEvent<{ id: string; pct: number }>('yt-progress', (p) => { if (p.id === r.id) onPct(p.pct) })
  try {
    const path = await invoke<string>('yt_download', { id: r.id })
    const now = Date.now()
    const item: Item = {
      id: hash(path), title: r.title, kind: 'video', src: { t: 'path', path }, origin: 'local', folder: 'YouTube',
      size: 0, mtime: now, addedAt: now, duration: r.duration || undefined,
    }
    await saveItems([item])
    return item
  } finally {
    off()
  }
}
