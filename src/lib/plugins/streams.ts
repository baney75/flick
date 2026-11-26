// Sort a source's streams the way a viewer picks one: by picture quality, playable before
// external, the source's own order kept inside each group. Quality, HDR and size come from the
// stream's own fields first, then from its title, where Stremio addons put them.
import type { Stream } from './validate'

export const QUALITIES = ['4K', '1080p', '720p', 'SD', 'Other'] as const
export type Quality = (typeof QUALITIES)[number]

const RULES: [RegExp, Quality][] = [
  [/\b(2160p|4k|uhd)\b/i, '4K'],
  [/\b(1080p|1080i|fhd)\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b(576p|480p|360p|240p|sd|dvdrip|dvdscr)\b/i, 'SD'],
]

export function qualityOf(s: Pick<Stream, 'quality' | 'title'>): Quality {
  for (const text of [s.quality, s.title]) {
    if (!text) continue
    for (const [re, q] of RULES) if (re.test(text)) return q
  }
  return 'Other'
}

export function hdrOf(s: Pick<Stream, 'quality' | 'title'>): 'Dolby Vision' | 'HDR' | null {
  const text = `${s.quality ?? ''} ${s.title ?? ''}`
  if (/\b(dv|dovi|dolby ?vision)\b/i.test(text)) return 'Dolby Vision'
  if (/\bhdr(10\+?)?\b/i.test(text)) return 'HDR'
  return null
}

export function sizeOf(s: Pick<Stream, 'title'>): string | null {
  const m = s.title?.match(/(\d+(?:[.,]\d+)?)\s?(GB|MB|GiB|MiB)\b/i)
  return m ? `${m[1].replace(',', '.')} ${m[2].toUpperCase().replace('I', '')}` : null
}

export interface Section { quality: Quality; streams: Stream[] }

export function sections(list: Stream[]): Section[] {
  const by = new Map<Quality, Stream[]>(QUALITIES.map((q) => [q, []]))
  for (const s of list) by.get(qualityOf(s))!.push(s)
  return QUALITIES.map((q) => ({ quality: q, streams: [...by.get(q)!.filter((s) => !s.external), ...by.get(q)!.filter((s) => s.external)] }))
    .filter((x) => x.streams.length)
}

/** The stream "Play" starts: the best quality that plays inside Flick, or null when every one is external. */
export function best(list: Stream[]): Stream | null {
  for (const x of sections(list)) { const s = x.streams.find((s) => !s.external); if (s) return s }
  return null
}
