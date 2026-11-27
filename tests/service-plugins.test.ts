// The `service` plugin kind (debrid services): manifest rules and the shape of every result.
import { describe, it, expect } from 'vitest'
import * as V from '../src/lib/plugins/validate'
import hostJs from '../public/plugin-host.js?raw'

const SFNS = ['account', 'cached', 'resolve']
const service = (over: Record<string, unknown> = {}) => ({
  api: 1, kind: 'service', provides: ['debrid'], id: 'app.example.debrid', name: 'Example', version: '1.0.0',
  hosts: ['api.example.app', '*.cdn.example.net'], debridHosts: ['*.cdn.example.net'],
  settings: [{ key: 'apiKey', label: 'API key', type: 'password' }], ...over,
})
const H = (c: string) => c.repeat(40)

describe('service plugin manifest', () => {
  it('accepts a service with no catalogs and keeps its debrid hosts', () => {
    const m = V.validateManifest(service(), SFNS)
    expect(m.kind).toBe('service')
    expect(m.provides).toEqual(['debrid'])
    expect(m.debridHosts).toEqual(['*.cdn.example.net'])
    expect(m.catalogs).toEqual([])
    expect(m.settings[0].secret).toBe(true)
  })
  it('names the missing function', () => {
    expect(() => V.validateManifest(service(), ['account', 'cached'])).toThrow(/needs a resolve\(\) function/)
    expect(() => V.validateManifest(service(), ['cached', 'resolve'])).toThrow(/needs a account\(\) function/)
    expect(() => V.validateManifest(service(), ['account', 'resolve'])).toThrow(/needs a cached\(\) function/)
  })
  it('refuses *, tools, debrid hosts missing from hosts, and unknown kinds or services', () => {
    expect(() => V.validateManifest(service({ hosts: ['*'] }), SFNS)).toThrow(/"\*" is not allowed/)
    expect(() => V.validateManifest(service({ hosts: [] , debridHosts: [] }), SFNS)).toThrow(/list the hosts/)
    expect(() => V.validateManifest(service({ tools: ['ytdlp'] }), SFNS)).toThrow(/cannot use desktop tools/)
    expect(() => V.validateManifest(service({ debridHosts: ['*.other.net'] }), SFNS)).toThrow(/must also be in hosts/)
    expect(() => V.validateManifest(service({ provides: [] }), SFNS)).toThrow(/must say what it provides/)
    expect(() => V.validateManifest(service({ provides: ['vpn'] }), SFNS)).toThrow(/no service called "vpn"/)
    expect(() => V.validateManifest(service({ kind: 'daemon' }), SFNS)).toThrow(/no plugin kind called "daemon"/)
  })
  it('a service is desktop only', () => {
    expect(V.validateManifest(service(), SFNS).platforms).toEqual(['desktop'])
    expect(() => V.validateManifest(service({ platforms: ['web', 'desktop'] }), SFNS)).toThrow(/only in the desktop app/)
    expect(() => V.validateManifest(service({ platforms: ['mobile'] }), SFNS)).toThrow(/only in the desktop app/)
  })
  it('vpnOptional is a true or false that only a service sets', () => {
    expect(V.validateManifest(service(), SFNS).vpnOptional).toBe(false)
    expect(V.validateManifest(service({ vpnOptional: true }), SFNS).vpnOptional).toBe(true)
    expect(() => V.validateManifest(service({ vpnOptional: 'yes' }), SFNS)).toThrow(/vpnOptional must be true or false/)
    const src = { api: 1, id: 'org.example.films', name: 'Films', version: '1', catalogs: [{ id: 'a', name: 'A', type: 'movie' }], vpnOptional: true }
    expect(() => V.validateManifest(src, ['catalog', 'meta', 'streams'])).toThrow(/Only a service/)
  })
  it('leaves source plugins as they were', () => {
    const src = { api: 1, id: 'org.example.films', name: 'Films', version: '1', hosts: ['*'], catalogs: [{ id: 'a', name: 'A', type: 'movie' }] }
    const m = V.validateManifest(src, ['catalog', 'meta', 'streams'])
    expect(m.kind).toBe('source')
    expect(m.debridHosts).toEqual([])
    expect(() => V.validateManifest({ ...src, kind: 'source' }, SFNS)).toThrow(/catalog\(\)/)
  })
  it('lets the sandbox call the service functions', () => {
    for (const f of SFNS) expect(hostJs).toMatch(new RegExp(`'progress'[^\\]]*'${f}'`))
  })
})

describe('service results', () => {
  const hosts = ['api.example.app', '*.cdn.example.net']
  it('resolve: only https links on the plugin hosts', () => {
    expect(V.validateResolve({ url: 'https://eu1.cdn.example.net/f.mkv' }, hosts)).toEqual({ url: 'https://eu1.cdn.example.net/f.mkv' })
    expect(() => V.validateResolve({ url: 'http://eu1.cdn.example.net/f.mkv' }, hosts)).toThrow(/not https on the plugin's hosts/)
    expect(() => V.validateResolve({ url: 'https://evil.example/f.mkv' }, hosts)).toThrow(/not https/)
    expect(() => V.validateResolve({ url: 'https://evilcdn.example.net/f.mkv' }, hosts)).toThrow(/not https/)
    expect(() => V.validateResolve({ url: 'https://cdn.example.net.evil.io/f.mkv' }, hosts)).toThrow(/not https/)
    expect(() => V.validateResolve({ url: 'javascript:alert(1)' }, hosts)).toThrow(/not https/)
    expect(() => V.validateResolve({ url: 'https://x.example/f' }, ['*'])).toThrow(/not https/)
  })
  it('resolve: bytes, the played file\'s size, is a whole number above 0', () => {
    const u = 'https://eu1.cdn.example.net/f.mkv'
    expect(V.validateResolve({ url: u, bytes: 1234 }, hosts)).toEqual({ url: u, bytes: 1234 })
    for (const bytes of [0, -1, 1.5, '12', Infinity, null]) expect(() => V.validateResolve({ url: u, bytes }, hosts), String(bytes)).toThrow('bytes must be a whole number above 0')
  })
  it('resolve: wait with a clamped percent, or an error', () => {
    expect(V.validateResolve({ wait: { pct: 40.4, message: 'Downloading' } }, hosts)).toEqual({ wait: { pct: 40, message: 'Downloading' } })
    expect(V.validateResolve({ wait: { pct: 140 } }, hosts)).toEqual({ wait: { pct: 100, message: 'Fetching' } })
    expect(V.validateResolve({ error: 'Not found' }, hosts)).toEqual({ error: 'Not found' })
    expect(() => V.validateResolve({}, hosts)).toThrow(/\{ url \}, \{ wait \} or \{ error \}/)
    expect(() => V.validateResolve('https://eu1.cdn.example.net/f', hosts)).toThrow()
  })
  it('cached: lowercase, only hashes Flick asked about', () => {
    const asked = [H('a'), H('b'), H('c')]
    expect(V.validateCached([H('B').toUpperCase(), H('d'), 'nope', 3, H('b')], asked)).toEqual([H('b')])
    expect(() => V.validateCached({ b: true }, asked)).toThrow(/list of infoHashes/)
  })
  it('account: the plan and expiry, or the service error', () => {
    expect(V.validateAccount({ ok: true, name: 'TorBox', plan: 'Pro', expires: '2027-03-01' })).toEqual({ ok: true, name: 'TorBox', plan: 'Pro', expires: '2027-03-01' })
    expect(V.validateAccount({ ok: false, message: 'BAD_TOKEN' })).toEqual({ ok: false, message: 'BAD_TOKEN' })
    expect(V.validateAccount({ ok: false })).toEqual({ ok: false, message: 'The service did not accept this key.' })
    expect(() => V.validateAccount({ ok: true })).toThrow(/account name is missing/)
    expect(() => V.validateAccount(null)).toThrow(/account\(\) must return/)
  })
})
