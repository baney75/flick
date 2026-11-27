import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

// The registry, faked: prepare() names the plugin in the code, install() records it.
const reg = vi.hoisted(() => ({ installed: { value: [] as { id: string }[] }, prepared: [] as string[] }))
vi.mock('../src/lib/plugins/registry', () => ({
  installed: reg.installed,
  prepare: async (src: { text?: string; url?: string }) => {
    const id = src.url ? 'com.youtube' : /api: 1, id: '([^']+)'/.exec(src.text!)![1]
    reg.prepared.push(id)
    return { id }
  },
  install: async (c: { id: string }) => { reg.installed.value = [...reg.installed.value, { id: c.id }] },
}))
vi.mock('../src/lib/platform', async (orig) => ({ ...(await orig<typeof import('../src/lib/platform')>()), isDesktop: false }))

import * as db from '../src/lib/db'
import { seed, seeded, SEED_VERSION } from '../src/lib/perf/seed'
import { buildSeed, PLUGIN_ID, SHELF_PLUGIN_ID } from './fixtures/perf-seed'

describe('real-app perf seed resumes across launches', () => {
  it('stops at its deadline between batches and goes on from there next launch', async () => {
    const all = buildSeed()
    let clock = 0
    // Each thumbnail batch moves the clock 10 ms; the first launch's deadline lets two batches in.
    const deps = { thumb: async (v: number) => new Blob([String(v)]), poster: () => 'data:,', now: () => clock }
    const put = db.putMany
    const spy = vi.spyOn(db, 'putMany').mockImplementation(async (name, rows) => { if (name === 'thumbs') clock += 10; return put(name, rows) })

    expect(await seed(20, deps)).toBe(false)
    expect(await db.get('kv', 'perf.seed.thumbs')).toBe(1000)
    expect(reg.prepared).toEqual([])
    expect(await seeded()).toBe(false)

    // A launch already past its deadline writes nothing and is not done.
    expect(await seed(clock, deps)).toBe(false)
    expect(await db.get('kv', 'perf.seed.thumbs')).toBe(1000)

    spy.mockClear()
    expect(await seed(Infinity, deps)).toBe(true)
    // Items were written once, by the first launch; the rest of the thumbnails, each exactly once.
    expect(spy.mock.calls.some(([name]) => name === 'items')).toBe(false)
    const thumbRows = spy.mock.calls.filter(([name]) => name === 'thumbs').flatMap(([, rows]) => rows.map(([id]) => id))
    expect(thumbRows).toEqual(all.thumbs.slice(1000).map(([id]) => id))
    expect(await db.get('kv', 'perf.seed.thumbs')).toBe(all.thumbs.length)
    expect((await db.all('items')).length).toBe(all.items.length)
    expect(await db.get(`thumbs`, all.thumbs.at(-1)![0])).toBeTruthy()
    expect(reg.prepared).toEqual([PLUGIN_ID, SHELF_PLUGIN_ID])
    expect(await db.get('kv', 'perf.seed')).toBe(SEED_VERSION)
    expect(await seeded()).toBe(true)
  })
})
