// The player's live readout for a debrid stream (SPEC-torrent rule 32, SPEC-debrid rule 11):
// "via TorBox · 12 Mbps, no VPN". The speed is P6's RateMeter, fed the bytes the player fetched:
// a link from a service plays in the web view, which reports how much of the file it holds as
// buffered time, so the bytes are the growth of that time at the file's average bytes per second.

import { signal } from '@preact/signals'
import { formatMbps, readoutLabel } from './speed'
import type { Ranked } from './pick'

/** What a debrid stream tells the player: the service's name and the file's size when known. */
export interface Via { service: string; bytes?: number }

/** The readout a row's stream gets: any stream through a service, torrent or link on its host.
 *  The size is the stream's listed size, so the speed is the file's average rate times buffer growth. */
export function viaOf(r: Ranked, name: (id: string) => string): Via | undefined {
  if (!r.c.service) return undefined
  // An episode may come from a season pack, whose listed size is the whole pack: no speed then.
  const bytes = r.c.episode ? undefined : r.c.sizeBytes ?? r.rel.bytes
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

/**
 * Whether the buffer still measures the service's download: the element plays the service's own
 * link with a known length. A converted MKV plays a local, growing stream, which measures ffmpeg.
 */
export function counts(currentSrc: string, url: string | undefined, durSec: number): boolean {
  if (!url || !(durSec > 0) || !isFinite(durSec)) return false
  // currentSrc is the browser's normalized form of the link it was given.
  try { return new URL(url).href === currentSrc } catch { return false }
}

/** "via TorBox · 12 Mbps via VPN", "via TorBox · 12 Mbps, no VPN", with no speed yet "via TorBox · no VPN",
 *  and with the gate not answered yet no VPN part at all. */
export function viaLine(v: Via, mbps: number | null, vpn: boolean | null): string {
  // Until the gate answers, the line makes no claim about the VPN.
  if (vpn === null) return mbps === null ? `via ${v.service}` : `via ${v.service} · ${formatMbps(mbps)}`
  return `via ${v.service} · ${mbps === null ? (vpn ? 'via VPN' : 'no VPN') : readoutLabel(mbps, vpn)}`
}

/** What the built-in engine reports for the torrent playing now: its speed and live peers. */
export interface EngineNow { mbps: number; peers: number }

/** Set by the engine's poll while it plays a torrent (lib/torrent), null otherwise. */
export const engineNow = signal<EngineNow | null>(null)

/** "12 Mbps via VPN · 8 peers": the engine plays only through the VPN gate. */
export function engineLine(e: EngineNow): string {
  return `${readoutLabel(e.mbps, true)} · ${e.peers} ${e.peers === 1 ? 'peer' : 'peers'}`
}
