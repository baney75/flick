import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll } from 'vitest'

// A fake relay socket: records what this device sends and lets the test deliver messages.
const net = vi.hoisted(() => ({ socks: [] as any[] }))
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
const { newSecret, openGroup, seal } = await import('../src/lib/sync/crypto')
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('sync engine', () => {
  beforeAll(async () => { await startSync(() => {}) })

  it('joining another group leaves the old group behind: no devices, no entries', async () => {
    const a = newSecret()
    await join(a)
    await settle()
    const g = await openGroup(a)
    const sock = net.socks.at(-1)
    sock.onmessage({ data: await seal(g.key, { type: 'hello', from: 'peer-1', name: 'Phone' }) })
    await settle()
    publish([['s:speed', 1.5]])
    expect(sync.value.peers.map((p) => p.id)).toEqual(['peer-1'])
    expect(docKeys('s:')).toEqual(['s:speed'])

    await join(newSecret())
    await settle()
    expect(sync.value.peers).toEqual([])
    expect(docKeys('')).toEqual([])
    expect(sock.readyState).toBe(3)
    // A message for the old group that arrives late reaches nothing.
    sock.onmessage?.({ data: await seal(g.key, { type: 'hello', from: 'peer-2', name: 'Late' }) })
    await settle()
    expect(sync.value.peers).toEqual([])
  })
})
