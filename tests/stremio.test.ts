import { describe, it, expect } from 'vitest'
import * as S from '../src/lib/stremio'

const addon = (resources: S.Manifest['resources'], extra: Partial<S.Manifest> = {}): S.Addon => ({
  transportUrl: 'https://addon.example/abc/manifest.json',
  manifest: { id: 'x', name: 'X', version: '1', types: ['movie', 'series'], idPrefixes: ['tt'], resources, catalogs: [], ...extra },
})

describe('stremio protocol', () => {
  it('normalizes addon URLs', () => {
    expect(S.normalizeAddonUrl('stremio://addon.example/abc/manifest.json')).toBe('https://addon.example/abc/manifest.json')
    expect(S.normalizeAddonUrl('https://addon.example/abc/')).toBe('https://addon.example/abc/manifest.json')
    expect(S.base('https://addon.example/abc/manifest.json')).toBe('https://addon.example/abc')
  })
  it('matches resources by type and id prefix', () => {
    const a = addon(['catalog', { name: 'stream', types: ['movie'], idPrefixes: ['tt'] }])
    expect(S.supports(a, 'stream', 'movie', 'tt123')).toBe(true)
    expect(S.supports(a, 'stream', 'series', 'tt123:1:1')).toBe(false)
    expect(S.supports(a, 'stream', 'movie', 'kitsu:1')).toBe(false)
    expect(S.supports(a, 'meta', 'movie', 'tt1')).toBe(false)
    expect(S.supports(a, 'catalog', 'series', 'tt1')).toBe(true)
  })
  it('skips catalogs that require search, builds catalog URLs', () => {
    const a = addon(['catalog'], { catalogs: [
      { type: 'movie', id: 'top' },
      { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'g', extra: [{ name: 'genre' }, { name: 'skip' }] },
    ] })
    expect(S.browsable(a).map((c) => c.id)).toEqual(['top', 'g'])
    expect(S.searchable(a).map((c) => c.id)).toEqual(['search'])
    expect(S.catalogUrl(a, a.manifest.catalogs[1], { search: 'dune part two' })).toBe('https://addon.example/abc/catalog/movie/search/search=dune%20part%20two.json')
  })
  it('plays direct URLs and hands off YouTube and external links', async () => {
    expect(await S.playable({ url: 'https://cdn/x.mp4' }, 'movie', 'tt1')).toEqual({ kind: 'play', url: 'https://cdn/x.mp4' })
    expect((await S.playable({ ytId: 'abc' }, 'movie', 'tt1')).kind).toBe('external')
    expect(await S.playable({ externalUrl: 'https://x' }, 'movie', 'tt1')).toMatchObject({ kind: 'external', url: 'https://x' })
  })
  it('orders continue watching by last watched', () => {
    const lib: S.LibraryItem[] = [
      { _id: 'a', name: 'A', type: 'movie', state: { timeOffset: 10, lastWatched: '2026-01-01T00:00:00Z' } },
      { _id: 'b', name: 'B', type: 'movie', state: { timeOffset: 0 } },
      { _id: 'c', name: 'C', type: 'movie', state: { timeOffset: 5, lastWatched: '2026-03-01T00:00:00Z' } },
    ]
    expect(S.continueWatching(lib).map((i) => i._id)).toEqual(['c', 'a'])
  })
})
