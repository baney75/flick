import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { flickConnect, flickMap, FLICK_UNREACHABLE, type Server, type FlickLibrary } from '../src/lib/servers'
import { hash } from '../src/lib/library'

const g = globalThis as Record<string, unknown>
g.location ??= { hash: '' }
g.addEventListener ??= () => {}

const CODE = 'Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC'
const nas: Server = { id: hash('https://nas.example'), type: 'flick', name: 'Living room NAS', url: 'https://nas.example', token: 'a+b/c=' }
const lib: FlickLibrary = {
  name: 'Living room NAS',
  folders: ['Movies', 'TV', 'Books'],
  items: [
    { id: '9f86d081884c7d65', folder: 'Movies', path: 'Heat (1995)/Heat (1995).mkv', name: 'Heat (1995).mkv', kind: 'video', ext: 'mkv', size: 7340032000, mtime: 1732550400000 },
    { id: '1111222233334444', folder: 'TV', path: 'The Office/The.Office.S02E03.Office.Olympics.mkv', name: 'The.Office.S02E03.Office.Olympics.mkv', kind: 'video', ext: 'mkv', size: 5, mtime: 2 },
    { id: 'aaaabbbbccccdddd', folder: 'Music', path: 'song.flac', name: 'Song.flac', kind: 'audio', ext: 'flac', size: 6, mtime: 3 },
    { id: 'eeeeffff00001111', folder: 'Books', path: 'Jane Doe - Test Book (2020).pdf', name: 'Jane Doe - Test Book (2020).pdf', kind: 'book', ext: 'pdf', size: 7, mtime: 4 },
  ],
}

describe('flickMap', () => {
  const out = flickMap(nas, lib)
  it('maps ids, kinds, folders and sizes', () => {
    expect(out.map((i) => i.id)).toEqual(lib.items.map((x) => hash(`${nas.id}:${x.id}`)))
    expect(out.map((i) => i.kind)).toEqual(['video', 'video', 'audio', 'book'])
    expect(out.every((i) => i.origin === 'flick' && i.server === nas.id)).toBe(true)
    expect(out[0]).toMatchObject({ folder: 'Living room NAS: Movies', size: 7340032000, mtime: 1732550400000, addedAt: 1732550400000 })
  })
  it('builds media URLs with the code encoded', () => {
    expect(out[0].src).toEqual({ t: 'url', url: 'https://nas.example/media/9f86d081884c7d65?t=a%2Bb%2Fc%3D' })
  })
  it('titles files the way local files are titled', () => {
    expect(out[0]).toMatchObject({ title: 'Heat', year: 1995 })
    expect(out[1]).toMatchObject({ show: 'The Office', season: 2, episode: 3 })
    expect(out[3]).toMatchObject({ title: 'Test Book', author: 'Jane Doe' })
  })
})

describe('flickConnect', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      calls.push([u, init])
      const path = new URL(u).pathname
      if (!routes[path]) throw new TypeError('Failed to fetch')
      return routes[path](init)
    })
    return calls
  }
  const info = () => Response.json({ app: 'flick-server', v: 1, name: 'Living room NAS', version: '0.1.0' })

  it('connects with a good code and normalizes the address', async () => {
    const calls = stub({ '/api/info': info, '/api/library': (i) => (new Headers(i?.headers).get('authorization') === `Bearer ${CODE}` ? Response.json(lib) : new Response('{}', { status: 401 })) })
    const s = await flickConnect('  nas.example/ ', CODE)
    expect(s).toEqual({ id: hash('https://nas.example'), type: 'flick', name: 'Living room NAS', url: 'https://nas.example', token: CODE })
    expect(calls.map((c) => c[0])).toEqual(['https://nas.example/api/info', 'https://nas.example/api/library'])
  })
  it('keeps an http address on a LAN', async () => {
    stub({ '/api/info': info, '/api/library': () => Response.json(lib) })
    expect((await flickConnect('http://192.168.1.5:8765', CODE)).url).toBe('http://192.168.1.5:8765')
  })
  it('says when the address is unreachable', async () => {
    stub({})
    await expect(flickConnect('https://nas.example', CODE)).rejects.toThrow(FLICK_UNREACHABLE)
  })
  it('says when the address is not a Flick server', async () => {
    stub({ '/api/info': () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) })
    await expect(flickConnect('https://nas.example', CODE)).rejects.toThrow('not a Flick server')
    stub({ '/api/info': () => Response.json({ app: 'other' }) })
    await expect(flickConnect('https://nas.example', CODE)).rejects.toThrow('not a Flick server')
  })
  it('says when the code is wrong', async () => {
    stub({ '/api/info': info, '/api/library': () => Response.json({ error: 'bad code' }, { status: 401 }) })
    await expect(flickConnect('https://nas.example', 'wrong-code-wrong-code')).rejects.toThrow('access code is wrong')
  })
})

describe('flick setup links', () => {
  const load = () => import('../src/lib/setup')
  const srv = { type: 'flick', name: 'Living room NAS', url: 'https://nas.tail1234.ts.net', token: CODE }
  it('accepts a flick server and round-trips it', async () => {
    const S = await load()
    const p = { v: 1 as const, servers: [srv as never] }
    expect(S.decodeSetup(S.encodeSetup(p))).toEqual(p)
  })
  it('rejects a bad address or a bad code', async () => {
    const S = await load()
    expect(() => S.validateSetup({ v: 1, servers: [{ ...srv, url: 'ftp://nas' }] })).toThrow('http or https')
    expect(() => S.validateSetup({ v: 1, servers: [{ ...srv, token: 'short' }] })).toThrow('access code')
    expect(() => S.validateSetup({ v: 1, servers: [{ ...srv, token: 'has spaces and + signs/ in it!!' }] })).toThrow('access code')
    expect(() => S.validateSetup({ v: 1, servers: [{ ...srv, token: 'x'.repeat(129) }] })).toThrow('access code')
  })
})
