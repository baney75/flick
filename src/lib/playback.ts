// Before a stream plays on the desktop, Flick asks ffprobe whether the web view can play it
// (SPEC-playback rule 1). One it cannot (an MKV, DTS audio) plays through a live remux run: ffmpeg
// writes a local HLS playlist from a start time, and the player adds that start to its own clock, so
// the seek bar, saved progress and resume all use the source's time (rules 2 and 3).

import { invoke, isDesktop, isMobileApp } from './platform'

export interface StreamProbe {
  duration: number
  container: string
  video?: string | null
  audio?: string | null
  channels: number
  direct: boolean
  why?: string | null
  convertsVideo: boolean
  convertsAudio: boolean
  checked: boolean
}

/** The Rust side's message when the server never answered the probe. */
export const SLOW_SERVER = 'The server did not answer within 6 seconds.'

type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export function isHls(url: string) {
  return /\.m3u8(\?|$)/i.test(url) || /\/hlsv2\//.test(url)
}

/** A source the live remux reads (rule 5): a URL or a file path, with the server's login. */
export interface Live { input: string; user: string; pass: string }

/** What the website shows for a stream its browser cannot open (rule 8): no ffmpeg there. */
export const DESKTOP_ONLY = 'This file plays in the Flick desktop app.'

const TYPES: Record<string, string> = {
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  ts: 'video/mp2t', m2ts: 'video/mp2t', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
}

/**
 * Whether the browser can open `url`, judged without fetching it: the type its extension names and
 * the element's canPlayType. A link with no known extension is given the chance to play.
 */
export function playsHere(url: string, canPlayType: (type: string) => string): boolean {
  let path = url
  try { path = new URL(url).pathname } catch { /* a bare path */ }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  const type = ext && TYPES[ext]
  return !type || canPlayType(type) !== ''
}

/** Streams the desktop probes before play: http(s) links that are not HLS, which the web view plays itself. */
export function probes(url: string | undefined): url is string {
  return !!url && isDesktop && !isMobileApp && /^https?:\/\//i.test(url) && !isHls(url)
}

const seen = new Map<string, Promise<StreamProbe>>()

/** The probe of `url`, once per session; a failed probe is tried again next time. */
export function probeStream(url: string, user = '', pass = '', call: Call = invoke): Promise<StreamProbe> {
  const key = `${url}\n${user}`
  let p = seen.get(key)
  if (!p) {
    p = call<StreamProbe>('probe_stream', { url, user, pass })
    p.catch(() => seen.delete(key))
    seen.set(key, p)
  }
  return p
}

/** Starts the probe early, so Play rarely waits. */
export function warmProbe(url: string | undefined) {
  if (probes(url)) probeStream(url).catch(() => {})
}

/** How long the pointer rests on a stream before Flick probes it. */
export const DWELL_MS = 300

let lastKey = 0
if (typeof window !== 'undefined') window.addEventListener('keydown', () => { lastKey = Date.now() }, true)

/**
 * Handlers that probe a stream once the user shows intent: the pointer resting on it, or keyboard
 * focus. Never on sight: an addon link with its own debrid key adds the torrent to the account when
 * fetched, so a row that is only shown is not contacted. `warm` is the probe; tests pass their own.
 */
export function intent(warm: () => void, now: () => number = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    onPointerEnter: () => { clearTimeout(timer); timer = setTimeout(warm, DWELL_MS) },
    onPointerLeave: () => clearTimeout(timer),
    // A focus the page moves by itself (the Play button on open) is not intent; one a key moved is.
    onFocus: () => { if (now() - lastKey < 500) warm() },
  }
}

/** What the player shows while a run converts, in words true to what ffmpeg does. */
export function convertLine(p: Pick<StreamProbe, 'convertsAudio' | 'convertsVideo'>): string {
  if (p.convertsAudio) return 'Converting audio for this Mac…'
  if (p.convertsVideo) return 'Converting video for this Mac…'
  return 'Converting the file for this Mac…'
}

export type SeekPlan = { local: number } | { restart: number }

/**
 * Where a seek to source time `target` goes: inside what the run starting at `at` has written
 * (`written` seconds of it), the player seeks in place; anywhere else a new run starts there.
 */
export function planSeek(target: number, at: number, written: number): SeekPlan {
  const t = Math.max(0, target)
  return t >= at && t - at <= written ? { local: t - at } : { restart: t }
}

/** Seconds a run has written: the end of the element's last seekable range. */
export function writtenOf(seekable: Pick<TimeRanges, 'length' | 'end'>): number {
  return seekable.length ? seekable.end(seekable.length - 1) : 0
}

/** One remuxed stream in the player: its runs, the start of the newest, and the stop. */
let players = 0

export class Remux {
  at = 0
  private n = 0
  /** This player's token: the desktop stops only its own run, so a closing player never stops the next one's. */
  readonly owner = `${Date.now().toString(36)}-${++players}`
  constructor(readonly url: string, readonly probe: StreamProbe, private user = '', private pass = '', private call: Call = invoke) {}

  /** Starts a run at source time `at` (stopping the last). Returns its playlist URL, or null when a newer run replaced it. */
  async open(at: number): Promise<string | null> {
    const n = ++this.n
    const max = this.probe.duration > 1 ? this.probe.duration - 1 : Infinity
    const from = Math.min(Math.max(0, at), max)
    try {
      const r = await this.call<{ url: string; at: number }>('remux_start', { url: this.url, user: this.user, pass: this.pass, at: from, owner: this.owner })
      if (n !== this.n) return null
      this.at = r.at
      return r.url
    } catch (e) {
      if (n !== this.n) return null
      throw e
    }
  }

  /** The source time at the player's clock. */
  time(clock: number): number {
    return this.at + clock
  }

  /** The source's length: the probe's, since a growing playlist does not know it. */
  duration(fallback: number): number {
    return this.probe.duration > 0 ? this.probe.duration : fallback
  }

  stop() {
    this.n++
    this.call('remux_stop', { owner: this.owner }).catch(() => {})
  }
}
