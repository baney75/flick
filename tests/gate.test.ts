import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { streamCandidates, type Debrid } from '../src/lib/candidates'
import { needsGate, rank, VPN_DEBRID, VPN_P2P, type Device, type PickCtx } from '../src/lib/pick'

// The store reads the route at import; the shell is a desktop one whose gate the tests answer.
const shell = vi.hoisted(() => {
  Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} })
  return { desktop: true, calls: [] as [string, unknown][], answer: { ok: true } as { ok: boolean; message?: string }, emit: null as null | ((g: unknown) => void) }
})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  get isDesktop() { return shell.desktop },
  isMobileApp: false,
  invoke: async (cmd: string, args?: unknown) => { shell.calls.push([cmd, args]); return shell.answer },
  onDesktopEvent: async (_: string, cb: (g: unknown) => void) => { shell.emit = cb; return () => {} },
}))
const { holdGate, noEngineFor, gate, VPN_DROPPED, WINDOWS_NO_ENGINE, NO_ENGINE_YET } = await import('../src/lib/picking')
const { nowPlaying, toast } = await import('../src/lib/store')
const { DESKTOP_ONLY } = await import('../src/views/Vpn')

const torbox = { id: 'org.torbox', vpnOptional: true, debridHosts: ['torbox.app'] }
const other = { id: 'org.other', vpnOptional: false, debridHosts: ['dl.other.net'] }
const debrid = (more: Partial<Debrid> = {}): Debrid => ({ known: [torbox, other], order: [], ...more })
const hash = 'A'.repeat(40)

describe('how a stream arrives', () => {
  it('a link on a service download host is that service, subdomains too (SPEC-debrid rule 6)', () => {
    const cs = streamCandidates('k', [{ url: 'https://cdn3.torbox.app/f/1.mkv' }, { url: 'https://dl.other.net/x' }, { url: 'https://nottorbox.app/x' }, { url: 'https://cdn.example/x' }], { debrid: debrid() })
    expect(cs.map((c) => [c.via, c.service, c.vpnOptional])).toEqual([
      ['debrid-cached', 'org.torbox', true], ['debrid-cached', 'org.other', false], ['direct', undefined, undefined], ['direct', undefined, undefined],
    ])
  })
  it('a torrent with no service set up is peer to peer', () =>
    expect(streamCandidates('k', [{ torrent: { infoHash: hash } }], { debrid: debrid() })[0].via).toBe('p2p'))
  it('a torrent goes to the first service that has it cached, by the lowercased infoHash', () => {
    const cached = (svc: string, h: string) => svc === 'org.other' && h === hash.toLowerCase()
    expect(streamCandidates('k', [{ torrent: { infoHash: hash } }], { debrid: debrid({ order: [torbox, other], cached }) })[0]).toMatchObject({ via: 'debrid-cached', service: 'org.other', vpnOptional: false })
  })
  it('none cached: the first service fetches it first', () =>
    expect(streamCandidates('k', [{ torrent: { infoHash: hash } }], { debrid: debrid({ order: [torbox, other], cached: () => false }) })[0]).toMatchObject({ via: 'debrid-fetch', service: 'org.torbox' }))
  it('no debrid info: every link is direct', () => expect(streamCandidates('k', [{ url: 'https://torbox.app/x' }])[0].via).toBe('direct'))
})

describe('which streams need the VPN gate', () => {
  it.each([
    [{ via: 'direct' as const }, false, false],
    [{ via: 'p2p' as const }, false, true],
    [{ via: 'debrid-cached' as const, vpnOptional: true }, false, false],
    [{ via: 'debrid-cached' as const, vpnOptional: true }, true, true],
    [{ via: 'debrid-fetch' as const, vpnOptional: false }, false, true],
    [{ via: 'debrid-fetch' as const }, false, true],
  ])('%o with the switch %s: %s', (c, sw, want) => expect(needsGate(c, sw)).toBe(want))
})

describe('SPEC-debrid Amendment 1 cases, through the ranker', () => {
  const dev: Device = { maxQuality: '1080p', hdr: false, codecs: {}, desktop: true, phone: false }
  const prefs = { audio: ['en'], subs: [], maxQuality: '4K' as const }
  const ctx = (more: Partial<PickCtx> = {}): PickCtx => ({ gate: false, vpnForDebrid: false, online: true, ...more })
  const one = (s: Parameters<typeof streamCandidates>[1][number], d: Debrid, c: PickCtx) => rank(streamCandidates('k', [s], { debrid: d }), prefs, dev, c)[0].blocked
  it('gate failing, TorBox (vpnOptional), switch off: plays', () => expect(one({ url: 'https://torbox.app/x' }, debrid(), ctx())).toBeUndefined())
  it('gate failing, TorBox, switch on: blocked', () => expect(one({ url: 'https://torbox.app/x' }, debrid(), ctx({ vpnForDebrid: true }))).toBe(VPN_DEBRID))
  it('gate failing, a service without vpnOptional: blocked', () => expect(one({ url: 'https://dl.other.net/x' }, debrid(), ctx())).toBe(VPN_DEBRID))
  it('gate failing, no service, torrent: blocked', () => expect(one({ torrent: { infoHash: hash } }, debrid(), ctx())).toBe(VPN_P2P))
  it('gate passing, a service without vpnOptional: plays', () => expect(one({ url: 'https://dl.other.net/x' }, debrid(), ctx({ gate: true }))).toBeUndefined())
  it('own server links never need the VPN', () => expect(one({ url: 'https://nas.local/m.mkv' }, debrid(), ctx({ vpnForDebrid: true }))).toBeUndefined())
})

describe('the built-in engine by platform', () => {
  it.each([
    [{ desktop: false, mobile: false, windows: false }, DESKTOP_ONLY],
    [{ desktop: true, mobile: true, windows: false }, DESKTOP_ONLY],
    [{ desktop: true, mobile: false, windows: true }, WINDOWS_NO_ENGINE],
    [{ desktop: true, mobile: false, windows: false }, NO_ENGINE_YET],
  ])('%o: %s', (p, why) => expect(noEngineFor(p)).toBe(why))
})

describe('playing through the gate', () => {
  const req = (key: string) => ({ key, title: 'T', kind: 'video' as const, url: 'https://dl.other.net/x', ref: { t: 'url' as const, url: 'x' } })
  it('holds before it plays, stops the player when the VPN drops, and lets go on leaving', async () => {
    shell.answer = { ok: true }
    expect((await holdGate('a')).ok).toBe(true)
    expect(shell.calls).toContainEqual(['vpn_gate_hold', { id: 'a' }])
    nowPlaying.value = req('a')
    shell.emit!({ ok: false, message: 'No VPN' })
    expect(nowPlaying.value).toBeNull()
    expect(toast.value?.text).toBe(VPN_DROPPED)
    expect(gate.value?.ok).toBe(false)

    shell.answer = { ok: true }
    await holdGate('b')
    nowPlaying.value = req('b')
    nowPlaying.value = req('c')
    expect(shell.calls).toContainEqual(['vpn_gate_release', { id: 'b' }])
    // c was never held: a later drop leaves it alone.
    shell.emit!({ ok: false })
    expect(nowPlaying.value?.key).toBe('c')
  })
  it('a failing hold plays nothing and holds nothing', async () => {
    nowPlaying.value = null
    shell.answer = { ok: false, message: 'Turn on your VPN to play torrents.' }
    expect(await holdGate('d')).toMatchObject({ ok: false, message: 'Turn on your VPN to play torrents.' })
    nowPlaying.value = req('d')
    shell.emit!({ ok: false })
    expect(nowPlaying.value?.key).toBe('d')
  })
  it('on the website there is no gate: it fails without asking', async () => {
    shell.desktop = false
    const before = shell.calls.length
    expect(await holdGate('e')).toEqual({ ok: false, message: DESKTOP_ONLY })
    expect(shell.calls.length).toBe(before)
    shell.desktop = true
  })
})

describe('a drop while the hold is on its way', () => {
  it('wins over the hold\'s older ok: nothing is held and the hold is let go', async () => {
    shell.answer = { ok: true }
    const slow = holdGate('f')
    shell.emit!({ ok: false, message: 'No VPN' })
    const g = await slow
    expect(g.ok).toBe(false)
    expect(shell.calls).toContainEqual(['vpn_gate_release', { id: 'f' }])
    expect(gate.value?.ok).toBe(false)
  })
})
