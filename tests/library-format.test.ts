// SPEC-library-format P10a: open kinds, shaped libraries, added and facts. Case numbers are the spec's.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as V from '../src/lib/plugins/validate'
import { buildTitles } from '../src/lib/titles'
import type { Installed } from '../src/lib/plugins/runtime'

const call = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
  return vi.fn()
})
vi.mock('../src/lib/plugins/runtime', async (orig) => ({ ...(await orig<typeof import('../src/lib/plugins/runtime')>()), callPlugin: call }))
const { installed } = await import('../src/lib/plugins/registry')
const { libraries, loadLibrary, searchAll, sources } = await import('../src/lib/plugins/use')

const meta = (over: Record<string, unknown> = {}) => ({ id: 'a', type: 'movie', name: 'Alpha', ...over })
const notes = () => { const out: string[] = []; return { out, note: (t: string) => { out.push(t) } } }

describe('open kinds (rule 1)', () => {
  it('case 1: today\'s Meta[] library works and is a movie title', () => {
    const lib = V.validateLibrary([meta()])
    expect(lib).toEqual({ shelves: [], items: [{ id: 'a', type: 'movie', name: 'Alpha' }] })
    expect(buildTitles([], new Map(), [{ p: 'x', pname: 'X', list: lib.items }], () => false)[0].type).toBe('movie')
  })
  it('case 2: a custom kind is kept, is "other", and never merges with a same-named movie', () => {
    const lib = V.validateLibrary([meta({ id: 'r', type: 'recipe', name: 'Dune' })])
    expect(lib.items[0].type).toBe('recipe')
    const t = buildTitles([], new Map(), [{ p: 'x', pname: 'X', list: lib.items }, { p: 'y', pname: 'Y', list: [meta({ id: 'd', name: 'Dune' }) as V.Meta] }], () => false)
    expect(t.map((x) => x.type).sort()).toEqual(['movie', 'other'])
    expect(t.every((x) => x.srcs.length === 1)).toBe(true)
  })
  it('case 3: a bad kind skips only that item, with one note for the call', () => {
    const { out, note } = notes()
    const items = [meta({ type: 'Recipe' }), meta({ type: 'x' }), meta({ type: 'k'.repeat(33) }), meta({ type: 5 }), meta({ id: 'ok', type: 'k'.repeat(32) })]
    expect(V.validateLibrary(items, note).items.map((m) => m.id)).toEqual(['ok'])
    expect(out).toEqual([expect.stringMatching(/^Skipped 4 items: Meta type "Recipe" is not one of movie/)])
    expect(() => V.validateMeta(meta({ type: 'Movie' }))).toThrow(V.PluginError)
  })
  it('case 4: a podcast catalog is accepted and catalog() gets type "podcast"', async () => {
    const m = V.validateManifest({ api: 1, id: 'org.example.pods', name: 'Pods', version: '1', catalogs: [{ id: 'find', name: 'Find', type: 'podcast', search: true }] }, ['catalog', 'meta', 'streams'])
    expect(m.catalogs[0].type).toBe('podcast')
    installed.value = [{ id: m.id, kind: 'source', enabled: true, manifest: m } as Installed]
    call.mockResolvedValue({ items: [], more: false })
    await searchAll('news', () => {}, sources.value[0])
    expect(call.mock.calls[0].slice(1)).toEqual(['catalog', [{ id: 'find', type: 'podcast', search: 'news', skip: 0 }]])
  })
})

describe('shaped libraries (rules 2 and 3)', () => {
  it('case 5: a declared shelf holds its item', () => {
    const lib = V.validateLibrary({ shelves: [{ id: 'liked', name: 'Liked' }], items: [meta({ shelves: ['liked'] })] })
    expect(lib.shelves).toEqual([{ id: 'liked', name: 'Liked' }])
    expect(lib.items[0].shelves).toEqual(['liked'])
    // shelves: null is the same as none; a declared id after 8 undeclared ones still counts.
    expect(V.validateLibrary({ shelves: null, items: [meta()] }).items).toHaveLength(1)
    const many = V.validateLibrary({ shelves: [{ id: 'liked', name: 'Liked' }], items: [meta({ shelves: [...'abcdefgh', 'liked'] })] })
    expect(many.items[0].shelves).toEqual(['liked'])
    // Outside library() shelf ids mean nothing and are not kept.
    expect(V.validateCatalog([meta({ shelves: ['liked'] })]).items[0].shelves).toBeUndefined()
  })
  it('case 6: an undeclared shelf id is dropped from 300 items with one note', () => {
    const { out, note } = notes()
    const items = Array.from({ length: 300 }, (_, i) => meta({ id: `m${i}`, shelves: ['nope'] }))
    const lib = V.validateLibrary({ shelves: [], items }, note)
    expect(lib.items).toHaveLength(300)
    expect(lib.items.every((m) => m.shelves === undefined)).toBe(true)
    expect(out).toEqual([expect.stringContaining('nope')])
  })
  it('case 7: 21 shelves keep the first 20, with a note', () => {
    const { out, note } = notes()
    const shelves = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }))
    expect(V.validateLibrary({ shelves, items: [] }, note).shelves.map((s) => s.id)).toEqual(shelves.slice(0, 20).map((s) => s.id))
    expect(out).toEqual(['Kept the first 20 of 21 shelves.'])
  })
  it('case 8: a duplicate shelf id keeps the first', () => {
    const lib = V.validateLibrary({ shelves: [{ id: 'liked', name: 'Liked' }, { id: 'liked', name: 'Loved' }], items: [] })
    expect(lib.shelves).toEqual([{ id: 'liked', name: 'Liked' }])
  })
  it('case 9: a blank name drops the shelf, a long one is trimmed to 40; bad ids drop, the rest stay', () => {
    const { out, note } = notes()
    const lib = V.validateLibrary({ shelves: [{ id: 'blank', name: '   ' }, { id: 'long', name: ` ${'n'.repeat(41)} ` }, { id: 'Bad Id', name: 'X' }, { id: 'ok', name: 'OK', layout: 'list', order: 'added' }], items: [] }, note)
    expect(lib.shelves).toEqual([{ id: 'long', name: 'n'.repeat(40) }, { id: 'ok', name: 'OK', layout: 'list', order: 'added' }])
    expect(out).toEqual([expect.stringMatching(/^Dropped 2 shelf entries: shelf "blank" has no name/)])
  })
  it('case 22: neither shape drops the whole result, and the plugin\'s library is empty', async () => {
    expect(() => V.validateLibrary({ items: 'x' })).toThrow(/list of metas or \{ shelves, items \}/)
    expect(() => V.validateLibrary({ shelves: 'x', items: [] })).toThrow(V.PluginError)
    const rec = { id: 'org.example.lib', kind: 'source', enabled: true, manifest: { has: { library: true } } } as unknown as Parameters<typeof loadLibrary>[0]
    libraries.value = { [rec.id]: { shelves: [], items: [meta() as V.Meta] } }
    call.mockRejectedValueOnce(new V.PluginError('library() must return a list of metas or { shelves, items }.'))
    await loadLibrary(rec, true)
    expect(libraries.value[rec.id]).toEqual({ shelves: [], items: [] })
  })
  it('case 23: 1001 items keep the first 1000', () => {
    const { out, note } = notes()
    const items = Array.from({ length: 1001 }, (_, i) => meta({ id: `m${i}` }))
    const lib = V.validateLibrary({ items }, note)
    expect(lib.items).toHaveLength(1000)
    expect(lib.items.at(-1)!.id).toBe('m999')
    expect(out).toEqual(['Kept the first 1000 of 1001 items.'])
    expect(V.validateLibrary(items).items).toHaveLength(1000)
  })
})

describe('added and facts (rules 4 and 5)', () => {
  it('case 12: seconds become milliseconds; milliseconds stay; nonsense is unknown', () => {
    expect(V.validateMeta(meta({ added: 1732600000 })).added).toBe(1732600000000)
    expect(V.validateMeta(meta({ added: 1732600000000 })).added).toBe(1732600000000)
    for (const added of ['1732600000', -1, 0, NaN]) expect(V.validateMeta(meta({ added })).added).toBeUndefined()
  })
  it('case 17: facts keep the first 8 good ones; a bad fact never drops the title', () => {
    const facts = [{ label: 'Servings', value: '4' }, { label: 'Year', value: 2024 }, 'x', { label: '', value: 'y' }, { label: 'L'.repeat(31), value: 'v'.repeat(121) },
      ...Array.from({ length: 7 }, (_, i) => ({ label: `F${i}`, value: `${i}` }))]
    const m = V.validateMeta(meta({ facts }))
    expect(m.facts).toHaveLength(8)
    expect(m.facts!.slice(0, 3)).toEqual([{ label: 'Servings', value: '4' }, { label: 'Year', value: '2024' }, { label: 'L'.repeat(30), value: 'v'.repeat(120) }])
    expect(V.validateMeta(meta({ facts: 'nope' })).facts).toBeUndefined()
  })
})

beforeEach(() => { call.mockReset() })
