import 'fake-indexeddb/auto'
import { describe, expect, it, inject } from 'vitest'
import { mp4Info, id3Cover, blobRead, bookOf, groupAudiobooks, chapterAt, startSleep, sleepDue, bookSpeed, setBookSpeed, type Read } from '../src/lib/audiobook'
import { itemKindOf } from '../src/lib/parse'
import { flickMap, type Server } from '../src/lib/servers'
import type { Item } from '../src/lib/library'

declare module 'vitest' {
  export interface ProvidedContext { media: Record<string, string>; chapters: { title: string; start: number }[] }
}

const bytes = (name: string) => Uint8Array.from(atob(inject('media')[name]), (c) => c.charCodeAt(0))
const reader = (b: Uint8Array): [Read, number] => [blobRead(new Blob([b as BlobPart])), b.length]
/** Hides one box by renaming it, so the parser has to use the other chapter list. */
function hide(b: Uint8Array, box: string) {
  const c = b.slice()
  const i = new TextDecoder('latin1').decode(c).indexOf(box)
  expect(i).toBeGreaterThan(0)
  c.set(new TextEncoder().encode('free'), i)
  return c
}
const expected = inject('chapters')

describe('audiobook chapters', () => {
  it('reads the QuickTime chapter track of an M4B', async () => {
    const info = await mp4Info(...reader(hide(bytes('book.m4b'), 'chpl')))
    expect(info.chapters.map((c) => ({ ...c, start: Math.round(c.start * 10) / 10 }))).toEqual(expected)
  })

  it('reads Nero chpl chapters when there is no chapter track', async () => {
    const info = await mp4Info(...reader(hide(bytes('book.m4b'), 'chap')))
    expect(info.chapters.map((c) => ({ ...c, start: Math.round(c.start * 10) / 10 }))).toEqual(expected)
  })

  it('finds the cover art in an M4B and in an MP3 ID3 tag', async () => {
    const jpeg = bytes('cover.jpg')
    expect((await mp4Info(...reader(bytes('book.m4b')))).cover).toEqual(jpeg)
    expect(await id3Cover(reader(bytes('01 Part.mp3'))[0])).toEqual(jpeg)
    expect(await id3Cover(reader(bytes('02 Part.mp3'))[0])).toBeUndefined()
  })

  it('knows which chapter a time is in', () => {
    expect([0, 3.9, 4, 8.6, 99].map((t) => chapterAt(expected, t))).toEqual([0, 0, 1, 2, 2])
  })
})

describe('sleep timer', () => {
  it('stops at the end of the chapter playing when it was set', () => {
    const s = startSleep('chapter', 0, 5, expected, 12)
    expect(sleepDue(s, 0, 8)).toBe(false)
    expect(sleepDue(s, 0, 8.5)).toBe(true)
    // In the last chapter it stops at the end of the book.
    expect(startSleep('chapter', 0, 9, expected, 12)).toEqual({ at: 12 })
  })

  it('stops after the minutes chosen, wherever the book is', () => {
    const s = startSleep(15, 1000, 0, expected, 12)
    expect(sleepDue(s, 1000 + 15 * 60_000 - 1, 11)).toBe(false)
    expect(sleepDue(s, 1000 + 15 * 60_000, 0)).toBe(true)
    expect(sleepDue(null, Infinity, Infinity)).toBe(false)
  })
})

describe('speed per book', () => {
  it('keeps each book at its own speed and new books at the default', async () => {
    await setBookSpeed('a', 1.5)
    await setBookSpeed('b', 0.75)
    expect(await bookSpeed('a')).toBe(1.5)
    expect(await bookSpeed('b')).toBe(0.75)
    expect(await bookSpeed('c', 1.25)).toBe(1.25)
  })
})

describe('finding audiobooks', () => {
  it('treats M4B files as audiobooks', () => {
    expect(itemKindOf('Jane Doe - Dune.m4b')).toBe('audiobook')
    expect(itemKindOf('song.m4a')).toBe('audio')
  })

  it('names a book from its folder under Audiobooks', () => {
    expect(bookOf('/Users/me/Audiobooks/Frank Herbert/Dune/01.mp3')).toEqual({ dir: '/Users/me/Audiobooks/Frank Herbert/Dune', title: 'Dune', author: 'Frank Herbert' })
    expect(bookOf('Audio Books/Frank Herbert - Dune (1965)/CD 2/01.mp3')).toEqual({ dir: 'Audio Books/Frank Herbert - Dune (1965)', title: 'Dune', author: 'Frank Herbert' })
    expect(bookOf('Music/Artist/Album/01.mp3')).toBeNull()
    expect(bookOf('Audiobooks/loose.mp3')).toBeNull()
  })

  it('makes one item per book from a server, parts in natural order', () => {
    const s: Server = { id: 'nas', type: 'flick', name: 'NAS', url: 'https://nas', token: 't' }
    const f = (id: string, path: string, folder = 'Audiobooks') => ({ id, folder, path, name: path.split('/').pop()!, kind: 'audio' as const, ext: 'mp3', size: 10, mtime: 1 })
    const out = flickMap(s, { name: 'NAS', folders: [], items: [f('a', 'Jane Doe/Test Book/10 Part.mp3'), f('b', 'Jane Doe/Test Book/2 Part.mp3'), f('c', 'Album/song.mp3', 'Music'),
      { ...f('d', 'Jane Doe - Other.m4b'), ext: 'm4b' }] })
    const book = out.find((i) => i.kind === 'audiobook' && i.parts)!
    expect(book).toMatchObject({ title: 'Test Book', author: 'Jane Doe', size: 20 })
    expect(book.parts!.map((p) => p.title)).toEqual(['2 Part', '10 Part'])
    expect(out.find((i) => i.title === 'Other')).toMatchObject({ kind: 'audiobook', author: 'Jane Doe' })
    expect(out.filter((i) => i.kind === 'audio').map((i) => i.title)).toEqual(['Song'])
    expect(groupAudiobooks([], () => '')).toEqual([])
  })
})

export type { Item }
