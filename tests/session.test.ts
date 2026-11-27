import { describe, it, expect, vi, afterEach } from 'vitest'

const g = globalThis as any

function fakeStorage(start: Record<string, string>) {
  const m = new Map(Object.entries(start))
  const calls = { get: 0, set: 0 }
  return {
    calls,
    m,
    api: {
      get length() { return m.size },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => { calls.get++; return m.get(k) ?? null },
      setItem: (k: string, v: string) => { calls.set++; m.set(k, v) },
    },
  }
}

async function load() {
  vi.resetModules()
  return import('../src/lib/session')
}

afterEach(() => { delete g.sessionStorage })

describe('session', () => {
  it('reads what the session saved before the module loaded', async () => {
    g.sessionStorage = fakeStorage({ 'flick.tab': 'movies' }).api
    const s = await load()
    expect(s.sessionGet('flick.tab')).toBe('movies')
    expect(s.sessionGet('missing')).toBeNull()
  })

  it('reads storage only at load: later reads never touch it', async () => {
    const f = fakeStorage({ 'flick.tab': 'movies' })
    g.sessionStorage = f.api
    const s = await load()
    const at = f.calls.get
    s.sessionGet('flick.tab'); s.sessionGet('x'); s.sessionGet('flick.tab')
    expect(f.calls.get).toBe(at)
  })

  it('a save is read back and written through for a reload', async () => {
    const f = fakeStorage({})
    g.sessionStorage = f.api
    const s = await load()
    s.sessionSet('flick.tab', 'downloads')
    expect(s.sessionGet('flick.tab')).toBe('downloads')
    expect(f.m.get('flick.tab')).toBe('downloads')
  })

  it('with storage that throws, picks still last the session', async () => {
    g.sessionStorage = { get length(): number { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    const s = await load()
    expect(s.sessionGet('flick.tab')).toBeNull()
    expect(() => s.sessionSet('flick.tab', 'shows')).not.toThrow()
    expect(s.sessionGet('flick.tab')).toBe('shows')
  })

  it('with no storage at all, it loads', async () => {
    const s = await load()
    expect(s.sessionGet('flick.tab')).toBeNull()
  })
})
