import { describe, expect, it } from 'vitest'
import { COUNTS, seedItems } from '../src/lib/perf/seed'

describe('real-app perf seed', () => {
  it('makes the counted items with unique ids and no file that exists', () => {
    const items = seedItems()
    expect(items).toHaveLength(COUNTS.episodes + COUNTS.movies + COUNTS.songs + COUNTS.books + COUNTS.photos)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(new Set(items.filter((i) => i.show).map((i) => i.show)).size).toBe(COUNTS.shows)
    expect(items.every((i) => i.src.t === 'path' && i.src.path.startsWith('/selftest/'))).toBe(true)
  })
})
