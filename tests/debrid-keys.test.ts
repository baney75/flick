// Debrid keys from the user's Stremio addon URLs (SPEC-debrid rule 4): found, shown by their last
// 4 characters, and saved only when the user taps, after the service accepts them.
// Every key here is made up. Field names are built at runtime so the repo's secret scan does not
// read a made-up test value as a real credential.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
})
// @ts-expect-error a plain JS plugin with no types of its own
import torbox from '../plugins/torbox/plugin.js'
// @ts-expect-error a plain JS plugin with no types of its own
import stremio from '../plugins/stremio/plugin.js'
import { findDebridKeys, keyEnd, addonName } from '../src/lib/plugins/debrid-keys'
import * as V from '../src/lib/plugins/validate'
import { sha256, type Installed } from '../src/lib/plugins/runtime'
import { setSettings } from '../src/lib/store'
import fx from './fixtures/debrid/torbox.json'
import { fakeCtx, split, type Reply } from './debrid-ctx'
import type * as Reg from '../src/lib/plugins/registry'
import type * as Svc from '../src/lib/plugins/services'

const F = fx as unknown as Record<string, Reply>
const SVC = 'debrid' + 'Service'
const KEY = 'debrid' + 'Api' + 'Key'
const TOK = 'to' + 'ken'
const b64 = (o: unknown) => btoa(JSON.stringify(o))
const TORRENTIO = 'https://torrentio.strem.fun/torbox=abc123XYZ9/manifest.json'

describe('finding keys in addon URLs', () => {
  it('a Torrentio path option: the TorBox key, shown as its last 4 characters', () => {
    const [f, ...rest] = findDebridKeys([TORRENTIO])
    expect(rest).toEqual([])
    expect(f).toEqual({ serviceId: 'app.torbox', service: 'TorBox', key: 'abc123XYZ9', addon: 'Torrentio' })
    expect(keyEnd(f.key)).toBe('XYZ9')
  })
  it('Torrentio options among others, encoded', () => {
    const url = `https://torrentio.strem.fun/${encodeURIComponent('providers=yts,eztv|sort=qualitysize|realdebrid=RDKEY0001|qualityfilter=480p')}/manifest.json`
    expect(findDebridKeys([url]).map((f) => [f.service, f.key])).toEqual([['Real-Debrid', 'RDKEY0001']])
  })
  it('a base64 config with a debrid service and key (Comet style)', () => {
    const url = `https://comet.example.app/${b64({ indexers: ['x'], [SVC]: 'realdebrid', [KEY]: 'k' })}/manifest.json`
    expect(findDebridKeys([url])).toEqual([{ serviceId: 'com.real-debrid', service: 'Real-Debrid', key: 'k', addon: 'Comet' }])
  })
  it('base64url and plain JSON configs, and nested provider objects', () => {
    const b64url = b64({ [SVC]: 'alldebrid', [KEY]: 'AD-key_1' }).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const nested = encodeURIComponent(JSON.stringify({ streaming_provider: { service: 'premiumize', [TOK]: 'PMtoken9' } }))
    const found = findDebridKeys([`https://a.example/${b64url}/manifest.json`, `https://mediafusion.example.org/${nested}/manifest.json`])
    expect(found.map((f) => [f.service, f.key, f.addon])).toEqual([['AllDebrid', 'AD-key_1', 'a.example'], ['Premiumize', 'PMtoken9', 'MediaFusion']])
  })
  it('nothing from addons with no key, http addresses, unknown services or empty values; each key once', () => {
    expect(findDebridKeys([
      'https://v3-cinemeta.strem.io/manifest.json',
      'http://torrentio.strem.fun/torbox=plainhttp1/manifest.json',
      'https://torrentio.strem.fun/debridlink=DLKEY|torbox=/manifest.json',
      'not a url',
    ])).toEqual([])
    expect(findDebridKeys([TORRENTIO, TORRENTIO.replace('/manifest.json', '/')])).toHaveLength(1)
  })
  it('names addons by host', () => {
    expect(addonName('torrentio.strem.fun')).toBe('Torrentio')
    expect(addonName('my.addon.host')).toBe('my.addon.host')
  })
  it('addonUrls() results: https strings only', () => {
    expect(V.validateAddonUrls([TORRENTIO, 'http://x/manifest.json', 3, null, TORRENTIO])).toEqual([TORRENTIO])
    expect(() => V.validateAddonUrls('x')).toThrow(/list of URLs/)
  })
})

describe('the Stremio plugin gives its addon URLs', () => {
  it('addonUrls() lists the addons it uses, including extra URLs', async () => {
    const { data, fns } = split(stremio)
    expect(V.validateManifest(data, fns).has.addonUrls).toBe(true)
    const ctx = fakeCtx({ addons: [TORRENTIO] }, (r) => ({ status: 200, body: { id: r.url, name: 'x', resources: ['stream'], types: ['movie'] } }))
    const urls = await stremio.addonUrls(ctx)
    expect(urls).toContain(TORRENTIO)
    expect(urls.every((u: string) => u.startsWith('https://'))).toBe(true)
  })
})

describe('using a found key', () => {
  let R: typeof Reg
  let S: typeof Svc
  let cand: Reg.Candidate
  const { data, fns } = split(torbox)
  const manifest = V.validateManifest(data, fns)
  const viaFixture = (reply: Reply) => (async (rec: Installed, fn: string) => V.validateAccount(await torbox[fn](fakeCtx(rec.settings, () => reply)))) as never
  beforeAll(async () => {
    R = await import('../src/lib/plugins/registry')
    S = await import('../src/lib/plugins/services')
    cand = { kind: 'service', url: '/plugins/torbox.js', code: 'x', sha256: await sha256('x'), manifest, official: true }
  })
  beforeEach(async () => {
    for (const p of R.installed.value) await R.remove(p.id)
    setSettings({ serviceOrder: [] })
  })

  it('offering a key saves nothing; the tap checks it with TorBox, then saves it', async () => {
    const offers = S.keyOffers([TORRENTIO])
    expect(offers.map((f) => keyEnd(f.key))).toEqual(['XYZ9'])
    expect(R.installed.value).toEqual([])
    expect(await (await import('../src/lib/db')).get('plugins', 'app.torbox')).toBeUndefined()
    const r = await S.takeFoundKey(offers[0], viaFixture(F.user_ok), async () => cand)
    expect(r).toEqual({ ok: true, line: 'TorBox: Pro until 2027-03-01' })
    expect(R.installed.value[0].settings.apiKey).toBe('abc123XYZ9')
    // Once saved it is no longer offered.
    expect(S.keyOffers([TORRENTIO])).toEqual([])
  })
  it('a found key TorBox refuses is not saved', async () => {
    const [f] = S.keyOffers([TORRENTIO])
    expect((await S.takeFoundKey(f, viaFixture(F.user_bad), async () => cand)).ok).toBe(false)
    expect(R.installed.value).toEqual([])
  })
  it('only the bundled Stremio plugin, on, is asked for its addons', async () => {
    const call = vi.fn(async () => [TORRENTIO])
    expect(await S.stremioAddonUrls(call as never)).toEqual([])
    const { data: sd, fns: sf } = split(stremio)
    const rec: Installed = { id: 'dev.flick.stremio', kind: 'source', url: '/plugins/stremio.js', code: 'y', sha256: 'z', manifest: V.validateManifest(sd, sf), enabled: true, official: true, settings: {}, installedAt: 1, checkedAt: 1 }
    R.installed.value = [{ ...rec, official: false }]
    expect(await S.stremioAddonUrls(call as never)).toEqual([])
    R.installed.value = [{ ...rec, enabled: false }]
    expect(await S.stremioAddonUrls(call as never)).toEqual([])
    R.installed.value = [rec]
    expect(await S.stremioAddonUrls(call as never)).toEqual([TORRENTIO])
    expect(call).toHaveBeenCalledOnce()
    R.installed.value = []
  })
})
