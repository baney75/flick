// The bundled TorBox service plugin, against recorded TorBox API answers. No real key, no network.
import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain JS plugin with no types of its own
import torbox, { pickFile } from '../plugins/torbox/plugin.js'
import * as V from '../src/lib/plugins/validate'
import fx from './fixtures/debrid/torbox.json'
import { fakeCtx, split, type Req, type Reply } from './debrid-ctx'

const KEY = 'tb-test-key-0000'
const F = fx as unknown as Record<string, Reply>
const { data, fns } = split(torbox)
const m = V.validateManifest(data, fns)
const HASH = 'c'.repeat(40)

describe('TorBox plugin', () => {
  it('passes the validator with named hosts only and a secret key', () => {
    expect(m.kind).toBe('service')
    expect(m.hosts).not.toContain('*')
    expect(m.hosts.every((h) => h === 'api.torbox.app' || /^\*\.tb-cdn\.\w+$/.test(h))).toBe(true)
    expect(m.debridHosts.length).toBeGreaterThan(0)
    expect(m.settings.filter((f) => f.type === 'password').map((f) => f.key)).toEqual(['apiKey'])
    expect(m.settings[0].help).toMatch(/https:\/\/torbox\.app\/settings/)
    expect(m.platforms).toEqual(['desktop'])
    expect(m.vpnOptional).toBe(true)
  })

  it('account: plan and expiry, with the key in the Authorization header only', async () => {
    const ctx = fakeCtx({ apiKey: KEY }, () => F.user_ok)
    expect(V.validateAccount(await torbox.account(ctx))).toEqual({ ok: true, name: 'TorBox', plan: 'Pro', expires: '2027-03-01' })
    expect(ctx.requests[0].url).toBe('https://api.torbox.app/v1/api/user/me')
    expect(ctx.requests[0].headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('account: a bad key shows TorBox\'s own error', async () => {
    const ctx = fakeCtx({ apiKey: 'wrong' }, () => F.user_bad)
    expect(V.validateAccount(await torbox.account(ctx))).toEqual({ ok: false, message: 'Your token is invalid or has expired. Please log in again or reset your token.' })
    expect(await torbox.account(fakeCtx({}, () => F.user_ok))).toEqual({ ok: false, message: 'Paste your TorBox API key.' })
  })

  it('cached: three hashes asked, one cached, returned lowercase', async () => {
    const asked = ['a'.repeat(40), 'b'.repeat(40), 'd'.repeat(40)]
    const ctx = fakeCtx({ apiKey: KEY }, () => F.checkcached_one)
    expect(V.validateCached(await torbox.cached(ctx, asked), asked)).toEqual(['b'.repeat(40)])
    expect(ctx.requests[0].url).toBe(`https://api.torbox.app/v1/api/torrents/checkcached?hash=${asked.join(',')}&format=list&list_files=false`)
  })

  it('resolve: an uncached torrent waits (queued, 40%) and then gives an https link on a TorBox host', async () => {
    const states = ['mylist_queued', 'mylist_40', 'mylist_done']
    const route = (r: Req): Reply => {
      if (r.url.includes('/torrents/createtorrent')) return F.createtorrent
      if (r.url.includes('/torrents/mylist')) return F[states.shift() ?? 'mylist_done']
      if (r.url.includes('/torrents/requestdl')) return F.requestdl
      return { status: 404, body: {} }
    }
    const ctx = fakeCtx({ apiKey: KEY }, route)
    const t = { infoHash: HASH.toUpperCase(), fileIdx: 2, name: 'Show.S01E02.1080p.mkv' }
    expect(V.validateResolve(await torbox.resolve(ctx, t), m.hosts)).toEqual({ wait: { pct: 0, message: 'TorBox is reading the torrent' } })
    expect(V.validateResolve(await torbox.resolve(ctx, t), m.hosts)).toEqual({ wait: { pct: 40, message: 'TorBox is downloading it' } })
    expect(V.validateResolve(await torbox.resolve(ctx, t), m.hosts)).toEqual({ url: 'https://store-031.weur.tb-cdn.st/dld/4711/1?token=signed' })

    const adds = ctx.requests.filter((r) => r.url.endsWith('/torrents/createtorrent'))
    expect(adds).toHaveLength(1)
    expect(adds[0].body).toBe(`magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${HASH}`)}`)
    expect(ctx.requests.at(-1)!.url).toContain('torrent_id=4711&file_id=2&redirect=false')
    // Only the infoHash and the file index leave: never the file name or anything else about the title.
    for (const r of ctx.requests) expect(`${r.url} ${r.body ?? ''}`).not.toMatch(/Show|S01E02/)
    for (const r of ctx.requests) expect(r.url.startsWith('https://api.torbox.app/')).toBe(true)
  })

  it('picks the file: fileIdx, then the name, then the largest video', () => {
    const files = (F.mylist_done.body as { data: { files: { id: number }[] } }).data.files
    expect(pickFile(files, 1).id).toBe(1)
    expect(pickFile(files, undefined, 'Show.S01E01.1080p.mkv').id).toBe(1)
    expect(pickFile(files).id).toBe(2)
    expect(pickFile([], 0)).toBeNull()
  })
})
