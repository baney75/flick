// Settings > Streaming services: a key is checked before it is saved, the account line, the order,
// and the resolve loop (3 s polls, 10 minute limit). The TorBox plugin runs against recorded answers.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
})
import officialIndex from '../plugins/index.json'
// @ts-expect-error a plain JS plugin with no types of its own
import torbox from '../plugins/torbox/plugin.js'
// @ts-expect-error plain JS
import realdebrid from '../plugins/realdebrid/plugin.js'
// @ts-expect-error plain JS
import alldebrid from '../plugins/alldebrid/plugin.js'
// @ts-expect-error plain JS
import premiumize from '../plugins/premiumize/plugin.js'
import * as V from '../src/lib/plugins/validate'
import { sha256, type Installed } from '../src/lib/plugins/runtime'
import { settings, setSettings } from '../src/lib/store'
import fx from './fixtures/debrid/torbox.json'
import { fakeCtx, split, type Reply } from './debrid-ctx'
import type * as Reg from '../src/lib/plugins/registry'
import type * as Svc from '../src/lib/plugins/services'

const BUNDLED: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries({ torbox, realdebrid, alldebrid, premiumize }).map(([k, v]) => [`plugins/${k}/plugin.js`, v]))
const F = fx as unknown as Record<string, Reply>
const { data, fns } = split(torbox)
const manifest = V.validateManifest(data, fns)
let R: typeof Reg
let S: typeof Svc
let candidate: Reg.Candidate
beforeAll(async () => {
  R = await import('../src/lib/plugins/registry')
  S = await import('../src/lib/plugins/services')
  candidate = { kind: 'service', url: '/plugins/torbox.js', code: 'x', sha256: await sha256('x'), manifest, official: true }
})
beforeEach(async () => {
  for (const p of R.installed.value) await R.remove(p.id)
  setSettings({ serviceOrder: [], debridNeedsVpn: false })
})

/** Run the real TorBox plugin's function against one recorded answer, the way the sandbox would. */
const viaFixture = (reply: Reply, seen: Installed[] = []) => (async (rec: Installed, fn: string) => {
  seen.push(rec)
  return V.validateAccount(await torbox[fn](fakeCtx(rec.settings, () => reply)))
}) as never

describe('adding a service', () => {
  it('a bad key shows TorBox\'s error and saves nothing', async () => {
    const seen: Installed[] = []
    const r = await S.checkAndSave(candidate, 'wrong-key', viaFixture(F.user_bad, seen))
    expect(r).toEqual({ ok: false, line: 'TorBox: Your token is invalid or has expired. Please log in again or reset your token.' })
    expect(seen[0].settings.apiKey).toBe('wrong-key')
    expect(R.installed.value).toEqual([])
    expect(await (await import('../src/lib/db')).get('plugins', 'app.torbox')).toBeUndefined()
    expect(settings.value.serviceOrder).toEqual([])
  })
  it('a good key installs it, with the plan and expiry', async () => {
    const r = await S.checkAndSave(candidate, '  tb-good-key  ', viaFixture(F.user_ok))
    expect(r).toEqual({ ok: true, line: 'TorBox: Pro until 2027-03-01' })
    const rec = R.installed.value.find((p) => p.id === 'app.torbox')!
    expect(rec.kind).toBe('service')
    expect(rec.settings.apiKey).toBe('tb-good-key')
    expect(settings.value.serviceOrder).toEqual(['app.torbox'])
  })
  it('a new key for an installed service is checked first, then replaces the old one', async () => {
    await S.checkAndSave(candidate, 'old-key', viaFixture(F.user_ok))
    const svc = S.allServices.value[0]
    expect((await S.checkAndSave(svc, 'bad', viaFixture(F.user_bad))).ok).toBe(false)
    expect(R.installed.value[0].settings.apiKey).toBe('old-key')
    expect((await S.checkAndSave(svc, 'new-key', viaFixture(F.user_ok))).ok).toBe(true)
    expect(R.installed.value[0].settings.apiKey).toBe('new-key')
  })
  it('an empty key never reaches the service', async () => {
    const call = vi.fn()
    expect(await S.checkAndSave(candidate, '   ', call as never)).toEqual({ ok: false, line: 'Paste your TorBox API key.' })
    expect(call).not.toHaveBeenCalled()
  })
  it('the account line', () => {
    expect(S.accountLine('TorBox', { ok: true, name: 'TorBox', plan: 'Pro', expires: '2027-03-01' })).toBe('TorBox: Pro until 2027-03-01')
    expect(S.accountLine('TorBox', { ok: true, name: 'TorBox', plan: 'Pro' })).toBe('TorBox: Pro')
    expect(S.accountLine('Real-Debrid', { ok: true, name: 'Real-Debrid' })).toBe('Real-Debrid: the key works')
    expect(S.accountLine('TorBox', { ok: false, message: 'BAD_TOKEN' })).toBe('TorBox: BAD_TOKEN')
  })
})

describe('order and removal', () => {
  it('services keep the user\'s order; one tap removes a service and its key', async () => {
    const rd = { ...manifest, id: 'com.real-debrid', name: 'Real-Debrid' }
    await S.checkAndSave(candidate, 'k1', viaFixture(F.user_ok))
    await S.checkAndSave({ ...candidate, manifest: rd }, 'k2', viaFixture(F.user_ok))
    expect(S.allServices.value.map((s) => s.id)).toEqual(['app.torbox', 'com.real-debrid'])
    S.moveService('com.real-debrid', -1)
    expect(S.allServices.value.map((s) => s.id)).toEqual(['com.real-debrid', 'app.torbox'])
    S.moveService('com.real-debrid', -1)
    expect(settings.value.serviceOrder).toEqual(['com.real-debrid', 'app.torbox'])
    await S.removeService('com.real-debrid')
    expect(S.allServices.value.map((s) => s.id)).toEqual(['app.torbox'])
    expect(settings.value.serviceOrder).toEqual(['app.torbox'])
    expect(await (await import('../src/lib/db')).get('plugins', 'com.real-debrid')).toBeUndefined()
  })
  it('playback uses no service outside the desktop app', async () => {
    await S.checkAndSave(candidate, 'k1', viaFixture(F.user_ok))
    expect(S.allServices.value).toHaveLength(1)
    expect(S.services.value).toEqual([])
  })
  it('requiring a VPN is read fresh as off', async () => {
    vi.resetModules()
    const fresh = await import('../src/lib/store')
    expect(fresh.settings.value.debridNeedsVpn).toBe(false)
    expect(fresh.settings.value.serviceOrder).toEqual([])
  })
})

describe('resolving a torrent', () => {
  const svc = () => ({ id: 'app.torbox', kind: 'service', manifest } as unknown as Svc.Service)
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms }) }
  }
  it('waits (0%, 40%) every 3 seconds, then gives the https link', async () => {
    const answers: V.ResolveResult[] = [{ wait: { pct: 0, message: 'TorBox is reading the torrent' } }, { wait: { pct: 40, message: 'TorBox is downloading it' } }, { url: 'https://x.tb-cdn.st/f' }]
    const call = vi.fn(async () => answers.shift()!)
    const c = clock()
    const waits: unknown[] = []
    const url = await S.resolveTorrent(svc(), { infoHash: 'c'.repeat(40), fileIdx: 2 }, { call: call as never, ...c, onWait: (w) => waits.push(w) })
    expect(url).toBe('https://x.tb-cdn.st/f')
    expect(waits).toEqual([{ pct: 0, message: 'TorBox is reading the torrent' }, { pct: 40, message: 'TorBox is downloading it' }])
    expect(c.sleep.mock.calls.map((x) => x[0])).toEqual([3000, 3000])
    expect(call.mock.calls[0]).toEqual([svc(), 'resolve', [{ infoHash: 'c'.repeat(40), fileIdx: 2 }]])
  })
  it('stops after 10 minutes with "TorBox could not fetch this torrent in time"', async () => {
    const call = vi.fn(async () => ({ wait: { message: 'TorBox is downloading it' } }))
    const c = clock()
    await expect(S.resolveTorrent(svc(), { infoHash: 'c'.repeat(40) }, { call: call as never, ...c })).rejects.toThrow('TorBox could not fetch this torrent in time')
    // The last ask is at 10:00, one every 3 s from 0:00.
    expect(c.now()).toBe(10 * 60_000)
    expect(call).toHaveBeenCalledTimes(201)
  })
  it('a service error stops it, and so does closing the player', async () => {
    const c = clock()
    await expect(S.resolveTorrent(svc(), { infoHash: 'c'.repeat(40) }, { call: (async () => ({ error: 'TorBox could not fetch this torrent (error).' })) as never, ...c })).rejects.toThrow('(error)')
    const stop = new AbortController()
    const call = vi.fn(async () => { stop.abort(); return { wait: { message: 'x' } } })
    await expect(S.resolveTorrent(svc(), { infoHash: 'c'.repeat(40) }, { call: call as never, ...c, signal: stop.signal })).rejects.toThrow('Stopped')
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('the official list', () => {
  it('lists the four bundled services as services, each a valid service plugin', async () => {
    const index = officialIndex.plugins as { url: string; name: string; kind: string }[]
    const svcs = index.filter((e) => e.kind === 'service')
    expect(svcs.map((e) => e.name)).toEqual(['TorBox', 'Real-Debrid', 'AllDebrid', 'Premiumize'])
    for (const e of svcs) {
      const dir = `plugins/${e.url.match(/^\/plugins\/([\w-]+)\.js$/)![1]}/plugin.js`
      expect(BUNDLED[dir]).toBeDefined()
      const p = split(BUNDLED[dir])
      const m = V.validateManifest(p.data, p.fns)
      expect([m.kind, m.name, m.vpnOptional, m.hosts.includes('*')]).toEqual(['service', e.name, true, false])
    }
  })
})
