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
})
