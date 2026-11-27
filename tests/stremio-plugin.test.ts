import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import code from '../plugins/stremio/plugin.js?raw'
// @ts-ignore: a plain JS plugin file with no types of its own
import * as S from '../plugins/stremio/plugin.js'
import * as db from '../src/lib/db'
import * as V from '../src/lib/plugins/validate'
import { installed, prepare, install, checkUpdates, remove, type Deps } from '../src/lib/plugins/registry'
import { migrateStremio, legacyProgress, STREMIO_ID } from '../src/lib/plugins/migrate'
import type { Progress } from '../src/lib/store'

const addon = (resources: unknown[], extra: Record<string, unknown> = {}) => ({
  transportUrl: 'https://addon.example/abc/manifest.json',
  manifest: { id: 'x', name: 'X', version: '1', types: ['movie', 'series'], idPrefixes: ['tt'], resources, catalogs: [], ...extra },
})

describe('Stremio plugin protocol', () => {
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
  })
  it('skips catalogs that require search, builds catalog URLs', () => {
    const a = addon(['catalog'], { catalogs: [
      { type: 'movie', id: 'top' },
      { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'g', extra: [{ name: 'genre' }, { name: 'skip' }] },
    ] })
    expect(S.browsable(a).map((c: { id: string }) => c.id)).toEqual(['top', 'g'])
    expect(S.searchable(a).map((c: { id: string }) => c.id)).toEqual(['search'])
    expect(S.catalogUrl(a, a.manifest.catalogs[1], { search: 'dune part two' })).toBe('https://addon.example/abc/catalog/movie/search/search=dune%20part%20two.json')
  })
  it('plays direct streams, hands off YouTube and external links, all valid for Flick', () => {
    const out = [
      S.toStream({ url: 'https://cdn/x.mp4', name: 'A' }, 'X'),
      S.toStream({ ytId: 'yt1' }, 'X'),
      S.toStream({ externalUrl: 'https://site.example/x' }, 'X'),
    ]
    expect(out.slice(1).every((s) => s.external)).toBe(true)
    expect(V.validateStreams(out)).toHaveLength(3)
  })
  it('turns an infoHash stream into a torrent, trackers from its tracker: sources (SPEC-torrent rule 3)', () => {
    const H = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
    const s = { infoHash: H.toUpperCase(), fileIdx: 2, name: 'Addon', title: '1080p', sources: ['tracker:udp://t.example:80', 'dht:x', 'tracker:udp://t.example:80', 'tracker:http://192.168.1.1/announce', 'tracker:udp://127.1:80', 'tracker:http://localhost./announce', 'tracker:udp://stremio.localhost.:80', 'tracker:ws://t.example', 'tracker:https://t.example/a'] }
    expect(S.toStream(s, 'X')).toEqual({ torrent: { infoHash: H, fileIdx: 2, trackers: ['udp://t.example:80', 'https://t.example/a'] }, title: 'Addon · 1080p', group: 'X', subs: [] })
    expect(S.toStream({ infoHash: H }, 'X')?.torrent).toEqual({ infoHash: H })
    expect(S.toStream({ infoHash: H, fileIdx: -1 }, 'X')?.torrent).toEqual({ infoHash: H })
    expect(S.toStream({ infoHash: 'abc' }, 'X')).toBeNull()
    const many = Array.from({ length: 60 }, (_, i) => `tracker:udp://t${i}.example:80`)
    expect(S.toStream({ infoHash: H, sources: many }, 'X')?.torrent?.trackers).toHaveLength(50)
    expect(V.validateStreams([S.toStream(s, 'X')])[0].torrent?.infoHash).toBe(H)
  })
  it('never plays a torrent around the VPN gate: no Stremio server URL, no hand-off', () => {
    expect(code).not.toMatch(/11470|web\.stremio\.com|\/\/127\.0\.0\.1|'127\.0\.0\.1'/)
    expect(S.default.hosts).toEqual(['*'])
  })
  it('plays only http(s) URLs on public hosts: no Stremio server, LAN server or magnet', () => {
    for (const url of [
      'http://127.0.0.1:11470/dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c/0',
      'http://127.1:11470/x', 'http://2130706433:11470/x', 'http://localhost:11470/x', 'http://stremio.localhost/x',
      'http://[::1]:11470/x', 'http://[::ffff:127.0.0.1]:11470/x', 'http://0.0.0.0:11470/x',
      'http://192.168.1.20:11470/x', 'http://10.0.0.5/x', 'http://172.20.0.1/x', 'http://169.254.1.1/x',
      'http://100.101.2.3/x', 'http://[fd7a:115c:a1e0::1]/x', 'http://[fe80::1]/x',
      'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c', 'file:///etc/passwd', 'not a url',
    ]) expect(S.toStream({ url }, 'X'), url).toBeNull()
    for (const url of ['https://cdn.example/a.mp4', 'http://8.8.8.8/a.mp4', 'https://172.32.0.1/a.mp4', 'https://[2606:4700::1]/a.mp4'])
      expect(S.toStream({ url }, 'X')?.url).toBe(url)
  })
  it('streams() returns no URL on this computer even when the Stremio server answers', async () => {
    const seen: string[] = []
    const ctx = {
      log: () => {},
      fetch: async (u: string) => {
        seen.push(u)
        const resources = u.startsWith('https://addon.example/') ? ['stream'] : []
        const body = u.endsWith('/manifest.json')
          ? { id: 'x', name: 'X', version: '1', types: ['movie'], idPrefixes: ['tt'], resources, catalogs: [] }
          : { streams: [{ infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c', fileIdx: 0 }, { url: 'https://cdn.example/a.mp4' }] }
        return new Response(JSON.stringify(body), { status: 200 })
      },
      settings: { addons: ['https://addon.example/abc/manifest.json'] },
      store: { get: async () => undefined, set: async () => {} },
    }
    const out = await S.default.streams(ctx, { type: 'movie', id: 'tt1', videoId: 'tt1' })
    expect(out.map((s: { url?: string; torrent?: { infoHash: string } }) => s.url ?? s.torrent?.infoHash)).toEqual(['dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c', 'https://cdn.example/a.mp4'])
    expect(seen.some((u) => /127\.0\.0\.1|:11470/.test(u))).toBe(false)
  })
})

describe('Stremio migration', () => {
  const fetched: string[] = []
  const deps: Deps = {
    fetchText: async (u) => { fetched.push(u); return code },
    inspect: async (c) => {
      const p = (await import(/* @vite-ignore */ 'data:text/javascript;charset=utf-8,' + encodeURIComponent(c))).default
      const data: Record<string, unknown> = {}, fns: string[] = []
      for (const [k, v] of Object.entries(p)) (typeof v === 'function' ? fns.push(k) : (data[k] = v))
      return { manifest: JSON.parse(JSON.stringify(data)), fns }
    },
  }
  const row = (ref: unknown): Progress => ({ pos: 100, dur: 3000, at: 5, title: 'Dune', ref: ref as Progress['ref'] })

  beforeEach(async () => {
    for (const s of ['kv', 'progress', 'plugins', 'pluginData'] as const) for (const [k] of await db.entries(s)) await db.del(s, k)
    installed.value = []
    fetched.length = 0
  })

  it('an installed copy with the Stremio server route updates to this one without a prompt', async () => {
    const old = code.replace("hosts: ['*']", "hosts: ['*', '127.0.0.1']")
    expect(old).not.toBe(code)
    const files: Record<string, string> = { 'https://p.example/stremio.js': old }
    const up: Deps = { ...deps, fetchText: async (u) => files[u] }
    const rec = await install(await prepare({ url: 'https://p.example/stremio.js' }, up))
    expect((rec.manifest as { hosts: string[] }).hosts).toEqual(['*', '127.0.0.1'])
    files['https://p.example/stremio.js'] = code
    await checkUpdates(rec.checkedAt + 25 * 3600_000, up)
    const now = installed.value.find((p) => p.id === rec.id)!
    expect((now.manifest as { hosts: string[] }).hosts).toEqual(['*'])
    expect(now.pending).toBeUndefined()
    expect(now.code).toBe(code)
    await remove(rec.id)
  })

  it('moves a Stremio user into the plugin: sign-in, addons, progress', async () => {
    await db.put('kv', 'stremio', { authKey: 'key-123', email: 'a@b.c', extra: ['https://torrentio.example/manifest.json'] })
    await db.put('kv', 'sync.doc', { secret: 's', rows: [['a:https://synced.example/manifest.json', { v: true }], ['a:https://gone.example/manifest.json', { v: null }]] })
    await db.put('progress', 'st:tt1:1:2', row({ t: 'stremio', type: 'series', id: 'tt1', videoId: 'tt1:1:2' }))
    await db.put('progress', 'file-1', row({ t: 'item', id: 'file-1' }))

    expect(await migrateStremio(deps)).toBe(true)
    expect(fetched).toEqual(['/plugins/stremio.js'])
    const rec = installed.value.find((p) => p.id === STREMIO_ID)!
    expect(rec.settings.addons).toEqual(['https://torrentio.example/manifest.json', 'https://synced.example/manifest.json'])
    expect(await db.get('pluginData', STREMIO_ID)).toMatchObject({ authKey: 'key-123', email: 'a@b.c' })
    expect(await db.get('progress', 'st:tt1:1:2')).toBeUndefined()
    expect((await db.get<Progress>('progress', `pl:${STREMIO_ID}:tt1:1:2`))!.ref).toEqual({ t: 'plugin', p: STREMIO_ID, type: 'series', id: 'tt1', videoId: 'tt1:1:2' })
    expect((await db.get<Progress>('progress', 'file-1'))!.ref).toEqual({ t: 'item', id: 'file-1' })
    expect(await db.get('kv', 'stremio')).toBeUndefined()
    // Once only.
    expect(await migrateStremio(deps)).toBe(false)
  })

  it('installs nothing for someone who never used Stremio', async () => {
    await db.put('kv', 'stremio', { authKey: null, email: null, extra: [] })
    await db.put('progress', 'file-1', row({ t: 'item', id: 'file-1' }))
    expect(await migrateStremio(deps)).toBe(false)
    expect(fetched).toEqual([])
    expect(installed.value).toEqual([])
    expect(await db.get('pluginData', STREMIO_ID)).toBeUndefined()
  })

  it('maps progress synced by a device that still has the old section', () => {
    expect(legacyProgress('st:tt9', row({ t: 'stremio', type: 'movie', id: 'tt9', videoId: 'tt9' }))![0]).toBe(`pl:${STREMIO_ID}:tt9`)
    expect(legacyProgress('x', row({ t: 'url', url: 'https://x' }))).toBeNull()
  })
})
