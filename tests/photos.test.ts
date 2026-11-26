import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'

// offline.ts loads the store, which reads the page address.
vi.hoisted(() => Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} }))
import { itemKindOf, isArtwork } from '../src/lib/parse'
import { exifTaken, wallClock } from '../src/lib/exif'
import { photoSet, byMonth, takenAt, dirOf } from '../src/lib/photos'
import { _test, mergeScan, allItems, type Item } from '../src/lib/library'
import { flickMap, type Server } from '../src/lib/servers'
import { canDownload } from '../src/lib/offline'

const entry = (path: string, mtime = new Date(2026, 10, 3, 12).getTime()) =>
  _test.itemFromEntry({ path, name: path.split('/').pop()!, size: 10, mtime }, 'f')!

/** A JPEG holding only an EXIF block with DateTimeOriginal, in either byte order. */
function jpegWithDate(date: string, little = false): ArrayBuffer {
  const t: number[] = []
  const u16 = (n: number) => (little ? t.push(n & 255, n >> 8) : t.push(n >> 8, n & 255))
  const u32 = (n: number) => (little ? t.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24) : t.push(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255))
  t.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d])); u16(42); u32(8)
  // IFD0 at 8: the Exif IFD pointer to 26.
  u16(1); u16(0x8769); u16(4); u32(1); u32(26); u32(0)
  // Exif IFD at 26: DateTimeOriginal, 20 bytes at 44.
  u16(1); u16(0x9003); u16(2); u32(20); u32(44); u32(0)
  for (const c of date) t.push(c.charCodeAt(0))
  t.push(0)
  const len = t.length + 8
  const seg = [0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...'Exif'.split('').map((c) => c.charCodeAt(0)), 0, 0, ...t, 0xff, 0xda, 0, 2]
  return new Uint8Array(seg).buffer
}

describe('photo kind', () => {
  it('knows photo files, upper case extensions too', () => {
    for (const n of ['IMG_1234.JPG', 'a.jpeg', 'b.png', 'IMG_1235.HEIC', 'c.heif', 'd.webp', 'e.gif', 'f.avif', 'Beach cover.jpg']) {
      expect(itemKindOf(n), n).toBe('photo')
    }
    expect(itemKindOf('IMG_1237.MOV')).toBe('video')
  })

  it('leaves out posters, fan art and album covers', () => {
    for (const n of ['poster.jpg', 'fanart.jpg', 'folder.jpg', 'cover.png', 'backdrop2.jpg', 'Heat (1995)-fanart.jpg', 'Heat (1995)-poster.jpg', 'season01-poster.jpg', 'clearlogo.png', 'front.jpg', 'AlbumArtSmall.jpg']) {
      expect(isArtwork(n), n).toBe(true)
      expect(itemKindOf(n), n).toBe(null)
    }
  })

  it('titles a photo by its file name', () => {
    expect(entry('/p/IMG_1234.JPG')).toMatchObject({ kind: 'photo', title: 'IMG_1234' })
  })
})

describe('capture date', () => {
  it('reads EXIF DateTimeOriginal as the local wall clock, both byte orders', () => {
    const want = new Date(2024, 5, 1, 10, 20, 30).getTime()
    expect(exifTaken(jpegWithDate('2024:06:01 10:20:30'))).toBe(want)
    expect(exifTaken(jpegWithDate('2024:06:01 10:20:30', true))).toBe(want)
  })

  it('gives no date for a zero date, no EXIF or a file that is not a JPEG', () => {
    expect(exifTaken(jpegWithDate('0000:00:00 00:00:00'))).toBeUndefined()
    expect(exifTaken(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeUndefined()
    expect(exifTaken(new TextEncoder().encode('not a photo').buffer)).toBeUndefined()
    expect(exifTaken(jpegWithDate('2024:06:01 10:20:30').slice(0, 30))).toBeUndefined()
    // An APP1 segment whose length is too short to hold its own header.
    expect(exifTaken(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0x45, 0x78, 0x69, 0x66, 0, 0, 0xff, 0xda]).buffer)).toBeUndefined()
  })

  it('parses the flick-server form', () => {
    expect(wallClock('2024-06-01T10:20:30')).toBe(new Date(2024, 5, 1, 10, 20, 30).getTime())
    expect(wallClock(undefined)).toBeUndefined()
    expect(wallClock('2024-13-01T10:20:30')).toBeUndefined()
  })

  it('prefers the capture date and falls back to mtime', () => {
    expect(takenAt({ taken: 5, mtime: 9 })).toBe(5)
    expect(takenAt({ mtime: 9 })).toBe(9)
  })
})

describe('the Photos set', () => {
  it('a phone folder of 3 jpg, 1 heic and 1 mov is 5 items in one month', () => {
    const list = ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.JPG', 'IMG_4.HEIC', 'IMG_5.MOV'].map((n, i) => entry(`/phone/${n}`, new Date(2026, 10, 3 + i).getTime()))
    const set = photoSet(list)
    expect(set.length).toBe(5)
    const groups = byMonth(set)
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([['2026-11', 5]])
    // Newest first: the video from the 7th leads, and it is still a video for the rest of the library.
    expect(groups[0].items[0]).toMatchObject({ kind: 'video', title: 'IMG_5' })
  })

  it('a folder of movies has no Photos', () => {
    const list = ['/m/Heat (1995).mkv', '/m/Dune.2021.mp4', '/m/Heat (1995)-poster.jpg', '/m/fanart.jpg'].map((p) => _test.itemFromEntry({ path: p, name: p.split('/').pop()!, size: 1, mtime: 1 }, 'm')).filter(Boolean) as Item[]
    expect(photoSet(list)).toEqual([])
  })

  it('a picture named after a video beside it is a poster, not a photo', () => {
    const list = ['/m/Heat (1995).mkv', '/m/Heat (1995).jpg', '/m/Heat (1995)-thumb.jpg', '/m/movie.jpg', '/m/default.jpg', '/m/cdart.png',
      '/s/Show.S01E01.mkv', '/s/Show.S01E01.jpg'].map((p) => _test.itemFromEntry({ path: p, name: p.split('/').pop()!, size: 1, mtime: 1 }, 'm')).filter(Boolean) as Item[]
    expect(photoSet(list)).toEqual([])
    // The same name in another folder is a photo.
    expect(photoSet([...list, entry('/other/Heat (1995).jpg')]).map((i) => i.title)).toEqual(['Heat (1995)'])
  })

  it('a Live Photo keeps its picture and its video, camera counters that look like years too', () => {
    const list = ['/p/IMG_1234.HEIC', '/p/IMG_1234.MOV', '/p/IMG_2005.HEIC', '/p/IMG_2005.MOV', '/p/Wedding.mp4', '/p/Wedding-1.jpg'].map((p) => entry(p))
    expect(photoSet(list).map((i) => i.title).sort()).toEqual(['IMG_1234', 'IMG_1234', 'IMG_2005', 'IMG_2005', 'Wedding', 'Wedding-1'])
    const mov = entry('/p/IMG_2005.MOV')
    expect([mov.kind, mov.title, mov.year]).toEqual(['video', 'IMG_2005', undefined])
  })

  it('a server poster named after its video is not a photo', () => {
    const s: Server = { id: 'srv', type: 'flick', name: 'NAS', url: 'https://nas.example', token: 't' }
    const e = (id: string, path: string, kind: 'photo' | 'video') => ({ id, folder: 'Movies', path, name: path.split('/').pop()!, kind, ext: '', size: 1, mtime: 1 })
    const out = flickMap(s, { name: 'NAS', folders: ['Movies'], items: [e('v', 'Heat (1995)/Heat (1995).mkv', 'video'), e('p', 'Heat (1995)/Heat (1995).jpg', 'photo'), e('q', 'Trip/Heat (1995).jpg', 'photo'),
      e('lv', 'Trip/IMG_2005.MOV', 'video'), e('lp', 'Trip/IMG_2005.HEIC', 'photo')] })
    expect(out.filter((i) => i.kind === 'photo').map((i) => i.dir)).toEqual(['srv:Movies/Trip', 'srv:Movies/Trip'])
  })

  it('takes home videos only from folders with photos, and never titled movies', () => {
    const list = [entry('/p/IMG_1.jpg'), entry('/p/Clip.mp4'), entry('/p/Heat.1995.mp4'), entry('/p/Show.S01E01.mp4'), entry('/other/IMG_9.MOV')]
    expect(photoSet(list).map((i) => i.title).sort()).toEqual(['Clip', 'IMG_1'])
  })

  it('groups by month newest first, by capture date over mtime', () => {
    const a = { ...entry('/p/a.jpg', new Date(2026, 10, 1).getTime()), taken: new Date(2025, 0, 5).getTime() }
    const b = entry('/p/b.jpg', new Date(2026, 9, 9).getTime())
    const c = entry('/p/c.jpg', new Date(2026, 10, 20).getTime())
    expect(byMonth(photoSet([a, b, c])).map((g) => [g.key, g.items.map((i) => i.title)])).toEqual([['2026-11', ['c']], ['2026-10', ['b']], ['2025-01', ['a']]])
  })

  it('knows the folder of each kind of source', () => {
    expect(dirOf(entry('/p/x/IMG_1.jpg'))).toBe('/p/x')
    expect(dirOf({ src: { t: 'handle', root: 'r', rel: 'Trip/IMG_1.jpg' } })).toBe('r/Trip')
    expect(dirOf({ src: { t: 'handle', root: 'r', rel: 'IMG_1.jpg' } })).toBe('r/')
    expect(dirOf({ dir: 's:Phone', src: { t: 'session', key: 'k' } })).toBe('s:Phone')
  })
})

describe('library keeps photo dates', () => {
  it('a rescan keeps the date of an unchanged photo and drops it for a changed one', async () => {
    const a = entry('/keep/a.jpg')
    const b = entry('/keep/b.jpg')
    await mergeScan('f', [a, b])
    const { saveItems } = await import('../src/lib/library')
    await saveItems([{ ...a, taken: 111 }, { ...b, taken: 222 }])
    await mergeScan('f', [entry('/keep/a.jpg'), { ...entry('/keep/b.jpg'), size: 99 }])
    const byTitle = Object.fromEntries((await allItems()).filter((i) => i.folder === 'f').map((i) => [i.title, i.taken]))
    expect(byTitle).toEqual({ a: 111, b: undefined })
  })
})

describe('flick-server photos', () => {
  const s: Server = { id: 'srv', type: 'flick', name: 'NAS', url: 'https://nas.example', token: 'c o' }
  const f = (id: string, path: string, extra: object = {}) => ({ id, folder: 'Photos', path, name: path.split('/').pop()!, kind: 'photo' as const, ext: 'jpg', size: 5, mtime: 1700000000000, ...extra })

  it('lists photos with the server thumbnail, the capture date and their folder', () => {
    const out = flickMap(s, { name: 'NAS', folders: ['Photos'], items: [
      f('p1', '2024/IMG_1.jpg', { taken: '2024-06-01T10:20:30' }),
      f('p2', 'Movies/poster.jpg'),
      { ...f('v1', '2024/IMG_2.MOV'), kind: 'video', ext: 'mov' },
    ] })
    const photo = out.find((i) => i.kind === 'photo')!
    expect(out.filter((i) => i.kind === 'photo').length).toBe(1)
    expect(photo.poster).toBe('https://nas.example/thumb/p1?t=c%20o&v=1700000000000')
    expect(photo.src).toEqual({ t: 'url', url: 'https://nas.example/media/p1?t=c%20o' })
    expect(photo.taken).toBe(new Date(2024, 5, 1, 10, 20, 30).getTime())
    // The phone video beside it joins the set; its mtime (2023) sorts it after the 2024 photo.
    expect(photoSet(out).map((i) => i.kind)).toEqual(['photo', 'video'])
    expect(canDownload(photo)).toBe(false)
  })
})
