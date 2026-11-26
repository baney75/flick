import { describe, expect, it } from 'vitest'
import { candidatesOf, srcCandidates, streamCandidates } from '../src/lib/candidates'
import { rankedRows, ranked, srcKey, type Src } from '../src/lib/titles'
import type { Item } from '../src/lib/library'
import type { Meta } from '../src/lib/plugins/validate'

const item = (id: string, more: Partial<Item> = {}): Item =>
  ({ id, title: 'Film', kind: 'video', src: { t: 'path', path: `/m/${id}.mkv` }, origin: 'local', size: 2e9, mtime: 0, addedAt: 0, ...more })
const meta: Meta = { id: 'tt1', type: 'movie', name: 'Film' }

describe('candidates from sources', () => {
  it('maps where each source is', () => {
    const srcs: Src[] = [
      { t: 'item', it: item('a'), dl: true },
      { t: 'item', it: item('b') },
      { t: 'item', it: item('c', { origin: 'jellyfin', src: { t: 'url', url: 'https://nas/c.mp4?k=1' } }) },
      { t: 'plugin', p: 'org.x', pname: 'X', m: meta },
    ]
    expect(srcCandidates(srcs).map((c) => [c.id, c.place, c.via, c.format])).toEqual([
      ['dl:a', 'download', 'direct', 'mkv'], ['item:b', 'device', 'direct', 'mkv'], ['item:c', 'server', 'direct', 'mp4'], ['pl:org.x:tt1', 'plugin', 'direct', undefined],
    ])
  })
  it('carries the media, size, duration, episode and progress', () => {
    const ep = item('e', { kind: 'audiobook', show: 'S', duration: 60, src: { t: 'opfs', name: 'book.m4b' } })
    const [c] = srcCandidates([{ t: 'item', it: ep }], () => 5)
    expect(c).toMatchObject({ media: 'audiobook', sizeBytes: 2e9, durSec: 60, episode: true, progressAt: 5, format: 'm4b' })
  })
})

describe('candidates from streams', () => {
  it('ids, text, quality, subtitles and flags', () => {
    const cs = streamCandidates('k', [
      { url: 'https://h/a.epub', title: 'Book EPUB', kind: 'book' },
      { url: 'https://h/v', title: '1080p 🇬🇧', group: 'Torrentio', quality: '1080p', subs: [{ url: 'https://h/s', lang: 'eng' }] },
      { url: 'https://h/x', external: true, needsDesktop: true },
    ], { episode: true })
    expect(cs[0]).toMatchObject({ id: 'k#0', media: 'book', format: 'epub' })
    expect(cs[1]).toMatchObject({ id: 'k#1', media: 'video', text: '1080p 🇬🇧\nTorrentio', quality: '1080p', subs: [{ lang: 'eng' }], episode: true })
    expect(cs[2]).toMatchObject({ external: true, needsDesktop: true })
  })
  it('audio from an audiobook title is an audiobook', () =>
    expect(streamCandidates('k', [{ url: 'https://h/a.m4b', kind: 'audio' }], { audiobook: true })[0].media).toBe('audiobook'))
  it('candidatesOf orders streams after the library sources', () => {
    const cs = candidatesOf([{ t: 'item', it: item('a') }], { key: 'k', list: [{ url: 'https://h/v' }] })
    expect(cs.map((c) => [c.id, c.order])).toEqual([['item:a', 0], ['k#0', 1]])
  })
})

describe('the chooser order', () => {
  const dl: Src = { t: 'item', it: item('m'), dl: true }
  const srv: Src = { t: 'item', it: item('m', { origin: 'plex', src: { t: 'url', url: 'https://plex/m.mp4' } }), stream: true }
  const pl: Src = { t: 'plugin', p: 'org.x', pname: 'X', m: meta }
  it('with no preferences: download, server, plugin', () => expect(ranked([pl, srv, dl]).map(srcKey)).toEqual(['dl:m', 'item:m', 'pl:org.x:tt1']))
  it('offline greys the server and the plugin with the reason', () => {
    const by = { prefs: { audio: ['en'], subs: [], maxQuality: '4K' as const }, dev: { maxQuality: '1080p' as const, hdr: false, codecs: {}, desktop: false, phone: false }, ctx: { gate: false, vpnForDebrid: true, online: false } }
    expect(rankedRows([pl, srv, dl], undefined, by).map(({ s, r }) => [srcKey(s), r.blocked])).toEqual([['dl:m', undefined], ['item:m', 'Offline'], ['pl:org.x:tt1', 'Offline']])
  })
  it('the hand pick comes first', () => expect(ranked([dl, srv], 'item:m')[0]).toBe(srv))
})
