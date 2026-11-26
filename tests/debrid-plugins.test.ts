// The bundled Real-Debrid, AllDebrid and Premiumize service plugins, against recorded API answers.
import { describe, it, expect } from 'vitest'
// @ts-expect-error plain JS plugins with no types of their own
import rd from '../plugins/realdebrid/plugin.js'
// @ts-expect-error see above
import ad, { flatten } from '../plugins/alldebrid/plugin.js'
// @ts-expect-error see above
import pm, { pickFile as pmPick } from '../plugins/premiumize/plugin.js'
import * as V from '../src/lib/plugins/validate'
import rdFx from './fixtures/debrid/realdebrid.json'
import adFx from './fixtures/debrid/alldebrid.json'
import pmFx from './fixtures/debrid/premiumize.json'
import { fakeCtx, split, type Req, type Reply } from './debrid-ctx'

const KEY = 'test-key-0000'
const HASH = 'c'.repeat(40)
const T = { infoHash: HASH, fileIdx: 1, name: 'Show.S01E02.1080p.mkv' }
const manifestOf = (p: Record<string, unknown>) => { const { data, fns } = split(p); return V.validateManifest(data, fns) }
/** Answers in turn for each matching path; the last one repeats. */
function script(fx: Record<string, unknown>, routes: [RegExp, string[]][]) {
  const F = fx as Record<string, Reply>
  return (r: Req): Reply => {
    for (const [re, names] of routes) if (re.test(r.url)) return F[names.length > 1 ? names.shift()! : names[0]]
    return { status: 404, body: { error: 'unknown_ressource' } }
  }
}
const noTitle = (ctx: ReturnType<typeof fakeCtx>) => { for (const r of ctx.requests) expect(`${r.url} ${r.body ?? ''}`).not.toMatch(/Show|S01E02/) }

describe.each([
  ['Real-Debrid', rd, 'api.real-debrid.com', 'https://real-debrid.com/apitoken'],
  ['AllDebrid', ad, 'api.alldebrid.com', 'https://alldebrid.com/apikeys'],
  ['Premiumize', pm, 'www.premiumize.me', 'https://www.premiumize.me/account'],
])('%s manifest', (_name, plugin, api, keyPage) => {
  it('passes the validator: named hosts, debrid hosts, one secret key with its page, no VPN needed', () => {
    const m = manifestOf(plugin)
    expect(m.kind).toBe('service')
    expect(m.hosts).not.toContain('*')
    expect(m.hosts[0]).toBe(api)
    expect(m.debridHosts.length).toBeGreaterThan(0)
    expect(m.debridHosts.every((h) => h.startsWith('*.'))).toBe(true)
    expect(m.settings.filter((f) => f.secret).map((f) => f.key)).toEqual(['apiKey'])
    expect(m.settings[0].help).toContain(keyPage)
    expect(m.vpnOptional).toBe(true)
    expect(m.platforms).toEqual(['desktop'])
  })
})

describe('Real-Debrid plugin', () => {
  const m = manifestOf(rd)
  it('account: premium until a date, or Real-Debrid\'s error', async () => {
    const ok = fakeCtx({ apiKey: KEY }, () => rdFx.user_ok as Reply)
    expect(V.validateAccount(await rd.account(ok))).toEqual({ ok: true, name: 'Real-Debrid', plan: 'Premium', expires: '2027-03-01' })
    expect(ok.requests[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(await rd.account(fakeCtx({ apiKey: 'bad' }, () => rdFx.user_bad as Reply))).toEqual({ ok: false, message: 'Real-Debrid: bad_token' })
  })
  it('cached: no cache check, so nothing is sent', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, () => rdFx.user_ok as Reply)
    expect(await rd.cached(ctx, [HASH])).toEqual([])
    expect(ctx.requests).toHaveLength(0)
  })
  it('resolve: adds, selects only fileIdx + 1, waits at 40%, then unrestricts the link', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(rdFx, [[/addMagnet/, ['add']], [/selectFiles/, ['select']], [/torrents\/info/, ['info_select', 'info_40', 'info_done']], [/unrestrict/, ['unrestrict']]]))
    expect(V.validateResolve(await rd.resolve(ctx, T), m.hosts)).toEqual({ wait: { pct: 0, message: 'Real-Debrid is starting it' } })
    expect(ctx.requests.find((r) => r.url.includes('selectFiles'))!.body).toBe('files=2')
    expect(V.validateResolve(await rd.resolve(ctx, T), m.hosts)).toEqual({ wait: { pct: 40, message: 'Real-Debrid is downloading it' } })
    expect(V.validateResolve(await rd.resolve(ctx, T), m.hosts)).toEqual({ url: 'https://41.download.real-debrid.com/d/ABCDEF/Show.S01E02.1080p.mkv' })
    expect(ctx.requests.filter((r) => r.url.includes('addMagnet'))).toHaveLength(1)
    noTitle(ctx)
  })
  it('resolve: a dead torrent is an error and is forgotten', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(rdFx, [[/addMagnet/, ['add']], [/torrents\/info/, ['info_dead']]]))
    expect(await rd.resolve(ctx, T)).toEqual({ error: 'Real-Debrid could not fetch this torrent (dead).' })
    expect(await ctx.store.get('ids')).toEqual({})
  })
})

describe('AllDebrid plugin', () => {
  const m = manifestOf(ad)
  it('account: premium until a date, or AllDebrid\'s error', async () => {
    expect(V.validateAccount(await ad.account(fakeCtx({ apiKey: KEY }, () => adFx.user_ok as Reply)))).toEqual({ ok: true, name: 'AllDebrid', plan: 'Premium', expires: '2027-03-01' })
    expect(await ad.account(fakeCtx({ apiKey: 'bad' }, () => adFx.user_bad as Reply))).toEqual({ ok: false, message: 'AllDebrid: The auth apikey is invalid' })
  })
  it('cached: no cache check', async () => {
    expect(await ad.cached(fakeCtx({ apiKey: KEY }, () => adFx.user_ok as Reply), [HASH])).toEqual([])
  })
  it('resolve: uploads the hash, waits at 40%, then unlocks the named file', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(adFx, [[/magnet\/upload/, ['upload']], [/magnet\/status/, ['status_40', 'status_ready']], [/magnet\/files/, ['files']], [/link\/unlock/, ['unlock']]]))
    expect(V.validateResolve(await ad.resolve(ctx, T), m.hosts)).toEqual({ wait: { pct: 40, message: 'AllDebrid is downloading it' } })
    expect(V.validateResolve(await ad.resolve(ctx, T), m.hosts)).toEqual({ url: 'https://xk7rz2.debrid.it/dl/2kd9f/Show.S01E02.1080p.mkv' })
    expect(ctx.requests[0].body).toBe(`magnets%5B%5D=${HASH}`)
    expect(ctx.requests.at(-1)!.body).toBe(`link=${encodeURIComponent('https://alldebrid.com/f/BBB')}`)
    noTitle(ctx)
  })
  it('resolve: a failed magnet is an error', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(adFx, [[/magnet\/upload/, ['upload']], [/magnet\/status/, ['status_failed']]]))
    expect(await ad.resolve(ctx, T)).toEqual({ error: 'AllDebrid could not fetch this torrent (File not available - no peer).' })
  })
  it('resolve: a queued magnet with no downloaded count waits at 0%, never NaN', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(adFx, [[/magnet\/upload/, ['upload']], [/magnet\/status/, ['status_queued']]]))
    expect(await ad.resolve(ctx, T)).toEqual({ wait: { pct: 0, message: 'AllDebrid has it in line' } })
  })
  it('flattens nested folders in order', () => {
    expect(flatten([{ n: 'a', e: [{ n: 'b.mkv', s: 1, l: 'L1' }, { n: 'c', e: [{ n: 'd.mp4', s: 2, l: 'L2' }] }] }]).map((f: { path: string }) => f.path)).toEqual(['a/b.mkv', 'a/c/d.mp4'])
  })
})

describe('Premiumize plugin', () => {
  const m = manifestOf(pm)
  it('account: premium until a date, or Premiumize\'s error', async () => {
    expect(V.validateAccount(await pm.account(fakeCtx({ apiKey: KEY }, () => pmFx.account_ok as Reply)))).toEqual({ ok: true, name: 'Premiumize', plan: 'Premium', expires: '2027-03-01' })
    expect(await pm.account(fakeCtx({ apiKey: 'bad' }, () => pmFx.account_bad as Reply))).toEqual({ ok: false, message: 'Premiumize: Not logged in.' })
  })
  it('cached: the hashes whose answer is true', async () => {
    const asked = ['a'.repeat(40), 'b'.repeat(40), 'd'.repeat(40)]
    const ctx = fakeCtx({ apiKey: KEY }, () => pmFx.cache_check as Reply)
    expect(V.validateCached(await pm.cached(ctx, asked), asked)).toEqual(['b'.repeat(40)])
    expect(ctx.requests[0].url).toBe(`https://www.premiumize.me/api/cache/check?${asked.map((h) => `items[]=${h}`).join('&')}`)
  })
  it('resolve: a cached torrent plays the named file at once', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(pmFx, [[/directdl/, ['directdl_hit']]]))
    expect(V.validateResolve(await pm.resolve(ctx, T), m.hosts)).toEqual({ url: 'https://a7.energycdn.com/dl/x2/Show.S01E02.1080p.mkv' })
    noTitle(ctx)
  })
  it('resolve: an uncached torrent becomes a transfer, waits at 40%, then plays', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(pmFx, [[/directdl/, ['directdl_miss', 'directdl_hit']], [/transfer\/create/, ['create']], [/transfer\/list/, ['list_40']]]))
    expect(V.validateResolve(await pm.resolve(ctx, T), m.hosts)).toEqual({ wait: { pct: 40, message: 'Premiumize is downloading it' } })
    expect(V.validateResolve(await pm.resolve(ctx, T), m.hosts)).toEqual({ url: 'https://a7.energycdn.com/dl/x2/Show.S01E02.1080p.mkv' })
    expect(ctx.requests.filter((r) => r.url.includes('transfer/create'))).toHaveLength(1)
    noTitle(ctx)
  })
  it('resolve: a failed transfer says why', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(pmFx, [[/directdl/, ['directdl_miss']], [/transfer\/create/, ['create']], [/transfer\/list/, ['list_error']]]))
    expect(await pm.resolve(ctx, T)).toEqual({ error: 'Premiumize could not fetch this torrent: No seeds' })
  })
  it('resolve: a deleted, banned or timed out transfer is an error, not an endless wait', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(pmFx, [[/directdl/, ['directdl_miss']], [/transfer\/create/, ['create']], [/transfer\/list/, ['list_deleted']]]))
    expect(await pm.resolve(ctx, T)).toEqual({ error: 'Premiumize could not fetch this torrent.' })
    expect(await ctx.store.get('ids')).toEqual({})
  })
  it('resolve: a refused create finds the transfer already on Premiumize by its magnet', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, script(pmFx, [[/directdl/, ['directdl_miss']], [/transfer\/create/, ['create_refused']], [/transfer\/list/, ['list_existing']]]))
    expect(await pm.resolve(ctx, T)).toEqual({ wait: { pct: 40, message: 'Premiumize is downloading it' } })
    expect(await pm.resolve(ctx, T)).toEqual({ wait: { pct: 40, message: 'Premiumize is downloading it' } })
    expect(ctx.requests.filter((r) => r.url.includes('transfer/create'))).toHaveLength(1)
    expect(await ctx.store.get('ids')).toEqual({ [HASH]: 'PMT9' })
  })
  it('picks the file: the name, then fileIdx as a place in the list, then the largest video', () => {
    const files = (pmFx.directdl_hit.body as { content: { path: string }[] }).content
    expect(pmPick(files, 0, 'Show.S01E02.1080p.mkv').path).toMatch(/E02/)
    expect(pmPick(files, 0).path).toMatch(/E01/)
    expect(pmPick(files).path).toMatch(/E02/)
  })
  it('account: a lapsed plan shows as Free with no date', async () => {
    expect(await pm.account(fakeCtx({ apiKey: KEY }, () => pmFx.account_lapsed as Reply))).toEqual({ ok: true, name: 'Premiumize', plan: 'Free' })
  })
})
