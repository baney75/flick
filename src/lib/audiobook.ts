// Audiobooks: folders of parts that make one book, MP4 chapter lists and covers, the sleep timer, and speed per book.

import * as db from './db'
import { hash, type Item } from './library'
import { parseBook } from './parse'

// ---- one book from a folder of parts ----

const SHELF = /^audio ?books?$/i
const DISC = /^(cd|dis[ck]|part)\s*\d+$/i

/** For a file under an "Audiobooks" folder: the book's folder, title and author. "Audiobooks/Author/Title/01.mp3",
 *  "Audiobooks/Author - Title/01.mp3" and disc folders ("Title/CD 2/01.mp3") all name one book. */
export function bookOf(path: string): { dir: string; title: string; author?: string } | null {
  const segs = path.split(/[\\/]/).slice(0, -1)
  const at = segs.findIndex((s) => SHELF.test(s.trim()))
  let end = segs.length
  if (end - 1 > at + 1 && DISC.test(segs[end - 1].trim())) end--
  if (at < 0 || end <= at + 1) return null
  const rest = segs.slice(at + 1, end)
  const named = parseBook(rest[rest.length - 1])
  return { dir: segs.slice(0, end).join('/'), title: named.title, author: rest.length > 1 ? rest[0] : named.author }
}

/** Natural order, so "2.mp3" comes before "10.mp3". */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** Turns audio files under an "Audiobooks" folder into one audiobook item per book folder, each file a part. */
export function groupAudiobooks(list: Item[], pathOf: (it: Item) => string): Item[] {
  const books = new Map<string, { b: NonNullable<ReturnType<typeof bookOf>>; parts: [string, Item][] }>()
  const out: Item[] = []
  for (const it of list) {
    const p = pathOf(it)
    const b = it.kind === 'audio' ? bookOf(p) : null
    if (!b) { out.push(it); continue }
    if (!books.has(b.dir)) books.set(b.dir, { b, parts: [] })
    books.get(b.dir)!.parts.push([p, it])
  }
  for (const [dir, { b, parts }] of books) {
    parts.sort((x, y) => natural(x[0], y[0]))
    const first = parts[0][1]
    out.push({
      ...first, id: hash(`audiobook:${first.server ?? ''}:${dir}`), kind: 'audiobook', title: b.title, author: b.author,
      show: undefined, season: undefined, episode: undefined, year: undefined, duration: undefined,
      size: parts.reduce((n, [, x]) => n + x.size, 0), mtime: Math.max(...parts.map(([, x]) => x.mtime)),
      parts: parts.map(([p, x]) => ({ src: x.src, title: p.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '') })),
    })
  }
  return out
}

// ---- chapters and cover inside an MP4 / M4B ----

export interface Chapter { title: string; start: number }

/** What a file is from its first bytes, since a server or session source often has no usable name. */
export function sniff(head: Uint8Array): 'mp4' | 'id3' | null {
  const s = String.fromCharCode(...head.subarray(0, 12))
  return s.slice(4, 8) === 'ftyp' ? 'mp4' : s.startsWith('ID3') ? 'id3' : null
}

/** The book's chapter list: each part's own chapters (from the file) moved to where the part starts, or
 *  one chapter named for the part when the file has none. */
export function bookChapters(parts: { title: string; dur: number }[], inner: Chapter[][]): Chapter[] {
  const out: Chapter[] = []
  let at = 0
  parts.forEach((p, i) => {
    const c = inner[i] ?? []
    if (c.length) out.push(...c.map((x) => ({ title: x.title, start: at + x.start })))
    else out.push({ title: p.title, start: at })
    at += p.dur
  })
  return out
}
/** Reads `len` bytes at `off` from the file. */
export type Read = (off: number, len: number) => Promise<Uint8Array>

type Box = [type: string, body: number, end: number]
function boxes(b: Uint8Array, s: number, e: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Box[] = []
  while (s + 8 <= e) {
    let size = v.getUint32(s)
    let h = 8
    if (size === 1) { size = Number(v.getBigUint64(s + 8)); h = 16 } else if (size === 0) size = e - s
    if (size < h) break
    out.push([String.fromCharCode(...b.subarray(s + 4, s + 8)), s + h, Math.min(e, s + size)])
    s += size
  }
  return out
}
/** The first box down a path such as moov/udta/chpl. `meta` is a full box: its children start 4 bytes in. */
function find(b: Uint8Array, [, s, e]: Box, path: string[]): Box | undefined {
  let cur: Box | undefined = ['', s, e]
  for (const t of path) {
    if (!cur) return
    cur = boxes(b, cur[1] + (cur[0] === 'meta' ? 4 : 0), cur[2]).find((x) => x[0] === t)
  }
  return cur
}

/** Chapters and cover art from an MP4, M4A or M4B: the QuickTime chapter track, else Nero `chpl`. */
export async function mp4Info(read: Read, size: number): Promise<{ chapters: Chapter[]; cover?: Uint8Array }> {
  let off = 0
  let moov: Uint8Array | null = null
  while (off + 8 <= size) {
    const h = await read(off, 16)
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const s = v.getUint32(0) === 1 ? Number(v.getBigUint64(8)) : v.getUint32(0) || size - off
    if (String.fromCharCode(...h.subarray(4, 8)) === 'moov') { if (s < 64 << 20) moov = await read(off, s); break }
    if (s < 8) break
    off += s
  }
  if (!moov) return { chapters: [] }
  const b = moov
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const root: Box = ['moov', 8, b.length]
  const u32 = (o: number) => v.getUint32(o)
  const covr = find(b, root, ['udta', 'meta', 'ilst', 'covr', 'data'])
  const cover = covr && covr[2] - covr[1] > 8 ? b.slice(covr[1] + 8, covr[2]) : undefined

  // QuickTime: the audio track's tref/chap names a text track whose samples are the chapter titles.
  const traks = boxes(b, 8, b.length).filter((x) => x[0] === 'trak')
  const tid = (t: Box) => { const k = find(b, t, ['tkhd'])!; return u32(k[1] + (b[k[1]] === 1 ? 20 : 12)) }
  const chap = traks.map((t) => find(b, t, ['tref', 'chap'])).find(Boolean)
  const text = chap && traks.find((t) => tid(t) === u32(chap[1]))
  if (text) {
    const stbl = (n: string) => find(b, text, ['mdia', 'minf', 'stbl', n])
    const mdhd = find(b, text, ['mdia', 'mdhd'])!
    const scale = u32(mdhd[1] + (b[mdhd[1]] === 1 ? 20 : 12))
    const [stts, stsz, stsc] = [stbl('stts'), stbl('stsz'), stbl('stsc')]
    const co = stbl('stco') ?? stbl('co64')
    if (stts && stsz && stsc && co && scale) {
      const starts: number[] = []
      for (let i = 0, t = 0; i < u32(stts[1] + 4); i++) {
        for (let n = 0; n < u32(stts[1] + 8 + i * 8); n++) { starts.push(t / scale); t += u32(stts[1] + 12 + i * 8) }
      }
      const fixed = u32(stsz[1] + 4)
      const sizes = starts.map((_, i) => fixed || u32(stsz[1] + 12 + i * 4))
      const chunks = Array.from({ length: u32(co[1] + 4) }, (_, i) => (co[0] === 'co64' ? Number(v.getBigUint64(co[1] + 8 + i * 8)) : u32(co[1] + 8 + i * 4)))
      const runs = Array.from({ length: u32(stsc[1] + 4) }, (_, i) => [u32(stsc[1] + 8 + i * 12), u32(stsc[1] + 12 + i * 12)])
      const offsets: number[] = []
      chunks.forEach((c, i) => {
        const per = [...runs].reverse().find((r) => r[0] <= i + 1)?.[1] ?? 1
        for (let n = 0; n < per && offsets.length < sizes.length; n++) { offsets.push(c); c += sizes[offsets.length - 1] }
      })
      const titles = await Promise.all(offsets.map(async (o, i) => {
        const s = await read(o, sizes[i])
        const len = Math.min(s.length - 2, (s[0] << 8) | s[1])
        const t = s.subarray(2, 2 + len)
        return new TextDecoder(t[0] === 0xfe && t[1] === 0xff ? 'utf-16be' : 'utf-8').decode(t).trim()
      }))
      if (titles.length) return { chapters: titles.map((title, i) => ({ title: title || `Chapter ${i + 1}`, start: starts[i] })), cover }
    }
  }
  // Nero: version, flags, (4 reserved in version 1), count, then 100 ns start, title length, title.
  const chpl = find(b, root, ['udta', 'chpl'])
  const chapters: Chapter[] = []
  if (chpl) {
    let p = chpl[1] + 4 + (b[chpl[1]] ? 4 : 0)
    for (let n = b[p++]; n > 0 && p + 9 <= chpl[2]; n--) {
      const start = Number(v.getBigUint64(p)) / 1e7
      const len = b[p + 8]
      chapters.push({ title: new TextDecoder().decode(b.subarray(p + 9, p + 9 + len)) || `Chapter ${chapters.length + 1}`, start })
      p += 9 + len
    }
  }
  return { chapters, cover }
}

/** The front cover (or first picture) in an MP3's ID3v2 tag. */
export async function id3Cover(read: Read): Promise<Uint8Array | undefined> {
  const h = await read(0, 10)
  if (String.fromCharCode(...h.subarray(0, 3)) !== 'ID3' || h[3] < 3) return
  const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
  const tag = await read(10, syncsafe(h, 6))
  const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength)
  for (let p = 0; p + 10 <= tag.length && tag[p];) {
    const size = h[3] === 4 ? syncsafe(tag, p + 4) : v.getUint32(p + 4)
    if (String.fromCharCode(...tag.subarray(p, p + 4)) === 'APIC') {
      const f = tag.subarray(p + 10, p + 10 + size)
      // Encoding, MIME type and a zero, picture type, a description ending in one zero (two in UTF-16), then the image.
      let q = f.indexOf(0, 1) + 2
      if (f[0] === 1 || f[0] === 2) { while (q + 1 < f.length && (f[q] || f[q + 1])) q += 2; q += 2 } else { while (q < f.length && f[q]) q++; q++ }
      return f.slice(q)
    }
    p += 10 + size
  }
}

/** A Read over a File or Blob. */
export const blobRead = (f: Blob): Read => async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer())

/** A Read over a URL with Range requests, and the file's size. Servers that ignore Range still work, slowly. */
export async function urlRead(url: string): Promise<[Read, number]> {
  const r = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  const size = Number(r.headers.get('content-range')?.split('/')[1] ?? r.headers.get('content-length') ?? 0)
  await r.body?.cancel()
  return [async (o, l) => {
    const x = await fetch(url, { headers: { Range: `bytes=${o}-${o + l - 1}` } })
    const a = new Uint8Array(await x.arrayBuffer())
    return x.status === 206 ? a : a.subarray(o, o + l)
  }, size]
}

// ---- where a time falls, and the sleep timer ----

/** The index of the chapter playing at time t. */
export const chapterAt = (ch: Chapter[], t: number) => Math.max(0, ch.findLastIndex((c) => c.start <= t + 0.01))

export type Sleep = { until: number } | { at: number } | null

/** A sleep timer: minutes from now, or the end of the chapter playing at time t. */
export function startSleep(choice: number | 'chapter', now: number, t: number, ch: Chapter[], total: number): Sleep {
  if (choice !== 'chapter') return { until: now + choice * 60_000 }
  const next = ch[chapterAt(ch, t) + 1]
  return { at: next ? next.start : total }
}

/** True once the timer should pause playback. `now` is the clock, `t` the place in the book. */
export const sleepDue = (s: Sleep, now: number, t: number) => !!s && ('until' in s ? now >= s.until : t >= s.at - 0.25)

// ---- speed, remembered per book ----

export async function bookSpeed(id: string, fallback = 1): Promise<number> {
  return (await db.get<number>('kv', `speed:${id}`).catch(() => undefined)) ?? fallback
}
export async function setBookSpeed(id: string, speed: number) {
  await db.put('kv', `speed:${id}`, speed)
}
