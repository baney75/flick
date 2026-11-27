// Debrid playback on a title page (SPEC-debrid rules 5 to 8 and Amendment 1): which services Flick
// may ask right now, the `cached` lookups, and what a torrent row says about its service.

import { signal } from '@preact/signals'
import { HASHES_PER_CALL, type Stream, type Torrent } from './plugins/validate'
import { callPlugin } from './plugins/runtime'
import { resolveTorrent, type PollOptions, type Service } from './plugins/services'
import type { Candidate, Ranked } from './pick'

/**
 * Flick may contact this service now: the VPN gate passes, or the service declares vpnOptional and
 * "Require a VPN for debrid services too" is off. While this is false nothing goes to it.
 */
export const mayAsk = (s: { vpnOptional: boolean }, gateOk: boolean, vpnForDebrid: boolean) => gateOk || (s.vpnOptional && !vpnForDebrid)

/**
 * The services a torrent may go to now, in the user's order: the ones Flick may ask. When it may ask
 * none, all of them, so the row names the first and the ranker blocks it until the VPN is on.
 */
export function resolveOrder<T extends { vpnOptional: boolean }>(list: T[], gateOk: boolean, vpnForDebrid: boolean): T[] {
  const open = list.filter((s) => mayAsk(s, gateOk, vpnForDebrid))
  return open.length ? open : list
}

/** Service id to the lowercase infoHashes it has ready. */
export type CachedMap = Record<string, string[]>

/**
 * Ask each service, in order, which of these torrents it has ready, HASHES_PER_CALL at a time. Only
 * the hashes go out (rule 8). `may` is read again before every call, so a VPN that drops mid-lookup
 * stops it, and a service cut short is left out of the answer. A failed call counts as none cached.
 */
export async function lookupCached(list: Service[], hashes: string[], may: (s: Service) => boolean, call: typeof callPlugin = callPlugin): Promise<CachedMap> {
  const want = [...new Set(hashes.map((h) => h.toLowerCase()))]
  const out: CachedMap = {}
  if (!want.length) return out
  for (const s of list) {
    const have: string[] = []
    let whole = true
    // callPlugin's validator lowercases the answer and drops hashes it was not asked about.
    for (let i = 0; i < want.length; i += HASHES_PER_CALL) {
      if (!may(s)) { whole = false; break }
      try { have.push(...(await call(s, 'cached', [want.slice(i, i + HASHES_PER_CALL)]))) } catch { /* none cached */ }
    }
    if (whole) out[s.id] = have
  }
  return out
}

/**
 * A title page's lookups. `view` is what rows may claim now: null while any askable service's
 * answer for these hashes is still to come. `fill` asks only the services that lack one, so a
 * service that becomes askable does not make the others asked again. After `dispose` nothing more
 * goes out and nothing calls back.
 */
export class CachedLookups {
  private got = new Map<string, { hk: string; have: string[] }>()
  private asking = new Set<string>()
  private live = true
  constructor(private onChange: () => void, private may: (s: Service) => boolean, private call: typeof callPlugin = callPlugin) {}

  view(hashes: string[], open: Service[]): CachedMap | null {
    const hk = hashes.join(',')
    const out: CachedMap = {}
    for (const s of open) {
      const g = this.got.get(s.id)
      if (g?.hk !== hk) return null
      out[s.id] = g.have
    }
    return out
  }

  fill(hashes: string[], open: Service[]) {
    const hk = hashes.join(',')
    for (const s of open) {
      const k = `${s.id}|${hk}`
      if (!this.live || this.got.get(s.id)?.hk === hk || this.asking.has(k)) continue
      this.asking.add(k)
      lookupCached([s], hashes, (x) => this.live && this.may(x), this.call).then((m) => {
        this.asking.delete(k)
        // Cut short (the VPN dropped, the page left): no answer, so the next fill asks again.
        if (!this.live || !(s.id in m)) return
        this.got.set(s.id, { hk, have: m[s.id] })
        this.onChange()
      })
    }
  }

  dispose() { this.live = false }
}

/**
 * Whether a title page must watch the VPN gate: any torrent or debrid stream. The gate decides
 * which services Flick may ask and whether the player says "via VPN", even when no row is gated.
 */
export const wantsGate = (cands: Pick<Candidate, 'via'>[]) => cands.some((c) => c.via !== 'direct')

/** The infoHashes of a stream list's torrents, lowercase, once each. */
export const torrentHashes = (list: Stream[]) => [...new Set(list.flatMap((s) => (s.torrent ? [s.torrent.infoHash.toLowerCase()] : [])))]

/** Rule 7: "Instant on TorBox" or "TorBox will fetch it first" on a torrent row that may play. */
export function serviceTag(s: Stream, c: Candidate | undefined, name: (id: string) => string): string | undefined {
  if (!s.torrent || !c?.service) return undefined
  if (c.via === 'debrid-cached') return `Instant on ${name(c.service)}`
  if (c.via === 'debrid-fetch') return `${name(c.service)} will fetch it first`
  return undefined
}

// ---------- Play: a torrent through a service ----------

/** A row Play can start: a link, or a torrent a service takes (rule 5b). */
export const canStart = (r: Ranked | undefined, s: Stream) =>
  !!s.url || (!!s.torrent && (r?.c.via === 'debrid-cached' || r?.c.via === 'debrid-fetch'))

/** Rule 8: all a service learns about the torrent. The contract carries no file name, so none goes. */
export const forService = (t: Torrent): { infoHash: string; fileIdx?: number } =>
  ({ infoHash: t.infoHash.toLowerCase(), ...(t.fileIdx !== undefined ? { fileIdx: t.fileIdx } : {}) })

/** "TorBox is fetching: 40%", or the service's own words when it gives no percent. */
export function waitLine(name: string, w: { pct?: number; message: string }): string {
  return `${name} is fetching: ${w.pct !== undefined ? `${Math.round(w.pct)}%` : w.message}`
}

/** The title page's wait while a service fetches a torrent, with its Cancel. */
export interface Fetching { key: string; service: string; line: string; cancel: () => void }
export const fetching = signal<Fetching | null>(null)
/** Stops the wait for `key`, or any wait. */
export function cancelFetch(key?: string) {
  if (fetching.value && (key === undefined || fetching.value.key === key)) fetching.value.cancel()
}

export const vpnStopped = (name: string) => `Your VPN dropped, so Flick stopped asking ${name}. Reconnect it and press Play.`

export interface TorrentPlay {
  /** Services set up to play, in the user's order. */
  list: Service[]
  /** Whether Flick may ask this service now (the VPN rules), read before every call. */
  may: (s: Service) => boolean
  /** Calls back whenever the VPN gate changes; returns the unsubscribe. */
  watch: (fn: () => void) => () => void
  call?: typeof callPlugin
  sleep?: PollOptions['sleep']
  now?: () => number
}

/**
 * The https link for a torrent row: `resolve` on the row's service, polling while it fetches, with
 * the wait line and Cancel in `fetching`. A newer wait cancels this one. For a service behind the
 * VPN gate, a gate failure stops it before the next call. Null when canceled.
 */
export async function torrentUrl(key: string, s: Stream, r: Ranked, o: TorrentPlay): Promise<string | null> {
  const svc = o.list.find((x) => x.id === r.c.service)
  if (!s.torrent || !svc) throw new Error('Set up a debrid service in Settings to play torrents.')
  const name = svc.manifest.name
  if (!o.may(svc)) throw new Error(vpnStopped(name))
  cancelFetch()
  const ctl = new AbortController()
  let dropped = false
  const drop = () => { if (!o.may(svc)) { dropped = true; ctl.abort() } }
  const unwatch = o.watch(drop)
  const mine: Fetching = { key, service: svc.id, line: `Asking ${name}`, cancel: () => ctl.abort() }
  fetching.value = mine
  const own = () => fetching.value?.cancel === mine.cancel
  const call = o.call ?? callPlugin
  try {
    return await resolveTorrent(svc, forService(s.torrent), {
      signal: ctl.signal,
      // A call goes out only while the VPN rules allow this service.
      call: ((p, fn, args) => { drop(); if (ctl.signal.aborted) throw new Error('Stopped.'); return call(p, fn, args) }) as typeof callPlugin,
      onWait: (w) => { if (own()) fetching.value = { ...mine, line: waitLine(name, w) } },
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.now ? { now: o.now } : {}),
    })
  } catch (e) {
    if (dropped) throw new Error(vpnStopped(name))
    if (ctl.signal.aborted) return null
    throw e
  } finally {
    unwatch()
    if (own()) fetching.value = null
  }
}
