// The seeded library scripts/perf.mjs measures (SPEC-perf rule 2): local videos, songs, books and
// photos, a flick-server, and one source plugin, written to IndexedDB in the shapes the app writes.
// Pure and deterministic: the same seed gives the same library, so two runs compare.

import type { Item, Folder } from '../../src/lib/library'
import type { Progress } from '../../src/lib/store'
import type { Server } from '../../src/lib/servers'
import type { Meta } from '../../src/lib/plugins/validate'

export const COUNTS = {
  localVideos: 5000,
  localEpisodes: 1200,
  localShows: 80,
  songs: 2000,
  books: 300,
  photos: 1500,
  serverItems: 3000,
  serverVideos: 2200,
  serverEpisodes: 400,
  serverShows: 20,
  pluginLibrary: 500,
  pluginInProgress: 40,
  localInProgress: 24,
  /** The shelf plugin's Watch later shelf, a list the size library() allows. */
  shelfList: 1000,
} as const

export const SERVER_ID = 'perf-nas'
export const PLUGIN_ID = 'dev.flick.perf'
export const SHELF_PLUGIN_ID = 'dev.flick.perf.shelves'
/** Port 9 is discard: nothing here is ever fetched, but a stray fetch fails at once instead of hanging. */
export const SERVER_URL = 'http://127.0.0.1:9'

const WORDS = ['Office', 'River', 'Night', 'Garden', 'Signal', 'Harbor', 'Winter', 'Glass', 'Engine', 'Orchard', 'Station', 'Comet',
  'Valley', 'Letter', 'Island', 'Marble', 'Thunder', 'Lantern', 'Meadow', 'Circuit', 'Shadow', 'Summit', 'Ember', 'Atlas', 'Canyon',
  'Prairie', 'Copper', 'Falcon', 'Hollow', 'Mirror', 'Paper', 'Quarry', 'Saddle', 'Timber', 'Voyage', 'Willow', 'Anchor', 'Beacon']
const ADJ = ['Last', 'Silent', 'Golden', 'Broken', 'Hidden', 'Long', 'Bright', 'Red', 'Little', 'Wild', 'Lost', 'Iron', 'Northern', 'Quiet']
const ARTISTS = ['The Hollows', 'June Avery', 'Northbound', 'Cass Reyes', 'The Office Band', 'Low Tide', 'Mara Lind', 'Copperline']
const AUTHORS = ['Jane Doe', 'John Roe', 'Ada Moss', 'Theo Grant', 'Ruth Hale', 'Silas Ward']

/** Mulberry32: small, fast, and the same numbers every run. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Seed {
  items: Item[]
  progress: Record<string, Progress>
  folders: Folder[]
  servers: Server[]
  /** Item ids that get a stored thumbnail, with the index of the image variant each one uses. */
  thumbs: [string, number][]
  /** The plugin's library, as library() returns it. */
  library: Meta[]
}

const NOW = Date.UTC(2026, 10, 1)
const DAY = 86_400_000

export function buildSeed(seed = 1): Seed {
  const r = rng(seed)
  const pick = <T>(l: readonly T[]) => l[Math.floor(r() * l.length)]
  const name = (n: number) => `${r() < 0.3 ? 'The ' : ''}${pick(ADJ)} ${WORDS[n % WORDS.length]}${n >= WORDS.length ? ` ${Math.floor(n / WORDS.length) + 1}` : ''}`
  const items: Item[] = []
  const thumbs: [string, number][] = []
  let n = 0
  const id = (p: string) => `${p}${(n++).toString(36)}`
  const base = (kind: Item['kind'], folder: string): Omit<Item, 'id' | 'title' | 'src'> => ({
    kind, origin: 'local', folder, size: 200_000_000 + Math.floor(r() * 4e9), mtime: NOW - Math.floor(r() * 900) * DAY, addedAt: NOW - Math.floor(r() * 900) * DAY,
  })

  // Local shows: 80 shows of 15 episodes, three seasons of five. "The Office" is one, for the search.
  const showNames = Array.from({ length: COUNTS.localShows }, (_, s) => (s === 0 ? 'The Office' : name(s + 7)))
  for (const show of showNames) {
    for (let e = 0; e < COUNTS.localEpisodes / COUNTS.localShows; e++) {
      const season = Math.floor(e / 5) + 1, episode = (e % 5) + 1
      const rel = `Shows/${show}/Season ${season}/${show} S0${season}E0${episode}.mkv`
      const it: Item = { ...base('video', 'Shows'), id: id('v'), title: `Episode ${episode}`, show, season, episode, duration: 1300 + Math.floor(r() * 1500), src: { t: 'handle', root: 'perf-shows', rel } }
      items.push(it)
      thumbs.push([it.id, thumbs.length % 48])
    }
  }
  // Local movies.
  const movies: Item[] = []
  for (let m = 0; m < COUNTS.localVideos - COUNTS.localEpisodes; m++) {
    const title = name(m), year = 1960 + Math.floor(r() * 66)
    const it: Item = { ...base('video', 'Movies'), id: id('v'), title, year, duration: 5000 + Math.floor(r() * 4000), src: { t: 'handle', root: 'perf-movies', rel: `Movies/${title} (${year}).mkv` } }
    items.push(it)
    movies.push(it)
    thumbs.push([it.id, thumbs.length % 48])
  }
  for (let s = 0; s < COUNTS.songs; s++) {
    const title = `${pick(ADJ)} ${pick(WORDS)}`
    items.push({ ...base('audio', 'Music'), id: id('a'), title, author: pick(ARTISTS), duration: 150 + Math.floor(r() * 200), src: { t: 'handle', root: 'perf-music', rel: `Music/${title}.mp3` } })
  }
  for (let b = 0; b < COUNTS.books; b++) {
    const title = name(b + 3), author = pick(AUTHORS)
    items.push({ ...base('book', 'Books'), id: id('b'), title, author, year: 1900 + Math.floor(r() * 125), src: { t: 'opfs', name: `${author} - ${title}.pdf` } })
  }
  for (let p = 0; p < COUNTS.photos; p++) {
    const it: Item = { ...base('photo', 'Phone'), id: id('p'), title: `IMG_${String(p).padStart(4, '0')}`, taken: NOW - p * 3 * 3_600_000, src: { t: 'handle', root: 'perf-phone', rel: `Phone/IMG_${p}.jpg` } }
    items.push(it)
    thumbs.push([it.id, thumbs.length % 48])
  }

  // A flick-server: videos (some the same films as the local ones, so they merge into one title), shows and songs.
  const srv = (kind: Item['kind'], title: string, extra: Partial<Item> = {}): Item => ({
    kind, origin: 'flick', server: SERVER_ID, folder: `Perf NAS: ${kind === 'audio' ? 'Music' : 'Movies'}`, dir: `${SERVER_ID}:Movies`,
    size: 1e9, mtime: NOW - Math.floor(r() * 400) * DAY, addedAt: NOW - Math.floor(r() * 400) * DAY,
    id: id('s'), title, src: { t: 'url', url: `${SERVER_URL}/media/${n}?t=perf` }, ...extra,
  })
  for (let s = 0; s < COUNTS.serverShows; s++) {
    const show = name(s + 200)
    for (let e = 0; e < COUNTS.serverEpisodes / COUNTS.serverShows; e++) {
      const it = srv('video', `Episode ${e + 1}`, { show, season: 1 + Math.floor(e / 10), episode: (e % 10) + 1, duration: 2400 })
      items.push(it)
      thumbs.push([it.id, thumbs.length % 48])
    }
  }
  for (let m = 0; m < COUNTS.serverVideos - COUNTS.serverEpisodes; m++) {
    const same = m < 300 ? movies[m * 7] : undefined
    const it = srv('video', same?.title ?? name(m + 400), { year: same?.year ?? 1980 + Math.floor(r() * 45), duration: 6000 })
    items.push(it)
    thumbs.push([it.id, thumbs.length % 48])
  }
  for (let s = 0; s < COUNTS.serverItems - COUNTS.serverVideos; s++) items.push(srv('audio', `${pick(ADJ)} ${pick(WORDS)}`, { author: pick(ARTISTS), duration: 200 }))

  // The plugin's library: films (a hundred also in the folders), and series; forty with a saved position.
  const library: Meta[] = []
  for (let m = 0; m < COUNTS.pluginLibrary; m++) {
    const same = m < 100 ? movies[m * 11 + 3] : undefined
    const series = !same && m % 4 === 0
    const meta: Meta = {
      id: `pm${m}`, type: series ? 'series' : 'movie', name: same?.title ?? name(m + 900), year: String(same?.year ?? 1990 + (m % 35)),
      poster: `poster:${m % 16}`, posterShape: 'poster',
    }
    if (m < COUNTS.pluginInProgress) meta.progress = { pos: 600 + m * 30, dur: 6000, at: NOW - m * 3_600_000 }
    library.push(meta)
  }

  const progress: Record<string, Progress> = {}
  for (let i = 0; i < COUNTS.localInProgress; i++) {
    const it = items[i * 53]
    progress[it.id] = { pos: 300 + i * 20, dur: it.duration ?? 3000, at: NOW - i * 7_200_000, title: it.show ?? it.title, subtitle: it.show ? `S${it.season} E${it.episode}` : undefined, ref: { t: 'item', id: it.id } }
  }

  const folders: Folder[] = ['Shows', 'Movies', 'Music', 'Books', 'Phone'].map((f) => ({ id: `perf-${f.toLowerCase()}`, name: f }))
  const servers: Server[] = [{ id: SERVER_ID, type: 'flick', name: 'Perf NAS', url: SERVER_URL, token: 'perf' }]
  return { items, progress, folders, servers, thumbs, library }
}

/**
 * The fixture plugin's code. Its library() is `library` with `poster:N` replaced by the Nth image;
 * search answers after `searchMs`, as a plugin on a fast network would.
 */
export function pluginCode(library: Meta[], posters: string[], searchMs = 50): string {
  return `const POSTERS = ${JSON.stringify(posters)}
const LIB = ${JSON.stringify(library)}.map((m) => ({ ...m, poster: POSTERS[Number(m.poster.slice(7))] }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
export default {
  api: 1, id: '${PLUGIN_ID}', name: 'Perf Films', version: '1.0.0', author: 'Flick perf', description: 'The perf fixture source.',
  hosts: [],
  catalogs: [{ id: 'popular', name: 'Popular', type: 'movie' }, { id: 'series', name: 'Series', type: 'series' }, { id: 'find', name: 'Find', type: 'movie', search: true }],
  async catalog(ctx, { id, search }) {
    if (search !== undefined) {
      await wait(${searchMs})
      const q = search.toLowerCase()
      return { items: LIB.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 40) }
    }
    return { items: LIB.filter((m) => (id === 'series') === (m.type === 'series')).slice(0, 40) }
  },
  async meta(ctx, { id }) {
    const m = LIB.find((x) => x.id === id) ?? LIB[0]
    return { ...m, description: 'A film from the perf fixture.', genres: ['Drama'], runtime: '1h 40m' }
  },
  async library() { return LIB },
  async streams() { return [] },
}
`
}

/**
 * A second plugin with shelves (the shape of tests/fixtures/shelves-plugin.js): Watch later, a list of
 * 1,000 videos, and Favorites, a poster grid of 60 films.
 */
export function shelvesPluginCode(posters: string[], count: number = COUNTS.shelfList): string {
  return `const POSTERS = ${JSON.stringify(posters)}
const ITEMS = Array.from({ length: ${count} }, (_, i) => ({
  id: 'sv' + i, type: 'video', name: 'Saved talk ' + (i + 1), subtitle: 'Channel ' + (i % 37), badges: [(i % 50) + 3 + ' min'],
  poster: POSTERS[i % POSTERS.length], posterShape: 'landscape', shelves: i < 60 ? ['later', 'fav'] : ['later'], added: 1760000000000 - i * 3600000,
}))
export default {
  api: 1, id: '${SHELF_PLUGIN_ID}', name: 'Perf Shelves', version: '1.0.0', author: 'Flick perf', description: 'The perf fixture with shelves.',
  hosts: [],
  catalogs: [{ id: 'recent', name: 'Recent', type: 'video' }],
  async catalog() { return { items: ITEMS.slice(0, 20) } },
  async meta(ctx, { id }) { return ITEMS.find((m) => m.id === id) ?? ITEMS[0] },
  async streams() { return [] },
  async library() {
    return { shelves: [{ id: 'later', name: 'Watch later', layout: 'list' }, { id: 'fav', name: 'Favorites', layout: 'poster' }], items: ITEMS }
  },
}
`
}
