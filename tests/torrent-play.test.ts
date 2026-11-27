import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

// The store reads the route at import; the shell is a desktop one whose engine the tests answer.
const shell = vi.hoisted(() => {
  Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} })
  return { calls: [] as [string, unknown][], stats: { downBps: 1_000_000, peers: 3 } as { downBps: number; peers: number } | null, gate: { ok: true } as unknown }
})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  isDesktop: true,
  isMobileApp: false,
  invoke: async (cmd: string, args?: unknown) => {
    shell.calls.push([cmd, args])
    if (cmd === 'torrent_stats') return shell.stats
    if (cmd === 'torrent_play') return 'http://127.0.0.1:5/t/x/0'
    return shell.gate
  },
  onDesktopEvent: async () => () => {},
}))
const { playingTorrent, dropTorrent, playTorrent } = await import('../src/lib/torrent')
const { engineNow, engineLine } = await import('../src/lib/readout')
const { nowPlaying } = await import('../src/lib/store')
const { checkAgain, gate } = await import('../src/lib/picking')

const H = 'DD8255ECDC7CA55FB0BBF81323D87062DB1F6D1C'
const h = H.toLowerCase()
const req = (key: string) => ({ key, title: 'T', kind: 'video' as const, url: 'http://127.0.0.1:5/t/x/0', ref: { t: 'url' as const, url: 'x' } })
const stops = () => shell.calls.filter(([c]) => c === 'torrent_stop').map(([, a]) => (a as { infoHash: string }).infoHash)
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the readout for an engine torrent (SPEC-torrent rule 32)', () => {
  it.each([
    [{ mbps: 12, peers: 8 }, '12 Mbps via VPN · 8 peers'],
    [{ mbps: 12, peers: 1 }, '12 Mbps via VPN · 1 peer'],
  ])('%o: %s', (r, text) => expect(engineLine(r)).toBe(text))
})

describe('a torrent the engine plays', () => {
  it('asks the engine with the torrent stream as it came', async () => {
    shell.calls = []
    expect(await playTorrent({ infoHash: H, fileIdx: 2 })).toBe('http://127.0.0.1:5/t/x/0')
    expect(shell.calls).toEqual([['torrent_play', { torrent: { infoHash: H, fileIdx: 2 } }]])
  })

  it('shows the engine speed and peers, and stops the torrent when playback leaves it', async () => {
    shell.calls = []
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    await tick()
    expect(shell.calls[0]).toEqual(['torrent_stats', { infoHash: h }])
    expect(engineNow.value).toEqual({ mbps: 8, peers: 3 })
    expect(stops()).toEqual([])
    nowPlaying.value = null
    expect(stops()).toEqual([h])
    expect(engineNow.value).toBeNull()
  })

  it('keeps a torrent that plays again, and stops the old one for another torrent', async () => {
    shell.calls = []
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    // The next episode of the same torrent: the engine already switched files.
    playingTorrent('k2', H)
    nowPlaying.value = req('k2')
    expect(stops()).toEqual([])
    const other = 'B'.repeat(40)
    playingTorrent('k3', other)
    expect(stops()).toEqual([h])
    nowPlaying.value = req('k3')
    nowPlaying.value = null
    expect(stops()).toEqual([h, 'b'.repeat(40)])
  })

  it('a started torrent that loses its tap or its hold stops, unless it is the one playing', async () => {
    shell.calls = []
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    dropTorrent(H)
    expect(stops()).toEqual([])
    dropTorrent('C'.repeat(40))
    expect(stops()).toEqual(['C'.repeat(40)])
    nowPlaying.value = null
  })
})

describe('Check again (SPEC-torrent rule 28)', () => {
  it('reruns the exit check and shows its answer', async () => {
    shell.calls = []
    shell.gate = { ok: true, iface: 'utun4' }
    checkAgain()
    await tick()
    expect(shell.calls).toEqual([['vpn_gate', { force: true }]])
    expect(gate.value).toEqual({ ok: true, iface: 'utun4' })
  })
})
