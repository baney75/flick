// SPEC-playback cases 9, 10 and 11: the stall watchdog and the loading words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Delayed, KEEP, kindOf, STALL_LIMIT_MS, waitLine, Watchdog, WAITING } from '../src/lib/stalls'

const timers = { now: () => Date.now(), set: (f: () => void, ms: number) => setTimeout(f, ms), clear: (t: unknown) => clearTimeout(t as number) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A watchdog on a source that has played its first frame, unless `opening`. */
function dog(opening = false) {
  const seen: string[] = []
  const w = new Watchdog('debrid', { reload: () => seen.push('reload'), giveUp: () => seen.push('give up') }, timers)
  w.attached()
  if (!opening) w.playing()
  return { w, seen }
}

describe('Watchdog', () => {
  it('case 9: 20 s with no bytes and an empty buffer reloads once and counts the stall', () => {
    const { w, seen } = dog()
    w.waiting(30, 30)
    vi.advanceTimersByTime(20_000)
    expect(seen).toEqual(['reload'])
    expect(w.stalls).toHaveLength(1)
    expect(w.stalls[0]).toMatchObject({ kind: 'debrid', from: 30, to: 30, ms: STALL_LIMIT_MS })
    expect(w.summary()).toBe('Stalls: 1, longest 15.0 s')
  })
  it('case 10: a second stuck stall gives up instead of reloading again', () => {
    const { w, seen } = dog()
    w.waiting(30, 30)
    vi.advanceTimersByTime(20_000)
    w.waiting(30, 30)
    vi.advanceTimersByTime(20_000)
    expect(seen).toEqual(['reload', 'give up'])
  })
  it('a stall still fed with data is not stuck', () => {
    const { w, seen } = dog()
    w.waiting(30, 31)
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(10_000); w.data(32 + i) }
    expect(seen).toEqual([])
    w.resumed()
    expect(w.stalls[0].ms).toBe(50_000)
    expect(w.stalls[0].to).toBe(36)
  })
  it('a short stall that resumes is counted, not acted on', () => {
    const { w, seen } = dog()
    w.waiting(10, 10)
    vi.advanceTimersByTime(4200)
    w.resumed()
    w.waiting(20, 20)
    vi.advanceTimersByTime(1000)
    w.resumed()
    vi.advanceTimersByTime(60_000)
    expect(seen).toEqual([])
    expect(w.summary()).toBe('Stalls: 2, longest 4.2 s')
  })
  it('a wait before the first frame or for a seek is watched but not counted', () => {
    const { w, seen } = dog(true)
    w.waiting(0, 0)
    vi.advanceTimersByTime(2000)
    w.playing()
    expect(w.summary()).toBeNull()
    w.waiting(0, 0, true)
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(seen).toEqual(['reload'])
    w.attached()
    w.waiting(40, 40)
    vi.advanceTimersByTime(800)
    w.playing()
    w.waiting(40, 40)
    vi.advanceTimersByTime(500)
    w.resumed()
    expect(w.summary()).toBe('Stalls: 1, longest 0.5 s')
  })
  it('a reload attaches again, and that opening wait is not a second stall (review F2)', () => {
    const { w, seen } = dog()
    w.waiting(30, 30)
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(seen).toEqual(['reload'])
    w.attached()
    w.waiting(30, 30)
    vi.advanceTimersByTime(1500)
    w.playing()
    expect(w.summary()).toBe('Stalls: 1, longest 15.0 s')
  })
  it('a pause during a wait ends it: no reload and no give-up later (review F1)', () => {
    const { w, seen } = dog()
    w.waiting(30, 30)
    vi.advanceTimersByTime(3000)
    w.paused()
    vi.advanceTimersByTime(5 * STALL_LIMIT_MS)
    expect(seen).toEqual([])
  })
  it('after a failure nothing reloads until the next attach (review F6)', () => {
    const { w, seen } = dog(true)
    w.waiting(0, 0)
    w.failed()
    w.waiting(0, 0)
    vi.advanceTimersByTime(5 * STALL_LIMIT_MS)
    expect(seen).toEqual([])
    w.attached()
    w.waiting(0, 0)
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(seen).toEqual(['reload'])
  })
  it('a stuck seek wait does not spend the reload a stall during play gets (review F7)', () => {
    const { w, seen } = dog()
    w.waiting(0, 0, true)
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    w.attached(); w.playing()
    w.waiting(50, 50)
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(seen).toEqual(['reload', 'reload'])
  })
  it('keeps the last 50 stalls', () => {
    const { w } = dog()
    for (let i = 0; i < KEEP + 7; i++) { w.waiting(i, i); w.resumed() }
    expect(w.stalls).toHaveLength(KEEP)
    expect(w.stalls[0].from).toBe(7)
  })
  it('no stalls, no line', () => {
    expect(dog().w.summary()).toBeNull()
  })
})

describe('kindOf and waitLine', () => {
  it('names each source', () => {
    expect(kindOf({ src: { t: 'path' } }, '/x.mp4', false)).toBe('file')
    expect(kindOf({ src: { t: 'kodi' } }, 'http://kodi/x', false)).toBe('server')
    expect(kindOf({}, 'https://addon/x.mp4', false)).toBe('plugin')
    expect(kindOf({}, 'https://cdn/x/master.m3u8', false)).toBe('hls')
    expect(kindOf({}, 'https://x/a.mkv', true)).toBe('remux')
    expect(kindOf({ via: { service: 'TorBox' } }, 'https://tb/x.mp4', false)).toBe('debrid')
    expect(kindOf({ peers: true }, 'http://127.0.0.1/t', false)).toBe('torrent')
  })
  it('an http stall waits on the server', () => {
    expect(waitLine('debrid')).toBe(WAITING)
    expect(waitLine('file')).toBe('Buffering…')
  })
})

describe('Delayed (case 11)', () => {
  it('shows no text under 1 s', () => {
    const shown: (string | null)[] = []
    const d = new Delayed((t) => shown.push(t), timers)
    d.set('Opening the file…')
    vi.advanceTimersByTime(900)
    d.set(null)
    vi.advanceTimersByTime(5000)
    expect(shown).toEqual([null])
  })
  it('shows the latest text once the wait passes 1 s, and a change after that at once', () => {
    const shown: (string | null)[] = []
    const d = new Delayed((t) => shown.push(t), timers)
    d.set('Opening the file…')
    vi.advanceTimersByTime(500)
    d.set('Converting audio for this Mac…')
    vi.advanceTimersByTime(500)
    expect(shown).toEqual(['Converting audio for this Mac…'])
    d.set(WAITING)
    expect(shown).toEqual(['Converting audio for this Mac…', WAITING])
  })
})
