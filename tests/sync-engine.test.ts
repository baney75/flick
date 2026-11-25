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

const { startSync, join, publish, docKeys, sync } = await import('../src/lib/sync/engine')
const db = await import('../src/lib/db')
const { newSecret, openGroup, seal } = await import('../src/lib/sync/crypto')
const settle = () => new Promise((r) => setTimeout(r, 30))

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
})
