// Turns a title's sources and a plugin's streams into the ranker's candidates (SPEC-best-stream
// rule 2). Pure: the views pass progress and the streams they already fetched.

import type { Candidate } from './pick'
import type { Stream } from './plugins/validate'
import type { Item, Source } from './library'
import { srcKey, type Src } from './titles'

const fileName = (s: Source): string =>
  s.t === 'path' ? s.path : s.t === 'handle' ? s.rel : s.t === 'opfs' ? s.name : s.t === 'url' || s.t === 'kodi' ? s.url.split('?')[0] : ''
const extOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name)?.[1].toLowerCase()

const MEDIA: Record<string, Candidate['media']> = { video: 'video', audio: 'audio', audiobook: 'audiobook', book: 'book' }

function itemCandidate(it: Item, id: string, dl: boolean, order: number, at?: number): Candidate {
  const name = fileName(it.src)
  const c: Candidate = {
    id,
    media: MEDIA[it.kind] ?? 'video',
    place: dl ? 'download' : it.origin === 'local' || it.origin === 'stored' ? 'device' : 'server',
    via: 'direct',
    text: [name.split('/').pop(), it.title].filter(Boolean).join(' '),
    order,
  }
  if (it.size > 1) c.sizeBytes = it.size
  if (it.duration) c.durSec = it.duration
  const ext = extOf(name)
  if (ext) c.format = ext
  if (it.show) c.episode = true
  if (at !== undefined) c.progressAt = at
  return c
}

/**
 * One candidate per source of a title. A show stands for its episodes and a plugin source for its
 * title page, so both carry only where they are; Play there picks again from what that page lists.
 */
export function srcCandidates(srcs: Src[], progressAt: (s: Src) => number | undefined = () => undefined): Candidate[] {
  return srcs.map((s, order) => {
    const id = srcKey(s), at = progressAt(s)
    if (s.t === 'item') return itemCandidate(s.it, id, !!s.dl, order, at)
    if (s.t === 'show') {
      const local = s.eps.some((e) => e.origin === 'local' || e.origin === 'stored')
      return { id, media: 'video', place: local ? 'device' : 'server', via: 'direct', text: '', episode: true, order }
    }
    const media = MEDIA[s.m.type] ?? 'video'
    const c: Candidate = { id, media, place: 'plugin', via: 'direct', text: '', order }
    if (at !== undefined) c.progressAt = at
    return c
  })
}

/** One candidate per stream a plugin returned for one video, id `${key}#${index}`. */
export function streamCandidates(key: string, list: Stream[], o: { audiobook?: boolean; episode?: boolean } = {}): Candidate[] {
  return list.map((s, i) => {
    const media: Candidate['media'] = s.kind === 'book' ? 'book' : s.kind === 'audio' ? (o.audiobook ? 'audiobook' : 'audio') : 'video'
    const c: Candidate = { id: `${key}#${i}`, media, place: 'plugin', via: 'direct', text: [s.title, s.group].filter(Boolean).join('\n'), order: i }
    if (s.quality) c.quality = s.quality
    if (s.subs?.length) c.subs = s.subs.map((x) => ({ lang: x.lang }))
    if (s.external) c.external = true
    if (s.needsDesktop) c.needsDesktop = true
    if (o.episode) c.episode = true
    let path = ''
    try { path = new URL(s.url).pathname } catch { /* not a URL: no format */ }
    const ext = extOf(path)
    if (ext) c.format = ext
    return c
  })
}

/** Rule 2: every candidate of a title, its library sources and the streams already fetched for it. */
export function candidatesOf(srcs: Src[], streams?: { key: string; list: Stream[]; audiobook?: boolean; episode?: boolean }, progressAt?: (s: Src) => number | undefined): Candidate[] {
  const own = srcCandidates(srcs, progressAt)
  if (!streams) return own
  const n = own.length
  return [...own, ...streamCandidates(streams.key, streams.list, streams).map((c) => ({ ...c, order: c.order + n }))]
}
