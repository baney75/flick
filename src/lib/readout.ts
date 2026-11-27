// The player's live readout for a debrid stream (SPEC-torrent rule 32, SPEC-debrid rule 11):
// "via TorBox · 12 Mbps, no VPN". The speed is P6's RateMeter, fed the bytes the player fetched:
// a link from a service plays in the web view, which reports how much of the file it holds as
// buffered time, so the bytes are the growth of that time at the file's average bytes per second.

import { readoutLabel } from './speed'
import type { Ranked } from './pick'

/** What a debrid stream tells the player: the service's name and the file's size when known. */
export interface Via { service: string; bytes?: number }

/** The readout a row's stream gets: any stream through a service, torrent or link on its host. */
export function viaOf(r: Ranked, name: (id: string) => string): Via | undefined {
  if (!r.c.service) return undefined
  const bytes = r.c.sizeBytes ?? r.rel.bytes
  return bytes ? { service: name(r.c.service), bytes } : { service: name(r.c.service) }
}

/** Seconds of the file the player holds, across every buffered range. */
export function bufferedSeconds(r: Pick<TimeRanges, 'length' | 'start' | 'end'>): number {
  let s = 0
  for (let i = 0; i < r.length; i++) s += Math.max(0, r.end(i) - r.start(i))
  return s
}

/** Bytes fetched between two buffered totals; a seek that drops a range fetched nothing. */
export function fetchedBytes(before: number, after: number, bytes: number | undefined, durSec: number): number {
  if (!bytes || !(durSec > 0) || !isFinite(durSec) || after <= before) return 0
  return ((after - before) * bytes) / durSec
}

/** "via TorBox · 12 Mbps via VPN", "via TorBox · 12 Mbps, no VPN", or with no speed yet "via TorBox · no VPN". */
export function viaLine(v: Via, mbps: number | null, vpn: boolean): string {
  return `via ${v.service} · ${mbps === null ? (vpn ? 'via VPN' : 'no VPN') : readoutLabel(mbps, vpn)}`
}
