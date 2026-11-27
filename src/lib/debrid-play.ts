// Debrid playback on a title page (SPEC-debrid rules 5 to 8 and Amendment 1): which services Flick
// may ask right now, the `cached` lookups, and what a torrent row says about its service.

import { HASHES_PER_CALL, type Stream } from './plugins/validate'
import { callPlugin } from './plugins/runtime'
import type { Service } from './plugins/services'
import type { Candidate } from './pick'

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
 * stops it. A failed call counts as none cached.
 */
export async function lookupCached(list: Service[], hashes: string[], may: (s: Service) => boolean, call: typeof callPlugin = callPlugin): Promise<CachedMap> {
  const want = [...new Set(hashes.map((h) => h.toLowerCase()))]
  const out: CachedMap = {}
  if (!want.length) return out
  for (const s of list) {
    const have: string[] = []
    // callPlugin's validator lowercases the answer and drops hashes it was not asked about.
    for (let i = 0; i < want.length; i += HASHES_PER_CALL) {
      if (!may(s)) break
      try { have.push(...(await call(s, 'cached', [want.slice(i, i + HASHES_PER_CALL)]))) } catch { /* none cached */ }
    }
    out[s.id] = have
  }
  return out
}

/**
 * Whether a title page must watch the VPN gate: any torrent or debrid stream. The gate decides
 * which services Flick may ask and whether the player says "via VPN", even when no row is gated.
 */
export const wantsGate = (cands: Pick<Candidate, 'via'>[]) => cands.some((c) => c.via !== 'direct')

/** Rule 5 until Play resolves through a service: a torrent row a service takes says so on a tap. */
export const notYet = (name: string) => `Playing torrents through ${name} comes in the next Flick update`

/** The infoHashes of a stream list's torrents, lowercase, once each. */
export const torrentHashes = (list: Stream[]) => [...new Set(list.flatMap((s) => (s.torrent ? [s.torrent.infoHash.toLowerCase()] : [])))]

/** Rule 7: "Instant on TorBox" or "TorBox will fetch it first" on a torrent row that may play. */
export function serviceTag(s: Stream, c: Candidate | undefined, name: (id: string) => string): string | undefined {
  if (!s.torrent || !c?.service) return undefined
  if (c.via === 'debrid-cached') return `Instant on ${name(c.service)}`
  if (c.via === 'debrid-fetch') return `${name(c.service)} will fetch it first`
  return undefined
}
