import { describe, expect, it } from 'vitest'
import { qualityOf, hdrOf, sizeOf, sections, best, downloadable } from '../src/lib/plugins/streams'

const s = (title: string, more: object = {}) => ({ url: `https://x/${title}`, title, ...more })

describe('stream quality', () => {
  it.each([
    [{ title: 'Movie.2023.2160p.WEB-DL' }, '4K'],
    [{ title: 'Torrentio 4K HDR' }, '4K'],
    [{ title: 'UHD BluRay' }, '4K'],
    [{ title: 'Movie 1080p x265' }, '1080p'],
    [{ title: 'FHD' }, '1080p'],
    [{ title: 'Movie 720p' }, '720p'],
    [{ title: 'Movie 480p' }, 'SD'],
    [{ title: 'DVDRip' }, 'SD'],
    [{ title: 'Some stream' }, 'Other'],
    [{ title: 'Movie 720p', quality: '1080p' }, '1080p'],
    [{ title: 'Movie1080pFile' }, 'Other'],
  ])('%j is %s', (x, q) => expect(qualityOf(x)).toBe(q))

  it('reads HDR and Dolby Vision', () => {
    expect(hdrOf({ title: '2160p HDR10+ x265' })).toBe('HDR')
    expect(hdrOf({ title: '2160p DV HDR' })).toBe('Dolby Vision')
    expect(hdrOf({ title: '1080p' })).toBeNull()
  })

  it('reads the size', () => {
    expect(sizeOf({ title: '👤 52 💾 2.14 GB ⚙️ ThePirateBay' })).toBe('2.14 GB')
    expect(sizeOf({ title: '700MB' })).toBe('700 MB')
    expect(sizeOf({ title: '1,5 GiB' })).toBe('1.5 GB')
    expect(sizeOf({ title: '1080p' })).toBeNull()
  })
})

describe('stream sections', () => {
  const list = [
    s('a 720p'), s('b 1080p'), s('c 4K', { external: true }), s('d 4K'), s('e'), s('f 1080p'),
  ]
  it('groups best quality first, keeps the source order, puts external last', () => {
    expect(sections(list).map((x) => [x.quality, x.streams.map((y) => y.title![0])])).toEqual([
      ['4K', ['d', 'c']], ['1080p', ['b', 'f']], ['720p', ['a']], ['Other', ['e']],
    ])
  })
  it('plays the best stream that plays in Flick', () => {
    expect(best(list)?.title).toBe('d 4K')
    expect(best([s('x 1080p', { external: true })])).toBeNull()
    expect(best([])).toBeNull()
  })
})

// SPEC P4 rule 19: Download shows on one-file http(s) streams, and on yt-dlp streams in the desktop app only.
describe('downloadable', () => {
  const desktop = { desktop: true, mobile: false }, web = { desktop: false, mobile: false }, phone = { desktop: true, mobile: true }
  const ia = { url: 'https://archive.org/download/night_of_the_living_dead/night.mp4' }
  const yt = { url: 'flick-tool:ytdlp/0123456789abcdef0123456789abcdef' }
  it.each([
    ['Internet Archive https mp4', ia, desktop, 'file'],
    ['Internet Archive https mp4 on the website', ia, web, 'file'],
    ['a LAN http file', { url: 'http://192.168.1.5:8080/a.mkv' }, phone, 'file'],
    ['a URL ending in .m3u8', { url: 'https://cdn.example/live/index.m3u8' }, desktop, null],
    ['an .M3U8 with a query', { url: 'https://cdn.example/a/master.M3U8?token=1' }, desktop, null],
    ['a DASH .mpd', { url: 'https://cdn.example/a/manifest.mpd' }, desktop, null],
    ['YouTube on the desktop app', yt, desktop, 'tool'],
    ['YouTube on the website', yt, web, null],
    ['YouTube in the phone app', yt, phone, null],
    ['an external link', { url: 'https://www.youtube.com/watch?v=x', external: true }, desktop, null],
    ['a book', { url: 'https://archive.org/download/x/x.pdf', kind: 'book' as const }, desktop, null],
    ['another tool', { url: 'flick-tool:other/abc' }, desktop, null],
  ])('%s', (_, st, app, want) => expect(downloadable(st, app)).toBe(want))
})
