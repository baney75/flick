import { describe, expect, it } from 'vitest'
import { bufferedSeconds, counts, fetchedBytes, viaLine, viaOf } from '../src/lib/readout'
import { RateMeter } from '../src/lib/speed'
import { streamCandidates } from '../src/lib/candidates'
import { rank, type PickCtx } from '../src/lib/pick'

const ranges = (...r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] })
const name = (id: string) => (id === 'app.torbox' ? 'TorBox' : id)

describe('the bytes the player fetched (SPEC-torrent rule 32)', () => {
  it('buffered time across every range', () => expect(bufferedSeconds(ranges([0, 30], [100, 110]))).toBe(40))
  it('2 more seconds of a 1 GB, 1,000 s file: 2 MB', () => expect(fetchedBytes(10, 12, 1e9, 1000)).toBe(2e6))
  it('a seek that drops a range fetched nothing', () => expect(fetchedBytes(40, 5, 1e9, 1000)).toBe(0))
  it('size or duration unknown: nothing to count', () => {
    expect(fetchedBytes(0, 5, undefined, 1000)).toBe(0)
    expect(fetchedBytes(0, 5, 1e9, NaN)).toBe(0)
    expect(fetchedBytes(0, 5, 1e9, Infinity)).toBe(0)
  })
  it('fed to the meter: 7.5 MB over the last 5 s is 12 Mbps', () => {
    const m = new RateMeter(0)
    for (let t = 1000; t <= 5000; t += 1000) m.add(fetchedBytes(0, 1.5, 1e9, 1000), t)
    expect(Math.round(m.mbps(5000))).toBe(12)
  })
})

describe('when the buffer measures the service', () => {
  it('the service link with a known length: yes', () => expect(counts('https://x.tb-cdn.st/f.mkv', 'https://x.tb-cdn.st/f.mkv', 5400)).toBe(true))
  it('a converted MKV (a local growing stream): no', () => expect(counts('asset://localhost/conv/index.m3u8', 'https://x.tb-cdn.st/f.mkv', Infinity)).toBe(false))
  it('the service link with an unknown length: no', () => {
    expect(counts('https://x.tb-cdn.st/f', 'https://x.tb-cdn.st/f', Infinity)).toBe(false)
    expect(counts('https://x.tb-cdn.st/f', 'https://x.tb-cdn.st/f', NaN)).toBe(false)
  })
  it('the same link in the browser\'s normalized form: yes', () => expect(counts('https://x.tb-cdn.st/a%20b.mkv', 'https://X.tb-cdn.st/a b.mkv', 100)).toBe(true))
  it('no link given: no', () => expect(counts('https://x/f', undefined, 100)).toBe(false))
})

describe('the readout line', () => {
  it('the gate has not answered: no claim about the VPN', () => {
    expect(viaLine({ service: 'TorBox' }, null, null)).toBe('via TorBox')
    expect(viaLine({ service: 'TorBox' }, 12, null)).toBe('via TorBox · 12 Mbps')
  })
  it('"via TorBox", the speed and "via VPN"', () => expect(viaLine({ service: 'TorBox' }, 12, true)).toBe('via TorBox · 12 Mbps via VPN'))
  it('"no VPN" when the gate does not pass', () => expect(viaLine({ service: 'TorBox' }, 12, false)).toBe('via TorBox · 12 Mbps, no VPN'))
  it('before the first speed sample', () => {
    expect(viaLine({ service: 'TorBox' }, null, false)).toBe('via TorBox · no VPN')
    expect(viaLine({ service: 'TorBox' }, null, true)).toBe('via TorBox · via VPN')
  })
})

describe('which streams get a readout', () => {
  const debrid = { known: [{ id: 'app.torbox', vpnOptional: true, debridHosts: ['tb-cdn.st'] }], order: [{ id: 'app.torbox', vpnOptional: true, debridHosts: ['tb-cdn.st'] }], cached: () => true }
  const ctx: PickCtx = { gate: false, vpnForDebrid: false, online: true }
  const dev = { maxQuality: '4K' as const, hdr: false, codecs: {}, desktop: true, phone: false }
  const prefs = { audio: ['en'], subs: [], maxQuality: '4K' as const }
  const rows = (s: Parameters<typeof streamCandidates>[1]) => rank(streamCandidates('k', s, { debrid }), prefs, dev, ctx)
  it('gate failing, TorBox (vpnOptional), switch off: plays, and the player says "no VPN"', () => {
    const [r] = rows([{ torrent: { infoHash: 'a'.repeat(40) }, title: 'Film 1080p 2.0 GB' }])
    expect(r.blocked).toBeUndefined()
    expect(viaOf(r, name)).toEqual({ service: 'TorBox', bytes: 2e9 })
    expect(viaLine(viaOf(r, name)!, null, false)).toBe('via TorBox · no VPN')
  })
  it('an addon link on a TorBox download host gets it too', () => expect(viaOf(rows([{ url: 'https://x.tb-cdn.st/f.mkv' }])[0], name)).toEqual({ service: 'TorBox' }))
  it('an episode: no size, since a season pack lists the whole pack', () => {
    const [r] = rank(streamCandidates('k', [{ torrent: { infoHash: 'b'.repeat(40) }, title: 'Show S01 1080p 20.0 GB' }], { debrid, episode: true }), prefs, dev, ctx)
    expect(viaOf(r, name)).toEqual({ service: 'TorBox' })
    // The service's size for the one file it plays counts, so the episode shows its speed.
    expect(viaOf(r, name, 1_007_000_000)).toEqual({ service: 'TorBox', bytes: 1_007_000_000 })
  })
  it('a direct link gets none', () => expect(viaOf(rows([{ url: 'https://cdn.example/f.mp4' }])[0], name)).toBeUndefined())
})
