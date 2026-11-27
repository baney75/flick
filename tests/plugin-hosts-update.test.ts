// An update with no new permissions installs quietly; when it drops hosts or tools the desktop app must
// stop allowing them at once (audit P15 F5).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import type { Deps } from '../src/lib/plugins/registry'
const calls = vi.hoisted(() => [] as { cmd: string; args: Record<string, unknown> }[])
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  isDesktop: true,
  invoke: async (cmd: string, args: Record<string, unknown>) => { calls.push({ cmd, args }) },
}))
const R = await import('../src/lib/plugins/registry')

const FNS = ['catalog', 'meta', 'streams']
const permsOf: Record<string, { hosts: string[]; tools: string[] }> = {
  v1: { hosts: ['example.org', 'old.example.org'], tools: ['ytdlp'] },
  v2: { hosts: ['example.org'], tools: [] },
}
const deps: Deps = {
  fetchText: async (u) => files[u],
  inspect: async (code) => ({
    manifest: { api: 1, id: 'org.example.drops', name: 'Drops', version: code, ...permsOf[code], catalogs: [{ id: 'top', name: 'Top', type: 'movie' }] },
    fns: FNS,
  }),
}
const files: Record<string, string> = { 'https://p.example/plugin.js': 'v1' }
const last = (cmd: string) => calls.filter((c) => c.cmd === cmd).at(-1)?.args

describe('a quiet plugin update', () => {
  it('tells the desktop app the hosts and tools it dropped', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ plugins: [] }) }))
    const rec = await R.install(await R.prepare({ url: 'https://p.example/plugin.js' }, deps))
    expect(last('plugin_hosts')).toEqual({ id: rec.id, hosts: ['example.org', 'old.example.org'] })
    expect(last('plugin_tools')).toEqual({ id: rec.id, tools: ['ytdlp'] })

    files['https://p.example/plugin.js'] = 'v2'
    const notes = await R.checkUpdates(rec.checkedAt + 25 * 3600_000, deps)
    expect(notes).toEqual([])
    expect(R.installed.value.find((p) => p.id === rec.id)?.manifest.version).toBe('v2')
    expect(last('plugin_hosts')).toEqual({ id: rec.id, hosts: ['example.org'] })
    expect(last('plugin_tools')).toEqual({ id: rec.id, tools: [] })
    await R.remove(rec.id)
    vi.unstubAllGlobals()
  })
})
