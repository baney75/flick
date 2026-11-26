// VPN speed (spec rules 32 and 33): the Settings > Privacy speed test, and the live readout the
// player shows while a torrent or debrid stream plays. The math is pure; the test takes its fetch,
// clock and timer as arguments so tests can drive it.

export const SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=25000000'
export const PING_URL = 'https://speed.cloudflare.com/__down?bytes=0'
export const LIMIT_BYTES = 25_000_000
export const LIMIT_MS = 10_000
export const PINGS = 5
export const WINDOW_MS = 5_000

/** Megabits per second from bytes over elapsed milliseconds. */
export function mbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes * 8) / (ms * 1000) : 0
}

/** "182 Mbps"; one decimal under 10 ("6.4 Mbps"). */
export function formatMbps(m: number): string {
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} Mbps`
}

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The download stops at 25 MB or 10 seconds, whichever comes first. */
export function shouldStop(bytes: number, ms: number): boolean {
  return bytes >= LIMIT_BYTES || ms >= LIMIT_MS
}

export interface SpeedResult { vpn: boolean; mbps: number; ms: number; at: number }

/** "VPN: 182 Mbps, 24 ms" or "No VPN: 410 Mbps, 9 ms". */
export function speedLabel(r: Pick<SpeedResult, 'vpn' | 'mbps' | 'ms'>): string {
  return `${r.vpn ? 'VPN' : 'No VPN'}: ${formatMbps(r.mbps)}, ${Math.round(r.ms)} ms`
}

export interface SpeedDeps {
  fetch: (url: string, init: { signal: AbortSignal; cache: RequestCache }) => Promise<Response>
  now: () => number
  /** Runs `fn` after `ms`; returns a cancel. */
  after: (ms: number, fn: () => void) => () => void
}

const browser: SpeedDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
}

const NO_ANSWER = "The speed test server didn't answer."

/** Five latency samples, all within one 10-second deadline. */
async function pings(d: SpeedDeps): Promise<number[]> {
  const ctl = new AbortController()
  const cancel = d.after(LIMIT_MS, () => ctl.abort())
  const out: number[] = []
  try {
    for (let i = 0; i < PINGS; i++) {
      const start = d.now()
      const r = await d.fetch(PING_URL, { signal: ctl.signal, cache: 'no-store' })
      if (!r.ok) throw new Error(`The speed test server answered ${r.status}.`)
      await r.arrayBuffer()
      out.push(d.now() - start)
    }
  } catch (e) {
    throw ctl.signal.aborted ? new Error(NO_ANSWER) : e
  } finally {
    cancel()
  }
  return out
}

/** Bytes read and the time they took from the first response, stopping at the limits: 25 MB,
 *  or 10 seconds from the request, which also ends a stalled body. */
export async function download(d: SpeedDeps): Promise<{ bytes: number; ms: number }> {
  const ctl = new AbortController()
  const sent = d.now()
  let start = sent
  const cancel = d.after(LIMIT_MS, () => ctl.abort())
  let bytes = 0
  try {
    const r = await d.fetch(SPEED_URL, { signal: ctl.signal, cache: 'no-store' })
    if (!r.ok || !r.body) throw new Error(`The speed test server answered ${r.status}.`)
    start = d.now() // time to the first byte is latency, not throughput
    const reader = r.body.getReader()
    while (!shouldStop(bytes, d.now() - sent)) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
    }
    reader.cancel().catch(() => {})
  } catch (e) {
    if (!ctl.signal.aborted) throw e
  } finally {
    cancel()
  }
  if (!bytes) throw new Error(NO_ANSWER)
  return { bytes, ms: Math.min(d.now() - start, LIMIT_MS) }
}

/** The whole test: 5 pings for latency, then the download. `vpn` is the gate's state. */
export async function speedTest(vpn: boolean, d: SpeedDeps = browser): Promise<SpeedResult> {
  const ms = median(await pings(d))
  const got = await download(d)
  return { vpn, mbps: mbps(got.bytes, got.ms), ms, at: Date.now() }
}

/** Download speed over the last 5 seconds, from bytes reported as they arrive. P7's debrid
 *  player feeds it the bytes it fetches; the engine's stats feed it for torrents. */
export class RateMeter {
  private samples: [number, number][] = []
  /** `start`: when the stream began, so a meter younger than 5 s divides by its age. */
  constructor(private start: number) {}
  add(bytes: number, at: number) {
    this.samples.push([at, bytes])
    this.samples = this.samples.filter(([t]) => t > at - WINDOW_MS)
  }
  mbps(now: number): number {
    const recent = this.samples.filter(([t]) => t > now - WINDOW_MS)
    const span = Math.max(Math.min(WINDOW_MS, now - this.start), 1000)
    return mbps(recent.reduce((n, [, b]) => n + b, 0), span)
  }
}

/** The player's readout: "12 Mbps via VPN" or "12 Mbps, no VPN". */
export function readoutLabel(m: number, vpn: boolean): string {
  return `${formatMbps(m)}${vpn ? ' via VPN' : ', no VPN'}`
}
