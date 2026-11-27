import { describe, expect, it } from 'vitest'
import { failures, override, table, IDENTIFIER } from '../scripts/desktop-selftest.mjs'

const ok = (name: string, totalMs: number) => ({ url: `/plugins/${name}.js`, name, totalMs, steps: [{ step: 'fetch', ms: 1 }, { step: 'ping', ms: totalMs - 1 }] })

describe('desktop self-test report', () => {
  it('builds a separate, hidden app', () => {
    expect(IDENTIFIER).toBe('dev.flick.selftest')
    const o = override({ app: { windows: [{ label: 'main', width: 1280 }, { label: 'other', visible: true }] } })
    expect(o).toMatchObject({ identifier: 'dev.flick.selftest', productName: 'Flick Self-test' })
    expect(o.app.windows).toEqual([{ label: 'main', width: 1280, visible: false, focus: false }, { label: 'other', visible: false, focus: false }])
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
