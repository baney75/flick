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

/** A debrid service plugin as the ranker needs it (SPEC-debrid rules 6 and 9). */
export interface ServiceInfo { id: string; vpnOptional: boolean; debridHosts: string[] }

/** What Flick already knows about debrid services; the ranker never asks them anything (rule 12). */
export interface Debrid {
  /** Every installed service: a stream on one of their download hosts is a debrid stream. */
  known: ServiceInfo[]
  /** The services set up to resolve torrents, in the user's order. */
  order: ServiceInfo[]
  /** The `cached` answers already fetched: whether this service has this infoHash ready. */
  cached?: (service: string, infoHash: string) => boolean
}

/** A stream with SPEC-torrent rule 2's torrent in place of a playable url. */
export type StreamIn = Omit<Stream, 'url'> & { url?: string; torrent?: { infoHash: string; fileIdx?: number } }

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }
const onHost = (host: string, hosts: string[]) => !!host && hosts.some((h) => host === h || host.endsWith(`.${h}`))

/** How a stream's bytes arrive: a torrent through a service or peers, a link on a debrid host, or direct. */
function viaOf(s: StreamIn, d: Debrid | undefined): Pick<Candidate, 'via' | 'service' | 'vpnOptional'> {
  if (s.torrent) {
    const hash = s.torrent.infoHash.toLowerCase()
    const svc = d?.order.find((x) => d.cached?.(x.id, hash)) ?? d?.order[0]
    if (!svc) return { via: 'p2p' }
    return { via: d?.cached?.(svc.id, hash) ? 'debrid-cached' : 'debrid-fetch', service: svc.id, vpnOptional: svc.vpnOptional }
  }
  // Rule 6: an addon link already resolved on a debrid host is a torrent for the VPN gate.
  const svc = d?.known.find((x) => onHost(hostOf(s.url ?? ''), x.debridHosts))
  return svc ? { via: 'debrid-cached', service: svc.id, vpnOptional: svc.vpnOptional } : { via: 'direct' }
}

/** One candidate per stream a plugin returned for one video, id `${key}#${index}`. */
export function streamCandidates(key: string, list: StreamIn[], o: { audiobook?: boolean; episode?: boolean; debrid?: Debrid } = {}): Candidate[] {
  return list.map((s, i) => {
    const media: Candidate['media'] = s.kind === 'book' ? 'book' : s.kind === 'audio' ? (o.audiobook ? 'audiobook' : 'audio') : 'video'
    const c: Candidate = { id: `${key}#${i}`, media, place: 'plugin', text: [s.title, s.group].filter(Boolean).join('\n'), order: i, ...viaOf(s, o.debrid) }
    if (s.quality) c.quality = s.quality
    if (s.subs?.length) c.subs = s.subs.map((x) => ({ lang: x.lang }))
    if (s.external) c.external = true
    if (s.needsDesktop) c.needsDesktop = true
    if (o.episode) c.episode = true
    let path = ''
    try { path = new URL(s.url ?? '').pathname } catch { /* not a URL, or a torrent: no format */ }
    const ext = extOf(path)
    if (ext) c.format = ext
    return c
  })
}

/** Rule 2: every candidate of a title, its library sources and the streams already fetched for it. */
export function candidatesOf(srcs: Src[], streams?: { key: string; list: StreamIn[]; audiobook?: boolean; episode?: boolean; debrid?: Debrid }, progressAt?: (s: Src) => number | undefined): Candidate[] {
  const own = srcCandidates(srcs, progressAt)
  if (!streams) return own
  const n = own.length
  return [...own, ...streamCandidates(streams.key, streams.list, streams).map((c) => ({ ...c, order: c.order + n }))]
}
