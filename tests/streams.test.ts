import { describe, expect, it } from 'vitest'
import { qualityOf, hdrOf, sizeOf, sections, best } from '../src/lib/plugins/streams'

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
