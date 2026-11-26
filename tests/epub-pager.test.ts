import { describe, it, expect } from 'vitest'
import { pager } from '../src/lib/epub'

// Runs Flick's chapter pager against a stand-in window, the way the sandboxed frame runs it.
function frame(start: number | 'end' | string = 0) {
  const ls: Record<string, ((e: unknown) => void)[]> = {}
  const msgs: { t: string; page?: number; pages?: number; d?: number }[] = []
  const se = { scrollWidth: 0, scrollLeft: 0 }
  const win = {
    w: 0,
    document: { scrollingElement: se, getElementById: () => null },
    get innerWidth() { return win.w },
    addEventListener: (t: string, f: (e: unknown) => void) => { (ls[t] ??= []).push(f) },
    parent: { postMessage: (m: never) => msgs.push(m) },
    requestAnimationFrame: (f: () => void) => f(),
  }
  // eslint-disable-next-line no-new-func
  new Function('win', 'start', `with (win) { (${pager.toString()})(start, 1) }`)(win, start)
  const fire = (t: string, e: unknown = {}) => (ls[t] ?? []).forEach((f) => f(e))
  const last = () => msgs.filter((m) => m.t === 'pos').at(-1)
  return { win, se, fire, last, msgs }
}

describe('the EPUB pager', () => {
  it('counts pages from the frame width', () => {
    const f = frame()
    f.win.w = 800; f.se.scrollWidth = 2400
    f.fire('load')
    expect(f.last()).toMatchObject({ page: 0, pages: 3 })
  })
  it('recovers when the frame loads before it has a width', () => {
    const f = frame()
    f.fire('load')
    f.win.w = 800; f.se.scrollWidth = 2400
    f.fire('resize')
    expect(f.last()).toMatchObject({ page: 0, pages: 3 })
    f.fire('message', { source: f.win.parent, data: { t: 'turn', d: 1 } })
    expect(f.last()).toMatchObject({ page: 1, pages: 3 })
  })
  it('never reports a page that is not a whole number', () => {
    const f = frame(0.5)
    f.fire('load')
    f.fire('resize')
    for (const m of f.msgs.filter((x) => x.t === 'pos')) {
      expect(Number.isInteger(m.page) && Number.isInteger(m.pages)).toBe(true)
    }
  })
})
