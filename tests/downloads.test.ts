import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { download, downloadStream, savedId, resumeDownloads, localFor, cancelDownload, removeDownload, getDownload, downloads, pickExt, BROWSER_BLOCKED, _test, type Saved } from '../src/lib/downloads'
import { playSaved, watchedDownloads } from '../src/lib/offline'
import { nowPlaying } from '../src/lib/store'
import * as db from '../src/lib/db'
import { resolve, type Item } from '../src/lib/library'
import { saveServer } from '../src/lib/servers'

// The shell, faked. `desktop` switches between the apps and the website.
const shell = vi.hoisted(() => ({
  // The store (playSaved) reads the route at import.
  _: Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} }),
  desktop: false,
  ffmpeg: null as string | null,
  calls: [] as [string, any][],
  listeners: new Map<string, (p: any) => void>(),
  exists: true,
  playable: true,
}))
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  get isDesktop() { return shell.desktop },
  fileUrl: async (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  onDesktopEvent: async (name: string, cb: (p: any) => void) => {
    shell.listeners.set(name, cb)
    return () => shell.listeners.delete(name)
  },
  invoke: async (cmd: string, args: any) => {
    shell.calls.push([cmd, args])
    if (cmd === 'download') {
      shell.listeners.get('download-progress')?.({ id: args.id, done: 5, total: 10, part: `/data/downloads/${args.id}.${args.ext}.part` })
      return `/data/downloads/${args.id}.${args.ext}`
    }
    if (cmd === 'tool_download') {
      shell.listeners.get('download-progress')?.({ id: args.id, done: 3, total: 9, part: '' })
      return `/data/downloads/${args.id}.mp4`
    }
    if (cmd === 'download_exists') return shell.exists
    if (cmd === 'probe') return { playable: shell.playable }
    if (cmd === 'ffmpeg_status') return { ffmpeg: shell.ffmpeg }
    if (cmd === 'sidecar_subs') return []
    return null
  },
}))

// ---- an in-memory OPFS ----
type Files = Map<string, Uint8Array>
const notFound = () => new DOMException('not found', 'NotFoundError')
function fileHandle(files: Files, n: string) {
  return {
    async getFile() { return new File([files.get(n)! as BlobPart], n) },
    async createWritable(o?: { keepExistingData?: boolean }) {
      let buf = o?.keepExistingData ? files.get(n)!.slice() : new Uint8Array(0)
      let pos = 0
      return {
        async seek(p: number) { pos = p },
        async write(c: Uint8Array) {
          if (pos + c.byteLength > buf.length) { const nb = new Uint8Array(pos + c.byteLength); nb.set(buf); buf = nb }
          buf.set(c, pos)
          pos += c.byteLength
        },
        async close() { files.set(n, buf) },
      }
    },
  }
}
function fakeDir() {
  const files: Files = new Map()
  const dirs = new Map<string, ReturnType<typeof fakeDir>>()
  const dir = {
    files,
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
      if (!dirs.has(n)) { if (!o?.create) throw notFound(); dirs.set(n, fakeDir()) }
      return dirs.get(n)!
    },
    async getFileHandle(n: string, o?: { create?: boolean }) {
      if (!files.has(n)) { if (!o?.create) throw notFound(); files.set(n, new Uint8Array(0)) }
      return fileHandle(files, n)
    },
    async removeEntry(n: string) { if (!files.delete(n)) throw notFound() },
  }
  return dir
}
const opfs = fakeDir()
Object.defineProperty(globalThis.navigator, 'storage', {
  configurable: true,
  value: { getDirectory: async () => opfs, persist: async () => true },
})
const dlFiles = async () => (await opfs.getDirectoryHandle('downloads', { create: true })).files

// ---- a fake server ----
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) % 251)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const net = { order: [] as string[], live: 0, max: 0, ranges: [] as (string | null)[] }

/** Serves `data` in `chunks` pieces, `delay` ms apart. Honors Range only when `ranges`. */
function serve(data: Uint8Array, { chunks = 4, delay = 2, ranges = true } = {}) {
  return async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    net.order.push(url)
    net.ranges.push(range)
    net.live++
    net.max = Math.max(net.max, net.live)
    const from = ranges && range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    const body = data.slice(from)
    const size = Math.ceil(body.length / chunks)
    let at = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        await sleep(delay)
        if (at >= body.length) { net.live--; c.close(); return }
        c.enqueue(body.slice(at, at + size))
        at += size
      },
      cancel() { net.live-- },
    })
    const headers: Record<string, string> = { 'content-length': String(body.length) }
    if (from) headers['content-range'] = `bytes ${from}-${data.length - 1}/${data.length}`
    return new Response(stream, { status: from ? 206 : 200, headers })
  }
}

const item = (id: string, src: Item['src']): Item => ({ id, title: id, kind: 'video', src, origin: 'jellyfin', size: 0, mtime: 0, addedAt: 0 })

beforeEach(() => {
  shell.desktop = false
  shell.ffmpeg = null
  shell.calls = []
  shell.exists = true
  shell.playable = true
  net.order = []
  net.ranges = []
  net.max = net.live = 0
  _test.reset()
})

describe('downloads on the website', () => {
  it('runs one download at a time, in the order asked', async () => {
    const data = bytes(4000)
    vi.stubGlobal('fetch', serve(data, { chunks: 5, delay: 5 }))
    const its = ['qa', 'qb', 'qc'].map((id) => item(id, { t: 'url', url: `http://srv/Videos/${id}.mp4?api_key=k` }))
    await Promise.all(its.map(download))
    expect(downloads.value.get('qb')?.state).toBe('queued')
    await _test.idle()
    expect(net.order).toEqual(its.map((i) => (i.src as { url: string }).url))
    expect(net.max).toBe(1)
    for (const it of its) {
      expect(await getDownload(it.id)).toMatchObject({ state: 'done', done: 4000, total: 4000, local: { t: 'opfs', dir: 'downloads', name: `${it.id}.mp4` } })
      expect((await dlFiles()).get(`${it.id}.mp4`)).toEqual(data)
    }
  })

  it('publishes progress to the signal, throttled', async () => {
    const data = bytes(20000)
    vi.stubGlobal('fetch', serve(data, { chunks: 40, delay: 15 }))
    const seen: { state: string; done: number }[] = []
    const off = downloads.subscribe((m) => { const r = m.get('pr'); if (r) seen.push({ state: r.state, done: r.done }) })
    const t0 = Date.now()
    await download(item('pr', { t: 'url', url: 'http://srv/a.mkv' }))
    await _test.idle()
    const took = Date.now() - t0
    off()
    const mid = seen.filter((s) => s.state === 'downloading' && s.done > 0 && s.done < 20000)
    expect(mid.length).toBeGreaterThan(0)
    // About 4 updates a second, not one per chunk.
    expect(mid.length).toBeLessThanOrEqual(Math.ceil(took / 250) + 1)
    expect(mid.length).toBeLessThan(40)
    expect(seen.at(-1)).toEqual({ state: 'done', done: 20000 })
  })

  it('resumes a partial file with Range when the server answers 206', async () => {
    const data = bytes(5000, 3)
    ;(await dlFiles()).set('rs.mp4', new Uint8Array(1200))
    vi.stubGlobal('fetch', serve(data))
    await download(item('rs', { t: 'url', url: 'http://srv/rs.mp4' }))
    await _test.idle()
    expect(net.ranges).toEqual(['bytes=1200-'])
    const got = (await dlFiles()).get('rs.mp4')!
    expect(got.length).toBe(5000)
    expect(got.slice(0, 1200).every((b) => b === 0)).toBe(true)
    expect(got.slice(1200)).toEqual(data.slice(1200))
    expect(await getDownload('rs')).toMatchObject({ state: 'done', total: 5000 })
  })

  it('starts over when the server ignores Range', async () => {
    const data = bytes(3000, 5)
    ;(await dlFiles()).set('ro.mp4', new Uint8Array(1000))
    vi.stubGlobal('fetch', serve(data, { ranges: false }))
    await download(item('ro', { t: 'url', url: 'http://srv/ro.mp4' }))
    await _test.idle()
    expect(net.ranges).toEqual(['bytes=1000-'])
    expect((await dlFiles()).get('ro.mp4')).toEqual(data)
  })

  it('fails Kodi items and CORS refusals with the browser message', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    await download(item('kw', { t: 'kodi', server: 'kodi-a', url: 'http://kodi:8080/vfs/%2Fa.mp4' }))
    await download(item('cw', { t: 'url', url: 'http://other/a.mp4' }))
    await _test.idle()
    expect(await getDownload('kw')).toMatchObject({ state: 'failed', error: BROWSER_BLOCKED })
    expect(await getDownload('cw')).toMatchObject({ state: 'failed', error: BROWSER_BLOCKED })
  })

  it('queues an item once when download is called twice in one tick', async () => {
    vi.stubGlobal('fetch', serve(bytes(1000)))
    const it = item('dd', { t: 'url', url: 'http://srv/dd.mp4' })
    await Promise.all([download(it), download(it)])
    await _test.idle()
    expect(net.order).toEqual(['http://srv/dd.mp4'])
    expect(await getDownload('dd')).toMatchObject({ state: 'done', total: 1000 })
  })

  it('cancel keeps the partial file; remove deletes file and row', async () => {
    vi.stubGlobal('fetch', serve(bytes(8000), { chunks: 20, delay: 10 }))
    await download(item('cx', { t: 'url', url: 'http://srv/cx.mp4' }))
    await sleep(60)
    await cancelDownload('cx')
    expect(await getDownload('cx')).toMatchObject({ state: 'failed', error: 'Canceled' })
    const kept = (await dlFiles()).get('cx.mp4')!.length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(8000)
    await removeDownload('cx')
    expect((await dlFiles()).has('cx.mp4')).toBe(false)
    expect(await getDownload('cx')).toBeUndefined()
  })

  it('resolve plays a done download, and falls back and drops the row when the file is gone', async () => {
    const data = bytes(2000)
    vi.stubGlobal('fetch', serve(data))
    const it = item('rv', { t: 'url', url: 'http://srv/Videos/rv/stream?static=true' })
    expect(pickExt((it.src as { url: string }).url)).toBe('bin')
    await download(it)
    await _test.idle()
    const r = await resolve(it.src, undefined, it.id)
    expect(r.url.startsWith('blob:')).toBe(true)
    expect(new Uint8Array(await r.file!.arrayBuffer())).toEqual(data)
    r.revoke?.()
    // Without the item id, playback is the plain stream as before.
    expect((await resolve(it.src)).url).toBe('http://srv/Videos/rv/stream?static=true')

    ;(await dlFiles()).delete('rv.bin')
    expect((await resolve(it.src, undefined, it.id)).url).toBe('http://srv/Videos/rv/stream?static=true')
    expect(await getDownload(it.id)).toBeUndefined()
  })
})

describe('downloads in the apps', () => {
  it('asks the shell with the Kodi login as arguments and keeps the URL clean', async () => {
    shell.desktop = true
    await saveServer({ id: 'kodi-d', type: 'kodi', name: 'K', url: 'http://kodi:8080', token: btoa('kodi:p@ss') })
    const url = 'http://kodi:8080/vfs/smb%3A%2F%2Fnas%2FA%20Movie.mkv'
    await download(item('kd', { t: 'kodi', server: 'kodi-d', url }))
    await _test.idle()
    const call = shell.calls.find(([c]) => c === 'download')!
    expect(call[1]).toEqual({ id: 'kd', url, user: 'kodi', pass: 'p@ss', ext: 'mkv' })
    expect(await getDownload('kd')).toMatchObject({ state: 'done', local: { t: 'path', path: '/data/downloads/kd.mkv' } })
    expect((await getDownload('kd'))!.part).toBeUndefined()
  })

  it('resolve plays the local path, and falls back when it is gone', async () => {
    shell.desktop = true
    const it = item('kp', { t: 'url', url: 'https://plex.example/library/parts/1/2/file.mp4?X-Plex-Token=t' })
    await download(it)
    await _test.idle()
    expect((await resolve(it.src, undefined, it.id)).url).toBe(`asset://localhost/${encodeURIComponent('/data/downloads/kp.mp4')}`)
    shell.exists = false
    expect((await resolve(it.src, undefined, it.id)).url).toBe((it.src as { url: string }).url)
    expect(await getDownload(it.id)).toBeUndefined()
  })

  it('resolve falls back to the network when the local copy cannot play', async () => {
    shell.desktop = true
    const it = item('kf', { t: 'url', url: 'https://plex.example/library/parts/1/3/file.mkv?X-Plex-Token=t' })
    await download(it)
    await _test.idle()
    // Desktop without ffmpeg: the probe says not playable and there is nothing to remux with.
    shell.playable = false
    expect((await resolve(it.src, undefined, it.id)).url).toBe((it.src as { url: string }).url)
  })

  it('SPEC-playback rule 5: a local file the web view cannot play streams through the live remux, not prepare', async () => {
    shell.desktop = true
    shell.playable = false
    shell.ffmpeg = '/opt/homebrew/bin/ffmpeg'
    const r = await resolve({ t: 'path', path: '/Movies/Big.mkv' })
    expect(r.live).toEqual({ input: '/Movies/Big.mkv', user: '', pass: '' })
    expect(shell.calls.some(([c]) => c === 'prepare')).toBe(false)
    shell.playable = true
    const plain = await resolve({ t: 'path', path: '/Movies/a.mp4' })
    expect(plain.live).toBeUndefined()
    expect(plain.url).toBe(`asset://localhost/${encodeURIComponent('/Movies/a.mp4')}`)
  })
})

describe('books', () => {
  it('opens a desktop book as the file itself, with no probe, convert or subtitle search', async () => {
    shell.desktop = true
    shell.playable = false
    const r = await resolve({ t: 'path', path: '/Books/Dune.pdf' }, undefined, undefined, true)
    expect(r.url).toBe(`asset://localhost/${encodeURIComponent('/Books/Dune.pdf')}`)
    expect(shell.calls.map(([c]) => c)).toEqual([])
  })
})

// SPEC P4: plugin streams use the same queue, play from the saved file and keep their progress key.
describe('plugin stream downloads', () => {
  const ref = { t: 'plugin' as const, p: 'org.archive', type: 'movie', id: 'night', videoId: 'night' }
  // Each case its own title: finished rows stay in IndexedDB between cases.
  let n = 0
  const saved = (url: string, more: Partial<Saved> = {}): Saved => ({ key: `pl:org.archive:night${++n}`, plugin: 'org.archive', title: 'Night of the Living Dead', kind: 'video', url, ref, ...more })
  const ia = 'https://archive.org/download/night/night.mp4'
  const yt = 'flick-tool:ytdlp/0123456789abcdef0123456789abcdef'

  it('names a title by a hash of its progress key, the same every time', async () => {
    const id = await savedId('pl:org.archive:night')
    expect(id).toMatch(/^pl-[0-9a-f]{32}$/)
    expect(await savedId('pl:org.archive:night')).toBe(id)
    expect(await savedId('pl:org.archive:other')).not.toBe(id)
  })

  it('saves an Internet Archive file on the website and plays it with no network, under its progress key', async () => {
    const data = bytes(3000)
    vi.stubGlobal('fetch', serve(data))
    const id = await downloadStream(saved(ia))
    await _test.idle()
    const d = await getDownload(id)
    expect(d).toMatchObject({ state: 'done', local: { t: 'opfs', dir: 'downloads', name: `${id}.mp4` }, saved: { url: ia } })
    expect((await dlFiles()).get(`${id}.mp4`)).toEqual(data)
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    expect(await playSaved(d!)).toBe(true)
    const req = nowPlaying.value!
    expect(req).toMatchObject({ key: d!.saved!.key, src: { t: 'opfs', name: `${id}.mp4` }, ref })
    expect(req.url).toBeUndefined()
    expect((await resolve(req.src!)).url).toMatch(/^blob:/)
  })

  it('drops the bytes of a stream canceled partway when the viewer saves another stream of the title', async () => {
    const a = bytes(8000, 3), b = bytes(3000, 5)
    const s = saved(ia)
    vi.stubGlobal('fetch', serve(a, { chunks: 20, delay: 10 }))
    const id = await downloadStream(s)
    await sleep(60)
    await cancelDownload(id)
    expect((await dlFiles()).get(`${id}.mp4`)!.length).toBeGreaterThan(0)
    net.ranges = []
    vi.stubGlobal('fetch', serve(b))
    await downloadStream({ ...s, url: 'https://archive.org/download/night/night-512kb.mp4' })
    await _test.idle()
    expect(net.ranges).toEqual([null])
    expect((await dlFiles()).get(`${id}.mp4`)).toEqual(b)
    expect(await getDownload(id)).toMatchObject({ state: 'done', total: 3000, saved: { url: 'https://archive.org/download/night/night-512kb.mp4' } })
  })

  it('saves a yt-dlp stream with the desktop tool and reports its progress', async () => {
    shell.desktop = true
    const id = await downloadStream(saved(yt, { key: 'pl:com.youtube:https://www.youtube.com/watch?v=a', plugin: 'com.youtube' }))
    await _test.idle()
    expect(shell.calls.find(([c]) => c === 'tool_download')?.[1]).toEqual({ id, plugin: 'com.youtube', url: yt })
    expect(shell.calls.some(([c]) => c === 'download')).toBe(false)
    // The total came only from the tool's progress event.
    expect(await getDownload(id)).toMatchObject({ state: 'done', total: 9, local: { t: 'path', path: `/data/downloads/${id}.mp4` } })
  })

  it('never runs a yt-dlp stream on the website', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const id = await downloadStream(saved(yt))
    await _test.idle()
    expect(await getDownload(id)).toMatchObject({ state: 'failed', error: BROWSER_BLOCKED })
    expect(f).not.toHaveBeenCalled()
  })

  it('removing a finished download deletes the file, so the title streams again', async () => {
    shell.desktop = true
    const id = await downloadStream(saved(yt, { plugin: 'com.youtube' }))
    await _test.idle()
    expect(await localFor(id)).toEqual({ t: 'path', path: `/data/downloads/${id}.mp4` })
    await removeDownload(id)
    expect(shell.calls).toContainEqual(['download_remove', { path: `/data/downloads/${id}.mp4` }])
    expect(shell.calls).toContainEqual(['tool_download_clean', { id }])
    expect(await getDownload(id)).toBeUndefined()
    expect(await localFor(id)).toBeNull()
  })

  it('resumes a saved stream after a restart, though it is no library item', async () => {
    const s = saved(ia)
    const id = await savedId(s.key)
    await db.put('downloads', id, { id, state: 'downloading', done: 0, total: 0, at: 1, saved: s })
    vi.stubGlobal('fetch', serve(bytes(500)))
    await resumeDownloads()
    await _test.idle()
    expect(await getDownload(id)).toMatchObject({ state: 'done', total: 500, saved: { url: ia } })
  })

  it('counts a plugin title as watched by its progress key', () => {
    const d = { id: 'pl-x', state: 'done' as const, done: 1, total: 1, at: 10, saved: saved(ia, { key: 'pl:org.archive:night' }) }
    expect(watchedDownloads(new Map([['pl-x', d]]), { 'pl:org.archive:night': { pos: 95, dur: 100, at: 20 } })).toEqual(['pl-x'])
    expect(watchedDownloads(new Map([['pl-x', d]]), { 'pl-x': { pos: 95, dur: 100, at: 20 } })).toEqual([])
  })
})
