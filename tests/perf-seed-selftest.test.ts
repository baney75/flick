import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/platform', async (orig) => ({ ...(await orig<typeof import('../src/lib/platform')>()), isDesktop: false }))

import { COUNTS, IMAGES, SEED_PLUGIN, seedPlugins } from '../src/lib/perf/seed'
import { buildSeed, COUNTS as FIXTURE, PLUGIN_ID, SHELF_PLUGIN_ID } from './fixtures/perf-seed'

describe('real-app perf seed', () => {
  it('is the perf.mjs fixture (SPEC-perf rule 2)', () => {
    expect(COUNTS).toBe(FIXTURE)
    const s = buildSeed()
    expect(s.items).toHaveLength(COUNTS.localVideos + COUNTS.songs + COUNTS.books + COUNTS.photos + COUNTS.serverItems)
    expect(Math.max(...s.thumbs.map(([, v]) => v))).toBe(IMAGES.thumbs - 1)
  })

  it('holds both fixture plugins, and YouTube only on the desktop', () => {
    expect(seedPlugins(false)).toEqual([PLUGIN_ID, SHELF_PLUGIN_ID])
    expect(seedPlugins(true)).toEqual([PLUGIN_ID, SHELF_PLUGIN_ID, SEED_PLUGIN.id])
  })
})
