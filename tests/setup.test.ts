import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll } from 'vitest'

// setup.ts pulls in the app store, which reads the location hash on load.
const g = globalThis as Record<string, unknown>
g.location ??= { hash: '' }
g.addEventListener ??= () => {}
let S: typeof import('../src/lib/setup')
beforeAll(async () => { S = await import('../src/lib/setup') })

const full = {
  v: 1 as const,
  stremioAddons: ['https://torrentio.strem.fun/manifest.json'],
  servers: [
    { type: 'plex' as const, name: 'Den', url: 'https://plex.example:32400', token: 'tok' },
    { type: 'jellyfin' as const, url: 'http://192.168.1.20:8096', token: 'jt', userId: 'u1' },
  ],
  folders: ['/Users/me/Movies'],
  settings: { theme: 'dark' as const, skipSeconds: 15 },
}

describe('setup payloads', () => {
  it('round-trips a valid payload, including non-ASCII names', () => {
    const p = { ...full, servers: [{ ...full.servers[0], name: 'Grand-mère' }, full.servers[1]] }
    const code = S.encodeSetup(p)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(S.decodeSetup(code)).toEqual(p)
  })
  it('strips unknown keys and bad settings', () => {
    const p = S.validateSetup({ v: 1, extra: 1, servers: [{ ...full.servers[0], junk: 2 }], settings: { theme: 'neon', speed: 1.5, evil: true } })
    expect(p).toEqual({ v: 1, servers: [full.servers[0]], settings: { speed: 1.5 } })
  })
  it('normalizes addon URLs', () => {
    expect(S.validateSetup({ v: 1, stremioAddons: ['stremio://addon.example/x'] }).stremioAddons).toEqual(['https://addon.example/x/manifest.json'])
  })
  it('rejects javascript: and other non-http URLs', () => {
    expect(() => S.validateSetup({ v: 1, stremioAddons: ['javascript:alert(1)'] })).toThrow(/http or https/)
    expect(() => S.validateSetup({ v: 1, servers: [{ type: 'plex', url: 'javascript:alert(1)', token: 't' }] })).toThrow(/http or https/)
    expect(() => S.validateSetup({ v: 1, servers: [{ type: 'plex', url: 'file:///etc', token: 't' }] })).toThrow(/http or https/)
  })
  it('rejects unknown versions, passwords, too many addons, missing tokens', () => {
    expect(() => S.validateSetup({ v: 2 })).toThrow(/version 2/)
    expect(() => S.validateSetup({ stremioAddons: [] })).toThrow(/version/)
    expect(() => S.validateSetup({ v: 1, servers: [{ type: 'jellyfin', url: 'http://a', token: 't', userId: 'u', password: 'x' }] })).toThrow(/passwords/)
    expect(() => S.validateSetup({ v: 1, stremioAddons: Array.from({ length: 51 }, (_, i) => `https://a${i}.example/manifest.json`) })).toThrow(/at most 50/)
    expect(() => S.validateSetup({ v: 1, servers: [{ type: 'plex', url: 'http://a' }] })).toThrow(/token/)
    expect(() => S.validateSetup({ v: 1, servers: [{ type: 'jellyfin', url: 'http://a', token: 't' }] })).toThrow(/userId/)
  })
  it('gives a clear error for bad base64 and bad JSON', () => {
    expect(() => S.decodeSetup('***not base64***')).toThrow(/not valid base64url/)
    expect(() => S.decodeSetup(btoa('{oops'))).toThrow(/not valid JSON/)
  })

  it('accepts plugin URLs over https or bundled paths only', () => {
    expect(S.validateSetup({ v: 1, plugins: ['https://gist.githubusercontent.com/u/1/raw/plugin.js', '/plugins/template.js'] }).plugins).toHaveLength(2)
    expect(() => S.validateSetup({ v: 1, plugins: ['http://evil.example/p.js'] })).toThrow(/https/)
    expect(() => S.validateSetup({ v: 1, plugins: ['javascript:alert(1)'] })).toThrow(/https/)
    expect(() => S.validateSetup({ v: 1, plugins: Array.from({ length: 21 }, (_, i) => `https://p${i}.example/p.js`) })).toThrow(/at most 20/)
  })
})

describe('applying a setup', () => {
  it('installs a plugin only as the review showed it, never fetching one it did not show', async () => {
    const calls: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no network in this test') }) as typeof fetch
    try {
      const out = await S.applySetup({ v: 1, plugins: ['https://plugins.example/late.js'] }, {})
      expect(out).toEqual([{ label: 'Plugin at https://plugins.example/late.js', ok: false, detail: 'It could not be read for the review, so it was not installed.' }])
      expect(calls).toEqual([])
    } finally { globalThis.fetch = real }
  })
  it('adds old Stremio addons only into a Stremio plugin the review showed', async () => {
    const calls: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no network in this test') }) as typeof fetch
    try {
      const out = await S.applySetup({ v: 1, stremioAddons: ['https://torrentio.strem.fun/manifest.json'] }, {})
      expect(out[0]).toMatchObject({ ok: false, detail: 'The Stremio plugin could not be read for the review, so it was not installed.' })
      expect(calls).toEqual([])
    } finally { globalThis.fetch = real }
  })
})

// A server added during setup is shown at once; its library loads after. A page closed while the
// library loads leaves the server marked, and the next start finishes the load.
describe('a server added by a setup link', () => {
  const lib = { name: 'NAS', folders: ['Movies'], items: [{ id: '9f86d081884c7d65', folder: 'Movies', path: 'Heat (1995).mkv', name: 'Heat (1995).mkv', kind: 'video', ext: 'mkv', size: 7, mtime: 1 }] }
  const CODE = 'Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC'
  const flickAt = (url: string) => ({ v: 1 as const, servers: [{ type: 'flick' as const, url, token: CODE }] })

  it('is connected without reading its library, which loads on the next start if the page closed', async () => {
    const { vi } = await import('vitest')
    const Srv = await import('../src/lib/servers')
    const db = await import('../src/lib/db')
    const calls: string[] = []
    let library: 'hang' | 'answer' = 'hang'
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      const path = new URL(u).pathname
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/api/info') return Response.json({ app: 'flick-server', v: 1, name: 'NAS' })
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      // The page closes while the library is on its way: this load never finishes.
      if (library === 'hang') return new Promise<Response>(() => {})
      return Response.json(lib)
    })
    try {
      const out = await S.applySetup(flickAt('https://nas-load.example'))
      expect(out).toEqual([{ label: 'Flick server at https://nas-load.example', ok: true, detail: 'Connected. Its titles are loading into your library.' }])
      // The connect checked the code with HEAD, and nothing waited for the full library.
      expect(calls.slice(0, 2)).toEqual(['GET /api/info', 'HEAD /api/library'])
      const srv = (await Srv.getServers()).find((s) => s.url === 'https://nas-load.example')!
      expect((await db.all<{ server?: string }>('items')).filter((i) => i.server === srv.id)).toEqual([])

      // The next start: the server answers and its library loads.
      library = 'answer'
      expect((await Srv.resumeServerLoads()).map((s) => s.id)).toEqual([srv.id])
      expect((await db.all<{ server?: string }>('items')).filter((i) => i.server === srv.id)).toHaveLength(1)
      // Loaded, so a later start does nothing more.
      expect(await Srv.resumeServerLoads()).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a load that fails is not retried on every start', async () => {
    const { vi } = await import('vitest')
    const Srv = await import('../src/lib/servers')
    let asked = 0
    vi.stubGlobal('fetch', async () => { asked++; return new Response('{}', { status: 401 }) })
    try {
      const s: import('../src/lib/servers').Server = { id: 'flick-gone', type: 'flick', name: 'Old NAS', url: 'https://old.example', token: 'x' }
      await Srv.saveServer(s)
      await expect(Srv.syncServer(s)).rejects.toThrow(/access code/)
      asked = 0
      expect(await Srv.resumeServerLoads()).toEqual([])
      expect(asked).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
