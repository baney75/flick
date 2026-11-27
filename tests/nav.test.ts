import { describe, it, expect } from 'vitest'
import { tabOf, HOME_ROWS_PER_SOURCE } from '../src/lib/nav'

describe('the main bar', () => {
  it('puts every route under Home, Library or Settings', () => {
    const cases: [string, string][] = [
      ['', '/'],
      ['/', '/'],
      ['/p/stremio', '/'],
      ['/p/stremio/movie/tt0816692?v=x', '/'],
      ['/sources', '/'],
      ['/continue', '/library'],
      ['/library', '/library'],
      ['/show/the%20office', '/library'],
      ['/read/abc', '/library'],
      ['/listen/abc', '/library'],
      ['/settings', '/settings'],
      ['/servers', '/settings'],
      ['/settings/servers', '/settings'],
      ['/setup?c=x', '/settings'],
    ]
    for (const [route, tab] of cases) expect(tabOf(route), route).toBe(tab)
  })
  it('keeps Home short: a few rows per source', () => {
    expect(HOME_ROWS_PER_SOURCE).toBeLessThanOrEqual(3)
  })
})
