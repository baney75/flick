import { describe, expect, it } from 'vitest'
import { failures, invokeSummary, medianReport, override, perfMarkdown, table, webkitPath, youtubeFailures, youtubeTable, IDENTIFIER } from '../scripts/desktop-selftest.mjs'
import { hostOf } from '../src/lib/plugins/selftest'

const ok = (name: string, totalMs: number) => ({ url: `/plugins/${name}.js`, name, totalMs, steps: [{ step: 'fetch', ms: 1 }, { step: 'ping', ms: totalMs - 1 }] })

describe('desktop self-test report', () => {
  it('builds a separate, hidden app', () => {
    expect(IDENTIFIER).toBe('dev.flick.selftest')
    const o = override({ app: { windows: [{ label: 'main', width: 1280 }, { label: 'other', visible: true }] } })
    expect(o).toMatchObject({ identifier: 'dev.flick.selftest', productName: 'Flick Self-test' })
    expect(o.app.windows).toEqual([
      { label: 'main', width: 1280, visible: false, focus: false, backgroundThrottling: 'disabled' },
      { label: 'other', visible: false, focus: false, backgroundThrottling: 'disabled' },
    ])
  })

  it('passes fast plugins and fails slow ones, errors and empty reports', () => {
    expect(failures({ plugins: [ok('archive', 40), ok('youtube', 1999)] })).toEqual([])
    expect(failures({ plugins: [ok('stremio', 20_400)] })).toEqual(['stremio: 20400 ms, over 2000 ms'])
    expect(failures({ plugins: [{ ...ok('torbox', 20_000), error: 'The plugin took longer than 20 seconds.', failedAfter: 'sandbox' }] }))
      .toEqual(['torbox: The plugin took longer than 20 seconds. (after sandbox)'])
    expect(failures({ plugins: [] })).toHaveLength(1)
    expect(failures({ error: 'boom' })).toEqual(['the self-test itself failed: boom'])
  })

  it('prints one row per plugin with each step', () => {
    const t = table({ plugins: [ok('archive', 40)] })
    expect(t).toContain('| archive')
    expect(t).toContain('fetch 1, ping 39')
  })
})

const inv = (cmd: string, start: number, end: number, ok = true) => ({ cmd, start, end, ok })
const perf = (home: number, tap: number) => ({
  phase: 'measured',
  start: { launchToSetupMs: 140, setupToPageMs: 50, launchToPageMs: 190, responseEndMs: 2, domInteractiveMs: 2, domContentLoadedMs: 50, firstPaintMs: 70, homeSettledMs: home, homeInteractiveMs: home, launchToHomeInteractiveMs: 190 + home, capped: false },
  scriptFetch: { kb: 297, ms: 1 },
  taps: [{ label: 'Home to Library', settledMs: tap, frameMs: null, capped: false, invokes: 0, slowestInvokeMs: 0 as number | null }],
  invokes: [],
})

describe('desktop self-test perf', () => {
  it('counts start-up invokes and which ones waited for another', () => {
    const s = invokeSummary([inv('a', 0, 5), inv('b', 6, 8), inv('c', 6, 20, false), inv('late', 500, 501)], 100)
    expect(s).toMatchObject({ count: 3, sumMs: 21, spanMs: 20, maxConcurrent: 2 })
    expect(s.by.c).toEqual({ count: 1, totalMs: 14, maxMs: 14, failed: 1 })
    expect(s.by.late).toBeUndefined()
    expect(invokeSummary([inv('a', 0, 5), inv('b', 6, 8)], 100).serial).toBe(1)
    expect(invokeSummary([inv('a', 0, 5), inv('b', 50, 60)], 100).serial).toBe(0)
  })

  it('takes the median of measured runs and skips seed runs', () => {
    const m = medianReport([perf(100, 30), { phase: 'seeded' }, perf(140, 10), perf(120, 20)])
    expect(m.runs).toBe(3)
    expect(m.start.homeInteractiveMs).toBe(120)
    expect(m.taps[0]).toMatchObject({ label: 'Home to Library', settledMs: 20 })
    expect(medianReport([{ phase: 'seeded' }])).toBeNull()
    // A run whose invoke never answered counts as the slowest, not as a reason to drop the median.
    const slow = (ms: number | null) => { const r = perf(100, 20); r.taps[0] = { ...r.taps[0], invokes: 3, slowestInvokeMs: ms }; (r.start as Record<string, unknown>).homeRowsMs = ms; return r }
    expect(medianReport([slow(7000), slow(null), slow(8000)]).taps[0].slowestInvokeMs).toBe(8000)
    expect(medianReport([slow(7000), slow(null), slow(null)]).start.homeRowsMs).toBeNull()
    // A run that stopped before a tap also counts as slowest there, not as a tap that waited on nothing.
    const tapless = perf(100, 20); tapless.taps = []
    expect(medianReport([slow(7000), slow(8000), tapless]).taps[0].slowestInvokeMs).toBe(8000)
  })

  it('prints the app beside the browser and leaves launch rows blank for the browser', () => {
    const md = perfMarkdown(medianReport([perf(120, 20)]), medianReport([perf(80, 15)]))
    expect(md).toContain('| Home interactive (from page start) | 120 | 80 |')
    expect(md).toContain('| Launch to page start | 190 | n/a |')
    expect(md).toContain('| Home to Library | 20 | 15 |')
    expect(perfMarkdown(null, null)).toContain('| Home interactive (from page start) | n/a | n/a |')
  })

  it("uses Playwright's WebKit when present, else the newest one cached, and installs nothing", () => {
    const fake = (files: string[]) => ({
      existsSync: (p: string) => files.some((f) => f === p || f.startsWith(`${p}/`)),
      readdirSync: (p: string) => [...new Set(files.filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split('/')[0]))],
    })
    const own = { executablePath: () => '/pw/webkit-2388/pw_run.sh' }
    expect(webkitPath(own, '/pw', fake(['/pw/webkit-2388/pw_run.sh']))).toBeUndefined()
    expect(() => webkitPath(own, '/pw', fake([]))).toThrow(/--no-browser/)
    const cached = fake(['/pw/webkit-2248/pw_run.sh', '/pw/webkit-2336/pw_run.sh', '/pw/webkit-2311/pw_run.sh', '/pw/webkit-2400/other', '/pw/chromium-1248/x'])
    expect(webkitPath(own, '/pw', cached)).toBe('/pw/webkit-2336/pw_run.sh')
  })
})

describe('YouTube self-test report', () => {
  const run = { query: 'karpathy', rows: 20, host: 'asset://localhost', steps: [{ step: 'install', ms: 40 }, { step: 'search', ms: 2100, detail: '20 rows' }, { step: 'streams', ms: 900 }, { step: 'open', ms: 3000 }] }
  it('passes with rows and a playable address, and says why when not', () => {
    expect(youtubeFailures(run)).toEqual([])
    expect(youtubeFailures({ ...run, rows: 0 })).toEqual(['YouTube: search "karpathy" returned no rows'])
    expect(youtubeFailures({ ...run, host: 'not a URL' })).toHaveLength(1)
    expect(youtubeFailures({ ...run, error: 'yt-dlp: ERROR: blocked', failedAfter: 'search' })).toEqual(['YouTube: yt-dlp: ERROR: blocked (at search)'])
    expect(youtubeFailures(null)).toHaveLength(1)
  })
  it('prints each step and the host only', () => {
    expect(youtubeTable(run)).toContain('| search  |   2100 | 20 rows')
    expect(youtubeTable(run)).toContain('Plays from asset://localhost.')
  })
  it('keeps the path and query out of the reported address', () => {
    expect(hostOf('http://asset.localhost/Users/x/cache/ytdlp/tok123/index.m3u8?sig=abc')).toBe('http://asset.localhost')
    expect(hostOf('nope')).toBe('not a URL')
  })
})
