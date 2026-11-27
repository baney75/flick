import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain JS plugin with no types of its own
import youtube, { views, age } from '../plugins/youtube/plugin.js'
import { validateCatalog, validateMeta } from '../src/lib/plugins/validate'
// What Flick's yt-dlp search tool makes of tests/fixtures/yt-search.json (src-tauri checks the two match).
import SEARCH from './fixtures/ytdlp-search.json'

/** A ctx with the ytdlp tool answering from the fixture and an in-memory store. */
function fakeCtx(results: unknown[] = SEARCH) {
  const store = new Map<string, unknown>()
  const searches: string[] = []
  return {
    searches,
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)) } },
    tools: { ytdlp: { search: async (q: string, n: number) => { searches.push(q); return structuredClone(results).slice(0, n) }, resolve: async () => 'flick-tool:ytdlp/x' } },
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
