import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'

const shell = vi.hoisted(() => ({ calls: [] as [string, any][] }))
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
vi.stubGlobal('location', { hash: '' })
vi.stubGlobal('addEventListener', () => {})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  isDesktop: true,
  invoke: async (cmd: string, args?: any) => {
    shell.calls.push([cmd, args])
    if (cmd === 'share_start') return { on: true, local_url: 'http://127.0.0.1:8740', lan_urls: [], tailscale_url: null, tailscale_error: null, setup_links: [], code: 'c' }
    return null
  },
}))

const { primaryLink, foldersChanged, applyShare, startShare, sharePrefs } = await import('../src/lib/share')
const { addFolder, removeFolder } = await import('../src/lib/library')
const { items } = await import('../src/lib/store')

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
}
const starts = () => shell.calls.filter(([c]) => c === 'share_start').map(([, a]) => a.folders)

describe('share', () => {
  it('shows the Tailscale link first, then Wi-Fi, then this computer', () => {
    const local = { label: 'This computer', url: 'l' }
    const lan = { label: 'Wi-Fi (192.168.1.5:8740)', url: 'w' }
    const ts = { label: 'Tailscale', url: 't' }
    expect(primaryLink([local, lan, ts])).toBe(ts)
    expect(primaryLink([local, lan])).toBe(lan)
    expect(primaryLink([local])).toBe(local)
    expect(primaryLink([])).toBeNull()
  })

  it('sees folder changes, ignoring order', () => {
    expect(foldersChanged(null, ['/a'])).toBe(false)
    expect(foldersChanged(['/a', '/b'], ['/b', '/a'])).toBe(false)
    expect(foldersChanged(['/a'], ['/a', '/b'])).toBe(true)
    expect(foldersChanged(['/a', '/b'], ['/a'])).toBe(true)
  })

  it('restarts the share when a folder is added or removed', async () => {
    const a = { id: 'a', name: 'Movies', path: '/m/Movies' }
    const b = { id: 'b', name: 'TV', path: '/m/TV' }
    await addFolder(a)
    startShare()
    await applyShare({ on: true, lan: true })
    expect(sharePrefs.value).toMatchObject({ on: true, lan: true, tailscale: false })
    expect(starts()).toEqual([['/m/Movies']])

    await addFolder(b)
    items.value = [...items.value]
    await until(() => starts().length === 2)
    expect(starts()[1]).toEqual(['/m/Movies', '/m/TV'])

    await removeFolder(a)
    items.value = [...items.value]
    await until(() => starts().length === 3)
    expect(starts()[2]).toEqual(['/m/TV'])

    // Nothing changed: no restart.
    items.value = [...items.value]
    await new Promise((r) => setTimeout(r, 50))
    expect(starts().length).toBe(3)

    await applyShare({ on: false })
    expect(shell.calls.at(-1)?.[0]).toBe('share_stop')
  })
})
