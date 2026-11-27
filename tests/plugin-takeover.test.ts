// A plugin with an installed plugin's id but another address, kind or official status takes that id over:
// it keeps none of the old plugin's secret settings or saved data (audit P15 F1).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
})
import * as db from '../src/lib/db'
import type * as Reg from '../src/lib/plugins/registry'
import type { Installed } from '../src/lib/plugins/runtime'

const KEY = 'tb-fake-0000aaaa'
const tbManifest = {
  api: 1, kind: 'service', provides: ['debrid'], id: 'app.torbox', name: 'TorBox', version: '1.0.0', author: 'Flick',
  hosts: ['api.torbox.app', '*.tb-cdn.st'], debridHosts: ['*.tb-cdn.st'], platforms: ['desktop'],
  settings: [{ key: 'apiKey', label: 'API key', type: 'password' }, { key: 'pin', label: 'PIN', type: 'password' }, { key: 'region', label: 'Region', type: 'text' }],
}
const fns = ['account', 'cached', 'resolve']
const deps: Reg.Deps = {
  fetchText: async () => '',
  inspect: async (code) => {
    if (code === 'official') return { manifest: tbManifest, fns }
    if (code === 'official-v2') return { manifest: { ...tbManifest, version: '1.1.0' }, fns }
    // Someone else's file: same id, its own hosts, and the old secret PIN field turned into plain text.
    return { manifest: { ...tbManifest, version: '9.0.0', author: 'Someone', hosts: ['api.evil.example'], debridHosts: [], settings: [tbManifest.settings[0], { key: 'pin', label: 'PIN', type: 'text' }, tbManifest.settings[2]] }, fns }
  },
}

let R: typeof Reg
let S: typeof import('../src/lib/plugins/services')
let K: typeof import('../src/lib/sync/keys')
beforeAll(async () => {
  R = await import('../src/lib/plugins/registry')
  S = await import('../src/lib/plugins/services')
  K = await import('../src/lib/sync/keys')
  vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [{ url: '/plugins/torbox.js', name: 'TorBox', kind: 'service' }] }) }))
})
afterEach(async () => { await R.remove('app.torbox') })

async function official() {
  const rec = await R.install(await R.prepare({ url: '/plugins/torbox.js', text: 'official' }, deps), { apiKey: KEY, pin: '4321', region: 'eu' })
  await db.put('pluginData', 'app.torbox', { token: 'saved-by-official' })
  return rec
}

describe('a plugin from another address with the same id', () => {
  it('does not inherit the installed plugin\'s secret key or saved data (audit repro)', async () => {
    expect((await official()).official).toBe(true)
    const other = await R.prepare({ url: 'https://gist.example/torbox-plus.js', text: 'other' }, deps)
    expect(other.official).toBe(false)
    expect(R.replaceLine(other)).toBe('This replaces TorBox from Flick with a plugin from gist.example. Its saved keys and data are cleared.')
    const rec = await R.install(other)
    expect(rec.settings.apiKey).toBeUndefined()
    // Secret in the old version, plain in the new one: still cleared.
    expect(rec.settings.pin).toBeUndefined()
    expect(rec.settings.region).toBe('eu')
    expect(await db.get('pluginData', 'app.torbox')).toBeUndefined()
  })

  it('an update from the same address keeps the key and the saved data', async () => {
    await official()
    const next = await R.prepare({ url: '/plugins/torbox.js', text: 'official-v2' }, deps)
    expect(R.replaceLine(next)).toBeNull()
    const rec = await R.install(next)
    expect(rec.settings).toMatchObject({ apiKey: KEY, pin: '4321', region: 'eu' })
    expect(await db.get('pluginData', 'app.torbox')).toEqual({ token: 'saved-by-official' })
  })

  it('the key check for a takeover never runs with the old plugin\'s other keys', async () => {
    await official()
    const other = await R.prepare({ url: 'https://gist.example/torbox-plus.js', text: 'other' }, deps)
    let seen: Record<string, unknown> = {}
    const call = (async (rec: Installed) => { seen = rec.settings; return { ok: false, message: 'no' } }) as never
    await S.checkAndSave(other, 'new-key', call)
    expect(seen).toEqual({ region: 'eu', apiKey: 'new-key' })
  })
})

describe('when something fails', () => {
  it('a takeover whose save fails leaves the old plugin\'s saved data', async () => {
    await official()
    const other = await R.prepare({ url: 'https://gist.example/torbox-plus.js', text: 'other' }, deps)
    // A function cannot be stored, so the save throws.
    const broken = { ...other, manifest: { ...other.manifest, bad: () => 1 } } as never
    await expect(R.install(broken)).rejects.toThrow('Saving the plugin failed')
    expect(await db.get('pluginData', 'app.torbox')).toEqual({ token: 'saved-by-official' })
  })

  it('an update from the same address while the official list cannot be read keeps the key', async () => {
    await official()
    vi.resetModules()
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const R2 = await import('../src/lib/plugins/registry')
    await R2.loadPlugins()
    const next = await R2.prepare({ url: '/plugins/torbox.js', text: 'official-v2' }, deps)
    expect(next.official).toBe(true)
    expect(R2.replaceLine(next)).toBeNull()
    expect((await R2.install(next)).settings.apiKey).toBe(KEY)
    // Still unreadable, from another address: not Flick's own, so a takeover.
    expect((await R2.prepare({ url: 'https://gist.example/torbox-plus.js', text: 'other' }, deps)).official).toBe(false)
    await R2.remove('app.torbox')
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [{ url: '/plugins/torbox.js', name: 'TorBox', kind: 'service' }] }) }))
  })
})

describe('takesOver', () => {
  const was = { url: 'https://a.example/p.js', official: false, kind: 'source' as const }
  const cases: [string, { url?: string | null; official?: boolean; kind?: 'source' }, boolean][] = [
    ['same address, kind and status', {}, false],
    ['another address', { url: 'https://b.example/p.js' }, true],
    ['a chosen file', { url: null }, true],
    ['now official', { official: true }, true],
    ['another kind', { kind: 'service' as never }, true],
  ]
  for (const [name, over, want] of cases) it(name, () => expect(R.takesOver({ ...was, ...over }, was)).toBe(want))
  it('a file replacing a file is a takeover too', () => expect(R.takesOver({ ...was, url: null }, { ...was, url: null })).toBe(true))
  it('nothing installed is no takeover', () => expect(R.takesOver(was, undefined)).toBe(false))
})

describe('a plugin synced from another device', () => {
  const old = { id: 'org.p', kind: 'source', url: 'https://a.example/p.js', official: false, manifest: { name: 'P' } } as unknown as Installed
  const cand = (url: string, replaces?: Installed) => ({ kind: 'source', url, official: false, replaces }) as unknown as Reg.Candidate
  const doc = (v: unknown) => (k: string) => (k === 'x:https://a.example/p.js' ? v : undefined)
  it('takes over a local plugin the doc says was removed', () => expect(K.mayTakeOverSynced(cand('https://b.example/p.js', old), doc(null))).toBe(true))
  it('waits while the old plugin is still synced', () => expect(K.mayTakeOverSynced(cand('https://b.example/p.js', old), doc({ on: true, settings: {} }))).toBe(false))
  it('never takes over a plugin that does not sync, such as a service', () => {
    const svc = { ...old, kind: 'service', url: '/plugins/torbox.js', official: true } as Installed
    expect(K.mayTakeOverSynced(cand('https://b.example/p.js', svc), () => undefined)).toBe(false)
  })
  it('updates its own copy with no question', () => expect(K.mayTakeOverSynced(cand('https://a.example/p.js', old), doc({ on: true, settings: {} }))).toBe(true))
})
