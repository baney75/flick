// The stall watchdog and the player's loading words (SPEC-playback rules 6 and 7). Every source
// records its `waiting` events: how long, what kind of source, and the buffered range. A stall that
// gets no new data for 15 s reloads the source at the same place once; a second one gives up and
// points to another source. Nothing here leaves the device.

export type SourceKind = 'file' | 'server' | 'plugin' | 'hls' | 'remux' | 'debrid' | 'torrent'

export interface Stall {
  kind: SourceKind
  /** When it began, in the watchdog's clock (ms). */
  start: number
  /** Its length in ms, null while it lasts. */
  ms: number | null
  /** The buffered range around the playhead when it began, and its end as new data came in (s). */
  from: number
  to: number
}

export const STALL_LIMIT_MS = 15_000
export const KEEP = 50
export const KEEPS_STALLING = 'This stream keeps stalling. Try another source.'
export const OPENING = 'Opening the file…'
export const WAITING = 'Waiting for the server…'
/** No words under this; a spinner alone says enough for a moment. */
export const TEXT_AFTER_MS = 1000

/** What kind of source a play request is, for the stall record. */
export function kindOf(req: { src?: { t: string }; via?: unknown; peers?: boolean }, url: string, remuxing: boolean): SourceKind {
  if (remuxing) return 'remux'
  if (req.peers) return 'torrent'
  if (req.via) return 'debrid'
  if (/\.m3u8(\?|$)/i.test(url) || /\/hlsv2\//.test(url)) return 'hls'
  const t = req.src?.t
  if (t === 'path' || t === 'handle' || t === 'opfs' || t === 'session') return 'file'
  if (t === 'kodi' || (t === 'url' && (req.src as { fallback?: string }).fallback)) return 'server'
  return 'plugin'
}

/** The words for a wait during play: a source on this device buffers, any other waits on its server. */
export function waitLine(kind: SourceKind): string {
  return kind === 'file' ? 'Buffering…' : WAITING
}

export interface Timers {
  now(): number
  set(f: () => void, ms: number): unknown
  clear(t: unknown): void
}
const real: Timers = { now: () => performance.now(), set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as number) }

export class Watchdog {
  readonly stalls: Stall[] = []
  reloads = 0
  private open: Stall | null = null
  private timer: unknown

  constructor(public kind: SourceKind, private on: { reload(): void; giveUp(): void }, private t: Timers = real) {}

  /** The element fired `waiting`; `from`..`to` is the buffered range at the playhead. */
  waiting(from: number, to: number) {
    if (this.open) return
    this.open = { kind: this.kind, start: this.t.now(), ms: null, from, to }
    this.stalls.push(this.open)
    if (this.stalls.length > KEEP) this.stalls.shift()
    this.arm()
  }

  /** New data arrived (`progress`): a stall that is still fed is not stuck. */
  data(to: number) {
    if (!this.open || !(to > this.open.to)) return
    this.open.to = to
    this.arm()
  }

  /** Playing again: the open stall ends. */
  resumed() {
    if (!this.open) return
    this.open.ms = this.t.now() - this.open.start
    this.open = null
    this.t.clear(this.timer)
  }

  stop() {
    this.t.clear(this.timer)
  }

  /** "Stalls: 3, longest 4.2 s", or null before the first. A stall still open counts its time so far. */
  summary(): string | null {
    if (!this.stalls.length) return null
    const now = this.t.now()
    const longest = Math.max(...this.stalls.map((s) => s.ms ?? now - s.start))
    return `Stalls: ${this.stalls.length}, longest ${(longest / 1000).toFixed(1)} s`
  }

  private arm() {
    this.t.clear(this.timer)
    this.timer = this.t.set(() => this.stuck(), STALL_LIMIT_MS)
  }

  private stuck() {
    const s = this.open
    if (!s) return
    s.ms = this.t.now() - s.start
    this.open = null
    if (this.reloads++ === 0) this.on.reload()
    else this.on.giveUp()
  }
}

/**
 * The status line, held back for its first second (rule 7): `set(text)` shows it once it has
 * stood 1 s; a change from one text to another keeps the clock, and null clears it at once.
 */
export class Delayed {
  private since: number | null = null
  private timer: unknown
  private text: string | null = null
  constructor(private show: (text: string | null) => void, private t: Timers = real) {}

  set(text: string | null) {
    this.text = text
    if (text === null) {
      this.since = null
      this.t.clear(this.timer)
      this.show(null)
      return
    }
    if (this.since === null) {
      this.since = this.t.now()
      this.timer = this.t.set(() => this.show(this.text), TEXT_AFTER_MS)
      return
    }
    if (this.t.now() - this.since >= TEXT_AFTER_MS) this.show(text)
  }

  stop() {
    this.t.clear(this.timer)
  }
}
