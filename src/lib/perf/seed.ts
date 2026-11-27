// A small seeded library for the real-app perf check (src/lib/perf/realapp.ts), written the way the app
// stores its own: items, and a JPEG thumbnail per video and photo. Swap for tests/fixtures/perf-seed.ts
// (SPEC-perf rule 2) once it lands. No file it names exists, so nothing plays; nothing reaches a host.

import * as db from '../db'
import type { Item } from '../library'

export const SEED_KEY = 'perf.seed'
export const SEED_VERSION = 1
export const COUNTS = { episodes: 120, shows: 8, movies: 280, songs: 150, books: 30, photos: 200 }

function thumb(i: number): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const g = c.getContext('2d')!
  g.fillStyle = `hsl(${(i * 37) % 360} 40% 35%)`
  g.fillRect(0, 0, 320, 180)
  g.fillStyle = '#fff'
  g.font = '28px sans-serif'
  g.fillText(String(i), 20, 100)
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.7))
}

export function seedItems(now = Date.UTC(2026, 10, 1)): Item[] {
  const out: Item[] = []
  const base = (id: string, title: string, kind: Item['kind'], path: string, n: number): Item =>
    ({ id, title, kind, src: { t: 'path', path }, origin: 'local', size: 1_000_000 + n, mtime: now - n * 60_000, addedAt: now - n * 60_000, folder: 'Selftest' })
  for (let n = 0; n < COUNTS.episodes; n++) {
    const show = `Show ${(n % COUNTS.shows) + 1}`
    const ep = Math.floor(n / COUNTS.shows) + 1
    out.push({ ...base(`ep${n}`, `${show} S01E${String(ep).padStart(2, '0')}`, 'video', `/selftest/${show}/e${ep}.mkv`, n), show, season: 1, episode: ep, duration: 1500 })
  }
  for (let n = 0; n < COUNTS.movies; n++) out.push({ ...base(`mv${n}`, `The Movie ${n}`, 'video', `/selftest/movies/m${n}.mp4`, 200 + n), year: 1950 + (n % 75), duration: 6000 })
  for (let n = 0; n < COUNTS.songs; n++) out.push({ ...base(`so${n}`, `Song ${n}`, 'audio', `/selftest/music/s${n}.mp3`, 600 + n), author: `Band ${n % 12}`, duration: 200 })
  for (let n = 0; n < COUNTS.books; n++) out.push({ ...base(`bk${n}`, `Book ${n}`, 'book', `/selftest/books/b${n}.pdf`, 800 + n), author: `Writer ${n % 9}` })
  for (let n = 0; n < COUNTS.photos; n++) out.push({ ...base(`ph${n}`, `IMG_${1000 + n}.JPG`, 'photo', `/selftest/photos/IMG_${1000 + n}.JPG`, 900 + n), taken: now - n * 3_600_000 })
  return out
}

/** True when this profile already holds the current seed. */
export async function seeded(): Promise<boolean> {
  return (await db.get<number>('kv', SEED_KEY)) === SEED_VERSION
}

export async function seed() {
  const items = seedItems()
  await db.putMany('items', items.map((i) => [i.id, i]))
  const withThumb = items.filter((i) => i.kind === 'video' || i.kind === 'photo')
  const thumbs: [string, Blob][] = []
  for (let n = 0; n < withThumb.length; n++) thumbs.push([withThumb[n].id, await thumb(n)])
  await db.putMany('thumbs', thumbs)
  await db.put('kv', SEED_KEY, SEED_VERSION)
}
