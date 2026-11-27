// The Stremio plugin's addons (SPEC-plugins-hub rule 11): the account's collection when signed in, the
// addons setting when signed out, and Stremio's Official and Community lists to browse. Every answer
// comes from tests/fixtures/stremio/addons.json (trimmed from the real responses, 2026-11-26); the
// account is made up and no request leaves the test.
import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain JS plugin with no types of its own
import stremio from '../plugins/stremio/plugin.js'
import * as V from '../src/lib/plugins/validate'
import fx from './fixtures/stremio/addons.json'
import { fakeCtx, split, type Req, type Reply } from './debrid-ctx'

const TORRENTIO = 'https://torrentio.strem.fun/manifest.json'
const TORRENTIO_TB = 'https://torrentio.strem.fun/torbox=made-up-key/manifest.json'
const CINEMETA = fx.official.addons[0]
const OPENSUBS = fx.official.addons[4]
const CHANNELS = fx.official.addons[1]
const CATALOG = 'https://v3-cinemeta.strem.io/addon_catalog/all/'
let n = 0

/** A fake Stremio: manifests and catalogs from the fixture, and one account's addon collection. */
function world(signedIn: boolean, settings: Record<string, unknown> = { addons: [] }, reply: { addons?: unknown[] } | null = null) {
  const account = { addons: [CINEMETA, CHANNELS, OPENSUBS] as unknown[], sets: [] as unknown[][] }
  const route = (r: Req): Reply => {
    if (r.url === TORRENTIO || r.url === TORRENTIO_TB) return { status: 200, body: fx.torrentio }
    if (r.url === `${CATALOG}official.json`) return { status: 200, body: fx.official }
    if (r.url === `${CATALOG}community.json`) return { status: 200, body: fx.community }
    const known = [...fx.official.addons, ...fx.community.addons].find((a) => a.transportUrl === r.url)
    if (known) return { status: 200, body: known.manifest }
    if (r.url.endsWith('/api/addonCollectionGet')) return { status: 200, body: { result: reply ?? { addons: account.addons } } }
    if (r.url.endsWith('/api/addonCollectionSet')) {
      const body = JSON.parse(r.body!)
      account.sets.push(body.addons)
      account.addons = body.addons
      return { status: 200, body: { result: { success: true } } }
    }
    return { status: 404, body: {} }
  }
  const ctx = fakeCtx(settings, route)
  // A new made-up key each time, so the plugin's 10 minute addon cache never carries over between tests.
  if (signedIn) void ctx.store.set('authKey', `made-up-key-${++n}`)
  return { ctx, account }
}
const apply = (ctx: { settings: Record<string, unknown> }, r: { settings?: Record<string, unknown> }) => Object.assign(ctx.settings, r.settings ?? {})
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

describe('Stremio addons', () => {
  it('the plugin has the whole extensions contract', () => {
    const { data, fns } = split(stremio)
    expect(V.validateManifest(data, fns).has.extensions).toBe(true)
  })

  it('the signed-out addon list is a secret setting, so it stays on this device', () => {
    const { data, fns } = split(stremio)
    expect(V.validateManifest(data, fns).settings.find((f) => f.key === 'addons')).toMatchObject({ type: 'list', secret: true })
  })

  it('signed out, add Torrentio: it appears in Addons and the addons setting holds it', async () => {
    const { ctx } = world(false)
    const before = V.validateExtensions(await stremio.extensions(ctx))
    expect(before.map((e) => [e.id, e.removable])).toEqual([['com.linvo.cinemeta', false], ['org.stremio.opensubtitlesv3', false]])
    const r = V.validateExtensionResult(await stremio.addExtension(ctx, { url: TORRENTIO }), split(stremio).data.settings)
    expect(r).toEqual({ ok: true, message: 'Added Torrentio.', settings: { addons: [TORRENTIO] } })
    apply(ctx, r)
    const after = V.validateExtensions(await stremio.extensions(ctx))
    expect(after.find((e) => e.id === 'com.stremio.torrentio.addon')).toMatchObject({ name: 'Torrentio', url: TORRENTIO, removable: true })
    expect(ctx.requests.some((q) => q.url.includes('addonCollection'))).toBe(false)
  })

  it('signed out, remove it again: the setting loses it', async () => {
    const { ctx } = world(false, { addons: [TORRENTIO] })
    const r = await stremio.removeExtension(ctx, { id: 'com.stremio.torrentio.addon' })
    expect(r).toEqual({ ok: true, message: 'Removed Torrentio.', settings: { addons: [] } })
  })

  it('signed in, add an addon: one addonCollectionSet with the old list plus it', async () => {
    const { ctx, account } = world(true)
    const old = [...account.addons]
    const r = await stremio.addExtension(ctx, { url: 'stremio://torrentio.strem.fun/manifest.json' })
    expect(r).toEqual({ ok: true, message: 'Added Torrentio to your Stremio account.' })
    expect(account.sets).toHaveLength(1)
    expect(account.sets[0].slice(0, old.length)).toEqual(old)
    expect(account.sets[0][old.length]).toEqual({ transportUrl: TORRENTIO, manifest: fx.torrentio, flags: { official: false, protected: false } })
    expect(ids(V.validateExtensions(await stremio.extensions(ctx)))).toContain('com.stremio.torrentio.addon')
  })

  it('signed in, adding one already there changes nothing', async () => {
    const { ctx, account } = world(true)
    await stremio.addExtension(ctx, { url: CHANNELS.transportUrl })
    expect(account.sets).toEqual([])
  })

  it('signed in, Cinemeta is not offered for removal, and removing it is refused', async () => {
    const { ctx, account } = world(true)
    const rows = V.validateExtensions(await stremio.extensions(ctx))
    expect(rows.map((e) => [e.id, e.removable])).toEqual([['com.linvo.cinemeta', false], ['com.linvo.stremiochannels', true], ['org.stremio.opensubtitlesv3', true]])
    expect((await stremio.removeExtension(ctx, { id: 'com.linvo.cinemeta' })).ok).toBe(false)
    expect(account.sets).toEqual([])
  })

  it('signed in, remove one: the account keeps the rest in order', async () => {
    const { ctx, account } = world(true)
    expect((await stremio.removeExtension(ctx, { id: 'com.linvo.stremiochannels' })).ok).toBe(true)
    expect(account.sets).toEqual([[CINEMETA, OPENSUBS]])
  })

  it('addExtension with an http:// or javascript: address is refused and saves nothing', async () => {
    for (const signedIn of [false, true]) {
      const { ctx, account } = world(signedIn)
      for (const url of ['http://torrentio.strem.fun/manifest.json', 'javascript:alert(1)']) {
        const r = await stremio.addExtension(ctx, { url })
        expect(r.ok).toBe(false)
        expect(r.settings).toBeUndefined()
      }
      expect(account.sets).toEqual([])
      expect(ctx.requests.filter((q) => q.url.startsWith('http://') || q.url.startsWith('javascript:'))).toEqual([])
      await expect(stremio.inspectExtension(ctx, { url: 'http://torrentio.strem.fun/manifest.json' })).rejects.toThrow(/https/)
    }
  })

  it('inspect reads the manifest and saves nothing', async () => {
    const { ctx, account } = world(true)
    const e = V.validateInspect(await stremio.inspectExtension(ctx, { url: TORRENTIO }))
    expect(e).toMatchObject({ id: 'com.stremio.torrentio.addon', name: 'Torrentio', types: ['movie', 'series', 'anime', 'other'], installed: false })
    expect(account.sets).toEqual([])
  })

  it('catalog search "torrentio": that row, installed true once it is', async () => {
    const { ctx, account } = world(true)
    const find = async () => V.validateExtensions(await stremio.extensionCatalog(ctx, { search: 'torrentio' }), true)
    const [row, ...rest] = await find()
    expect(rest).toEqual([])
    expect(row).toMatchObject({ id: 'com.stremio.torrentio.catalog.addon', url: 'https://torrent-catalogs.strem.fun/manifest.json', installed: false, removable: false })
    await stremio.addExtension(ctx, { url: row.url })
    expect(account.sets).toHaveLength(1)
    expect((await find())[0]).toMatchObject({ installed: true, removable: true })
  })

  it('the catalog lists Official before Community, Cinemeta installed and not removable, http addons left out', async () => {
    const { ctx } = world(false)
    const rows = V.validateExtensions(await stremio.extensionCatalog(ctx, {}), true)
    expect(rows[0]).toMatchObject({ id: 'com.linvo.cinemeta', installed: true, removable: false })
    expect(ids(rows)).not.toContain('org.stremio.local')
    expect(ids(rows).indexOf('com.stremio.torrentio.catalog.addon')).toBeGreaterThan(ids(rows).indexOf('org.stremio.watchhub'))
  })

  it('signed out, the catalog says OpenSubtitles is not removable, as Addons does', async () => {
    const { ctx } = world(false)
    const rows = V.validateExtensions(await stremio.extensionCatalog(ctx, { search: 'opensubtitles' }), true)
    expect(rows.find((e) => e.id === 'org.stremio.opensubtitlesv3')).toMatchObject({ installed: true, removable: false })
  })

  it('signed in, an account read with no addon list changes nothing', async () => {
    const { ctx, account } = world(true, undefined, {})
    await expect(stremio.addExtension(ctx, { url: TORRENTIO })).rejects.toThrow(/nothing was changed/)
    await expect(stremio.removeExtension(ctx, { id: 'com.linvo.stremiochannels' })).rejects.toThrow(/nothing was changed/)
    expect(account.sets).toEqual([])
  })

  it('signed in, adding to an empty account keeps Cinemeta and OpenSubtitles', async () => {
    const { ctx, account } = world(true, undefined, { addons: [] })
    expect((await stremio.addExtension(ctx, { url: TORRENTIO })).ok).toBe(true)
    expect(account.sets).toHaveLength(1)
    expect(account.sets[0].map((a) => (a as { manifest: { id: string } }).manifest.id)).toEqual(['com.linvo.cinemeta', 'org.stremio.opensubtitlesv3', 'com.stremio.torrentio.addon'])
    expect((account.sets[0][0] as { flags: unknown }).flags).toEqual({ official: true, protected: true })
  })

  it('signed out, a new configuration of an added addon replaces the old one in place', async () => {
    const other = 'https://torrent-catalogs.strem.fun/manifest.json'
    const { ctx } = world(false, { addons: [TORRENTIO, other] })
    const r = await stremio.addExtension(ctx, { url: TORRENTIO_TB })
    expect(r).toEqual({ ok: true, message: 'Added Torrentio.', settings: { addons: [TORRENTIO_TB, other] } })
  })
})
