// SPEC-library-format P10b: Library chips from plugin libraries. Case numbers are the spec's.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import * as V from '../src/lib/plugins/validate'
import { buildTitles } from '../src/lib/titles'
import { shelfChips, shelfOrder, shelfKey, metaText, typeChip, type ShelfChip } from '../src/lib/shelves'
import type { Installed } from '../src/lib/plugins/runtime'

const call = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
  return vi.fn()
})
vi.mock('../src/lib/plugins/runtime', async (orig) => ({ ...(await orig<typeof import('../src/lib/plugins/runtime')>()), callPlugin: call }))
const { onChange } = await import('../src/lib/plugins/runtime')
const { installed } = await import('../src/lib/plugins/registry')
await import('../src/lib/plugins/use')

const meta = (id: string, over: Partial<V.Meta> = {}): V.Meta => ({ id, type: 'video', name: id, ...over })
const lib = (shelves: V.Shelf[], items: V.Meta[]): V.Library => ({ shelves, items })
const ids = (c: ShelfChip) => c.items.map((x) => `${x.p}:${x.m.id}`)

describe('shelf chips (rules 8 and 9)', () => {
  it('case 10: two plugins\' "Watch later" are one chip, A\'s items then B\'s, first spelling wins', () => {
    const chips = shelfChips([
      { p: 'a', lib: lib([{ id: 'wl', name: 'Watch later' }], [meta('1', { shelves: ['wl'] }), meta('2', { shelves: ['wl'] })]) },
      { p: 'b', lib: lib([{ id: 'later', name: ' Watch Later ' }], [meta('3', { shelves: ['later'] })]) },
    ])
    expect(chips).toHaveLength(1)
    expect(chips[0].name).toBe('Watch later')
    expect(ids(chips[0])).toEqual(['a:1', 'a:2', 'b:3'])
  })
  it('case 11: a shelf with no items has no chip', () => {
    expect(shelfChips([{ p: 'a', lib: lib([{ id: 'liked', name: 'Liked' }], [meta('1')]) }])).toEqual([])
  })
  it('case 13: with no shelf order, "Recently added" keeps plugin order for items with no added', () => {
    const [c] = shelfChips([{ p: 'a', lib: lib([{ id: 's', name: 'S' }], ['c', 'a', 'b'].map((x) => meta(x, { shelves: ['s'] }))) }])
    expect(c.order).toBe('plugin')
    expect(shelfOrder(c, 'added').map((x) => x.m.id)).toEqual(['c', 'a', 'b'])
    expect(shelfOrder(c).map((x) => x.m.id)).toEqual(['c', 'a', 'b'])
    expect(shelfOrder(c, 'title').map((x) => x.m.id)).toEqual(['a', 'b', 'c'])
    const [n] = shelfChips([{ p: 'a', lib: lib([{ id: 's', name: 'S', order: 'added' }], [meta('old', { shelves: ['s'], added: 1 }), meta('new', { shelves: ['s'], added: 2 })]) }])
    expect(shelfOrder(n).map((x) => x.m.id)).toEqual(['new', 'old'])
  })
  it('case 14: layout list is kept; without a layout the most common posterShape, else poster', () => {
    const one = (s: V.Shelf, items: V.Meta[]) => shelfChips([{ p: 'a', lib: lib([s], items) }])[0].layout
    expect(one({ id: 's', name: 'S', layout: 'list' }, [meta('1', { shelves: ['s'], posterShape: 'square' })])).toBe('list')
    expect(one({ id: 's', name: 'S' }, [meta('1', { shelves: ['s'], posterShape: 'square' }), meta('2', { shelves: ['s'], posterShape: 'square' }), meta('3', { shelves: ['s'], posterShape: 'landscape' })])).toBe('square')
    expect(one({ id: 's', name: 'S' }, [meta('1', { shelves: ['s'] })])).toBe('poster')
  })
  it('case 20: chip keys fold case and space, so a saved tab survives a reload', () => {
    expect(shelfKey(' Watch Later ')).toBe('shelf:watch later')
    expect(shelfChips([{ p: 'a', lib: lib([{ id: 'wl', name: 'Watch Later' }], [meta('1', { shelves: ['wl'] })]) }])[0].key).toBe('shelf:watch later')
  })
})

describe('Flick\'s own chips by type (rule 7)', () => {
  const titles = (items: V.Meta[]) => buildTitles([], new Map(), [{ p: 'a', pname: 'A', list: items }], () => false)
  it('case 15: a plugin song with no shelf is a Music title', () => {
    expect(titles([meta('s', { type: 'audio' })]).map(typeChip)).toEqual(['music'])
  })
  it('case 16: video and channel are Videos; books, audiobooks by type; movies and custom kinds are not', () => {
    const t = titles([meta('v'), meta('c', { type: 'channel' }), meta('b', { type: 'book' }), meta('ab', { type: 'audiobook' }), meta('m', { type: 'movie', year: '2020' }), meta('r', { type: 'recipe' })])
    expect(Object.fromEntries(t.map((x) => [x.name, typeChip(x)]))).toEqual({ v: 'videos', c: 'videos', b: 'books', ab: 'audiobooks', m: null, r: null })
    expect(titles([meta('m', { type: 'movie' })]).map(typeChip)).toEqual([null])
  })
  it('a plugin item\'s added dates its title for "Recently added"', () => {
    expect(titles([meta('v', { added: 5 })])[0].addedAt).toBe(5)
  })
})

describe('search and refresh (rules 11 and 12)', () => {
  it('case 18: search reads name, subtitle, badges and fact values', () => {
    const t = metaText(meta('g', { name: 'Zelda', subtitle: 'Nintendo', badges: ['2023'], facts: [{ label: 'Platform', value: 'Switch' }] }))
    for (const w of ['Zelda', 'Nintendo', '2023', 'Switch']) expect(t).toContain(w)
    expect(t).not.toContain('Platform')
  })
  it('after an action, progress or title action the plugin\'s library reloads at once', async () => {
    const m = V.validateManifest({ api: 1, id: 'org.example.yt', name: 'YT', version: '1', catalogs: [{ id: 'a', name: 'A', type: 'video' }] }, ['catalog', 'meta', 'streams', 'library'])
    installed.value = [{ id: m.id, kind: 'source', enabled: true, manifest: m } as Installed]
    call.mockResolvedValue({ shelves: [], items: [] })
    for (const f of onChange) f(m.id)
    for (const f of onChange) f(m.id)
    expect(call.mock.calls.map((c) => c[1])).toEqual(['library', 'library'])
  })
})
