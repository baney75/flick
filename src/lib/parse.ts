// Turn messy release file names into clean titles, years and episode numbers.

export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'ogv', '3gp']
export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'alac', 'aiff', 'aif', 'wma']
export const SUB_EXT = ['srt', 'vtt', 'ass', 'ssa']
export const BOOK_EXT = ['pdf', 'epub']
export const AUDIOBOOK_EXT = ['m4b']
export const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'avif']

/** What the player plays. Library items can also be books, which open in the reader, audiobooks and photos. */
export type Playable = 'video' | 'audio'
export type Kind = Playable | 'book' | 'audiobook' | 'photo'

export function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function kindOf(name: string): Playable | null {
  const e = ext(name)
  if (VIDEO_EXT.includes(e)) return 'video'
  if (AUDIO_EXT.includes(e)) return 'audio'
  return null
}

// Pictures that media folders hold for players (Kodi, Plex and Jellyfin posters, fan art, album covers),
// named alone ("poster.jpg", "backdrop2.jpg") or after the media ("Heat (1995)-fanart.jpg").
const ARTWORK = /^(?:.+-)?(?:poster|fanart|folder|cover|default|movie|show|cdart|banner|clearlogo|clearart|landscape|logo|thumb|backdrop|background|art|disc|discart|keyart|season\d*(?:-poster|-fanart|-banner|-landscape)?|season-all(?:-poster|-fanart|-banner)?)\d*$|^(?:front|back|albumart\w*)$/i

/** A file a phone or camera named (IMG_2005.MOV, PXL_20240601_1020.mp4, DSC_0042.JPG): its digits are a counter, not a year. */
export const isCameraName = (name: string) => /^(?:img|dsc[fn]?|pxl|vid|mvi|gopr|gh\d\d|dji|cimg|sam|wp)[_-]?\d/i.test(name.replace(/^.*[\\/]/, ''))

/** True for a poster, fan art or album cover file that players read next to media. */
export const isArtwork = (name: string) => ARTWORK.test(name.replace(/\.[^.]+$/, ''))

/** The library kind of a file: playable media, a book, an audiobook or a photo. */
export function itemKindOf(name: string): Kind | null {
  const e = ext(name)
  if (PHOTO_EXT.includes(e)) return isArtwork(name) ? null : 'photo'
  return AUDIOBOOK_EXT.includes(e) ? 'audiobook' : kindOf(name) ?? (BOOK_EXT.includes(e) ? 'book' : null)
}

/** Clamps a page number to the book. */
export const clampPage = (n: number, pages: number) => Math.min(Math.max(1, Math.round(n) || 1), Math.max(1, pages))

/** "Author - Title.epub" or "Title (2019).pdf" to a clean title, author and year. */
export function parseBook(name: string): { title: string; author?: string; year?: number } {
  let base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
  const y = base.match(/[([]((?:1[5-9]|20)\d\d)[)\]]/)
  if (y) base = base.replace(y[0], '').trim()
  const dash = base.split(/\s+-\s+/)
  const [author, title] = dash.length > 1 ? [dash[0].trim(), dash.slice(1).join(' - ').trim()] : [undefined, base]
  return { title: title || base, author, year: y ? Number(y[1]) : undefined }
}

export interface Parsed {
  title: string
  year?: number
  show?: string
  season?: number
  episode?: number
}

// Words that mark the end of the real title in a release name.
const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|dv|dolby ?vision|web-?dl|web-?rip|webrip|bluray|blu-ray|brrip|bdrip|dvdrip|hdtv|hdrip|remux|x26[45]|h\.?26[45]|hevc|avc|aac\d?(\.\d)?|ac3|eac3|ddp?\d?(\.\d)?|dts(-hd)?|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|imax|internal|limited|multi|subbed|dubbed|nf|amzn|dsnp|hmax|atvp)\b/i

function tidy(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s*[[(].*?[\])]\s*/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(s: string): string {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

export function parseName(fileName: string): Parsed {
  let base = fileName.replace(/\.[a-z0-9]{2,4}$/i, '')
  // Drop leading release-group tags like "[Group] ".
  base = base.replace(/^\s*\[[^\]]*\]\s*/, '')

  const ep =
    base.match(/^(.*?)[\s._-]*\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i) ||
    base.match(/^(.*?)[\s._-]*\b(\d{1,2})x(\d{2,3})\b/i)
  if (ep) {
    const show = titleCase(tidy(ep[1]).replace(/\s*\b(19|20)\d{2}\b\s*$/, ''))
    const season = Number(ep[2])
    const episode = Number(ep[3])
    // Text after the episode tag is often the episode title.
    const rest = base.slice(ep[0].length)
    const cut = rest.search(JUNK)
    const epTitle = tidy(cut >= 0 ? rest.slice(0, cut) : rest).replace(/^-\s*/, '')
    const title = epTitle && !/^\d+$/.test(epTitle) ? epTitle : `Episode ${episode}`
    return { title, show: show || undefined, season, episode }
  }

  // Cut at the first quality tag, then take the last year before it,
  // so "Blade Runner 2049 2017" keeps 2049 in the title.
  const cut = base.search(JUNK)
  const head = cut > 0 ? base.slice(0, cut) : base
  const yearMatch = head.match(/^(.*)[\s._(\[-]+((?:19|20)\d{2})(?:[\s._)\]-]|$)/)
  if (yearMatch && yearMatch[1].trim()) {
    return { title: titleCase(tidy(yearMatch[1])), year: Number(yearMatch[2]) }
  }
  return { title: titleCase(tidy(head)) || fileName }
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`
}
