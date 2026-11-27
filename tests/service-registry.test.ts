// A service plugin's key stays on the device: never synced, never in a setup link, never in a log.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll } from 'vitest'
// setup.ts pulls in the app store, which reads the location hash on load.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
})
import * as V from '../src/lib/plugins/validate'
import { ctxHandler, logLine, logs, setSecrets, startRefusal, type Installed } from '../src/lib/plugins/runtime'
import { pluginSnapshot, mayInstallSynced } from '../src/lib/sync/keys'
import type * as Reg from '../src/lib/plugins/registry'

const KEY = 'tb-secret-9f3a7c'
const manifest = V.validateManifest({
  api: 1, kind: 'service', provides: ['debrid'], id: 'app.torbox', name: 'TorBox', version: '1.0.0',
  hosts: ['api.torbox.app', '*.tb-cdn.st'], debridHosts: ['*.tb-cdn.st'], platforms: ['desktop'],
  settings: [{ key: 'apiKey', label: 'API key', type: 'password' }],
}, ['account', 'cached', 'resolve'])
const rec = (over: Partial<Installed> = {}): Installed => ({
  id: 'app.torbox', kind: 'service', url: '/plugins/torbox.js', code: 'x', sha256: 'y', manifest, enabled: true, official: true,
  settings: { apiKey: KEY }, installedAt: 1, checkedAt: 1, ...over,
})

let R: typeof Reg
let S: typeof import('../src/lib/setup')
beforeAll(async () => { R = await import('../src/lib/plugins/registry'); S = await import('../src/lib/setup') })

describe('service keys', () => {
  it('the key is a secret setting', () => {
    expect(R.isSecret(rec(), 'apiKey')).toBe(true)
    expect(R.publicSettings(rec())).toEqual({})
  })
  it('a service never syncs, so neither does its key', () => {
    const snap = pluginSnapshot([rec()])
    expect(snap.size).toBe(0)
    expect(JSON.stringify([...snap])).not.toContain(KEY)
  })
  it('a service synced from elsewhere never installs without a review here', () => {
    const c = { kind: 'service', sha256: 'y', manifest } as unknown as Reg.Candidate
    expect(mayInstallSynced({ on: true, settings: {}, sha256: 'y', hosts: manifest.hosts, tools: [] }, c)).toBe(false)
  })
  it('a setup link carries no service and no key', async () => {
    R.installed.value = [rec()]
    const s = await S.currentSetup()
    expect(s.plugins ?? []).not.toContain('/plugins/torbox.js')
    expect(JSON.stringify(s)).not.toContain(KEY)
    R.installed.value = []
  })
  it('the key is blanked out of the plugin log', () => {
    setSecrets('app.torbox', rec())
    logLine('app.torbox', `resolve() failed: Could not reach https://api.torbox.app/v1/api/torrents/requestdl?token=${KEY}`)
    const line = logs.value['app.torbox'].at(-1)!
    expect(line).not.toContain(KEY)
    expect(line).toContain('token=[key]')
  })
  it('a service fetches https only', async () => {
    const call = vi.fn(async () => ({ status: 200, headers: {}, body: '' }))
    const h = ctxHandler('app.torbox', true, call as never, true)
    await expect(h('fetch', ['http://api.torbox.app/v1/api/user/me'])).rejects.toThrow(/https/)
    expect(call).not.toHaveBeenCalled()
    await h('fetch', ['https://api.torbox.app/v1/api/user/me'])
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('service records', () => {
  it('a service starts on the desktop only, even when an older stored manifest lists more', () => {
    const old = rec({ manifest: { ...manifest, platforms: ['web', 'desktop', 'mobile'] } })
    expect(startRefusal(old, 'web')).toMatch(/only in the Flick desktop app/)
    expect(startRefusal(old, 'mobile')).toMatch(/only in the Flick desktop app/)
    expect(startRefusal(old, 'desktop')).toBeNull()
    expect(startRefusal({ ...old, kind: 'source' }, 'web')).toBeNull()
  })
  it('a service stored as a source gets its kind back on load', async () => {
    const db = await import('../src/lib/db')
    await db.put('plugins', 'app.torbox', rec({ kind: 'source' }))
    await R.loadPlugins()
    expect(R.installed.value.find((p) => p.id === 'app.torbox')!.kind).toBe('service')
    await R.remove('app.torbox')
  })
  it('a source stored before title actions existed loads with none', async () => {
    const db = await import('../src/lib/db')
    const src = V.validateManifest({ api: 1, id: 'org.old', name: 'Old', version: '1', catalogs: [{ id: 'a', name: 'A', type: 'movie' }] }, ['catalog', 'meta', 'streams'])
    const { titleActions: _, ...before } = src
    await db.put('plugins', 'org.old', rec({ id: 'org.old', kind: 'source', manifest: before as V.PluginManifest, pending: { code: 'v2', sha256: 'z', manifest: before as V.PluginManifest, added: [] } }))
    await R.loadPlugins()
    const got = R.installed.value.find((p) => p.id === 'org.old')!
    expect((got.manifest as V.PluginManifest).titleActions).toEqual([])
    expect((got.pending!.manifest as V.PluginManifest).titleActions).toEqual([])
    await R.remove('org.old')
  })
})

describe('service updates', () => {
  it('dropping a debrid host waits for a tap', () => {
    expect(V.addedPermissions(manifest, { ...manifest, debridHosts: [] })).toEqual(['stop treating *.tb-cdn.st as a debrid host'])
    expect(V.addedPermissions(manifest, manifest)).toEqual([])
    expect(V.addedPermissions(manifest, { ...manifest, vpnOptional: true })).toEqual(['play with no VPN'])
    expect(V.addedPermissions({ ...manifest, vpnOptional: true }, manifest)).toEqual([])
  })
  it('an update that changes a source into a service is refused', async () => {
    const src = { api: 1, id: 'app.torbox', name: 'TorBox', version: '1', hosts: ['api.torbox.app'], catalogs: [{ id: 'a', name: 'A', type: 'movie' }] }
    const deps: Reg.Deps = {
      fetchText: async () => 'v2',
      inspect: async (code) => (code === 'v1' ? { manifest: src, fns: ['catalog', 'meta', 'streams'] } : { manifest: { ...manifest, version: '2' }, fns: ['account', 'cached', 'resolve'] }),
    }
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [] }) }))
    const first = await R.install(await R.prepare({ url: 'https://p.example/tb.js', text: 'v1' }, deps))
    const notes = await R.checkUpdates(first.checkedAt + 1, deps, true)
    expect(notes.join(' ')).toMatch(/different kind/)
    const now = R.installed.value.find((p) => p.id === 'app.torbox')!
    expect(now.kind).toBe('source')
    expect(now.pending).toBeUndefined()
    await R.remove('app.torbox')
  })
})
