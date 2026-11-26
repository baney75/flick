import { describe, expect, it } from 'vitest'
import { Clock, digest, merge, missingFor, write, wins, type Doc } from '../src/lib/sync/doc'
import { newSecret, openGroup, pairLink, parsePair, seal, unseal } from '../src/lib/sync/crypto'
import { contentIndex, contentKey, localProgressKeys, progressDocKey, pluginSnapshot, mayInstallSynced } from '../src/lib/sync/keys'
import type { Candidate } from '../src/lib/plugins/registry'
import type { Installed } from '../src/lib/plugins/registry'
import type { Item } from '../src/lib/library'

// Sync two docs the way two devices do: swap digests, send what the other lacks.
function sync(a: Doc, ca: Clock, b: Doc, cb: Clock) {
  const toB = missingFor(a, digest(b))
  const toA = missingFor(b, digest(a))
  merge(b, cb, toB)
  merge(a, ca, toA)
}

describe('sync doc', () => {
  it('converges whatever order writes and syncs happen in', () => {
    const [a, b, c] = [new Map(), new Map(), new Map()] as Doc[]
    const [ca, cb, cc] = [new Clock(), new Clock(), new Clock()]
    write(a, ca, 'A', 'p:k:x', { pos: 10 })
    write(b, cb, 'B', 'p:k:x', { pos: 20 })
    write(c, cc, 'C', 's:settings', { speed: 1.5 })
    write(a, ca, 'A', 'a:https://addon/manifest.json', true)
    sync(a, ca, b, cb)
    sync(b, cb, c, cc)
    sync(c, cc, a, ca)
    expect(digest(a).sort()).toEqual(digest(b).sort())
    expect(digest(b).sort()).toEqual(digest(c).sort())
  })

  it('a later write wins and a delete travels as a tombstone', () => {
    const a: Doc = new Map(), b: Doc = new Map()
    const ca = new Clock(), cb = new Clock()
    write(a, ca, 'A', 'v:plex-1', { name: 'Plex' })
    sync(a, ca, b, cb)
    expect(b.get('v:plex-1')?.v).toEqual({ name: 'Plex' })
    write(b, cb, 'B', 'v:plex-1', null)
    sync(a, ca, b, cb)
    expect(a.get('v:plex-1')?.v).toBeNull()
  })

  it('sends nothing when both sides already match', () => {
    const a: Doc = new Map(), b: Doc = new Map()
    const ca = new Clock(), cb = new Clock()
    write(a, ca, 'A', 'k', 1)
    sync(a, ca, b, cb)
    expect(missingFor(a, digest(b))).toEqual([])
    expect(missingFor(b, digest(a))).toEqual([])
  })

  it('breaks time ties the same way on every device and ignores malformed entries', () => {
    expect(wins({ v: 1, t: 5, d: 'B' }, { v: 2, t: 5, d: 'A' })).toBe(true)
    expect(wins({ v: 2, t: 5, d: 'A' }, { v: 1, t: 5, d: 'B' })).toBe(false)
    const a: Doc = new Map()
    const changed = merge(a, new Clock(), [['k', { v: 1, t: Number.NaN, d: 'X' }], ['j', { v: 1, t: 1, d: '' }], ['h', { v: 1, t: 1e300, d: 'X' }], ['g', { v: 1, t: 1.5, d: 'X' }]])
    expect(changed).toEqual([])
  })

  it('a value stamped by a far-future clock does not pin the key', () => {
    const a: Doc = new Map(), b: Doc = new Map()
    const ca = new Clock(), cb = new Clock()
    merge(a, ca, [['p:k:x', { v: 'stale', t: Date.now() + 365 * 864e5, d: 'Z' }]])
    sync(a, ca, b, cb)
    write(b, cb, 'B', 'p:k:x', 'fresh')
    sync(a, ca, b, cb)
    expect(a.get('p:k:x')?.v).toBe('fresh')
    merge(a, ca, [['p:k:y', { v: 'stale', t: Number.MAX_SAFE_INTEGER - 2, d: 'Z' }]])
    write(a, ca, 'A', 'p:k:y', 'fresh')
    expect(a.get('p:k:y')?.v).toBe('fresh')
  })

  it('a device clock far in the future cannot pin every later write', () => {
    const c = new Clock()
    c.see(Date.now() + 365 * 864e5)
    expect(c.now()).toBeLessThan(Date.now() + 120_000)
  })
})

describe('sync crypto', () => {
  it('derives the same room on every device and seals messages only the group can open', async () => {
    const s = newSecret()
    const g1 = await openGroup(s), g2 = await openGroup(s)
    expect(g1.room).toMatch(/^[0-9a-f]{32}$/)
    expect(g1.room).toBe(g2.room)
    const sealed = await seal(g1.key, { hello: 'world' })
    expect(sealed).not.toContain('world')
    expect(await unseal(g2.key, sealed)).toEqual({ hello: 'world' })
    const other = await openGroup(newSecret())
    await expect(unseal(other.key, sealed)).rejects.toThrow()
  })

  it('rejects a tampered message', async () => {
    const g = await openGroup(newSecret())
    const sealed = await seal(g.key, { n: 1 })
    const flip = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21)
    await expect(unseal(g.key, flip)).rejects.toThrow()
  })

  it('reads pairing codes from links, app links and bare text', () => {
    const s = newSecret()
    expect(parsePair(pairLink(s))).toBe(s)
    expect(parsePair(`flick://pair?k=${s}`)).toBe(s)
    expect(parsePair(`  ${s}\n`)).toBe(s)
    expect(parsePair('https://flick-player.pages.dev/#/pair?k=short')).toBeNull()
    expect(parsePair(s + 'x')).toBeNull()
  })
})

describe('sync keys', () => {
  const base = { kind: 'video', src: { t: 'path', path: '/x' }, size: 1, mtime: 1, addedAt: 1 } as const
  const mac: Item = { ...base, id: 'm1', origin: 'local', title: 'Pilot', show: 'The Chosen', season: 1, episode: 1 }
  const phone: Item = { ...base, id: 'p9', origin: 'stored', title: 'Pilot', show: 'the chosen', season: 1, episode: 1 }
  const plex: Item = { ...base, id: 'px', origin: 'plex', title: 'Ben-Hur', year: 1959 }

  it('matches the same episode across devices by name, not path', () => {
    expect(contentKey(mac)).toBe(contentKey(phone))
    expect(contentKey(plex)).toBe('id:px')
  })

  it('keeps non-Latin titles, specials and repeated song titles apart', () => {
    const jp = contentKey({ ...mac, title: '第1話', show: '進撃の巨人' })
    const ru = contentKey({ ...mac, title: 'Брат', show: undefined, season: undefined, episode: undefined, year: 1997 })
    expect(jp).toBe('ep:進撃の巨人:1:1')
    expect(ru).toBe('mv:брат:1997')
    const sp = (title: string) => contentKey({ ...mac, title, episode: undefined })
    expect(sp('Behind the Scenes')).not.toBe(sp('Part Two'))
    const song = (size: number) => contentKey({ ...mac, kind: 'audio', title: 'Intro', show: undefined, size })
    expect(song(4_100_000)).not.toBe(song(5_200_000))
  })

  it('maps progress to synced keys and back to local items', () => {
    const byId = new Map([[mac.id, mac]])
    const k = progressDocKey('m1', { ref: { t: 'item', id: 'm1' } }, byId)!
    expect(k).toBe('p:i:ep:the chosen:1:1')
    expect(localProgressKeys(k, contentIndex([phone]))).toEqual(['p9'])
    expect(progressDocKey('st:tt1', { ref: { t: 'stremio', type: 'movie', id: 'tt1', videoId: 'tt1' } }, byId)).toBe('p:k:st:tt1')
    expect(localProgressKeys('p:k:st:tt1', new Map())).toEqual(['st:tt1'])
    expect(progressDocKey('gone', { ref: { t: 'item', id: 'gone' } }, byId)).toBeNull()
    expect(progressDocKey('pl:org.x.y:tt1:1:2', { ref: { t: 'plugin', p: 'org.x.y', type: 'series', id: 'tt1', videoId: 'tt1:1:2' } }, byId)).toBe('p:k:pl:org.x.y:tt1:1:2')
  })

  it('syncs installed plugin URLs and settings, never secret ones or file installs', () => {
    const settings = [{ key: 'lang', label: 'L', type: 'text' }, { key: 'token', label: 'T', type: 'text', secret: true }]
    const rec = (id: string, url: string | null) => ({ id, kind: 'source', url, enabled: true, manifest: { settings }, settings: { lang: 'en', token: 'abc123' } }) as unknown as Installed
    const snap = pluginSnapshot([rec('org.a.one', 'https://a.example/plugin.js'), rec('org.b.two', null)])
    expect([...snap.keys()]).toEqual(['x:https://a.example/plugin.js'])
    expect(JSON.parse(snap.get('x:https://a.example/plugin.js')!)).toMatchObject({ on: true, settings: { lang: 'en' } })
    expect([...snap.values()].join()).not.toContain('abc123')
  })

  it('syncs a bundled plugin by its /plugins/ path, so the app and the website share one key', () => {
    const rec = (id: string, url: string) => ({ id, kind: 'source', url, enabled: true, manifest: { settings: [] }, settings: {} }) as unknown as Installed
    const snap = pluginSnapshot([rec('org.flick.template', '/plugins/template.js'), rec('org.local.dev', 'http://127.0.0.1:5173/p.js')])
    // A localhost plugin only works on the device that has it, so it does not sync.
    expect([...snap.keys()]).toEqual(['x:/plugins/template.js'])
  })

  it('another device installs a synced plugin only as reviewed, or asking for nothing more', () => {
    const rec = { id: 'org.g.p', kind: 'source', url: 'https://gist.example/p.js', enabled: true, sha256: 'aaa', manifest: { settings: [], hosts: ['api.example.com'], tools: [] }, settings: {} } as unknown as Installed
    const v = JSON.parse(pluginSnapshot([rec]).get('x:https://gist.example/p.js')!)
    expect(v).toMatchObject({ sha256: 'aaa', hosts: ['api.example.com'], tools: [] })
    const cand = (sha256: string, hosts: string[], tools: string[] = []) => ({ kind: 'source', sha256, manifest: { hosts, tools } }) as unknown as Candidate
    expect(mayInstallSynced(v, cand('aaa', ['api.example.com']))).toBe(true)
    expect(mayInstallSynced(v, cand('bbb', ['api.example.com']))).toBe(true)
    expect(mayInstallSynced(v, cand('bbb', ['*']))).toBe(false)
    expect(mayInstallSynced(v, cand('bbb', ['api.example.com'], ['ytdlp']))).toBe(false)
  })
})
