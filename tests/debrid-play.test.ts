import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamCandidates } from '../src/lib/candidates'
import { rank, VPN_DEBRID, VPN_P2P, type Device, type PickCtx } from '../src/lib/pick'
import type { Stream } from '../src/lib/plugins/validate'

// A desktop shell whose VPN gate the tests set through the gate signal.
const shell = vi.hoisted(() => {
  Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} })
  return { answer: { ok: false } as { ok: boolean } }
})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  isDesktop: true,
  isMobileApp: false,
  invoke: async () => shell.answer,
  onDesktopEvent: async () => () => {},
}))
const { debridNow, gate, askable, mayAskNow, watchGate, NO_ENGINE_YET } = await import('../src/lib/picking')
const { lookupCached, serviceTag, torrentHashes, mayAsk, resolveOrder, wantsGate, canStart, torrentUrl, fetching, cancelFetch, waitLine, vpnStopped } = await import('../src/lib/debrid-play')
const { services: playable } = await import('../src/lib/plugins/services')
const { installed } = await import('../src/lib/plugins/registry')
const { settings } = await import('../src/lib/store')

const svc = (id: string, name: string, vpnOptional: boolean) => ({
  id, kind: 'service', enabled: true, official: true, settings: { apiKey: 'k' },
  manifest: { id, name, vpnOptional, debridHosts: [`dl.${id}`], hosts: [`api.${id}`], settings: [{ key: 'apiKey', type: 'password' }] },
}) as never
const TORBOX = svc('app.torbox', 'TorBox', true)
const OTHER = svc('org.other', 'Other', false)
const h = (c: string) => c.repeat(40)

const dev: Device = { maxQuality: '1080p', hdr: false, codecs: {}, desktop: true, phone: false }
const prefs = { audio: ['en'], subs: [], maxQuality: '4K' as const }
const ctx = (more: Partial<PickCtx> = {}): PickCtx => ({ gate: gate.value?.ok === true, vpnForDebrid: settings.value.debridNeedsVpn === true, online: true, noEngine: NO_ENGINE_YET, ...more })
const setup = (o: { list: unknown[]; gate: boolean; sw?: boolean }) => {
  installed.value = o.list as never
  settings.value = { ...settings.value, serviceOrder: (o.list as { id: string }[]).map((s) => s.id), debridNeedsVpn: o.sw === true }
  gate.value = { ok: o.gate, message: o.gate ? null : 'no VPN' } as never
}

/** What the page does: look up with the services Flick may ask, then rank. */
async function page(streams: Stream[], answer: (id: string, hashes: string[]) => string[] = () => []) {
  const call = vi.fn(async (s: { id: string }, _fn: string, args: unknown[]) => answer(s.id, args[0] as string[]))
  const cached = await lookupCached(askable(), torrentHashes(streams), mayAskNow, call as never)
  const rows = rank(streamCandidates('k', streams, { debrid: debridNow(cached) }), prefs, dev, ctx())
  return { call, rows }
}

beforeEach(() => setup({ list: [], gate: false }))

describe('which services Flick may ask (SPEC-debrid Amendment 1)', () => {
  it.each([
    [true, false, false, true], [true, true, false, true], [false, true, false, true],
    [false, true, true, false], [false, false, false, false], [true, false, true, true],
  ])('gate %s, vpnOptional %s, switch %s: %s', (g, opt, sw, want) => expect(mayAsk({ vpnOptional: opt }, g, sw)).toBe(want))
  it('none askable: every service stays in order, so the first one blocks', () =>
    expect(resolveOrder([{ id: 'a', vpnOptional: false }], false, false)).toEqual([{ id: 'a', vpnOptional: false }]))
})

describe('the cached lookups', () => {
  const torrent = (c: string, more: Partial<Stream> = {}): Stream => ({ torrent: { infoHash: h(c).toUpperCase(), fileIdx: 1, trackers: ['udp://t.example:80'] }, title: `T ${c} 1080p`, ...more })

  it('gate failing, TorBox (vpnOptional), switch off: TorBox is asked and the row may play', async () => {
    setup({ list: [TORBOX], gate: false })
    const { call, rows } = await page([torrent('a')])
    expect(call).toHaveBeenCalledOnce()
    expect(rows[0].c).toMatchObject({ via: 'debrid-fetch', service: 'app.torbox' })
    expect(rows[0].blocked).toBeUndefined()
  })
  it('gate failing, TorBox, switch on: no request to TorBox; the row says to turn on the VPN', async () => {
    setup({ list: [TORBOX], gate: false, sw: true })
    const { call, rows } = await page([torrent('a')])
    expect(call).not.toHaveBeenCalled()
    expect(rows[0].blocked).toBe(VPN_DEBRID)
  })
  it('gate failing, a third-party service without vpnOptional: no request; blocked', async () => {
    setup({ list: [OTHER], gate: false })
    const { call, rows } = await page([torrent('a')])
    expect(call).not.toHaveBeenCalled()
    expect(rows[0].blocked).toBe(VPN_DEBRID)
  })
  it('gate failing, a gated service first and TorBox second: only TorBox is asked and used', async () => {
    setup({ list: [OTHER, TORBOX], gate: false })
    const { call, rows } = await page([torrent('a')], () => [h('a')])
    expect(call.mock.calls.map((c) => c[0].id)).toEqual(['app.torbox'])
    expect(rows[0].c).toMatchObject({ via: 'debrid-cached', service: 'app.torbox' })
  })
  it('gate failing, no service, torrent stream: blocked (the built-in engine needs the VPN)', async () => {
    setup({ list: [], gate: false })
    const { call, rows } = await page([torrent('a')])
    expect(call).not.toHaveBeenCalled()
    expect(rows[0].c.via).toBe('p2p')
    expect([NO_ENGINE_YET, VPN_P2P]).toContain(rows[0].blocked)
  })
  it('gate passes, two services, the second has it cached: the second takes it', async () => {
    setup({ list: [OTHER, TORBOX], gate: true })
    const { call, rows } = await page([torrent('a')], (id) => (id === 'app.torbox' ? [h('a')] : []))
    expect(call.mock.calls.map((c) => c[0].id)).toEqual(['org.other', 'app.torbox'])
    expect(rows[0].c).toMatchObject({ via: 'debrid-cached', service: 'app.torbox' })
  })
  it('only lowercase hashes go out, HASHES_PER_CALL at a time (150 hashes: 100, then 50)', async () => {
    setup({ list: [TORBOX], gate: true })
    const streams = Array.from({ length: 150 }, (_, i) => torrent('', { torrent: { infoHash: i.toString(16).padStart(40, 'A'), trackers: ['udp://x:1'] } }))
    const { call } = await page(streams)
    expect(call.mock.calls.map((c) => [c[1], (c[2][0] as string[]).length])).toEqual([['cached', 100], ['cached', 50]])
    for (const c of call.mock.calls) {
      expect(c[2]).toHaveLength(1)
      expect((c[2][0] as string[]).every((x) => /^[0-9a-f]{40}$/.test(x))).toBe(true)
    }
  })
  it('a VPN that drops mid-lookup stops the next call to a gated service', async () => {
    setup({ list: [OTHER], gate: true })
    const streams = Array.from({ length: 150 }, (_, i) => torrent('', { torrent: { infoHash: i.toString(16).padStart(40, 'b') } }))
    const call = vi.fn(async () => { gate.value = { ok: false, message: 'dropped' } as never; return [] })
    await lookupCached(askable(), torrentHashes(streams), mayAskNow, call as never)
    expect(call).toHaveBeenCalledOnce()
  })
  it('a failed lookup counts as none cached: the row says the service fetches it first', async () => {
    setup({ list: [TORBOX], gate: true })
    const call = vi.fn(async () => { throw new Error('offline') })
    const cached = await lookupCached(askable(), [h('a')], mayAskNow, call as never)
    const c = streamCandidates('k', [torrent('a')], { debrid: debridNow(cached) })[0]
    expect(serviceTag(torrent('a'), c, () => 'TorBox')).toBe('TorBox will fetch it first')
  })
  it('a service turned off or without a key is never asked', async () => {
    setup({ list: [{ ...(TORBOX as object), enabled: false }, { ...(OTHER as object), settings: {} }], gate: true })
    const { call, rows } = await page([torrent('a')])
    expect(call).not.toHaveBeenCalled()
    expect(rows[0].c.via).toBe('p2p')
  })
})

describe('the title page watches the gate for any torrent or debrid stream', () => {
  it('direct links only: no watch; a torrent or a debrid link: watch', () => {
    expect(wantsGate([{ via: 'direct' }])).toBe(false)
    expect(wantsGate([{ via: 'direct' }, { via: 'debrid-fetch' }])).toBe(true)
    expect(wantsGate([{ via: 'debrid-cached' }])).toBe(true)
    expect(wantsGate([{ via: 'p2p' }])).toBe(true)
  })
  it('fresh start, VPN on, [gated, TorBox]: TorBox alone until the gate answers, then the user\'s order', async () => {
    setup({ list: [OTHER, TORBOX], gate: false })
    gate.value = null
    expect(debridNow().order.map((s) => s.id)).toEqual(['app.torbox'])
    // Every row routes to TorBox (vpnOptional), so no row is gated; the page still watches.
    expect(wantsGate(streamCandidates('k', [{ torrent: { infoHash: h('a') } }], { debrid: debridNow() }))).toBe(true)
    shell.answer = { ok: true }
    watchGate()
    await vi.waitFor(() => expect(gate.value?.ok).toBe(true))
    expect(debridNow().order.map((s) => s.id)).toEqual(['org.other', 'app.torbox'])
    shell.answer = { ok: false }
  })
  it('leaving the page stops the batches still to go', async () => {
    setup({ list: [TORBOX], gate: true })
    let live = true
    const call = vi.fn(async () => { live = false; return [] })
    const many = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(40, 'c'))
    await lookupCached(askable(), many, (s) => live && mayAskNow(s), call as never)
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('the row tag (rule 7)', () => {
  const t: Stream = { torrent: { infoHash: h('a') } }
  const name = (id: string) => (id === 'app.torbox' ? 'TorBox' : id)
  it('cached: "Instant on TorBox"', () => expect(serviceTag(t, { via: 'debrid-cached', service: 'app.torbox' } as never, name)).toBe('Instant on TorBox'))
  it('not cached: "TorBox will fetch it first"', () => expect(serviceTag(t, { via: 'debrid-fetch', service: 'app.torbox' } as never, name)).toBe('TorBox will fetch it first'))
  it('a link on a debrid host is no torrent row: no tag', () => expect(serviceTag({ url: 'https://dl.app.torbox/x' }, { via: 'debrid-cached', service: 'app.torbox' } as never, name)).toBeUndefined())
  it('peer to peer: no tag', () => expect(serviceTag(t, { via: 'p2p' } as never, name)).toBeUndefined())
})

describe('the best-stream button prefers cached rows', () => {
  it('two torrent rows, the second cached: it ranks first', async () => {
    setup({ list: [TORBOX], gate: true })
    const { rows } = await page([{ torrent: { infoHash: h('a') }, title: 'A 1080p' }, { torrent: { infoHash: h('b') }, title: 'B 1080p' }], () => [h('b')])
    expect(rows[0].c).toMatchObject({ id: 'k#1', via: 'debrid-cached' })
    expect(rows[1].c.via).toBe('debrid-fetch')
  })
})

describe('Play on a torrent row (rules 5b, 8)', () => {
  const tor: Stream = { torrent: { infoHash: h('C'), fileIdx: 2, trackers: ['udp://t.example:80', 'https://t.example/a'] }, title: 'C 1080p' }
  const row = (service: string, via: 'debrid-cached' | 'debrid-fetch' = 'debrid-fetch') => ({ c: { id: 'k#0', via, service } }) as never
  const clock = () => { let t = 0; return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms }) } }
  const opts = (call: unknown, more: object = {}) => ({ list: playable.value, may: mayAskNow, watch: (fn: () => void) => gate.subscribe(fn), call: call as never, ...clock(), ...more })
  const lines: string[] = []
  const stopLines = fetching.subscribe((f) => { if (f) lines.push(f.line) })
  beforeEach(() => { lines.length = 0 })

  it('TorBox, uncached, fixtures queued, 40%, done: shows the wait at 40%, then gives the https link', async () => {
    setup({ list: [TORBOX], gate: false })
    const answers = [{ wait: { message: 'Queued' } }, { wait: { pct: 40, message: 'Downloading' } }, { url: 'https://api.app.torbox/f.mkv' }]
    const call = vi.fn(async () => answers.shift())
    expect(await torrentUrl('k', tor, row('app.torbox'), opts(call))).toBe('https://api.app.torbox/f.mkv')
    expect(lines).toEqual(['Asking TorBox', 'TorBox is fetching: Queued', 'TorBox is fetching: 40%'])
    expect(fetching.value).toBeNull()
  })
  it('only the infoHash (lowercase) and fileIdx go to the service, never the trackers', async () => {
    setup({ list: [TORBOX], gate: true })
    const call = vi.fn(async (..._a: unknown[]) => ({ url: 'https://api.app.torbox/f' }))
    await torrentUrl('k', tor, row('app.torbox', 'debrid-cached'), opts(call))
    expect(call.mock.calls[0][1]).toBe('resolve')
    expect(call.mock.calls[0][2]).toEqual([{ infoHash: h('c'), fileIdx: 2 }])
  })
  it('gate passes, two services, the second has it cached: only the second resolves', async () => {
    setup({ list: [OTHER, TORBOX], gate: true })
    const call = vi.fn(async (s: { id: string }, fn: string, args: unknown[]) => (fn === 'cached' ? (s.id === 'app.torbox' ? [h('c')] : []) : (void args, { url: `https://api.${s.id}/f` })))
    const cached = await lookupCached(askable(), torrentHashes([tor]), mayAskNow, call as never)
    const r = rank(streamCandidates('k', [tor], { debrid: debridNow(cached) }), prefs, dev, ctx())[0]
    expect(await torrentUrl('k', tor, r, opts(call))).toBe('https://api.app.torbox/f')
    expect(call.mock.calls.filter((c) => c[1] === 'resolve').map((c) => c[0].id)).toEqual(['app.torbox'])
  })
  it('Cancel during the wait stops it: no more calls, nothing plays, the line goes', async () => {
    setup({ list: [TORBOX], gate: true })
    const call = vi.fn(async () => { if (call.mock.calls.length === 2) cancelFetch('k'); return { wait: { pct: 10, message: 'x' } } })
    expect(await torrentUrl('k', tor, row('app.torbox'), opts(call))).toBeNull()
    expect(call).toHaveBeenCalledTimes(2)
    expect(fetching.value).toBeNull()
  })
  it('a newer wait cancels the older one', async () => {
    setup({ list: [TORBOX], gate: true })
    let second: Promise<string | null> | null = null
    const call = vi.fn(async () => {
      if (!second) second = torrentUrl('k2', tor, row('app.torbox'), opts(async () => ({ url: 'https://api.app.torbox/2' })))
      return { wait: { message: 'x' } }
    })
    expect(await torrentUrl('k', tor, row('app.torbox'), opts(call))).toBeNull()
    expect(await second).toBe('https://api.app.torbox/2')
  })
  it('a gated service: the VPN dropping mid-wait stops it before the next call', async () => {
    setup({ list: [OTHER], gate: true })
    const call = vi.fn(async () => { gate.value = { ok: false, message: 'dropped' } as never; return { wait: { message: 'x' } } })
    await expect(torrentUrl('k', tor, row('org.other'), opts(call))).rejects.toThrow(vpnStopped('Other'))
    expect(call).toHaveBeenCalledOnce()
  })
  it('a gated service with the gate failing: no request at all', async () => {
    setup({ list: [OTHER], gate: false })
    const call = vi.fn()
    await expect(torrentUrl('k', tor, row('org.other'), opts(call))).rejects.toThrow(vpnStopped('Other'))
    expect(call).not.toHaveBeenCalled()
  })
  it('TorBox with the switch off keeps going when the VPN drops', async () => {
    setup({ list: [TORBOX], gate: true })
    const answers = [{ wait: { message: 'x' } }, { url: 'https://api.app.torbox/f' }]
    const call = vi.fn(async () => { gate.value = { ok: false, message: 'dropped' } as never; return answers.shift() })
    expect(await torrentUrl('k', tor, row('app.torbox'), opts(call))).toBe('https://api.app.torbox/f')
  })
  it('wait longer than 10 minutes: "TorBox could not fetch this torrent in time"', async () => {
    setup({ list: [TORBOX], gate: true })
    await expect(torrentUrl('k', tor, row('app.torbox'), opts(async () => ({ wait: { message: 'x' } })))).rejects.toThrow('TorBox could not fetch this torrent in time')
    expect(fetching.value).toBeNull()
  })
  it('the wait line', () => {
    expect(waitLine('TorBox', { pct: 39.6, message: 'x' })).toBe('TorBox is fetching: 40%')
    expect(waitLine('TorBox', { message: 'Queued' })).toBe('TorBox is fetching: Queued')
  })
  it('Play starts a link, or a torrent a service takes; with no service a torrent waits for the engine', () => {
    expect(canStart({ c: { via: 'direct' } } as never, { url: 'https://x/y' })).toBe(true)
    expect(canStart(row('app.torbox', 'debrid-cached'), tor)).toBe(true)
    expect(canStart(row('app.torbox'), tor)).toBe(true)
    expect(canStart({ c: { via: 'p2p' } } as never, tor)).toBe(false)
  })
  it('the best-stream button: a torrent through TorBox; none with no service', async () => {
    setup({ list: [TORBOX], gate: false })
    const best = (rows: { blocked?: string; c: { id: string } }[], list: Stream[]) => rows.find((r) => !r.blocked && canStart(r as never, list[Number(r.c.id.split('#')[1])]))
    expect(best((await page([tor])).rows, [tor])?.c.id).toBe('k#0')
    setup({ list: [], gate: true })
    expect(best((await page([tor])).rows, [tor])).toBeUndefined()
  })
  afterAll(() => stopLines())
})
