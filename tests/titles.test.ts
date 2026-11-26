import { describe, it, expect, beforeEach } from 'vitest'
import { normTitle, buildTitles, ranked, srcKey, badgeOf, latestProgress, pickedFor, remember, type PluginLib } from '../src/lib/titles'
import type { Item, Origin } from '../src/lib/library'
import type { Meta } from '../src/lib/plugins/validate'

let n = 0
const movie = (title: string, year?: number, origin: Origin = 'jellyfin'): Item =>
  ({ id: `i${++n}`, title, year, kind: 'video', origin, src: { t: 'url', url: 'https://x/' }, size: 1, mtime: 0, addedAt: n })
const ep = (show: string, origin: Origin = 'plex'): Item => ({ ...movie(`${show} pilot`, undefined, origin), show, season: 1, episode: 1 })
const meta = (name: string, year?: string, type: Meta['type'] = 'movie'): Meta => ({ id: `m${++n}`, type, name, year } as Meta)
const stremio = (...list: Meta[]): PluginLib[] => [{ p: 'stremio', pname: 'Stremio', list }]
const showMap = (...eps: Item[]) => new Map(eps.map((e) => [e.show!.toLowerCase(), [e]]))
const none = () => false

describe('title names', () => {
  it('match across case, accents, punctuation and a leading The', () => {
    const cases: [string, string][] = [
      ['The Office', 'office'],
      ['Office', 'office'],
      ['Amélie', 'amelie'],
      ['Spider-Man: No Way Home', 'spider man no way home'],
      ['Fast & Furious', 'fast and furious'],
      ['  The  Matrix ', 'matrix'],
      ['Theodore', 'theodore'],
    ]
    for (const [a, b] of cases) expect(normTitle(a), a).toBe(b)
  })
})

describe('one library', () => {
  it('follows the spec case table', () => {
    // "Interstellar (2014)" on Jellyfin and in the Stremio library: one card, server first.
    let t = buildTitles([movie('Interstellar', 2014)], new Map(), stremio(meta('Interstellar', '2014')), none)
    expect(t).toHaveLength(1)
    expect(ranked(t[0].srcs).map((s) => s.t)).toEqual(['item', 'plugin'])
    expect(badgeOf(t[0])).toBe('Jellyfin · Stremio')

    // "The Office" on Plex, "Office" in Stremio: one card.
    t = buildTitles([], showMap(ep('The Office')), stremio(meta('Office', '2005–', 'series')), none)
    expect(t).toHaveLength(1)
    expect(t[0].type).toBe('show')

    // "Dune" 1984 on a server, "Dune" 2021 in Stremio: two cards.
    expect(buildTitles([movie('Dune', 1984)], new Map(), stremio(meta('Dune', '2021')), none)).toHaveLength(2)

    // "Dune" with no year on a server, "Dune" 2021 in Stremio: one card.
    t = buildTitles([movie('Dune')], new Map(), stremio(meta('Dune', '2021')), none)
    expect(t).toHaveLength(1)
    expect(t[0].year).toBe(2021)

    // Downloaded and on its server: Downloaded first, then the server.
    const m = movie('Heat', 1995)
    t = buildTitles([m], new Map(), [], (id) => id === m.id)
    expect(ranked(t[0].srcs).map((s) => srcKey(s))).toEqual([`dl:${m.id}`, `item:${m.id}`])

    // Only in Stremio: one source, so no sheet.
    t = buildTitles([], new Map(), stremio(meta('Arrival', '2016')), none)
    expect(t).toHaveLength(1)
    expect(t[0].srcs).toHaveLength(1)
  })

  it('keeps an undated title apart when two dated ones share its name', () => {
    const t = buildTitles([movie('Dune'), movie('Dune', 1984)], new Map(), stremio(meta('Dune', '2021')), none)
    expect(t.map((x) => x.year ?? null).sort()).toEqual([1984, 2021, null])
  })

  it('never merges a movie with a show, or plugin videos with each other', () => {
    expect(buildTitles([movie('Fargo', 1996)], showMap(ep('Fargo')), [], none)).toHaveLength(2)
    expect(buildTitles([], new Map(), stremio(meta('Clip', undefined, 'video'), meta('Clip', undefined, 'video')), none)).toHaveLength(2)
  })

  it('lists this device before servers and plugins', () => {
    const t = buildTitles([movie('Up', 2009, 'plex'), movie('Up', 2009, 'local')], new Map(), stremio(meta('Up', '2009')), none)
    expect(ranked(t[0].srcs).map((s) => (s.t === 'item' ? s.it.origin : s.t))).toEqual(['local', 'plex', 'plugin'])
  })
})

describe('the remembered pick', () => {
  beforeEach(() => { try { localStorage.clear() } catch { /* no storage in this runner */ } })
  it('comes first next time', () => {
    const t = buildTitles([movie('Interstellar', 2014)], new Map(), stremio(meta('Interstellar', '2014')), none)[0]
    const pl = t.srcs.find((s) => s.t === 'plugin')!
    remember(t.key, srcKey(pl))
    const picked = pickedFor(t.key)
    if (typeof localStorage !== 'undefined') expect(picked).toBe(srcKey(pl))
    expect(ranked(t.srcs, srcKey(pl))[0]).toBe(pl)
  })
})

describe('progress on a merged card', () => {
  it('comes from the source that saved last', () => {
    const it0 = movie('Interstellar', 2014)
    const m = { ...meta('Interstellar', '2014'), progress: { pos: 90, dur: 100, at: 50 } }
    const t = buildTitles([it0], new Map(), stremio(m), none)[0]
    expect(latestProgress(t, { [it0.id]: { pos: 10, dur: 100, at: 20 } }, () => undefined)).toBe(0.9)
    expect(latestProgress(t, { [it0.id]: { pos: 10, dur: 100, at: 99 } }, () => undefined)).toBe(0.1)
  })
})
