// Picks what Play starts: one ranker for every source of a title (downloads, this device, the
// user's servers, plugin streams, debrid and torrents), by the user's language and quality
// preferences and this device. Pure: no DOM, no network, no signals. Spec: SPEC-best-stream.md.

import { langCode, parseRelease, type Codec, type Release } from './release'

export type MaxQuality = '4K' | '1080p' | '720p' | 'SD'
export const MAX_QUALITIES: MaxQuality[] = ['4K', '1080p', '720p', 'SD']

export interface Candidate {
  /** srcKey, or `${srcKey}#${stream index}` for a plugin stream. */
  id: string
  media: 'video' | 'audio' | 'audiobook' | 'book'
  /** Downloaded copy, this device, the user's own server, or a plugin. */
  place: 'download' | 'device' | 'server' | 'plugin'
  /** How the bytes arrive. */
  via: 'direct' | 'debrid-cached' | 'debrid-fetch' | 'p2p'
  /** The debrid plugin id when via is debrid-*. */
  service?: string
  /** That service's manifest flag (SPEC-debrid rule 9). */
  vpnOptional?: boolean
  external?: boolean
  needsDesktop?: boolean
  /** Title, quality and group text the parser reads. */
  text: string
  quality?: string
  subs?: { lang: string }[]
  sizeBytes?: number
  durSec?: number
  /** File extension or MIME, for books and audio. */
  format?: string
  /** The book's language when the source gives one. */
  lang?: string
  /** A show episode, for the size sanity check. */
  episode?: boolean
  /** Newest progress record on this exact source, ms epoch. */
  progressAt?: number
  /** The source's own order, the last tie-break. */
  order: number
}

export interface Prefs { audio: string[]; subs: string[]; maxQuality: MaxQuality }

export interface Device {
  maxQuality: MaxQuality
  hdr: boolean
  /** true plays, false cannot, undefined unknown. */
  codecs: Partial<Record<Codec, boolean>>
  /** The desktop app (not the phone app), which converts what the web view cannot play. */
  desktop: boolean
  phone: boolean
}

export interface PickCtx {
  /** The VPN gate passes now (SPEC-torrent rule 25). The web and phone builds pass false. */
  gate: boolean
  /** Why this platform has no built-in torrent engine (web, phones, Windows); undefined when it has one. */
  noEngine?: string
  /** Why this platform has no VPN gate at all (web, phones); undefined where there is one. */
  noGate?: string
  /** Settings > Streaming services: "Require a VPN for debrid services too". */
  vpnForDebrid: boolean
  online: boolean
  /** Newest of the last speed test and the player's observed speed. */
  mbps?: number
  /** The source the user picked by hand last time for this title (pickedFor). */
  picked?: string
}

export interface Ranked {
  c: Candidate
  rel: Release
  /** Why it is never auto-picked; undefined when it plays. */
  blocked?: string
  /** The subtitle language the player turns on, when the audio is not one the user listed. */
  sub?: string
  /** The audio language the line names, or 'multi'. */
  lang?: string
}

export const VPN_P2P = 'Turn on your VPN to play torrents'
export const VPN_DEBRID = 'Turn on your VPN'
const CODEC_NAME: Record<Codec, string> = { hevc: 'HEVC', av1: 'AV1', h264: 'H.264' }

/**
 * Whether playing it must pass the VPN gate: peers always; a debrid service unless it declares
 * vpnOptional and the "Require a VPN for debrid services too" switch is off. Direct never does.
 */
export function needsGate(c: Pick<Candidate, 'via' | 'vpnOptional'>, vpnForDebrid: boolean): boolean {
  if (c.via === 'p2p') return true
  if (c.via === 'debrid-cached' || c.via === 'debrid-fetch') return !(c.vpnOptional && !vpnForDebrid)
  return false
}

function blockedBy(c: Candidate, rel: Release, dev: Device, ctx: PickCtx): string | undefined {
  if (!ctx.online && c.place !== 'download' && c.place !== 'device') return 'Offline'
  if (c.external) return 'Opens outside Flick'
  if (c.needsDesktop && !dev.desktop) return 'Needs the desktop app'
  if (c.via === 'p2p') {
    if (ctx.noEngine) return ctx.noEngine
    if (!ctx.gate) return VPN_P2P
  }
  if (c.via !== 'p2p' && needsGate(c, ctx.vpnForDebrid) && !ctx.gate) return ctx.noGate ?? VPN_DEBRID
  if (rel.codec && dev.codecs[rel.codec] === false && !dev.desktop) return `This device can't play ${CODEC_NAME[rel.codec]}`
  return undefined
}

const isText = (c: Candidate) => c.media === 'book' || c.media === 'audiobook'

/** The audio languages of a candidate: the release name's, or for a book the language its source gives. */
function audioOf(c: Candidate, rel: Release): string[] {
  const own = langCode(c.lang)
  return own ? [own] : rel.audio
}

function subsOf(c: Candidate, rel: Release): string[] {
  return [...new Set([...(c.subs ?? []).map((s) => langCode(s.lang)).filter((l): l is string => !!l), ...rel.subs])]
}

/** Rule 6.2: the listed rank, multi 0; unknown after every listed one; not listed with a wanted subtitle next; not listed last. */
function langRank(audio: string[], subs: string[], prefs: Prefs): number {
  const n = prefs.audio.length
  if (audio.includes('multi')) return 0
  if (!audio.length) return n
  const listed = audio.map((l) => prefs.audio.indexOf(l)).filter((i) => i >= 0)
  if (listed.length) return Math.min(...listed)
  return subs.some((s) => prefs.subs.includes(s)) ? n + 1 : n + 2
}

const LADDER = MAX_QUALITIES as string[]
/** Rule 6.3: the target first, then lower from highest down, then higher from lowest up, then Other. */
function qualityRank(q: string, target: MaxQuality): number {
  const i = LADDER.indexOf(q), t = LADDER.indexOf(target)
  if (i < 0) return 100
  return i >= t ? i - t : 10 + (t - i)
}

function hdrRank(rel: Release, dev: Device): number {
  if (dev.hdr) return rel.hdr || rel.dv ? 0 : 1
  if (rel.dv && !rel.hdr) return 2
  return rel.hdr ? 1 : 0
}

const DELIVERY = ['download', 'device', 'server', 'debrid-cached', 'direct', 'debrid-fetch', 'p2p']
const delivery = (c: Candidate) => DELIVERY.indexOf(c.place === 'plugin' ? c.via : c.place)

const ext = (c: Candidate) => (c.format ?? '').toLowerCase().replace(/^.*[./]/, '').replace(/^epub\+zip$/, 'epub')

/** Rule 6.10 for books and audiobooks: format by device, then abridgement, one file, bitrate. */
function fitOf(c: Candidate, rel: Release): number[] {
  if (c.media === 'book') {
    // Rule 6.10 gives the phone and the desktop the same order: EPUB, PDF, then the rest.
    const i = ['epub', 'pdf'].indexOf(ext(c))
    return [i < 0 ? 2 : i, 0, 0]
  }
  if (c.media === 'audiobook') {
    const ab = rel.abridged === false ? 0 : rel.abridged === undefined ? 1 : 2
    const one = ['m4b', 'mp4', 'audio/mp4', 'x-m4b'].includes(ext(c)) ? 0 : 1
    return [ab, one, -(rel.kbps ?? 0)]
  }
  return [0, 0, 0]
}

function scoreOf(c: Candidate, rel: Release, prefs: Prefs, dev: Device, ctx: PickCtx): number[] {
  const video = c.media === 'video'
  const target = LADDER[Math.max(LADDER.indexOf(prefs.maxQuality), LADDER.indexOf(dev.maxQuality))] as MaxQuality
  const bytes = c.sizeBytes ?? rel.bytes
  // Only what comes over the network; a file on this device plays at any bitrate.
  const remote = c.place !== 'download' && c.place !== 'device'
  const overBandwidth = (video || c.media === 'audio') && remote && bytes && c.durSec && ctx.mbps
    ? Number((bytes * 8) / c.durSec > ctx.mbps * 1e6 * 0.8) : 0
  const codec = rel.codec && rel.codec !== 'h264' && dev.codecs[rel.codec] === true ? 0 : 1
  const swarm = c.via === 'p2p' || c.via === 'debrid-fetch'
  const seedGroup = !swarm ? 0 : rel.seeders === undefined ? 1 : rel.seeders < 3 ? 2 : 0
  const small = video && bytes !== undefined && (c.episode ? bytes < 150e6 : (rel.quality === '1080p' || rel.quality === '4K') && bytes < 700e6)
  return [
    Number(rel.bad),
    langRank(audioOf(c, rel), subsOf(c, rel), prefs),
    video ? qualityRank(rel.quality, target) : 0,
    overBandwidth,
    video ? hdrRank(rel, dev) : 0,
    // Books and audiobooks: the right format and edition matter more than where the file is.
    ...fitOf(c, rel),
    delivery(c),
    video ? codec : 0,
    seedGroup,
    swarm ? -(rel.seeders ?? 0) : 0,
    Number(small),
    c.order,
  ]
}

const cmp = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

/** Rule 5: the hand pick, then a book's newest progress, then a download, the first that plays. */
function stickyOf(list: Ranked[], ctx: PickCtx): Ranked | undefined {
  const ok = list.filter((r) => !r.blocked)
  const hand = ok.find((r) => r.c.id === ctx.picked)
  if (hand) return hand
  // The newest progress on a copy that plays: a blocked copy's place is no use right now.
  const read = ok.filter((r) => isText(r.c) && r.c.progressAt !== undefined)
    .sort((a, b) => b.c.progressAt! - a.c.progressAt!)[0]
  if (read) return read
  return ok.find((r) => r.c.place === 'download')
}

/**
 * Rule 9 once the player has every track: the subtitle the ranker chose, or, when the audio is not
 * one of the user's languages, the first subtitle language of theirs among the tracks fetched later.
 */
export function subLangFor(r: Ranked | undefined, prefs: Prefs, have: string[]): string | undefined {
  if (!r) return undefined
  if (r.sub) return r.sub
  if (r.lang === 'multi' || (r.lang && prefs.audio.includes(r.lang))) return undefined
  return prefs.subs.find((p) => have.includes(p))
}

/** Every candidate, best first: the ones that play in score order, then the blocked ones in score order. */
export function rank(cands: Candidate[], prefs: Prefs, dev: Device, ctx: PickCtx): Ranked[] {
  const rows = cands.map((c) => {
    const rel = parseRelease(c.text, c.quality)
    const r: Ranked = { c, rel }
    const blocked = blockedBy(c, rel, dev, ctx)
    if (blocked) r.blocked = blocked
    const audio = audioOf(c, rel)
    const lang = audio.includes('multi') ? 'multi' : audio.find((l) => prefs.audio.includes(l)) ?? audio[0]
    if (lang) r.lang = lang
    if (!audio.includes('multi') && !audio.some((l) => prefs.audio.includes(l))) {
      const have = subsOf(c, rel)
      const sub = prefs.subs.find((s) => have.includes(s))
      if (sub) r.sub = sub
    }
    return { r, score: scoreOf(c, rel, prefs, dev, ctx) }
  })
  rows.sort((a, b) => Number(!!a.r.blocked) - Number(!!b.r.blocked) || cmp(a.score, b.score))
  const out = rows.map((x) => x.r)
  const top = stickyOf(out, ctx)
  return top ? [top, ...out.filter((r) => r !== top)] : out
}

/** The candidate Play starts, or null when every one is blocked. */
export function pick(cands: Candidate[], prefs: Prefs, dev: Device, ctx: PickCtx): Ranked | null {
  const top = rank(cands, prefs, dev, ctx)[0]
  return top && !top.blocked ? top : null
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', hi: 'Hindi', multi: 'Multi audio',
}
export function langName(code: string): string {
  if (LANG_NAMES[code]) return LANG_NAMES[code]
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code }
}

/** Rule 10: the pick in one line, "1080p · English · TorBox instant", "Your server · EPUB", "Downloaded". */
export function pickLine(r: Ranked, serviceName: (id: string) => string = (id) => id): string {
  const { c, rel } = r
  if (c.place === 'download') return 'Downloaded'
  const where = c.place === 'device' ? 'This device' : c.place === 'server' ? 'Your server'
    : c.via === 'debrid-cached' ? `${serviceName(c.service ?? '')} instant`
      : c.via === 'debrid-fetch' ? `${serviceName(c.service ?? '')} fetches it first`
        : c.via === 'p2p' ? 'Torrent' : ''
  if (isText(c)) return [where, ext(c).toUpperCase()].filter(Boolean).join(' · ')
  const parts = [c.media === 'video' && rel.quality !== 'Other' ? rel.quality : '', r.lang ? langName(r.lang) : '', where]
  return parts.filter(Boolean).join(' · ')
}
