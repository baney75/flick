// SPEC-perf: the budget gate, the statistics behind it, and the seeded library perf.mjs measures.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module, no types
import { stats, matches, gate, budgetFor, table, compare, regressions } from '../scripts/perf-lib.mjs'
import { buildSeed, COUNTS, pluginCode, shelvesPluginCode, PLUGIN_ID, SHELF_PLUGIN_ID } from './fixtures/perf-seed'
import { validateLibrary, validateManifest } from '../src/lib/plugins/validate'
import { shelfChips } from '../src/lib/shelves'

const m = (samples: number[], unit = 'ms') => ({ unit, ...stats(samples) })

describe('stats', () => {
  it('takes the median and the nearest rank p95', () => {
    expect(stats([5, 1, 3])).toMatchObject({ median: 3, p95: 5, n: 3 })
    expect(stats([1, 2, 3, 4])).toMatchObject({ median: 2.5, p95: 4 })
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(stats(twenty).p95).toBe(19)
  })
  it('has no numbers for no samples', () => {
    expect(stats([])).toMatchObject({ n: 0 })
    expect(Number.isNaN(stats([]).p95)).toBe(true)
  })
})

describe('gate', () => {
  const budgets = { 'chip.all': 100, 'scroll.dropped': 5, 'cls.*': 0.05 }
  it('passes when every p95 is within its budget', () => {
    expect(gate({ 'chip.all': m([40, 60, 100]), 'scroll.dropped': m([0, 5], '%'), 'cls.library': m([0.01], 'score') }, budgets)).toEqual([])
  })
  it('fails a p95 over budget even when the median is fine (case 10: a 200 ms delay on a chip)', () => {
    const misses = gate({ 'chip.all': m([30, 31, 32, 33, 230]), 'scroll.dropped': m([0], '%'), 'cls.library': m([0], 'score') }, budgets)
    expect(misses).toEqual([{ metric: 'chip.all', p95: 230, budget: 100, why: 'over budget' }])
  })
  it('checks every metric a glob matches', () => {
    const misses = gate({ 'chip.all': m([1]), 'scroll.dropped': m([0], '%'), 'cls.library': m([0], 'score'), 'cls.scroll': m([0.08], 'score') }, budgets)
    expect(misses.map((x: { metric: string }) => x.metric)).toEqual(['cls.scroll'])
  })
  it('fails a budget nothing measured, so a broken scenario cannot pass by measuring nothing', () => {
    const misses = gate({ 'chip.all': m([1]), 'scroll.dropped': m([0], '%') }, budgets)
    expect(misses).toEqual([{ metric: 'cls.*', p95: null, budget: 0.05, why: 'not measured' }])
    expect(gate({ 'chip.all': m([]), 'scroll.dropped': m([0], '%'), 'cls.x': m([0], 'score') }, budgets)[0].why).toBe('no samples')
  })
  it('leaves phone metrics ungated', () => {
    expect(gate({ 'chip.all': m([1]), 'phone.chip.all': m([900]), 'scroll.dropped': m([0], '%'), 'cls.home': m([0], 'score') }, budgets)).toEqual([])
  })
})

describe('budgetFor and the tables', () => {
  it('prefers an exact key over a glob', () => {
    expect(matches('cls.*', 'cls.home')).toBe(true)
    expect(matches('cls.*', 'phone.cls.home')).toBe(false)
    expect(budgetFor('cls.home', { 'cls.*': 0.05, 'cls.home': 0.1 })).toBe(0.1)
    expect(budgetFor('nav.x', { 'cls.*': 0.05 })).toBeUndefined()
  })
  it('marks misses in the table and shows the change in the compare', () => {
    expect(table({ 'chip.all': m([150]) }, { 'chip.all': 100 })).toContain('| chip.all | 150 | 150 | 100 | MISS |')
    expect(compare({ 'chip.all': m([200]) }, { 'chip.all': m([50]) }, { 'chip.all': 100 })).toContain('| chip.all | 200 | 50 | -150 (-75%) | 100 |')
  })
})

describe('the perf seed (SPEC-perf rule 2)', () => {
  const seed = buildSeed()
  it('is the library the spec names, the same on every build', () => {
    const byKind = (k: string) => seed.items.filter((i) => i.kind === k && !i.server).length
    expect(seed.items.filter((i) => i.kind === 'video' && !i.server).length).toBe(COUNTS.localVideos)
    expect(byKind('audio')).toBe(COUNTS.songs)
    expect(seed.items.filter((i) => i.kind === 'photo').length).toBe(COUNTS.photos)
    expect(seed.items.filter((i) => i.server).length).toBe(COUNTS.serverItems)
    expect(seed.library.length).toBe(COUNTS.pluginLibrary)
    expect(seed.items.filter((i) => i.kind === 'book').length).toBe(COUNTS.books)
    expect(JSON.stringify(buildSeed().items.slice(0, 50))).toBe(JSON.stringify(seed.items.slice(0, 50)))
  })
  it('makes two plugins that load and pass validation, one with a 1,000 row list shelf', async () => {
    const load = async (code: string) => (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default
    const films = await load(pluginCode(seed.library, ['p']))
    const shelves = await load(shelvesPluginCode(['p']))
    for (const [mod, id] of [[films, PLUGIN_ID], [shelves, SHELF_PLUGIN_ID]] as const) {
      expect(validateManifest(mod, Object.keys(mod).filter((k) => typeof mod[k] === 'function')).id).toBe(id)
    }
    const lib = validateLibrary(await shelves.library())
    const chips = shelfChips([{ p: SHELF_PLUGIN_ID, lib }])
    expect(chips.find((c) => c.name === 'Watch later')).toMatchObject({ layout: 'list' })
    expect(chips.find((c) => c.name === 'Watch later')!.items.length).toBe(COUNTS.shelfList)
  })
})

describe('regressions', () => {
  const budgets = { 'nav.home-library': 100, 'scroll.dropped': 5, 'cls.*': 0.05 }
  it('passes run to run noise and a slow machine that is slow for both builds', () => {
    const base = { 'nav.home-library': m([190, 195, 200, 205, 210]), 'scroll.dropped': m([45, 48, 50], '%'), 'cls.home': m([0.005], 'score') }
    const cur = { 'nav.home-library': m([200, 210, 220, 230, 508]), 'scroll.dropped': m([50, 55, 57], '%'), 'cls.home': m([0.02], 'score') }
    expect(regressions(base, cur, budgets)).toEqual([])
  })
  it('fails a median half again worse and past the floor', () => {
    const base = { 'nav.home-library': m([60, 65, 70]), 'scroll.dropped': m([1, 2, 3], '%') }
    const cur = { 'nav.home-library': m([190, 200, 210]), 'scroll.dropped': m([14, 15, 16], '%') }
    expect(regressions(base, cur, budgets).map((r) => [r.metric, r.why])).toEqual([['nav.home-library', 'regressed'], ['scroll.dropped', 'regressed']])
  })
  it('needs the floor on fast metrics: 20 to 40 ms is noise, not a regression', () => {
    expect(regressions({ 'nav.home-library': m([20]) }, { 'nav.home-library': m([40]) }, budgets)).toEqual([])
    expect(regressions({ 'nav.home-library': m([20]) }, { 'nav.home-library': m([51]) }, budgets)).toHaveLength(1)
  })
  it('fails a budgeted metric the base measured and this run did not', () => {
    expect(regressions({ 'nav.home-library': m([60]) }, {}, budgets)).toMatchObject([{ metric: 'nav.home-library', why: 'not measured' }])
  })
  it('ignores metrics with no budget', () => {
    expect(regressions({ 'start.painted': m([90]) }, { 'start.painted': m([900]) }, budgets)).toEqual([])
  })
})
