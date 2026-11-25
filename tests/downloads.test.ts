import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { download, cancelDownload, removeDownload, getDownload, downloads, pickExt, BROWSER_BLOCKED, _test } from '../src/lib/downloads'
import { resolve, type Item } from '../src/lib/library'
import { saveServer } from '../src/lib/servers'

// The shell, faked. `desktop` switches between the apps and the website.
const shell = vi.hoisted(() => ({
  desktop: false,
  calls: [] as [string, any][],
  listeners: new Map<string, (p: any) => void>(),
  exists: true,
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
    if (cmd === 'download_exists') return shell.exists
    if (cmd === 'probe') return { playable: true }
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
  shell.calls = []
  shell.exists = true
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
})
