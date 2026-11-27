import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import * as V from '../src/lib/plugins/validate'
import { connect } from '../src/lib/plugins/rpc'
import { ctxHandler, openFrame, SANDBOX, sha256 } from '../src/lib/plugins/runtime'
import * as R from '../src/lib/plugins/registry'
import { themeCss, applyTheme } from '../src/lib/plugins/themes'
import * as db from '../src/lib/db'

const FNS = ['catalog', 'meta', 'streams']
const manifest = (over: Record<string, unknown> = {}) => ({
  api: 1, id: 'org.example.films', name: 'Films', version: '1.0.0', hosts: ['example.org'],
  catalogs: [{ id: 'top', name: 'Top', type: 'movie' }], ...over,
})

describe('plugin validation', () => {
  it('accepts a good manifest and fills defaults', () => {
    const m = V.validateManifest(manifest(), FNS)
    expect(m.platforms).toEqual(['web', 'desktop', 'mobile'])
    expect(m.tools).toEqual([])
    expect(m.has).toEqual({ library: false, action: false, progress: false, subtitles: false, userCatalogs: false, addonUrls: false, extensions: false })
  })
  it('refuses bad ids, hosts, tools, types, API versions and missing functions', () => {
    expect(() => V.validateManifest(manifest({ id: 'Films' }), FNS)).toThrow(/reverse-DNS/)
    expect(() => V.validateManifest(manifest({ hosts: ['https://example.org/x'] }), FNS)).toThrow(/not a host name/)
    expect(() => V.validateManifest(manifest({ tools: ['shell'] }), FNS)).toThrow(/no desktop tool/)
    expect(() => V.validateManifest(manifest({ catalogs: [{ id: 'a', name: 'A', type: 'Porn' }] }), FNS)).toThrow(/not one of/)
    expect(() => V.validateManifest(manifest({ api: 2 }), FNS)).toThrow(/API 2/)
    expect(() => V.validateManifest(manifest(), ['catalog', 'meta'])).toThrow(/streams\(\)/)
    expect(() => V.validateManifest(manifest({ actions: [{ id: 'in', label: 'Sign in' }] }), FNS)).toThrow(/action\(\)/)
  })
  it('reads title actions: one-letter keys, unique, with a titleAction() function', () => {
    const acts = [{ id: 'like', label: 'Like', key: 'L' }, { id: 'later', label: 'Watch later', key: 'w' }]
    expect(V.validateManifest(manifest({ titleActions: acts }), [...FNS, 'titleAction']).titleActions).toEqual([{ id: 'like', label: 'Like', key: 'l' }, { id: 'later', label: 'Watch later', key: 'w' }])
    expect(() => V.validateManifest(manifest({ titleActions: acts }), FNS)).toThrow(/titleAction\(\)/)
    expect(() => V.validateManifest(manifest({ titleActions: [{ id: 'a', label: 'A', key: 'ab' }] }), [...FNS, 'titleAction'])).toThrow(/one letter/)
    expect(() => V.validateManifest(manifest({ titleActions: [{ id: 'a', label: 'A', key: '/' }] }), [...FNS, 'titleAction'])).toThrow(/one letter/)
    expect(() => V.validateManifest(manifest({ titleActions: [{ id: 'a', label: 'A', key: 'w' }, { id: 'b', label: 'B', key: 'W' }] }), [...FNS, 'titleAction'])).toThrow(/share a key/)
    expect(V.validateTitleAction({ ok: true, on: true, message: 'Liked' })).toEqual({ ok: true, on: true, message: 'Liked' })
    expect(() => V.validateTitleAction({ ok: true })).toThrow(/on/)
    expect(V.validateTitleAction({ ok: false, message: 'Offline' })).toEqual({ ok: false, on: false, message: 'Offline' })
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }))
    expect(() => V.validateManifest(manifest({ titleActions: seven }), [...FNS, 'titleAction'])).toThrow(/at most 6/)
    expect(V.validateMeta({ id: 'a', type: 'video', name: 'A', marks: ['like', 'Bad Id', 3] }).marks).toEqual(['like'])
  })
  it('reads a layout: rows by default, grid when asked, anything else refused', () => {
    expect(V.validateManifest(manifest(), FNS).layout).toBe('rows')
    expect(V.validateManifest(manifest({ layout: 'grid' }), FNS).layout).toBe('grid')
    expect(() => V.validateManifest(manifest({ layout: 'list' }), FNS)).toThrow(/layout/)
  })
  it('marks password fields secret', () => {
    const m = V.validateManifest(manifest({ actions: [{ id: 'in', label: 'Sign in', fields: [{ key: 'pw', type: 'password' }] }] }), [...FNS, 'action'])
    expect(m.actions[0].fields[0].secret).toBe(true)
  })
  it('keeps only playable stream URLs', () => {
    const s = V.validateStreams([
      { url: 'https://cdn.example/a.mp4', title: 'A' },
      { url: 'javascript:alert(1)' },
      { url: 'file:///etc/passwd' },
      { url: 'http://192.168.1.2/b.mkv', needsDesktop: true },
      { url: 'http://x.example/c', external: true },
      { url: 'https://x.example/d', external: true, subs: [{ url: 'data:text/vtt,x', lang: 'en' }, { url: 'https://s/x.srt', lang: 'en' }] },
    ])
    expect(s.map((x) => x.url)).toEqual(['https://cdn.example/a.mp4', 'http://192.168.1.2/b.mkv', 'https://x.example/d'])
    expect(s[2].subs).toEqual([{ url: 'https://s/x.srt', lang: 'en' }])
  })
  it('takes a torrent in place of a url, checked like the desktop engine checks it (SPEC-torrent rule 2)', () => {
    const H = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
    const s = V.validateStreams([
      { torrent: { infoHash: H.toUpperCase(), fileIdx: 2, trackers: ['udp://t.example:80', 'https://t.example/a'] }, title: 'T', group: 'G', kind: 'book', external: true, needsDesktop: true },
      { torrent: { infoHash: H } },
      { url: 'https://cdn.example/a.mp4', torrent: { infoHash: 'not a hash' } },
    ])
    expect(s[0]).toEqual({ torrent: { infoHash: H, fileIdx: 2, trackers: ['udp://t.example:80', 'https://t.example/a'] }, title: 'T', group: 'G' })
    expect(s[1]).toEqual({ torrent: { infoHash: H } })
    // A null torrent is an absent one, and an empty url is no url.
    expect(V.validateStreams([{ url: 'https://cdn.example/a.mp4', torrent: null }, { url: undefined, torrent: null }])).toEqual([{ url: 'https://cdn.example/a.mp4' }])
    expect(V.validateStreams([{ url: ' ', torrent: { infoHash: H } }])).toEqual([{ torrent: { infoHash: H } }])
    expect(s[2]).toEqual({ url: 'https://cdn.example/a.mp4' })
    const bad = (torrent: unknown) => () => V.validateStreams([{ torrent }])
    expect(bad({ infoHash: H.slice(0, 39) })).toThrow('torrent.infoHash must be 40 hex characters.')
    expect(bad({ infoHash: `${H.slice(0, 39)}g` })).toThrow('torrent.infoHash')
    expect(bad({})).toThrow('torrent.infoHash')
    expect(bad('magnet:?xt=urn:btih:x')).toThrow('torrent must be')
    for (const fileIdx of [-1, 1.5, '2', null]) expect(bad({ infoHash: H, fileIdx })).toThrow('torrent.fileIdx')
    // The file's name inside the torrent: text of at most 512 characters, trimmed.
    expect(V.validateStreams([{ torrent: { infoHash: H, name: ` ${'n'.repeat(512)} ` } }])[0].torrent?.name).toBe('n'.repeat(512))
    expect(bad({ infoHash: H, name: 'n'.repeat(513) })).toThrow('torrent.name is at most 512 characters.')
    expect(bad({ infoHash: H, name: { x: 1 } })).toThrow('torrent.name must be text.')
    for (const t of ['file:///etc/passwd', 'ws://t.example', 'UDP://t.example:80', 'udp://', 'udp://a b', 'http:t.example', 7])
      expect(bad({ infoHash: H, trackers: [t] }), String(t)).toThrow('torrent.trackers takes udp, http and https trackers')
    expect(bad({ infoHash: H, trackers: 'udp://t.example:80' })).toThrow('torrent.trackers must be a list.')
    expect(bad({ infoHash: H, trackers: [`https://t.example/${'a'.repeat(2048)}`] })).toThrow('at most 2048 bytes')
    const many = Array.from({ length: 51 }, (_, i) => `udp://t${i}.example:80`)
    expect(bad({ infoHash: H, trackers: many })).toThrow('at most 50 trackers')
    expect(V.validateStreams([{ torrent: { infoHash: H, trackers: many.slice(0, 50) } }])[0].torrent?.trackers).toHaveLength(50)
  })
  it('skips bad metas, trims strings and caps items at 200', () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, type: 'movie', name: 'x'.repeat(3000), poster: 'javascript:1' }))
    items.splice(1, 0, { id: 'bad', type: 'Nope', name: 'Bad', poster: '' })
    const r = V.validateCatalog({ items, more: true })
    expect(r.items.length).toBe(199)
    expect(r.items[0].name.length).toBe(2000)
    expect(r.items[0].poster).toBeUndefined()
    expect(r.more).toBe(true)
    expect(() => V.validateCatalog('nope')).toThrow()
  })
})

describe('install errors name the step that failed', () => {
  const ok: R.Deps = { fetchText: async () => 'code', inspect: async () => ({ manifest: manifest(), fns: FNS }) }
  it.each([
    ['the download', { ...ok, fetchText: async () => { throw new TypeError('Load failed') } }, 'Downloading the plugin failed: Load failed'],
    ['a 404', { ...ok, fetchText: async (u: string) => { throw new Error(`${u} answered 404.`) } }, 'Downloading the plugin failed: https://p.example/x.js answered 404.'],
    ['the sandbox', { ...ok, inspect: async () => { throw new Error('The plugin sandbox did not start.') } }, 'Starting the plugin failed: The plugin sandbox did not start.'],
    ['a string thrown', { ...ok, inspect: async () => { throw 'gone' } }, 'Starting the plugin failed: gone'],
    ['the manifest', { ...ok, inspect: async () => ({ manifest: manifest({ id: 'Films' }), fns: FNS }) }, /^Checking the plugin failed: .*reverse-DNS/],
    ['a theme', { ...ok, fetchText: async () => '{"nope":1}' }, /^Checking the theme failed: /],
  ] as [string, R.Deps, string | RegExp][])('%s', async (_, deps, msg) => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [] }) }))
    await expect(R.prepare({ url: 'https://p.example/x.js' }, deps)).rejects.toThrow(msg)
  })
  it('an address or size problem keeps its own words', async () => {
    await expect(R.prepare({ url: 'ftp://x' }, ok)).rejects.toThrow(/^A plugin address must start with https:\/\/\.$/)
  })
  it('saving', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [] }) }))
    const c = await R.prepare({ url: 'https://p.example/x.js' }, ok)
    const put = vi.spyOn(db, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'))
    await expect(R.install(c)).rejects.toThrow('Saving the plugin failed: QuotaExceededError')
    put.mockRestore()
  })
})

describe('update permission rule', () => {
  it('lists only new hosts and tools', () => {
    expect(V.addedPermissions({ hosts: ['a.org'], tools: [] }, { hosts: ['a.org'], tools: [] })).toEqual([])
    expect(V.addedPermissions({ hosts: ['a.org', 'b.org'], tools: ['ytdlp'] }, { hosts: ['a.org'], tools: [] })).toEqual([])
    expect(V.addedPermissions({ hosts: ['a.org'], tools: [] }, { hosts: ['a.org', '*'], tools: ['ytdlp'] })).toEqual(['reach *', 'use ytdlp'])
  })

  it('updates quietly with the same permissions and holds new ones for a tap', async () => {
    const files: Record<string, string> = { 'https://p.example/plugin.js': 'v1' }
    const hostsOf: Record<string, string[]> = { v1: ['example.org'], v2: ['example.org'], v3: ['example.org', 'evil.example'] }
    const deps: R.Deps = {
      fetchText: async (u) => files[u],
      inspect: async (code) => ({ manifest: manifest({ version: code, hosts: hostsOf[code] }), fns: FNS }),
    }
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [] }) }))
    const rec = await R.install(await R.prepare({ url: 'https://p.example/plugin.js' }, deps))
    expect(rec.manifest.version).toBe('v1')

    files['https://p.example/plugin.js'] = 'v2'
    await R.checkUpdates(rec.checkedAt + 25 * 3600_000, deps)
    let now = R.installed.value.find((p) => p.id === rec.id)!
    expect(now.manifest.version).toBe('v2')
    expect(now.pending).toBeUndefined()

    files['https://p.example/plugin.js'] = 'v3'
    const notes = await R.checkUpdates(now.checkedAt + 25 * 3600_000, deps)
    now = R.installed.value.find((p) => p.id === rec.id)!
    expect(now.manifest.version).toBe('v2')
    expect(now.pending?.added).toEqual(['reach evil.example'])
    expect(notes[0]).toMatch(/evil\.example/)

    await R.acceptUpdate(rec.id)
    now = R.installed.value.find((p) => p.id === rec.id)!
    expect(now.manifest.version).toBe('v3')
    expect(now.sha256).toBe(await sha256('v3'))
    await R.remove(rec.id)
    vi.unstubAllGlobals()
  })

  it('keeps secret settings off the synced list', async () => {
    const m = V.validateManifest(manifest({ settings: [{ key: 'lang', label: 'L' }, { key: 'token', label: 'T', secret: true }] }), FNS)
    const rec = { kind: 'source', manifest: m, settings: { lang: 'en', token: 'abc' } } as unknown as R.Installed
    expect(R.publicSettings(rec)).toEqual({ lang: 'en' })
  })
})

describe('themes', () => {
  const theme = {
    flick: 'theme', api: 1, id: 'com.example.forest', name: 'Forest', version: '1.0.0',
    light: { bg: '#f4f1ea', surface: '#ffffff', fg: '#1d2420', dim: '#5c675f', line: '#dcd6c8', accent: '#2f7a4f' },
    dark: { bg: '#101512', surface: '#18201b', fg: '#eef2ec', dim: '#9aa79d', line: '#26302a', accent: '#5cc488' },
    radius: 12,
  }
  it('measures contrast like WCAG', () => {
    expect(V.contrast('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(V.contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })
  it('refuses a theme under 4.5:1 and bad colors', () => {
    expect(V.validateTheme(theme).name).toBe('Forest')
    expect(() => V.validateTheme({ ...theme, dark: { ...theme.dark, fg: '#3a3a3a' } })).toThrow(/contrast/)
    expect(() => V.validateTheme({ ...theme, light: { ...theme.light, surface: '#4a4a4a' } })).toThrow(/fg on surface/)
    expect(() => V.validateTheme({ ...theme, light: { ...theme.light, accent: 'red; } body { display:none' } })).toThrow(/color/)
    expect(() => V.validateTheme({ ...theme, font: "x'; } *{" })).toThrow(/font/)
    expect(() => V.validateTheme({ ...theme, radius: 99 })).toThrow(/radius/)
  })
  it('writes CSS variables over the built-in ones', () => {
    const css = themeCss(V.validateTheme(theme))
    expect(css).toContain(':root:root { --bg: #101512')
    expect(css).toContain("[data-theme='light'] { --bg: #f4f1ea")
    expect(css).toContain('--radius: 12px')
    const head: unknown[] = []
    const doc = { getElementById: () => null, createElement: () => ({}), head: { appendChild: (x: unknown) => head.push(x) } } as unknown as Document
    expect(() => applyTheme({ ...theme, dark: { ...theme.dark, fg: '#111111' } } as unknown as V.ThemeManifest, doc)).toThrow(/contrast/)
    expect(head.length).toBe(0)
  })
})

describe('plugin RPC', () => {
  it('answers calls both ways', async () => {
    const ch = new MessageChannel()
    const a = connect(ch.port1, async () => null)
    const b = connect(ch.port2, async (m, args) => (m === 'add' ? (args[0] as number) + (args[1] as number) : Promise.reject(new Error('no'))))
    expect(await a.call('add', [2, 3])).toBe(5)
    await expect(a.call('other')).rejects.toThrow('no')
    a.close(); b.close()
  })
  it('gives up on a call that takes too long', async () => {
    const ch = new MessageChannel()
    const a = connect(ch.port1, async () => null, 60)
    const b = connect(ch.port2, () => new Promise(() => {}))
    const t0 = Date.now()
    await expect(a.call('hang')).rejects.toThrow(/longer than/)
    expect(Date.now() - t0).toBeLessThan(1000)
    a.close(); b.close()
  })
  it('uses a 20 second limit by default', () => {
    expect(V.CALL_TIMEOUT_MS).toBe(20_000)
  })
})

describe('plugin isolation', () => {
  it('runs each plugin in an opaque-origin sandbox', async () => {
    const attrs: Record<string, string> = {}
    const iframe = { setAttribute: (k: string, v: string) => (attrs[k] = v), addEventListener: () => {}, remove: () => {} }
    const doc = { createElement: () => iframe, body: { appendChild: () => {} } } as unknown as Document
    openFrame(async () => null, doc).catch(() => {})
    expect(SANDBOX).toBe('allow-scripts')
    expect(attrs.sandbox).toBe('allow-scripts')
  })
  it('gives a plugin only its own store, whatever id it sends', async () => {
    const a = ctxHandler('org.a.one'), b = ctxHandler('org.b.two')
    await a('store.set', ['authKey', 'secret-a'])
    expect(await a('store.get', ['authKey'])).toBe('secret-a')
    expect(await b('store.get', ['authKey', 'org.a.one'])).toBeNull()
    expect(await b('store.get', ['org.a.one'])).toBeNull()
    expect(await db.get('pluginData', 'org.b.two')).toBeUndefined()
  })
  it('caps a plugin store at 1 MB', async () => {
    const a = ctxHandler('org.big.one')
    await expect(a('store.set', ['k', 'x'.repeat(1024 * 1024)])).rejects.toThrow(/1 MB/)
    expect(await a('store.get', ['k'])).toBeNull()
  })
  it('sends desktop fetches with the bound id and no host list from the plugin', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const h = ctxHandler('org.mine.one', true, async (cmd, args) => { calls.push([cmd, args!]); return { status: 200, headers: {}, body: '' } as never })
    await h('fetch', ['https://example.org/x', { method: 'post', hosts: ['*'], id: 'org.other.one', body: 'q' }])
    expect(calls).toEqual([['plugin_fetch', { id: 'org.mine.one', url: 'https://example.org/x', method: 'POST', headers: {}, body: 'q' }]])
  })
  it('sends desktop tool calls with the bound id, and needs the desktop app', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const h = ctxHandler('org.mine.one', true, async (cmd, args) => { calls.push([cmd, args!]); return 'flick-tool:ytdlp/abc' as never })
    expect(await h('tool', ['ytdlp', 'resolve', ['https://www.youtube.com/watch?v=x'], 'org.other.one'])).toBe('flick-tool:ytdlp/abc')
    expect(calls).toEqual([['plugin_tool', { id: 'org.mine.one', tool: 'ytdlp', op: 'resolve', args: ['https://www.youtube.com/watch?v=x'] }]])
    await expect(ctxHandler('org.mine.one')('tool', ['ytdlp', 'search', ['x']])).rejects.toThrow(/desktop app/)
  })
  it('refuses requests it does not know', async () => {
    const h = ctxHandler('org.mine.one')
    await expect(h('db.get', ['progress'])).rejects.toThrow(/does not know/)
    await expect(h('fetch', ['https://x'])).rejects.toThrow(/inside the sandbox/)
  })
})
