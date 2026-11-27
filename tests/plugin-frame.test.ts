// A plugin that stops answering never holds Flick's later calls: a call past its time limit ends the frame
// (and the Worker in it) when the plugin can't answer a ping either, and so does a frame that loads again,
// so the next call starts a fresh one. A plugin that still answers keeps its frame and its other calls.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { PING_MS, callPlugin, openFrame, sha256, stopPlugin, type Installed } from '../src/lib/plugins/runtime'

/**
 * A stand-in for public/plugin-host.js: answers load, catalog and ping, never answers `hang`. A `stuck`
 * host stands for a plugin in a loop: after load it answers nothing, not even a ping.
 */
function fakeHost(stuck = false) {
  const frames: { removed: boolean; load: () => void }[] = []
  const doc = {
    createElement: () => {
      let onLoad = () => {}
      const fr = {
        removed: false,
        load: () => onLoad(),
        setAttribute() {},
        addEventListener: (_: string, f: () => void) => { onLoad = f },
        remove() { fr.removed = true },
        contentWindow: {
          postMessage(_m: unknown, _t: string, [port]: MessagePort[]) {
            port.onmessage = (e) => {
              const { id, m, a } = e.data
              if (m === 'call' && a[0] === 'hang') return
              if (stuck && m !== 'load') return
              const v = m === 'load' ? { manifest: {}, fns: [] } : m === 'call' ? { items: [], more: false } : null
              port.postMessage({ re: id, ok: true, v })
            }
          },
        },
      }
      frames.push(fr)
      return fr
    },
    body: { appendChild: (f: { load: () => void }) => queueMicrotask(f.load) },
  }
  return { doc: doc as unknown as Document, frames }
}

describe('a plugin frame that stops answering', () => {
  it('a slow call fails alone while the plugin still answers a ping', async () => {
    const { doc, frames } = fakeHost()
    let dead = 0
    const fr = await openFrame(async () => null, doc, () => dead++)
    const other = fr.rpc.call('call', ['hang'], 5000)
    await expect(fr.rpc.call('call', ['hang'], 50)).rejects.toThrow(/longer than/)
    await new Promise((ok) => setTimeout(ok, 100))
    expect([dead, frames[0].removed]).toEqual([0, false])
    // The other call is still waiting, and the plugin still answers new ones.
    const settled = await Promise.race([other.then(() => 'answered', () => 'rejected'), new Promise((ok) => setTimeout(ok, 50, 'waiting'))])
    expect(settled).toBe('waiting')
    await expect(fr.rpc.call('call', ['catalog'])).resolves.toEqual({ items: [], more: false })
    fr.rpc.close()
    await expect(other).rejects.toThrow('The plugin stopped.')
  })

  it('a call past its time limit ends the frame when the plugin does not answer a ping', async () => {
    const { doc, frames } = fakeHost(true)
    let dead = 0
    const fr = await openFrame(async () => null, doc, () => dead++)
    const other = fr.rpc.call('call', ['hang'], 20_000)
    const t0 = Date.now()
    await expect(fr.rpc.call('call', ['hang'], 50)).rejects.toThrow(/longer than/)
    // The frame is gone, so a call still waiting on it fails now, not at its own limit.
    await expect(other).rejects.toThrow('The plugin stopped.')
    expect(Date.now() - t0).toBeLessThan(PING_MS + 1000)
    expect([dead, frames[0].removed]).toEqual([1, true])
  })

  it('a frame that loads again (it navigated away) is ended at once', async () => {
    const { doc, frames } = fakeHost()
    let dead = 0
    const fr = await openFrame(async () => null, doc, () => dead++)
    const waiting = fr.rpc.call('call', ['hang'], 20_000)
    const t0 = Date.now()
    frames[0].load()
    await expect(waiting).rejects.toThrow('The plugin stopped.')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect([dead, frames[0].removed]).toEqual([1, true])
  })

  it('the next call to that plugin starts a new frame', async () => {
    const { doc, frames } = fakeHost()
    const g = globalThis as { document?: Document }
    g.document = doc
    const code = 'export default {}'
    const rec: Installed = {
      id: 'org.example.stuck', kind: 'source', url: null, code, sha256: await sha256(code), enabled: true, official: false,
      settings: {}, installedAt: 0, checkedAt: 0,
      manifest: { api: 1, id: 'org.example.stuck', name: 'Stuck', version: '1', hosts: [], tools: [], platforms: ['web'], settings: [], actions: [], titleActions: [], catalogs: [] } as never,
    }
    try {
      await callPlugin(rec, 'catalog', [{ id: 'top' }])
      expect(frames).toHaveLength(1)
      frames[0].load()
      const t0 = Date.now()
      await callPlugin(rec, 'catalog', [{ id: 'top' }])
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(frames).toHaveLength(2)
      expect([frames[0].removed, frames[1].removed]).toEqual([true, false])
    } finally {
      stopPlugin(rec.id)
      delete g.document
    }
  })
})
