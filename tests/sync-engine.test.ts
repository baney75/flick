import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll } from 'vitest'

// A fake relay socket: records what this device sends and lets the test deliver messages.
const net = vi.hoisted(() => ({ socks: [] as any[], hold: null as Promise<void> | null }))
// Key derivation waits on net.hold when it is set, so a test can keep a connect attempt in flight.
vi.mock('../src/lib/sync/crypto', async (orig) => {
  const real = await orig<typeof import('../src/lib/sync/crypto')>()
  return { ...real, openGroup: async (s: string) => { if (net.hold) await net.hold; return real.openGroup(s) } }
})
class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { net.socks.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.() }) }
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3 }
}
vi.stubGlobal('WebSocket', FakeSocket)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
vi.stubGlobal('navigator', { userAgent: 'Mac' })
vi.stubGlobal('document', { addEventListener: () => {}, hidden: false })
vi.stubGlobal('addEventListener', () => {})

const { startSync, join, createGroup, publish, docKeys, docValue, sync } = await import('../src/lib/sync/engine')
const db = await import('../src/lib/db')
const { digest } = await import('../src/lib/sync/doc')
const { newSecret, openGroup, seal, unseal } = await import('../src/lib/sync/crypto')
const settle = () => new Promise((r) => setTimeout(r, 30))
// Sealing thousands of entries takes a while under load: wait until nothing new has been sent for 150 ms.
const quiet = async (sock: { sent: string[] }) => { for (let n = -1; n !== sock.sent.length;) { n = sock.sent.length; await new Promise((r) => setTimeout(r, 150)) } }

describe('sync engine', () => {
  // This device has one setting of its own to offer every group it joins.
  beforeAll(async () => { await startSync(() => {}, () => [['s:theme', 'dark']]) })

  it('joining another group leaves the old group behind and offers this device\'s own data to the new one', async () => {
    const a = newSecret()
    await join(a)
    await settle()
    const g = await openGroup(a)
    const sock = net.socks.at(-1)
    sock.onmessage({ data: await seal(g.key, { type: 'hello', from: 'peer-1', name: 'Phone' }) })
    await settle()
    publish([['s:speed', 1.5]])
    expect(sync.value.peers.map((p) => p.id)).toEqual(['peer-1'])
    expect(docKeys('s:').sort()).toEqual(['s:speed', 's:theme'])

    await join(newSecret())
    await settle()
    expect(sync.value.peers).toEqual([])
    // The old group's entries are gone, and the device offers its own again to the new group.
    expect(docKeys('')).toEqual(['s:theme'])
    expect(net.socks.at(-1).sent.length).toBeGreaterThan(0)
    expect(sock.readyState).toBe(3)
    // A message for the old group that arrives late reaches nothing.
    sock.onmessage?.({ data: await seal(g.key, { type: 'hello', from: 'peer-2', name: 'Late' }) })
    await settle()
    expect(sync.value.peers).toEqual([])
  })

  it('a join made while an older connect is still deriving its key still connects', async () => {
    let release = () => {}
    net.hold = new Promise((r) => { release = r })
    const b = newSecret(), c = newSecret()
    const pb = join(b)
    await settle()
    const pc = join(c)
    await settle()
    net.hold = null
    release()
    await Promise.all([pb, pc])
    await settle()
    expect(net.socks.at(-1).url).toContain((await openGroup(c)).room)
    expect(sync.value.status).toBe('online')
  })

  it('a peer update in a tab that missed a leave does not put the old group back', async () => {
    const a = newSecret()
    await join(a)
    await settle()
    const g = await openGroup(a)
    const sock = net.socks.at(-1)
    // A beat arrives and this tab saves the peer while another tab of the browser leaves sync.
    await sock.onmessage({ data: await seal(g.key, { type: 'beat', from: 'peer-3' }) })
    void db.put('kv', 'sync', { secret: null, device: sync.value.device })
    await settle()
    expect((await db.get<{ secret: string | null }>('kv', 'sync'))?.secret).toBeNull()
  })

  it('on first pairing the group creator\'s data beats a joiner\'s seeded defaults', async () => {
    await createGroup()
    await settle()
    const g = await openGroup(sync.value.secret!)
    const sock = net.socks.at(-1)
    // The joiner seeds its own default at time 1, from a device id that would win any tie.
    await sock.onmessage({ data: await seal(g.key, { type: 'entries', from: 'ffffffffffffffff', list: [['s:theme', { v: 'light', t: 1, d: 'ffffffffffffffff' }]] }) })
    await settle()
    expect(docValue('s:theme')).toBe('dark')
  })
  // The relay closes a socket on any message over 256 KiB, and a device that can never send its digest
  // never syncs again. A big watch history must go out in parts that each fit, and still settle.
  it('a doc too big for one message syncs in parts that each fit the relay cap', async () => {
    const CAP = 256 * 1024
    const a = newSecret()
    await join(a)
    await settle()
    const g = await openGroup(a)
    const sock = net.socks.at(-1)
    const many: [string, unknown][] = Array.from({ length: 4000 }, (_, i) => [`p:k:plugin:tt${1000000 + i}:1:${i}`, { pos: i, dur: 2400, at: 1764000000000 + i, title: `Show number ${i} 進撃`, ref: { t: 'url', url: `https://example.test/video/${i}` } }])
    publish(many)
    await quiet(sock)
    // A peer says hello; this device answers with its digest, then sends what the peer lacks.
    sock.sent.length = 0
    await sock.onmessage({ data: await seal(g.key, { type: 'hello', from: 'peer-big', name: 'Phone' }) })
    await sock.onmessage({ data: await seal(g.key, { type: 'digest', from: 'peer-big', rows: [] }) })
    await quiet(sock)
    const sizes = sock.sent.map((s: string) => new TextEncoder().encode(s).length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CAP)
    const msgs = await Promise.all(sock.sent.map((s: string) => unseal<any>(g.key, s)))
    const welcome = msgs.filter((m) => m.type === 'welcome').flatMap((m) => m.rows)
    expect(welcome.length).toBe(docKeys('').length)
    // The peer has nothing, so every entry goes to it, in parts.
    expect(msgs.filter((m) => m.type === 'entries').flatMap((m) => m.list).length).toBe(docKeys('').length)

    // Its own publish of the whole history fits too.
    sock.sent.length = 0
    publish(many.map(([k, v]) => [k, { ...(v as object), pos: 1 }]))
    await quiet(sock)
    expect(Math.max(...sock.sent.map((s: string) => new TextEncoder().encode(s).length))).toBeLessThanOrEqual(CAP)

    // A digest that arrives in parts is answered once, after the last part, with only what the peer lacks:
    // here one key the peer's digest leaves out.
    const keys = docKeys('')
    const lacks = keys[1234]
    const newer = (ks: string[]) => digest(new Map(ks.map((k) => [k, { v: null, t: Number.MAX_SAFE_INTEGER - 1, d: 'z' }])))
    const rows = newer(keys.filter((k) => k !== lacks))
    const half = Math.ceil(rows.length / 2)
    const sentNow = () => Promise.all(sock.sent.map((s: string) => unseal<any>(g.key, s)))
    sock.sent.length = 0
    await sock.onmessage({ data: await seal(g.key, { type: 'digest', from: 'peer-big', rows: rows.slice(0, half), set: 'r1', part: 0, parts: 2 }) })
    await quiet(sock)
    expect(sock.sent).toEqual([])
    await sock.onmessage({ data: await seal(g.key, { type: 'digest', from: 'peer-big', rows: rows.slice(half), set: 'r1', part: 1, parts: 2 }) })
    await quiet(sock)
    expect((await sentNow()).flatMap((m) => m.list.map(([k]: [string]) => k))).toEqual([lacks])

    // A welcome in parts, out of order and with a part repeated, gets one digest set back and one round
    // of entries, only once the last part is in.
    sock.sent.length = 0
    const w = (part: number, r: typeof rows) => seal(g.key, { type: 'welcome', from: 'peer-w', name: 'TV', rows: r, set: 'w1', part, parts: 2 })
    await sock.onmessage({ data: await w(1, rows.slice(half)) })
    await sock.onmessage({ data: await w(1, rows.slice(half)) })
    await quiet(sock)
    expect(sock.sent).toEqual([])
    await sock.onmessage({ data: await w(0, rows.slice(0, half)) })
    await quiet(sock)
    const back = await sentNow()
    const digests = back.filter((m) => m.type === 'digest')
    expect(new Set(digests.map((m) => m.set)).size).toBe(1)
    expect(digests.flatMap((m) => m.rows).length).toBe(keys.length)
    expect(back.filter((m) => m.type === 'entries').flatMap((m) => m.list.map(([k]: [string]) => k))).toEqual([lacks])
  })
})
