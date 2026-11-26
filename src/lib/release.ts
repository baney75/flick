// Reads what a release name says about itself: audio language, subtitles, codec, a bad source
// (CAM and the like), seeders, size, and for audiobooks abridgement and bitrate. Pure: the ranker in
// pick.ts reads only this. Quality and HDR come from qualityOf and hdrOf in plugins/streams.ts.

import { hdrOf, qualityOf, type Quality } from './plugins/streams'

export type Codec = 'hevc' | 'av1' | 'h264'

export interface Release {
  /** ISO 639-1 audio languages, plus 'multi' for Dual Audio or MULTI. Empty: unknown. */
  audio: string[]
  /** Subtitle languages the name says it carries (VOSTFR, SUBFRENCH). */
  subs: string[]
  codec: Codec | null
  quality: Quality
  hdr: boolean
  dv: boolean
  /** CAM, TS, telecine or screener: a copy filmed or leaked from a cinema. */
  bad: boolean
  seeders?: number
  bytes?: number
  /** true abridged, false unabridged, undefined when the name says neither. */
  abridged?: boolean
  kbps?: number
}

// Flags are two regional indicator letters; Flick reads the country, then its language.
const FLAGS: Record<string, string> = {
  GB: 'en', US: 'en', FR: 'fr', ES: 'es', MX: 'es', DE: 'de', IT: 'it', PT: 'pt', BR: 'pt',
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', RU: 'ru', IN: 'hi',
}

const WORDS: [string, string][] = [
  ['english|eng', 'en'], ['french|fre|vff|truefrench', 'fr'], ['spanish|esp|latino', 'es'],
  ['german|ger', 'de'], ['italian|ita', 'it'], ['portuguese', 'pt'], ['japanese|jap', 'ja'],
  ['korean', 'ko'], ['hindi', 'hi'], ['russian|rus', 'ru'],
]

// A word is bounded by anything but a letter or digit, so "Movie.FRENCH.1080p" and "Movie_ITA" both read.
const word = (alts: string, flags = 'i') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, `u${flags}`)
const WORD_RES = WORDS.map(([alts, code]) => [word(alts), code] as const)
const MULTI = word('dual[ .-]?audio|multi')
const SUBS_FR = word('vostfr|subfrench')
// Short tokens only in capitals, so a ".ts" file or the film "Cam" is not a bad source.
const BAD = [word('CAM|TS|TC|SCR', ''), word('hdcam|hdts|telesync|telecine|screener')]

const ISO2: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', hin: 'hi', ara: 'ar', dut: 'nl', nld: 'nl', pol: 'pl',
  tur: 'tr', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', gre: 'el', ell: 'el', heb: 'he', hun: 'hu',
  cze: 'cs', ces: 'cs', rum: 'ro', ron: 'ro', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id',
}
const NAMES: Record<string, string> = Object.fromEntries(
  WORDS.map(([alts, code]) => [alts.split('|')[0], code]).concat([['chinese', 'zh']]),
)

/** One language tag (en-US, eng, English, fr) as its ISO 639-1 base code, or null. */
export function langCode(x: string | undefined): string | null {
  const s = (x ?? '').trim().toLowerCase()
  if (!s || s === 'und') return null
  const base = s.split(/[-_]/)[0]
  if (/^[a-z]{2}$/.test(base)) return base
  return ISO2[base] ?? NAMES[base] ?? null
}

function flagLangs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)) {
    const cc = String.fromCharCode(m[1].codePointAt(0)! - 0x1f1e6 + 65, m[2].codePointAt(0)! - 0x1f1e6 + 65)
    if (FLAGS[cc]) out.push(FLAGS[cc])
  }
  return out
}

const UNITS: Record<string, number> = { gb: 1e9, mb: 1e6, gib: 2 ** 30, mib: 2 ** 20 }
/** The size in the text in bytes: "2.14 GB", "700MB", "1,5 GiB". */
export function bytesOf(text: string): number | undefined {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s?(GB|MB|GiB|MiB)(?![\p{L}\p{N}])/iu)
  return m ? Math.round(parseFloat(m[1].replace(',', '.')) * UNITS[m[2].toLowerCase()]) : undefined
}

export function codecOf(text: string): Codec | null {
  if (word('x265|hevc|h\\.?265').test(text)) return 'hevc'
  if (word('av1').test(text)) return 'av1'
  if (word('x264|h\\.?264|avc').test(text)) return 'h264'
  return null
}

export function parseRelease(text: string, quality?: string): Release {
  const audio = new Set<string>()
  // VOSTFR and SUBFRENCH name French subtitles; read them out first so their letters are not audio.
  const subs = SUBS_FR.test(text) ? ['fr'] : []
  const rest = text.replace(new RegExp(SUBS_FR.source, 'giu'), ' ')
  if (MULTI.test(rest)) audio.add('multi')
  for (const l of flagLangs(rest)) audio.add(l)
  for (const [re, code] of WORD_RES) if (re.test(rest)) audio.add(code)
  const r: Release = {
    audio: [...audio],
    subs,
    codec: codecOf(text),
    quality: qualityOf({ quality, title: text }),
    hdr: word('hdr(?:10\\+?)?').test(`${quality ?? ''} ${text}`),
    dv: hdrOf({ quality, title: text }) === 'Dolby Vision',
    bad: BAD.some((re) => re.test(text)),
  }
  const seed = text.match(/(?:👤\s*|(?<![\p{L}\p{N}])(?:Seeders|S):\s*)(\d+)/u)
  if (seed) r.seeders = parseInt(seed[1], 10)
  const bytes = bytesOf(text)
  if (bytes !== undefined) r.bytes = bytes
  if (word('unabridged').test(text)) r.abridged = false
  else if (word('abridged').test(text)) r.abridged = true
  const kbps = text.match(/(\d+) ?kbps/i)
  if (kbps) r.kbps = parseInt(kbps[1], 10)
  return r
}
