import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain JS plugin with no types of its own
import youtube, { views, age, forYouQuery } from '../plugins/youtube/plugin.js'
import { validateCatalog, validateManifest, validateMeta, validateTitleAction } from '../src/lib/plugins/validate'
// What Flick's yt-dlp search tool makes of tests/fixtures/yt-search.json (src-tauri checks the two match).
import SEARCH from './fixtures/ytdlp-search.json'

/** A ctx with the ytdlp tool answering from the fixture and an in-memory store. */
function fakeCtx(results: unknown[] = SEARCH) {
  const store = new Map<string, unknown>()
  const searches: string[] = []
  return {
    searches,
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)) } },
    tools: { ytdlp: { search: async (q: string, n: number) => { searches.push(q); return structuredClone(results).slice(0, n) }, resolve: async (u: string) => { if (/gone/.test(u)) throw new Error('yt-dlp: ERROR: [youtube] gone: Video unavailable'); return 'flick-tool:ytdlp/x' } } },
    fetch: async () => ({ json: async () => ({ title: 'A shared video', author_name: 'Someone', thumbnail_url: 'https://i.ytimg.com/vi/s/hq.jpg' }) }),
    settings: {},
    platform: 'desktop',
    log: () => {},
  }
}

describe('YouTube cards', () => {
  it('shows an hour-long video as 1:02:05 with 1.2M views, the channel and its age', async () => {
    const r = validateCatalog(await youtube.catalog(fakeCtx(), { id: 'search', type: 'video', search: 'karpathy' }))
    const m = r.items.find((x) => x.name === 'A fixture lecture, one hour long')!
    expect(m.runtime).toBe('1:02:05')
    expect(m.subtitle).toBe('Andrej Karpathy')
    expect(m.badges?.[0]).toBe('1.2M views')
    expect(m.badges?.[1]).toMatch(/^\d+ (year|month)s? ago$/)
    expect(m.posterShape).toBe('landscape')
  })
  it('leaves out what the search did not say', async () => {
    const r = validateCatalog(await youtube.catalog(fakeCtx(), { id: 'search', type: 'video', search: 'x' }))
    const m = r.items.find((x) => x.name === 'No channel, no thumbnails')!
    expect(m.badges).toBeUndefined()
    expect(m.runtime).toBeUndefined()
  })
  it('writes counts and ages the way YouTube does', () => {
    expect([0, 1, 999, 1234, 12_345, 999_999, 1_200_000, 391_000_000, 2_500_000_000].map(views))
      .toEqual(['No views', '1 view', '999 views', '1.2K views', '12K views', '999K views', '1.2M views', '391M views', '2.5B views'])
    expect(views(null)).toBeNull()
    const now = Date.UTC(2026, 10, 26)
    const ago = (s: number) => age(now / 1000 - s, now)
    expect([30, 120, 7200, 86400 * 3, 86400 * 14, 86400 * 60, 86400 * 362, 86400 * 800].map(ago))
      .toEqual(['Just now', '2 minutes ago', '2 hours ago', '3 days ago', '2 weeks ago', '2 months ago', '1 year ago', '2 years ago'])
    expect(age(null, now)).toBeNull()
  })
  it('keeps the channel and badges on the title page', async () => {
    const ctx = fakeCtx()
    await youtube.catalog(ctx, { id: 'search', type: 'video', search: 'karpathy' })
    const m = validateMeta(await youtube.meta(ctx, { type: 'video', id: 'https://www.youtube.com/watch?v=kArPaThY001' }))
    expect(m.subtitle).toBe('Andrej Karpathy')
    expect(m.badges?.[0]).toBe('1.2M views')
  })
})

describe('card fields in the contract', () => {
  it('keeps a subtitle and at most 4 short badges', () => {
    const m = validateMeta({ id: 'a', type: 'video', name: 'A', subtitle: ' Chan ', badges: ['one', '', 3, 'x'.repeat(60), 'b', 'c', 'd'] })
    expect(m.subtitle).toBe('Chan')
    expect(m.badges).toEqual(['one', 'x'.repeat(40), 'b', 'c'])
  })
  it('drops a wrong-shaped subtitle or badges but keeps the title', () => {
    const m = validateMeta({ id: 'a', type: 'video', name: 'A', subtitle: { x: 1 }, badges: 'HD' })
    expect(m.name).toBe('A')
    expect(m.subtitle).toBeUndefined()
    expect(m.badges).toBeUndefined()
  })
})

const FIX = (n: number) => (SEARCH as { id: string; channel?: string }[])[n]
const FNS = ['catalog', 'meta', 'streams', 'userCatalogs', 'titleAction', 'progress']

describe('YouTube lists, For You and keys', () => {
  it('is a grid with For You, the topics, and L and W on each title', () => {
    const { catalog, meta, streams, userCatalogs, titleAction, progress, ...m } = youtube
    const v = validateManifest(m, FNS)
    expect(v.layout).toBe('grid')
    expect(v.catalogs.map((c) => c.name)).toEqual(['Search', 'For You', 'Science', 'Nature', 'Classic films', 'Concerts', 'Programming', 'AI', 'Math', 'History', 'Lectures'])
    expect(v.titleActions).toEqual([{ id: 'like', label: 'Like', key: 'l' }, { id: 'later', label: 'Watch later', key: 'w' }])
    void [catalog, meta, streams, userCatalogs, titleAction, progress]
  })
  it('press W: the video is in Watch later, shows marked, and W again takes it out', async () => {
    const ctx = fakeCtx()
    await youtube.catalog(ctx, { id: 'search', type: 'video', search: 'karpathy' })
    const id = 'https://www.youtube.com/watch?v=kArPaThY001'
    expect(await youtube.userCatalogs(ctx)).toEqual([])
    expect(validateTitleAction(await youtube.titleAction(ctx, { type: 'video', id, action: 'later' }))).toEqual({ ok: true, on: true, message: 'Added to Watch later' })
    expect(await youtube.userCatalogs(ctx)).toEqual([{ id: 'my-later', name: 'Watch later', type: 'video' }])
    const later = validateCatalog(await youtube.catalog(ctx, { id: 'my-later', type: 'video' }))
    expect(later.items.map((m) => [m.name, m.runtime, m.subtitle])).toEqual([['A fixture lecture, one hour long', '1:02:05', 'Andrej Karpathy']])
    expect(validateMeta(await youtube.meta(ctx, { type: 'video', id })).marks).toEqual(['later'])
    expect((await youtube.titleAction(ctx, { type: 'video', id, action: 'later' })).on).toBe(false)
    expect(await youtube.userCatalogs(ctx)).toEqual([])
  })
  it('likes a shared link it never searched, from oEmbed', async () => {
    const ctx = fakeCtx()
    await youtube.titleAction(ctx, { type: 'video', id: 'https://youtu.be/shared1', action: 'like' })
    const liked = validateCatalog(await youtube.catalog(ctx, { id: 'my-liked', type: 'video' }))
    expect(liked.items.map((m) => [m.name, m.subtitle])).toEqual([['A shared video', 'Someone']])
  })
  it('play two videos from one channel: For You searches that channel next', async () => {
    const ctx = fakeCtx()
    await youtube.catalog(ctx, { id: 'search', type: 'video', search: 'x' })
    expect((await youtube.catalog(ctx, { id: 'foryou', type: 'video' })).items).toEqual([])
    // One from the search, one shared link whose oEmbed names the same channel.
    expect(FIX(3).channel).toBe('Someone')
    await youtube.progress(ctx, { type: 'video', id: FIX(3).id, pos: 10, dur: 100 })
    await youtube.catalog(ctx, { id: 'foryou', type: 'video' })
    expect(ctx.searches.at(-1)).not.toBe('Someone')
    await youtube.progress(ctx, { type: 'video', id: 'https://youtu.be/shared2', pos: 10, dur: 100 })
    await youtube.catalog(ctx, { id: 'foryou', type: 'video' })
    expect(ctx.searches.at(-1)).toBe('Someone')
  })
  it('History is newest first, each video once', async () => {
    const ctx = fakeCtx()
    await youtube.catalog(ctx, { id: 'search', type: 'video', search: 'x' })
    for (const n of [0, 1, 0, 0]) await youtube.progress(ctx, { type: 'video', id: FIX(n).id, pos: 5, dur: 9 })
    const h = validateCatalog(await youtube.catalog(ctx, { id: 'my-history', type: 'video' }))
    expect(h.items.map((m) => m.id)).toEqual([FIX(0).id, FIX(1).id])
  })
  it('For You falls back to words two titles share, and liking a watched video is not a second one', () => {
    expect(forYouQuery([{ id: 1, channel: 'A', name: 'Rust ownership talk' }, { id: 2, channel: 'B', name: 'Rust async talk' }], [{ id: 1, channel: 'A', name: 'Rust ownership talk' }])).toBe('rust talk')
    expect(forYouQuery([], [])).toBeNull()
  })
  it("a video yt-dlp cannot play says yt-dlp's reason", async () => {
    await expect(youtube.streams(fakeCtx(), { type: 'video', id: 'https://www.youtube.com/watch?v=gone' })).rejects.toThrow('yt-dlp: ERROR: [youtube] gone: Video unavailable')
  })
})
