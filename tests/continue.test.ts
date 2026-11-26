import { describe, it, expect } from 'vitest'
import { continueEntries, inProgress } from '../src/lib/continue'
import type { Progress } from '../src/lib/store'
import type { Meta } from '../src/lib/plugins/validate'

const item = (id: string, pos: number, dur: number, at: number, book = false): Progress => ({ pos, dur, at, title: id, book, ref: { t: 'item', id } })
const plug = (p: string, id: string, videoId: string, pos: number, at: number): Progress =>
  ({ pos, dur: 1000, at, title: id, ref: { t: 'plugin', p, type: 'series', id, videoId } })
const meta = (id: string, progress?: Meta['progress']): Meta => ({ id, type: 'movie', name: id, progress } as Meta)
const keys = (l: ReturnType<typeof continueEntries>) => l.map((e) => (e.t === 'local' ? e.k : `${e.p}:${e.m.id}`))

describe('in progress', () => {
  it('means started and not finished', () => {
    const cases: [Progress, boolean][] = [
      [item('a', 100, 1000, 1), true],
      [item('a', 9, 1000, 1), false],
      [item('a', 10, 1000, 1), true],
      [item('a', 950, 1000, 1), false],
      [item('a', 100, 0, 1), true],
      [item('b', 2, 100, 1, true), true],
      [item('b', 1, 100, 1, true), false],
      [item('b', 100, 100, 1, true), false],
    ]
    for (const [p, want] of cases) expect(inProgress(p), JSON.stringify(p)).toBe(want)
  })
})

describe('the Continue tab', () => {
  it('lists this device and plugin titles together, newest first', () => {
    const l = continueEntries({ a: item('a', 100, 1000, 10), b: item('b', 100, 1000, 30) }, [{ p: 'stremio', list: [meta('tt1', { pos: 50, dur: 100, at: 20 })] }])
    expect(keys(l)).toEqual(['b', 'stremio:tt1', 'a'])
  })
  it('shows a series once, from its latest episode', () => {
    const l = continueEntries({ e1: plug('s', 'tt9', 'tt9:1:1', 100, 5), e2: plug('s', 'tt9', 'tt9:1:2', 100, 9) }, [])
    expect(keys(l)).toEqual(['e2'])
  })
  it("prefers Flick's own position over the plugin's record of the same title", () => {
    const l = continueEntries({ e1: plug('s', 'tt9', 'tt9:1:1', 100, 5) }, [{ p: 's', list: [meta('tt9', { pos: 10, dur: 100, at: 99 })] }])
    expect(keys(l)).toEqual(['e1'])
  })
  it('leaves out finished and unstarted plugin titles', () => {
    const l = continueEntries({}, [{ p: 's', list: [meta('done', { pos: 95, dur: 100, at: 1 }), meta('new'), meta('zero', { pos: 0, dur: 100, at: 1 })] }])
    expect(l).toEqual([])
  })
  it('leaves out a series whose newest episode is finished, even with an older one partway', () => {
    const l = continueEntries({ e1: plug('s', 'tt9', 'tt9:1:1', 500, 5), e2: plug('s', 'tt9', 'tt9:1:2', 1000, 9) }, [])
    expect(l).toEqual([])
  })
  it("leaves out a plugin title Flick saw finished, whatever the plugin's record says", () => {
    const l = continueEntries({ e1: plug('s', 'tt9', 'tt9:1:1', 1000, 5) }, [{ p: 's', list: [meta('tt9', { pos: 10, dur: 100, at: 99 })] }])
    expect(l).toEqual([])
  })
  it('shows a show from a folder or server once, from its newest episode', () => {
    const show = (id: string) => (id === 'ep1' || id === 'ep2' ? 'The Office' : undefined)
    const l = continueEntries({ ep1: item('ep1', 400, 1000, 5), ep2: item('ep2', 200, 1000, 9), m: item('m', 100, 1000, 7) }, [], show)
    expect(keys(l)).toEqual(['ep2', 'm'])
  })
})

