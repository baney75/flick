import { describe, expect, it, vi } from 'vitest'
import type { Progress } from '../src/lib/store'

// A place the player saves while a synced change is being written must not be lost when that change lands.

vi.hoisted(() => Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} }))

const doc = new Map<string, unknown>()
const writes: string[] = []
let onPut: (() => void) | undefined

vi.mock('../src/lib/db', () => ({
  get: async () => undefined,
  getAll: async () => [],
  put: async (_store: string, key: string) => { writes.push(key); const f = onPut; onPut = undefined; f?.() },
  del: async () => {},
}))
vi.mock('../src/lib/sync/engine', () => ({
  startSync: async () => {},
  publish: () => {},
  docValue: (k: string) => doc.get(k) ?? null,
  docKeys: (prefix: string) => [...doc.keys()].filter((k) => k.startsWith(prefix)),
}))
vi.mock('../src/lib/servers', () => ({ getServers: async () => [], saveServer: async () => {}, removeServer: async () => {}, syncServer: async () => {} }))
vi.mock('../src/lib/plugins/registry', () => ({
  installed: { value: [] }, prepare: async () => { throw new Error('none') }, install: async () => {}, remove: async () => {},
  setEnabled: async () => {}, setPluginSettings: async () => {}, isSecret: () => false, portable: (u: string) => u,
}))

const row = (title: string, at: number): Progress => ({ pos: 10, dur: 100, at, title, ref: { t: 'url', url: `https://example.test/${title}` } })

describe('sync: a remote change lands on the progress as it is then', () => {
  it('keeps a place saved here while the remote one was being written', async () => {
    const { progress } = await import('../src/lib/store')
    const { applyRemote } = await import('../src/lib/sync/bind')
    progress.value = {}
    doc.set('p:k:remote-film', row('remote-film', 5))
    // The player saves its place while the synced row is being written.
    onPut = () => { progress.value = { ...progress.value, 'local-film': row('local-film', 6) } }
    await applyRemote(['p:k:remote-film'])
    expect(writes).toEqual(['remote-film'])
    expect(Object.keys(progress.value).sort()).toEqual(['local-film', 'remote-film'])
  })

  it('does not replace a newer place saved here with an older synced one', async () => {
    const { progress } = await import('../src/lib/store')
    const { applyRemote } = await import('../src/lib/sync/bind')
    progress.value = {}
    doc.set('p:k:film', row('film', 5))
    onPut = () => { progress.value = { ...progress.value, film: row('film', 9) } }
    await applyRemote(['p:k:film'])
    expect(progress.value.film.at).toBe(9)
  })
})
