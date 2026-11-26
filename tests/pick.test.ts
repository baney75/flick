import { describe, expect, it } from 'vitest'
import { pick, pickLine, rank, subLangFor, VPN_DEBRID, VPN_P2P, type Candidate, type Device, type PickCtx, type Prefs, type Ranked } from '../src/lib/pick'
import { parseRelease } from '../src/lib/release'

let n = 0
const c = (text: string, more: Partial<Candidate> = {}): Candidate =>
  ({ id: text, media: 'video', place: 'plugin', via: 'direct', text, order: n++, ...more })
const prefs = (more: Partial<Prefs> = {}): Prefs => ({ audio: ['en'], subs: [], maxQuality: '4K', ...more })
const dev = (more: Partial<Device> = {}): Device => ({ maxQuality: '4K', hdr: false, codecs: {}, desktop: true, phone: false, ...more })
const ctx = (more: Partial<PickCtx> = {}): PickCtx => ({ gate: true, vpnForDebrid: false, online: true, ...more })
const WEB = 'Torrents play in the Flick desktop app with a VPN on.'

const top = (cs: Candidate[], p = prefs(), d = dev(), x = ctx()) => pick(cs, p, d, x)?.c.id ?? null
const order = (cs: Candidate[], p = prefs(), d = dev(), x = ctx()) => rank(cs, p, d, x).map((r) => r.c.id)
const row = (cs: Candidate[], id: string, p = prefs(), d = dev(), x = ctx()) => rank(cs, p, d, x).find((r) => r.c.id === id)!

describe('language', () => {
  it('a listed language beats a higher quality in another', () =>
    expect(top([c('1080p 🇫🇷'), c('720p 🇬🇧')])).toBe('720p 🇬🇧'))
  it('follows the order of the list', () =>
    expect(top([c('1080p ENG'), c('1080p Latino')], prefs({ audio: ['es', 'en'] }))).toBe('1080p Latino'))
  it('MULTI ties with the first language; order decides', () => {
    expect(top([c('1080p MULTI'), c('1080p 🇬🇧')])).toBe('1080p MULTI')
    expect(top([c('1080p 🇬🇧'), c('1080p MULTI')])).toBe('1080p 🇬🇧')
  })
  it('unknown after listed, before not listed; not listed with a wanted subtitle between', () => {
    const cs = [c('1080p 🇫🇷'), c('1080p 🇯🇵', { subs: [{ lang: 'eng' }] }), c('1080p'), c('1080p 🇬🇧')]
    expect(order(cs, prefs({ subs: ['en'] }))).toEqual(['1080p 🇬🇧', '1080p', '1080p 🇯🇵', '1080p 🇫🇷'])
  })
  it('VOSTFR is unknown audio with French subtitles', () => {
    const r = row([c('1080p VOSTFR')], '1080p VOSTFR', prefs({ subs: ['fr'] }))
    expect(r.rel).toMatchObject({ audio: [], subs: ['fr'] })
    expect(r.sub).toBe('fr')
  })
  it('turns on a wanted subtitle when the audio is not listed', () => {
    const cs = [c('1080p 🇯🇵', { subs: [{ lang: 'en' }] })]
    const r = pick(cs, prefs({ subs: ['en'] }), dev(), ctx())!
    expect(r.c.id).toBe('1080p 🇯🇵')
    expect(r.sub).toBe('en')
    expect(pick([c('1080p 🇬🇧', { subs: [{ lang: 'en' }] })], prefs({ subs: ['en'] }), dev(), ctx())!.sub).toBeUndefined()
  })
})

describe('quality', () => {
  it('the device caps the target', () => expect(top([c('4K'), c('1080p'), c('720p')], prefs(), dev({ maxQuality: '1080p' }))).toBe('1080p'))
  it('best available under the target', () => expect(top([c('720p'), c('1080p')])).toBe('1080p'))
  it('lower before higher', () => expect(top([c('4K'), c('720p')], prefs(), dev({ maxQuality: '1080p' }))).toBe('720p'))
  it('data saver picks SD', () => expect(top([c('1080p'), c('480p')], prefs({ maxQuality: 'SD' }))).toBe('480p'))
  it('full ladder for a 1080p target', () =>
    expect(order([c('Other stream'), c('4K'), c('SD 480p'), c('1080p'), c('720p')], prefs(), dev({ maxQuality: '1080p' })))
      .toEqual(['1080p', '720p', 'SD 480p', '4K', 'Other stream']))
})

describe('bandwidth', () => {
  const big = c('1080p 4.0 GB', { durSec: 7200 }), small = c('1080p 1.5 GB', { durSec: 7200 })
  it('a bitrate over 80% of the speed ranks after one that fits', () => expect(top([big, small], prefs(), dev(), ctx({ mbps: 5 }))).toBe(small.id))
  it('ignored with no speed known', () => expect(top([big, small])).toBe(big.id))
  it('a big file on this device is never over the bandwidth', () =>
    expect(top([c('srv 1080p 1.5 GB', { place: 'server', durSec: 7200 }), c('dev 1080p 4.0 GB', { place: 'device', durSec: 7200 })], prefs(), dev(), ctx({ mbps: 5 }))).toBe('dev 1080p 4.0 GB'))
})

describe('HDR', () => {
  it('SDR display prefers SDR', () => expect(top([c('4K HDR'), c('4K')])).toBe('4K'))
  it('HDR display prefers HDR', () => expect(top([c('4K'), c('4K HDR')], prefs(), dev({ hdr: true }))).toBe('4K HDR'))
  it('SDR display puts Dolby Vision with no HDR10 last', () => expect(top([c('4K DV'), c('4K HDR')])).toBe('4K HDR'))
})

describe('sources and delivery', () => {
  it('a bad source loses to a lower quality', () => expect(top([c('1080p HDCAM'), c('720p WEB-DL')])).toBe('720p WEB-DL'))
  it('own server, then debrid cached, then P2P', () => {
    const cs = [c('p2p 1080p', { via: 'p2p' }), c('tb 1080p', { via: 'debrid-cached', service: 'app.torbox' }), c('srv 1080p', { place: 'server' })]
    expect(order(cs)).toEqual(['srv 1080p', 'tb 1080p', 'p2p 1080p'])
  })
  it('cached before uncached', () =>
    expect(top([c('a 1080p', { via: 'debrid-fetch' }), c('b 1080p', { via: 'debrid-cached' })])).toBe('b 1080p'))
  it('more seeders first, under 3 last', () => {
    expect(top([c('1080p 👤 2', { via: 'p2p' }), c('1080p 👤 40', { via: 'p2p' })])).toBe('1080p 👤 40')
    expect(order([c('x 1080p 👤 1', { via: 'p2p' }), c('y 1080p', { via: 'p2p' }), c('z 1080p 👤 5', { via: 'p2p' })]))
      .toEqual(['z 1080p 👤 5', 'y 1080p', 'x 1080p 👤 1'])
  })
  it('a 1080p movie under 700 MB goes last', () => expect(top([c('1080p 400 MB'), c('1080p 2 GB')])).toBe('1080p 2 GB'))
  it('an episode under 150 MB goes last; 400 MB is fine', () => {
    expect(top([c('720p 100 MB', { episode: true }), c('720p 400 MB', { episode: true })])).toBe('720p 400 MB')
    expect(top([c('1080p 400 MB', { episode: true }), c('1080p 2 GB', { episode: true })])).toBe('1080p 400 MB')
  })
})

describe('VPN gate and platform', () => {
  const tb = (more: Partial<Candidate> = {}) => c('tb 1080p', { via: 'debrid-cached', service: 'app.torbox', vpnOptional: true, ...more })
  it('vpnOptional debrid plays with the gate failing and the switch off', () => expect(top([tb()], prefs(), dev(), ctx({ gate: false }))).toBe('tb 1080p'))
  it('the switch on blocks it; nothing plays and the reason is the VPN', () => {
    const x = ctx({ gate: false, vpnForDebrid: true })
    const cs = [c('p2p 1080p', { via: 'p2p' }), tb()]
    expect(pick(cs, prefs(), dev(), x)).toBeNull()
    expect(rank(cs, prefs(), dev(), x)[0].blocked).toBe(VPN_DEBRID)
  })
  it('a service without vpnOptional needs the gate', () =>
    expect(row([tb({ vpnOptional: undefined })], 'tb 1080p', prefs(), dev(), ctx({ gate: false })).blocked).toBe(VPN_DEBRID))
  it('P2P is blocked with the gate failing; https plays', () => {
    const cs = [c('p2p 4K', { via: 'p2p' }), c('https 720p')]
    expect(top(cs, prefs(), dev(), ctx({ gate: false }))).toBe('https 720p')
    expect(row(cs, 'p2p 4K', prefs(), dev(), ctx({ gate: false })).blocked).toBe(VPN_P2P)
  })
  it('the web app has no engine: the platform message', () => {
    const cs = [c('p2p 1080p', { via: 'p2p' })]
    const x = ctx({ gate: false, noEngine: WEB })
    expect(pick(cs, prefs(), dev({ desktop: false }), x)).toBeNull()
    expect(rank(cs, prefs(), dev({ desktop: false }), x)[0].blocked).toBe(WEB)
  })
  it('HEVC the web app cannot decode is blocked; the desktop app converts', () => {
    const cs = [c('1080p x265')]
    const d = { codecs: { hevc: false } }
    expect(rank(cs, prefs(), dev({ ...d, desktop: false }), ctx())[0].blocked).toBe("This device can't play HEVC")
    expect(top(cs, prefs(), dev(d))).toBe('1080p x265')
  })
  it('a phone that decodes HEVC prefers it', () =>
    expect(top([c('1080p x264'), c('1080p x265')], prefs(), dev({ desktop: false, phone: true, codecs: { hevc: true } }))).toBe('1080p x265'))
  it('unknown codec support keeps the source order', () => expect(top([c('1080p x264'), c('1080p x265')])).toBe('1080p x264'))
  it('external and desktop-only', () => {
    const cs = [c('ext', { external: true }), c('mkv', { needsDesktop: true })]
    const rs = rank(cs, prefs(), dev({ desktop: false }), ctx())
    expect(rs.map((r) => r.blocked)).toEqual(['Opens outside Flick', 'Needs the desktop app'])
  })
  it('a book torrent with the gate failing is blocked; a book from the own server plays', () => {
    const book = { media: 'book' as const, format: 'epub' }
    expect(row([c('bk', { ...book, via: 'p2p' })], 'bk', prefs(), dev(), ctx({ gate: false })).blocked).toBe(VPN_P2P)
    expect(top([c('calibre', { ...book, place: 'server' })], prefs(), dev(), ctx({ gate: false }))).toBe('calibre')
  })
})

describe('stickiness', () => {
  const dl = c('dl 1080p', { place: 'download' }), srv = c('srv 1080p', { place: 'server' })
  it('offline: the download plays, the server is greyed Offline', () => {
    const rs = rank([srv, dl], prefs(), dev(), ctx({ online: false }))
    expect(rs.map((r) => [r.c.id, r.blocked])).toEqual([['dl 1080p', undefined], ['srv 1080p', 'Offline']])
  })
  it('the hand pick wins over a download', () => expect(top([dl, srv], prefs(), dev(), ctx({ picked: srv.id }))).toBe(srv.id))
  it('a blocked hand pick falls through to the download', () => expect(top([dl, srv], prefs(), dev(), ctx({ picked: srv.id, online: false }))).toBe(dl.id))
  it('a download wins over a better-scored stream', () => expect(top([c('4K 🇬🇧'), c('720p', { place: 'download' })])).toBe('720p'))
  it('an audiobook keeps the copy with the newest progress', () => {
    const abs = c('abs', { media: 'audiobook', place: 'server', format: 'mp3', progressAt: 2000 })
    const pl = c('pl', { media: 'audiobook', format: 'm4b', progressAt: 1000 })
    expect(top([pl, abs])).toBe('abs')
    expect(top([pl, c('abs2', { media: 'audiobook', place: 'server', format: 'mp3' })])).toBe('pl')
  })
  it('newest progress on a blocked copy falls back to the newest one that plays', () => {
    const p2p = c('p2p', { media: 'audiobook', via: 'p2p', format: 'm4b', progressAt: 3000 })
    const srv = c('srv', { media: 'audiobook', place: 'server', format: 'mp3', progressAt: 2000 })
    expect(top([c('m4b', { media: 'audiobook', format: 'm4b' }), p2p, srv], prefs(), dev(), ctx({ gate: false }))).toBe('srv')
  })
})

describe('books and audiobooks', () => {
  const ab = (text: string, format: string) => c(text, { media: 'audiobook', format })
  it('unabridged before abridged', () => expect(top([ab('Abridged', 'm4b'), ab('Unabridged parts', 'mp3')])).toBe('Unabridged parts'))
  it('one m4b before many parts', () => expect(top([ab('Unabridged a', 'mp3'), ab('Unabridged b', 'm4b')])).toBe('Unabridged b'))
  it('higher bitrate first', () => expect(top([ab('Unabridged 64 kbps', 'm4b'), ab('Unabridged 128 kbps', 'm4b')])).toBe('Unabridged 128 kbps'))
  it('a phone takes the plugin EPUB over the server PDF', () => {
    const cs = [c('pdf', { media: 'book', place: 'server', format: 'pdf' }), c('epub', { media: 'book', format: 'application/epub+zip' })]
    expect(top(cs, prefs(), dev({ desktop: false, phone: true }))).toBe('epub')
  })
  it('a book in a listed language before one in another', () => {
    const cs = [c('fr', { media: 'book', format: 'epub', lang: 'fr' }), c('en', { media: 'book', format: 'epub', lang: 'eng' })]
    expect(top(cs)).toBe('en')
  })
})

describe('pick line', () => {
  const line = (x: Candidate, p = prefs()) => pickLine(rank([x], p, dev(), ctx())[0], (id) => (id === 'app.torbox' ? 'TorBox' : id))
  it.each([
    [c('1080p 🇬🇧', { via: 'debrid-cached', service: 'app.torbox' }), '1080p · English · TorBox instant'],
    [c('Book', { media: 'book', place: 'server', format: 'epub' }), 'Your server · EPUB'],
    [c('1080p 🇬🇧', { place: 'download' }), 'Downloaded'],
    [c('720p English'), '720p · English'],
    [c('1080p', { via: 'debrid-fetch', service: 'app.torbox' }), '1080p · TorBox fetches it first'],
    [c('Movie 4K', { place: 'device' }), '4K · This device'],
  ])('%#: %s', (x, want) => expect(line(x)).toBe(want))
})

describe('subtitles the plugin fetches later (rule 9)', () => {
  const prefs = { audio: ['en'], subs: ['fr', 'en'], maxQuality: '4K' as const }
  const row = (more: Partial<Ranked>): Ranked => ({ c: { id: 'k#0', media: 'video', place: 'plugin', via: 'direct', text: '', order: 0 }, rel: parseRelease(''), ...more })
  it('Japanese audio, tracks only from subtitles(): the first of the user\'s subtitle languages there', () =>
    expect(subLangFor(row({ lang: 'ja' }), prefs, ['de', 'en'])).toBe('en'))
  it('unknown audio counts as not theirs', () => expect(subLangFor(row({}), prefs, ['fr'])).toBe('fr'))
  it('the ranker\'s choice wins', () => expect(subLangFor(row({ lang: 'ja', sub: 'fr' }), prefs, ['en'])).toBe('fr'))
  it('their own audio or MULTI turns none on', () => {
    expect(subLangFor(row({ lang: 'en' }), prefs, ['fr'])).toBeUndefined()
    expect(subLangFor(row({ lang: 'multi' }), prefs, ['fr'])).toBeUndefined()
  })
  it('no row, no subtitle', () => expect(subLangFor(undefined, prefs, ['fr'])).toBeUndefined())
})
