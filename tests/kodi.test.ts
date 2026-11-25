import { describe, it, expect } from 'vitest'
import { kodiMap, kodiBase, type Server, type KodiLibrary } from '../src/lib/servers'
import { hash } from '../src/lib/library'

const open: Server = { id: 'kodi-a', type: 'kodi', name: 'Living Room', url: 'http://192.168.1.30:8080', token: '' }
const locked: Server = { ...open, token: btoa('kodi:p@ss word') }

// Trimmed from real JSON-RPC result shapes.
const lib: KodiLibrary = {
  movies: [
    {
      movieid: 7, title: 'Big Buck Bunny', year: 2008, runtime: 596, file: '/media/movies/Big Buck Bunny.mkv',
      art: { poster: 'image://%2fmedia%2fposter.jpg/', fanart: 'image://%2fmedia%2ffan.jpg/' }, dateadded: '2024-03-01 20:15:00',
    },
    { movieid: 8, title: 'No File', file: '' },
  ],
  episodes: [
    {
      episodeid: 42, title: 'Pilot', showtitle: 'The Show', season: 1, episode: 2, runtime: 1500, file: 'smb://nas/tv/The Show/S01E02.mkv',
      art: { thumb: 'image://thumb/', 'season.poster': 'image://season/', 'tvshow.poster': 'image://show/' }, dateadded: '',
    },
  ],
  songs: [{ songid: 3, title: 'Song', artist: ['Artist'], album: 'Album', duration: 201, file: '/music/a.flac', thumbnail: '' }],
}

describe('kodi mapping', () => {
  it('maps movies, episodes and songs to library items', () => {
    const items = kodiMap(open, lib)
    expect(items).toHaveLength(3)
    const [movie, ep, song] = items

    expect(movie).toMatchObject({
      id: hash('kodi-a:movie:7'), title: 'Big Buck Bunny', kind: 'video', origin: 'kodi', server: 'kodi-a', folder: 'Living Room',
      duration: 596, year: 2008, mtime: Date.parse('2024-03-01T20:15:00'),
      src: { t: 'url', url: 'http://192.168.1.30:8080/vfs/%2Fmedia%2Fmovies%2FBig%20Buck%20Bunny.mkv' },
      poster: 'http://192.168.1.30:8080/image/image%3A%2F%2F%252fmedia%252fposter.jpg%2F',
    })

    expect(ep).toMatchObject({ id: hash('kodi-a:episode:42'), show: 'The Show', season: 1, episode: 2, duration: 1500, mtime: 0 })
    expect(ep.poster).toBe('http://192.168.1.30:8080/image/image%3A%2F%2Fshow%2F')
    expect(ep.src).toEqual({ t: 'url', url: 'http://192.168.1.30:8080/vfs/smb%3A%2F%2Fnas%2Ftv%2FThe%20Show%2FS01E02.mkv' })

    expect(song).toMatchObject({ id: hash('kodi-a:song:3'), kind: 'audio', duration: 201, poster: undefined })
    expect(song.show).toBeUndefined()
  })

  it('keeps ids stable and distinct across types', () => {
    const a = kodiMap(open, { movies: [{ movieid: 1, title: 'A', file: 'a' }], episodes: [{ episodeid: 1, title: 'B', file: 'b' }] })
    const b = kodiMap(open, { movies: [{ movieid: 1, title: 'A', file: 'a' }] })
    expect(a[0].id).toBe(b[0].id)
    expect(a[0].id).not.toBe(a[1].id)
  })

  it('embeds the login in media URLs when Kodi has a password', () => {
    expect(kodiBase(open)).toBe('http://192.168.1.30:8080')
    expect(kodiBase(locked)).toBe('http://kodi:p%40ss%20word@192.168.1.30:8080')
    const [m] = kodiMap(locked, { movies: [{ movieid: 1, title: 'A', file: '/a.mp4' }] })
    expect(m.src).toEqual({ t: 'url', url: 'http://kodi:p%40ss%20word@192.168.1.30:8080/vfs/%2Fa.mp4' })
  })

  it('handles an empty library', () => {
    expect(kodiMap(open, {})).toEqual([])
  })
})
