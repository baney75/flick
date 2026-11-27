import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { kodiLive, kodiMap, kodiNeedsFfmpeg, kodiResolve, kodiItems, saveServer, KODI_DESKTOP_ONLY, type Server, type KodiLibrary } from '../src/lib/servers'
import { hash, KODI_IMG } from '../src/lib/library'

// The shell, faked: invoke answers per command; protocolUrl builds the macOS form of convertFileSrc.
const shell = vi.hoisted(() => ({ mobile: false, apple: true, ffmpeg: '/opt/homebrew/bin/ffmpeg' as string | null, calls: [] as [string, any][], rpc: (_m: string, _p: any): any => ({}) }))
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  get isMobileApp() { return shell.mobile },
  get isApple() { return shell.apple },
  fileUrl: async (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  protocolUrl: async (p: string, proto: string) => `${proto}://localhost/${encodeURIComponent(p)}`,
  onDesktopEvent: async () => () => {},
  invoke: async (cmd: string, args: any) => {
    shell.calls.push([cmd, args])
    if (cmd === 'ffmpeg_status') return { ffmpeg: shell.ffmpeg }
    if (cmd === 'kodi_rpc') return shell.rpc(args.method, args.params)
    return null
  },
}))

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
      src: { t: 'kodi', server: 'kodi-a', url: 'http://192.168.1.30:8080/vfs/%2Fmedia%2Fmovies%2FBig%20Buck%20Bunny.mkv' },
      poster: 'http://192.168.1.30:8080/image/image%3A%2F%2F%252fmedia%252fposter.jpg%2F',
    })

    expect(ep).toMatchObject({ id: hash('kodi-a:episode:42'), show: 'The Show', season: 1, episode: 2, duration: 1500, mtime: 0 })
    expect(ep.poster).toBe('http://192.168.1.30:8080/image/image%3A%2F%2Fshow%2F')
    expect(ep.src).toEqual({ t: 'kodi', server: 'kodi-a', url: 'http://192.168.1.30:8080/vfs/smb%3A%2F%2Fnas%2Ftv%2FThe%20Show%2FS01E02.mkv' })

    expect(song).toMatchObject({ id: hash('kodi-a:song:3'), kind: 'audio', duration: 201, poster: undefined })
    expect(song.show).toBeUndefined()
  })

  it('keeps ids stable and distinct across types', () => {
    const a = kodiMap(open, { movies: [{ movieid: 1, title: 'A', file: 'a' }], episodes: [{ episodeid: 1, title: 'B', file: 'b' }] })
    const b = kodiMap(open, { movies: [{ movieid: 1, title: 'A', file: 'a' }] })
    expect(a[0].id).toBe(b[0].id)
    expect(a[0].id).not.toBe(a[1].id)
  })

  it('never puts the login in a URL, even when Kodi has a password', () => {
    for (const s of [open, locked]) {
      for (const it of kodiMap(s, lib)) {
        expect(it.src.t === 'kodi' && it.src.url).not.toContain('@')
        expect(it.poster ?? '').not.toContain('@')
      }
    }
    const [m] = kodiMap(locked, lib)
    expect(m.src).toEqual({ t: 'kodi', server: 'kodi-a', url: 'http://192.168.1.30:8080/vfs/%2Fmedia%2Fmovies%2FBig%20Buck%20Bunny.mkv' })
    // With a password, the poster is a marker the shell fetches with the login.
    expect(m.poster).toBe(`${KODI_IMG}image%3A%2F%2F%252fmedia%252fposter.jpg%2F`)
  })

  it('handles an empty library', () => {
    expect(kodiMap(open, {})).toEqual([])
  })

  it('says what to do when ffmpeg is missing', () => {
    expect(kodiNeedsFfmpeg()).toMatch(/install ffmpeg/i)
    expect(kodiNeedsFfmpeg()).toMatch(/MKV and AVI/)
  })
})

describe('kodi playback', () => {
  const src = (s: Server, file: string) => ({ t: 'kodi' as const, server: s.id, url: `${s.url}/vfs/${encodeURIComponent(file)}` })
  beforeEach(async () => {
    shell.mobile = false
    shell.apple = true
    shell.ffmpeg = '/opt/homebrew/bin/ffmpeg'
    shell.calls = []
    await saveServer(open)
    await saveServer({ ...locked, id: 'kodi-b' })
  })
  const lockedB = { ...locked, id: 'kodi-b' }

  it('plays a native file straight from a Kodi without a password', async () => {
    const s = src(open, '/m/A.mp4')
    expect((await kodiResolve(s)).url).toBe(s.url)
    expect(shell.calls).toEqual([])
  })

  it('streams a native file through the kodi:// proxy when Kodi has a password', async () => {
    const { url } = await kodiResolve(src(lockedB, '/m/A.mp4'))
    expect(url).toBe(`kodi://localhost/${encodeURIComponent('kodi-b/vfs/%2Fm%2FA.mp4')}`)
    expect(url).not.toContain('p%40ss')
    expect(shell.calls).toEqual([['kodi_proxy_register', { id: 'kodi-b', base: lockedB.url, user: 'kodi', pass: 'p@ss word' }]])
    // Registered once per session.
    await kodiResolve(src(lockedB, '/m/B.m4v'))
    expect(shell.calls.filter(([c]) => c === 'kodi_proxy_register')).toHaveLength(1)
    // Works on a phone too: no ffmpeg needed.
    shell.mobile = true
    shell.ffmpeg = null
    expect((await kodiResolve(src(lockedB, '/m/C.webm'))).url).toMatch(/^kodi:\/\/localhost\/kodi-b%2Fvfs%2F/)
  })

  it('plays OGG and Opus as they are off Apple, and still converts MKV', async () => {
    shell.apple = false
    expect((await kodiResolve(src(open, '/m/a.ogg'))).url).toBe(src(open, '/m/a.ogg').url)
    expect((await kodiResolve(src(lockedB, '/m/a.opus'))).url).toMatch(/^kodi:\/\/localhost\/kodi-b%2Fvfs%2F/)
    shell.mobile = true
    shell.ffmpeg = null
    expect((await kodiResolve(src(lockedB, '/m/a.oga'))).url).toMatch(/^kodi:\/\/localhost\/kodi-b%2Fvfs%2F/)
    await expect(kodiResolve(src(open, '/m/A.mkv'))).rejects.toThrow(KODI_DESKTOP_ONLY)
    expect(shell.calls.filter(([c]) => c === 'prepare')).toEqual([])
  })

  it('streams MKV, OGG and Opus through the live remux on the Mac, with the server login', async () => {
    for (const f of ['/m/A.mkv', '/m/a.ogg', '/m/a.opus']) {
      shell.calls = []
      expect(await kodiResolve(src(lockedB, f))).toEqual({ url: src(lockedB, f).url, live: { input: src(lockedB, f).url, user: 'kodi', pass: 'p@ss word' } })
      expect(shell.calls.some(([c]) => c === 'prepare')).toBe(false)
    }
    shell.ffmpeg = null
    await expect(kodiResolve(src(open, '/m/A.mkv'))).rejects.toThrow(/install ffmpeg/i)
  })

  it('streams an MP4 the web view could not play through the live remux, with the server login', async () => {
    // kodiResolve plays this MP4 as it is; the player calls kodiLive when the web view rejects it.
    expect((await kodiResolve(src(lockedB, '/m/ac3.mp4'))).url).toMatch(/^kodi:\/\//)
    shell.calls = []
    expect(await kodiLive(src(lockedB, '/m/ac3.mp4'))).toEqual({ input: src(lockedB, '/m/ac3.mp4').url, user: 'kodi', pass: 'p@ss word' })
    expect(shell.calls.some(([c]) => c === 'prepare')).toBe(false)
    shell.mobile = true
    await expect(kodiLive(src(lockedB, '/m/ac3.mp4'))).rejects.toThrow(KODI_DESKTOP_ONLY)
  })

  it('streams through the proxy on a phone even without a password', async () => {
    shell.mobile = true
    shell.ffmpeg = null
    expect((await kodiResolve(src(open, '/m/A.mp4'))).url).toBe(`kodi://localhost/${encodeURIComponent('kodi-a/vfs/%2Fm%2FA.mp4')}`)
    expect(shell.calls).toEqual([['kodi_proxy_register', { id: 'kodi-a', base: open.url, user: '', pass: '' }]])
    const [m] = kodiMap(open, lib)
    expect(m.poster?.startsWith(KODI_IMG)).toBe(true)
  })

  it('tells a phone that MKV needs the desktop app', async () => {
    shell.mobile = true
    await expect(kodiResolve(src(open, '/m/A.mkv'))).rejects.toThrow(KODI_DESKTOP_ONLY)
    expect(KODI_DESKTOP_ONLY).toMatch(/desktop app \(Mac, Windows or Linux\)/)
    expect(shell.calls.some(([c]) => c === 'prepare')).toBe(false)
  })

  it('pages library calls until the total is reached', async () => {
    const total = 4500
    const asked: Record<string, [number, number][]> = {}
    shell.rpc = (method, p) => {
      const { start, end } = p.limits
      ;(asked[method] ??= []).push([start, end])
      const n = method === 'VideoLibrary.GetMovies' ? total : method === 'VideoLibrary.GetEpisodes' ? 3 : 0
      const ids = Array.from({ length: Math.max(0, Math.min(end, n) - start) }, (_, i) => start + i)
      if (method === 'VideoLibrary.GetMovies') return { movies: ids.map((i) => ({ movieid: i, title: `M${i}`, file: `/m/${i}.mp4` })), limits: { start, end, total: n } }
      if (method === 'VideoLibrary.GetEpisodes') return { episodes: ids.map((i) => ({ episodeid: i, title: `E${i}`, file: `/e/${i}.mkv` })), limits: { start, end, total: n } }
      return { limits: { start: 0, end: 0, total: 0 } }
    }
    const items = await kodiItems(open)
    expect(asked['VideoLibrary.GetMovies']).toEqual([[0, 2000], [2000, 4000], [4000, 6000]])
    expect(asked['VideoLibrary.GetEpisodes']).toEqual([[0, 2000]])
    expect(asked['AudioLibrary.GetSongs']).toEqual([[0, 2000]])
    expect(items).toHaveLength(total + 3)
    expect(new Set(items.map((i) => i.id)).size).toBe(total + 3)
  })
})
