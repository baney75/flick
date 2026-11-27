import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { playingTorrent, letGo, playTorrent, wantTorrent, GRACE_MS, POLL_MS, TORRENT_LOST } = await import('../src/lib/torrent')
const { engineNow, engineLine } = await import('../src/lib/readout')
const { nowPlaying, toast } = await import('../src/lib/store')
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
  beforeEach(() => { vi.useFakeTimers(); shell.calls = []; shell.stats = { downBps: 1_000_000, peers: 3 } })
  afterEach(async () => { nowPlaying.value = null; await vi.advanceTimersByTimeAsync(GRACE_MS); vi.useRealTimers() })
  const flush = () => vi.advanceTimersByTimeAsync(0)

  it('asks the engine with the torrent stream as it came', async () => {
    expect(await playTorrent({ infoHash: H, fileIdx: 2 })).toBe('http://127.0.0.1:5/t/x/0')
    expect(shell.calls).toEqual([['torrent_play', { torrent: { infoHash: H, fileIdx: 2 } }]])
  })

  it('shows the engine speed and peers, and stops the torrent once the grace after closing ends', async () => {
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    await flush()
    expect(shell.calls[0]).toEqual(['torrent_stats', { infoHash: h }])
    expect(engineNow.value).toEqual({ mbps: 8, peers: 3 })
    nowPlaying.value = null
    expect(engineNow.value).toBeNull()
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100)
    expect(stops()).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(stops()).toEqual([h])
  })

  it('a replay or the next episode right after closing keeps the torrent; another torrent stops it at once', async () => {
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    nowPlaying.value = null
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2)
    playingTorrent('k2', H)
    nowPlaying.value = req('k2')
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(stops()).toEqual([])
    const other = 'B'.repeat(40)
    nowPlaying.value = null
    playingTorrent('k3', other)
    expect(stops()).toEqual([h])
    nowPlaying.value = req('k3')
    nowPlaying.value = null
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(stops()).toEqual([h, 'b'.repeat(40)])
  })

  it('a torrent whose VPN hold failed stops, unless it is the one playing', async () => {
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    letGo(H, true)
    expect(stops()).toEqual([])
    wantTorrent('C'.repeat(40))
    letGo('C'.repeat(40), true)
    expect(stops()).toEqual(['C'.repeat(40)])
  })

  it('a tap whose hold fails after a newer tap wants the same torrent leaves it to that tap', async () => {
    // Tap 1 waits on its hold; tap 2 wants the same torrent, so tap 1's hold answers stale.
    wantTorrent(H)
    wantTorrent(H)
    letGo(H, false)
    expect(stops()).toEqual([])
    letGo(H, true)
    expect(stops()).toEqual([H])
  })

  it('a tap that wants a torrent in its grace keeps it running through a slow start', async () => {
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    nowPlaying.value = null
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000)
    // The tap for the next file: torrent_play, the subtitles and the hold take longer than the grace left.
    wantTorrent(H)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(stops()).toEqual([])
    playingTorrent('k2', H)
    nowPlaying.value = req('k2')
    nowPlaying.value = null
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(stops()).toEqual([h])
  })

  it('a double tap starts the torrent once, and the losing tap never stops what the newer one wants', async () => {
    const t = { infoHash: H }
    wantTorrent(H)
    const [a, b] = await Promise.all([playTorrent(t), playTorrent(t)])
    expect(a).toBe(b)
    expect(shell.calls.filter(([c]) => c === 'torrent_play')).toHaveLength(1)
    letGo(H, false)
    expect(stops()).toEqual([])
    // A newer tap on another stream: the older torrent stops.
    wantTorrent(undefined)
    letGo(H, false)
    expect(stops()).toEqual([H])
  })

  it('closes the player when the engine no longer runs the torrent (the VPN changed tunnels)', async () => {
    playingTorrent('k1', H)
    nowPlaying.value = req('k1')
    await flush()
    shell.stats = null
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(nowPlaying.value).toBeNull()
    expect(toast.value?.text).toBe(TORRENT_LOST)
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
