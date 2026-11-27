import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { streamCandidates, type Debrid } from '../src/lib/candidates'
import { needsGate, rank, VPN_DEBRID, VPN_P2P, type Candidate, type Device, type PickCtx, type Ranked } from '../src/lib/pick'
import { parseRelease } from '../src/lib/release'

// The store reads the route at import; the shell is a desktop one whose gate the tests answer.
const shell = vi.hoisted(() => {
  Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} })
  return { desktop: true, calls: [] as [string, unknown][], answer: { ok: true } as { ok: boolean; message?: string }, emit: null as null | ((g: unknown) => void), listenFails: false }
})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  get isDesktop() { return shell.desktop },
  isMobileApp: false,
  invoke: async (cmd: string, args?: unknown) => { shell.calls.push([cmd, args]); return shell.answer },
  onDesktopEvent: async (_: string, cb: (g: unknown) => void) => { if (shell.listenFails) throw new Error('no listen'); shell.emit = cb; return () => {} },
}))
const { holdGate, releaseGate, shutFor, debridNow, noEngineFor, gate, VPN_DROPPED, NO_WATCH, OUTSIDE_GATE, WINDOWS_NO_ENGINE, NO_ENGINE_YET } = await import('../src/lib/picking')
const { installed } = await import('../src/lib/plugins/registry')
const { nowPlaying, toast } = await import('../src/lib/store')
const { DESKTOP_ONLY } = await import('../src/views/Vpn')

const torbox = { id: 'org.torbox', vpnOptional: true, debridHosts: ['torbox.app'] }
const other = { id: 'org.other', vpnOptional: false, debridHosts: ['dl.other.net'] }
const debrid = (more: Partial<Debrid> = {}): Debrid => ({ known: [torbox, other], order: [], ...more })
const hash = 'A'.repeat(40)

describe('how a stream arrives', () => {
  it('a link on a service download host is that service, subdomains too (SPEC-debrid rule 6)', () => {
    const cs = streamCandidates('k', [{ url: 'https://cdn3.torbox.app/f/1.mkv' }, { url: 'https://dl.other.net/x' }, { url: 'https://dl.other.net./x' }, { url: 'https://nottorbox.app/x' }, { url: 'https://cdn.example/x' }], { debrid: debrid() })
    expect(cs.map((c) => [c.via, c.service, c.vpnOptional])).toEqual([
      ['debrid-cached', 'org.torbox', true], ['debrid-cached', 'org.other', false], ['debrid-cached', 'org.other', false], ['direct', undefined, undefined], ['direct', undefined, undefined],
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
  // Holds are per tap: `${key}#${tap}`.
  const sent = (cmd: string, key: string) => shell.calls.some(([c, a]) => c === cmd && (a as { id: string }).id.startsWith(`${key}#`))
  const released = (key: string) => sent('vpn_gate_release', key)
  it('holds before it plays; a drop stops the player, says why and lets the hold go', async () => {
    shell.answer = { ok: true }
    expect((await holdGate('a')).ok).toBe(true)
    expect(sent('vpn_gate_hold', 'a')).toBe(true)
    nowPlaying.value = req('a')
    shell.emit!({ ok: false, message: 'No VPN' })
    expect(nowPlaying.value).toBeNull()
    expect(toast.value?.text).toBe(VPN_DROPPED)
    expect(gate.value?.ok).toBe(false)
    expect(released('a')).toBe(true)
  })
  it('leaving the stream lets it go; what was never held is left alone by a drop', async () => {
    shell.answer = { ok: true }
    await holdGate('b')
    nowPlaying.value = req('b')
    nowPlaying.value = req('c')
    expect(released('b')).toBe(true)
    shell.emit!({ ok: false })
    expect(nowPlaying.value?.key).toBe('c')
  })
  it('a failing hold plays nothing, holds nothing, and leaves the stream already playing held', async () => {
    shell.answer = { ok: true }
    await holdGate('g')
    nowPlaying.value = req('g')
    shell.answer = { ok: false, message: 'Turn on your VPN to play torrents.' }
    expect(await holdGate('h')).toMatchObject({ ok: false, message: 'Turn on your VPN to play torrents.' })
    expect(released('g')).toBe(false)
    shell.emit!({ ok: false })
    expect(nowPlaying.value).toBeNull()
  })
  it('a direct stream taking over lets the hold go, so a drop leaves it playing', async () => {
    shell.answer = { ok: true }
    await holdGate('i')
    nowPlaying.value = req('i')
    releaseGate()
    expect(released('i')).toBe(true)
    shell.emit!({ ok: false })
    expect(nowPlaying.value?.key).toBe('i')
  })
  it('a drop while the hold is on its way fails it, even when the VPN comes back first', async () => {
    shell.answer = { ok: true }
    const slow = holdGate('f')
    await Promise.resolve()
    shell.emit!({ ok: false, message: 'No VPN' })
    shell.emit!({ ok: true })
    expect(await slow).toEqual({ ok: false, message: VPN_DROPPED })
    expect(released('f')).toBe(true)
  })
  it('two taps whose holds answer together: only the newer plays and stays held, even on the same video', async () => {
    shell.answer = { ok: true }
    nowPlaying.value = null
    const { tap, current } = await import('../src/lib/picking')
    const t1 = tap(), first = holdGate('v', t1)
    const t2 = tap(), second = holdGate('v', t2)
    const [g1, g2] = await Promise.all([first, second])
    expect([g1.ok, current(t1), g2.ok, current(t2)]).toEqual([false, false, true, true])
    expect(shell.calls).toContainEqual(['vpn_gate_release', { id: `v#${t1}` }])
    expect(shell.calls).not.toContainEqual(['vpn_gate_release', { id: `v#${t2}` }])
    nowPlaying.value = req('v')
    shell.emit!({ ok: false })
    expect(nowPlaying.value).toBeNull()
  })
  it('on the website there is no gate: it fails without asking', async () => {
    shell.desktop = false
    const before = shell.calls.length
    expect(await holdGate('e')).toEqual({ ok: false, message: DESKTOP_ONLY })
    expect(shell.calls.length).toBe(before)
    shell.desktop = true
  })
  it('with no way to hear a drop, nothing gated plays, and the gate never reads as passing', async () => {
    vi.resetModules()
    shell.listenFails = true
    shell.answer = { ok: true }
    const fresh = await import('../src/lib/picking')
    fresh.watchGate()
    await new Promise((r) => setTimeout(r, 0))
    expect(fresh.gate.value).toEqual({ ok: false, message: NO_WATCH })
    expect(await fresh.holdGate('j')).toEqual({ ok: false, message: NO_WATCH })
    expect(shell.calls.some(([c, a]) => c === 'vpn_gate_hold' && (a as { id: string }).id.startsWith('j#'))).toBe(false)
    shell.listenFails = false
  })
})

describe('what stays shut on a tap', () => {
  const r = (c: Partial<Candidate>, blocked?: string): Ranked =>
    ({ c: { id: 'k#0', media: 'video', place: 'plugin', via: 'direct', text: '', order: 0, ...c }, rel: parseRelease(''), ...(blocked ? { blocked } : {}) })
  it('a gated row the gate fails', () => expect(shutFor(r({ via: 'debrid-cached' }, VPN_DEBRID), false)).toBe(VPN_DEBRID))
  it('a gated book or browser link, even with the gate passing', () => {
    expect(shutFor(r({ via: 'debrid-cached', media: 'book' }), false)).toBe(OUTSIDE_GATE)
    expect(shutFor(r({ via: 'debrid-cached', external: true }, 'Opens outside Flick'), false)).toBe(OUTSIDE_GATE)
  })
  it('not a vpnOptional service with the switch off, nor a direct link', () => {
    expect(shutFor(r({ via: 'debrid-cached', vpnOptional: true, media: 'book' }), false)).toBeUndefined()
    expect(shutFor(r({ external: true }, 'Opens outside Flick'), true)).toBeUndefined()
  })
})

describe('no gate on this platform', () => {
  const dev: Device = { maxQuality: '1080p', hdr: false, codecs: {}, desktop: false, phone: true }
  const prefs = { audio: ['en'], subs: [], maxQuality: '4K' as const }
  it('a gated debrid link says it needs the desktop app, not to turn on a VPN', () =>
    expect(rank(streamCandidates('k', [{ url: 'https://dl.other.net/x' }], { debrid: debrid() }), prefs, dev, { gate: false, vpnForDebrid: false, online: true, noGate: DESKTOP_ONLY })[0].blocked).toBe(DESKTOP_ONLY))
  it('a vpnOptional one with the switch off still plays', () =>
    expect(rank(streamCandidates('k', [{ url: 'https://torbox.app/x' }], { debrid: debrid() }), prefs, dev, { gate: false, vpnForDebrid: false, online: true, noGate: DESKTOP_ONLY })[0].blocked).toBeUndefined())
})

describe('installed services', () => {
  it('their download hosts compare in lowercase, without leading or trailing dots', () => {
    installed.value = [{ id: 'org.x', kind: 'service', manifest: { name: 'X', vpnOptional: false, debridHosts: ['.DL.X.net.'] } } as never]
    expect(debridNow().known).toEqual([{ id: 'org.x', vpnOptional: false, debridHosts: ['dl.x.net'] }])
    expect(streamCandidates('k', [{ url: 'https://a.dl.x.net/f' }], { debrid: debridNow() })[0].via).toBe('debrid-cached')
    installed.value = []
  })
})

describe('the context the ranker gets', () => {
  it('reads the "Require a VPN for debrid services too" switch, off by default', async () => {
    const { settings } = await import('../src/lib/store')
    const { ctxNow } = await import('../src/lib/picking')
    expect(ctxNow().vpnForDebrid).toBe(false)
    settings.value = { ...settings.value, debridNeedsVpn: true }
    expect(ctxNow().vpnForDebrid).toBe(true)
    settings.value = { ...settings.value, debridNeedsVpn: false }
  })
  it('fails closed before the gate answers; the desktop app has a gate to wait for', async () => {
    const { ctxNow, gate: g } = await import('../src/lib/picking')
    g.value = null
    expect(ctxNow().gate).toBe(false)
    expect(ctxNow().noGate).toBeUndefined()
  })
})
