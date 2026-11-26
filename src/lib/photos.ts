// Photos and home videos: which items are in the Photos tab, when each was taken, and the month groups.
// Everything here is pure, for tests. Nothing about photos ever syncs or uploads.

import type { Item, Source } from './library'
import { srcName } from './library'

/** When a photo or home video was taken: its capture date when known, else the file's mtime. */
export const takenAt = (i: Pick<Item, 'taken' | 'mtime'>) => i.taken ?? i.mtime

/** The folder an item's file sits in, so videos can be matched to the photos beside them. */
export function dirOf(i: Pick<Item, 'dir' | 'src'>): string {
  if (i.dir !== undefined) return i.dir
  const up = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
  const s: Source = i.src
  if (s.t === 'path') return up(s.path)
  if (s.t === 'handle') return `${s.root}/${s.rel.includes('/') ? up(s.rel) : ''}`
  if (s.t === 'opfs') return `opfs:${s.dir ?? 'media'}`
  if (s.t === 'url' || s.t === 'kodi') return up(s.url.split('?')[0])
  return ''
}

/** A video from a phone or camera (IMG_1234.MOV): no year and no episode in its name (camera counters are not years). Server URLs carry no file name, so the extension is not checked. */
export const isHomeVideo = (i: Item) => i.kind === 'video' && !i.show && !i.year

/**
 * The Photos tab: every photo, plus each home video in a folder that has a photo, newest first.
 * The videos stay videos everywhere else too.
 */
export function photoSet(items: Item[]): Item[] {
  // Only a titled video (a year or an episode) has a poster; a phone video beside its photo is a Live Photo.
  const videos = new Set(items.filter((i) => i.kind === 'video' && !isHomeVideo(i)).map((i) => `${dirOf(i)}\0${stem(srcName(i.src))}`))
  const photos = items.filter((i) => i.kind === 'photo' && !isPosterOf(dirOf(i), srcName(i.src), videos))
  const dirs = new Set(photos.map(dirOf))
  return [...photos, ...items.filter((i) => dirs.size > 0 && isHomeVideo(i) && dirs.has(dirOf(i)))]
    .sort((a, b) => takenAt(b) - takenAt(a))
}

/** A file name without its folder and extension, in lower case. */
export const stem = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase()

/**
 * A picture named after a titled video in its folder (Heat (1995).jpg or Heat (1995)-thumb.jpg beside Heat (1995).mkv)
 * is that video's poster, not a photo. `videos` holds "folder\0stem" for each titled video.
 */
export function isPosterOf(dir: string, name: string, videos: Set<string>): boolean {
  const s = stem(name)
  return videos.has(`${dir}\0${s}`) || videos.has(`${dir}\0${s.replace(/-[^-]*$/, '')}`)
}

export interface MonthGroup { key: string; items: Item[] }

/** Groups a newest-first list by the month it was taken, keyed "2024-06". */
export function byMonth(list: Item[]): MonthGroup[] {
  const out: MonthGroup[] = []
  for (const i of list) {
    const d = new Date(takenAt(i))
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const last = out[out.length - 1]
    if (last?.key === key) last.items.push(i)
    else out.push({ key, items: [i] })
  }
  return out
}

/** "June 2024" for a month key. */
export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
