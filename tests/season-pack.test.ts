// A season pack must play the asked episode on every bundled service (SPEC-debrid-play Amendment 1):
// fileIdx only where the service's list keeps torrent order, else the exact name, else the largest
// video holding the episode tag; never a pack's first or largest file. Recorded shapes, no network.
import { describe, it, expect } from 'vitest'
// @ts-expect-error plain JS plugins with no types of their own
import tb, { pickFile as tbPick, holdsEpisode as tbTag } from '../plugins/torbox/plugin.js'
// @ts-expect-error see above
import rd, { pickFile as rdPick, holdsEpisode as rdTag } from '../plugins/realdebrid/plugin.js'
// @ts-expect-error see above
import ad, { pickFile as adPick, holdsEpisode as adTag, flatten } from '../plugins/alldebrid/plugin.js'
// @ts-expect-error see above
import pm, { pickFile as pmPick, holdsEpisode as pmTag } from '../plugins/premiumize/plugin.js'
import * as V from '../src/lib/plugins/validate'
import pack from './fixtures/debrid/season-pack.json'
import tbFx from './fixtures/debrid/torbox.json'
import adFx from './fixtures/debrid/alldebrid.json'
import { fakeCtx, split, type Req, type Reply } from './debrid-ctx'

type F = Record<string, unknown>
const P = pack as unknown as Record<string, Reply>
const body = (k: string) => P[k].body as F
const HASH = 'c'.repeat(40)
const E07 = 'Show.S01E07.1080p.mkv'
const E07_BYTES = 1_007_000_000
const ep = (episode: number) => ({ season: 1, episode })
const hostsOf = (p: F) => { const { data, fns } = split(p); return V.validateManifest(data, fns).hosts }
const noTitle = (ctx: ReturnType<typeof fakeCtx>) => { for (const r of ctx.requests) expect(`${r.url} ${r.body ?? ''}`).not.toMatch(/Show|S01E0/) }

// Each service's pack file list, how a file names its path, and a renamed copy of size n (a decoy).
const services = [
  { name: 'TorBox', pick: tbPick, tag: tbTag, files: () => (body('torbox_mylist').data as { files: F[] }).files, path: (f: F) => f.name as string, as: (f: F, p: string, n = 1) => ({ ...f, id: 99, name: p, short_name: p.split('/').pop(), size: n }) },
  { name: 'Real-Debrid', pick: rdPick, tag: rdTag, files: () => body('rd_info_select').files as F[], path: (f: F) => f.path as string, as: (f: F, p: string, n = 1) => ({ ...f, id: 99, path: `/${p}`, bytes: n }) },
  { name: 'AllDebrid', pick: adPick, tag: adTag, files: () => flatten((body('ad_files').data as { magnets: { files: unknown }[] }).magnets[0].files) as F[], path: (f: F) => f.path as string, as: (f: F, p: string, n = 1) => ({ ...f, path: p, size: n }) },
  { name: 'Premiumize', pick: pmPick, tag: pmTag, files: () => body('pm_directdl').content as F[], path: (f: F) => f.path as string, as: (f: F, p: string, n = 1) => ({ ...f, path: p, size: n }) },
]

describe.each(services)('$name picks the episode from a 10-episode pack', ({ pick, tag, files, path, as }) => {
  const picked = (want: F) => { const f = pick(files(), want); return f ? path(f).split('/').pop() : null }
  it('a Stremio stream (fileIdx, name, episode): that episode', () => expect(picked({ fileIdx: 7, name: E07, episode: ep(7) })).toBe(E07))
  it('fileIdx and episode, no name: the episode, not list place or id 7 (E03)', () => expect(picked({ fileIdx: 7, episode: ep(7) })).toBe(E07))
  it('episode only: the tagged video, not the sample, not the largest file (E10)', () => expect(picked({ episode: ep(7) })).toBe(E07))
  it('an episode the pack lacks: nothing, never the first or largest file', () => expect(picked({ episode: ep(11) })).toBeNull())
  it('the exact name wins over a decoy whose name ends the same, even the largest file', () => {
    const list = [as(files()[0], `Extras/Bonus.${E07}`, 9e9), ...files()]
    expect(path(pick(list, { name: E07 }))).not.toMatch(/Bonus/)
  })
  it('a one-video torrent with no tag plays that video for any episode', () => {
    const one = [as(files()[0], 'Show/Pilot.mkv'), as(files()[0], 'Show/info.nfo')]
    expect(path(pick(one, { episode: ep(3) }))).toBe(path(one[0]))
  })
  it('one untagged video and a sample (a daily show, an anime "- 07"): the video, not an error', () => {
    const two = [as(files()[0], 'The.Daily.Show.2026.11.26.mkv', 2e9), as(files()[0], 'sample.mkv', 9e9)]
    expect(path(pick(two, { episode: ep(7) }))).toBe(path(two[0]))
  })
  it('the tag on the folder (Show.S01/S01E07/video.mkv) when no file name holds it', () => {
    const dirs = [7, 8, 9].map((n) => as(files()[0], `Show.S01/S01E0${n}/video.mkv`, 2e9 - n))
    expect(path(pick(dirs, { episode: ep(8) }))).toBe(path(dirs[1]))
  })
  it('a movie (no episode): the largest video', () => expect(picked({})).toBe('Show.S01E10.1080p.mkv'))
  it('the tag: S01E07, s1.e7, 1x07 and a run like S01E06E07 match; S01E070, S11E07, S01E17 and E07 alone do not', () => {
    for (const n of ['Show.S01E07.mkv', 'show s1.e7 x.mkv', 'Show 1x07.mkv', 'Show.S01E07E08.mkv', 'S1_E07.mkv', 'Show.S01E06E07.mkv', 'Show.S01E06-E07.mkv']) expect(tag(n, ep(7)), n).toBe(true)
    for (const n of ['Show.S01E070.mkv', 'Show.S11E07.mkv', 'Show.E07.mkv', 'Show 11x07.mkv', 'XS01E07.mkv', 'Show.S01E17.mkv', 'Show.S01E06E08.mkv']) expect(tag(n, ep(7)), n).toBe(false)
  })
})

describe('each service plays E07 from the pack with its size, so the readout shows its speed', () => {
  const want = { infoHash: HASH, fileIdx: 7, episode: ep(7) }
  it('TorBox: requests the E07 file id and returns its bytes', async () => {
    const ctx = fakeCtx({ apiKey: 'k' }, (r: Req): Reply => r.url.includes('createtorrent') ? (tbFx as F).createtorrent as Reply : r.url.includes('mylist') ? P.torbox_mylist : r.url.includes('requestdl') ? P.torbox_requestdl : { status: 404, body: {} })
    const got = V.validateResolve(await tb.resolve(ctx, want), hostsOf(tb))
    expect(got).toEqual({ url: 'https://store-031.weur.tb-cdn.st/dld/4711/x?token=signed', bytes: E07_BYTES })
    const id = (body('torbox_mylist').data as { files: F[] }).files.find((f) => f.short_name === E07)!.id
    expect(ctx.requests.at(-1)!.url).toContain(`&file_id=${id}&`)
    noTitle(ctx)
  })
  it('Real-Debrid: selects file 8 (fileIdx 7 + 1), then returns the link and E07\'s bytes', async () => {
    const info = ['rd_info_select', 'rd_info_done']
    const ctx = fakeCtx({ apiKey: 'k' }, (r: Req): Reply => r.url.includes('addMagnet') ? P.rd_add : r.url.includes('selectFiles') ? P.rd_select : r.url.includes('torrents/info') ? P[info.length > 1 ? info.shift()! : info[0]] : r.url.includes('unrestrict') ? P.rd_unrestrict : { status: 404, body: {} })
    expect((await rd.resolve(ctx, want)).wait).toBeDefined()
    expect(ctx.requests.find((r) => r.url.includes('selectFiles'))!.body).toBe('files=8')
    expect(V.validateResolve(await rd.resolve(ctx, want), hostsOf(rd))).toEqual({ url: `https://41.download.real-debrid.com/d/PACK07/${E07}`, bytes: E07_BYTES })
  })
  it('Real-Debrid: two episodes of one pack with no fileIdx or name are two torrents, not one', async () => {
    const ctx = fakeCtx({ apiKey: 'k' }, (r: Req): Reply => r.url.includes('addMagnet') ? P.rd_add : r.url.includes('torrents/info') ? P.rd_info_select : P.rd_select)
    await rd.resolve(ctx, { infoHash: HASH, episode: ep(7) })
    await rd.resolve(ctx, { infoHash: HASH, episode: ep(8) })
    expect(ctx.requests.filter((r) => r.url.includes('addMagnet'))).toHaveLength(2)
    expect(ctx.requests.filter((r) => r.url.includes('selectFiles')).map((r) => r.body)).toEqual(['files=8', 'files=9'])
  })
  it('AllDebrid: unlocks E07\'s link and returns its bytes', async () => {
    const A = adFx as unknown as Record<string, Reply>
    const ctx = fakeCtx({ apiKey: 'k' }, (r: Req): Reply => r.url.includes('magnet/upload') ? A.upload : r.url.includes('magnet/status') ? A.status_ready : r.url.includes('magnet/files') ? P.ad_files : P.ad_unlock)
    expect(V.validateResolve(await ad.resolve(ctx, want), hostsOf(ad))).toEqual({ url: `https://xk7rz2.debrid.it/dl/p7/${E07}`, bytes: E07_BYTES })
    expect(ctx.requests.at(-1)!.body).toBe(`link=${encodeURIComponent('https://alldebrid.com/f/P07')}`)
  })
  it('Premiumize: plays E07 at once with its bytes; an episode the pack lacks is an error', async () => {
    const ctx = fakeCtx({ apiKey: 'k' }, () => P.pm_directdl)
    expect(V.validateResolve(await pm.resolve(ctx, want), hostsOf(pm))).toEqual({ url: `https://a7.energycdn.com/dl/p07/${E07}`, bytes: E07_BYTES })
    expect(await pm.resolve(ctx, { infoHash: HASH, episode: ep(11) })).toEqual({ error: 'No file for S01E11 in this torrent.' })
  })
  it.each([['TorBox', tb], ['AllDebrid', ad]])('%s: an episode the pack lacks is an error, not the largest file', async (_n, p) => {
    const A = adFx as unknown as Record<string, Reply>
    const ctx = fakeCtx({ apiKey: 'k' }, (r: Req): Reply => r.url.includes('createtorrent') ? (tbFx as F).createtorrent as Reply : r.url.includes('mylist') ? P.torbox_mylist : r.url.includes('magnet/upload') ? A.upload : r.url.includes('magnet/status') ? A.status_ready : P.ad_files)
    expect(await p.resolve(ctx, { infoHash: HASH, episode: ep(11) })).toEqual({ error: 'No file for S01E11 in this torrent.' })
  })
})
