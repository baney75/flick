// Before a stream plays on the desktop, Flick asks ffprobe whether the web view can play it
// (SPEC-playback rule 1). One it cannot (an MKV, DTS audio) plays through a live remux run: ffmpeg
// writes a local HLS playlist from a start time, and the player adds that start to its own clock, so
// the seek bar, saved progress and resume all use the source's time (rules 2 and 3).
// SPEC-playback-2: an http(s) stream is resolved once first (redirects, up to 90 s for a debrid link),
// and the probe, the remux and direct play all read the final URL. A probe that fails never fails the
// play: the URL's type picks direct play or the safe-profile remux instead.

import { invoke, isDesktop, isMobileApp } from './platform'
import { OPENING, WAITING } from './stalls'

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

/** What the desktop's one GET of a stream found (rule 1). */
export interface Resolved {
  url: string
  status: number
  contentType?: string | null
  length?: number | null
  ranges: boolean
  redirects: number
  ms: number
}

/** The Rust side's limit and words when the server sends no first byte. */
export const RESOLVE_LIMIT_S = 90
export const NO_ANSWER = `The server did not answer within ${RESOLVE_LIMIT_S} seconds.`

/** The waiting line `ms` into a resolve: the seconds count shows from 5 s on (rule 1). */
export function serverWait(ms: number): string {
  return ms < 5000 ? WAITING : `${WAITING} ${Math.floor(ms / 1000)} s`
}

type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export function isHls(url: string) {
  return /\.m3u8(\?|$)/i.test(url) || /\/hlsv2\//.test(url)
}

/** The words of a failure: the shell rejects with a plain string, the web side with an Error. */
export function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e)
}

/**
 * The subtitle lines showing at source time `t`. A remux run's element clock starts at 0 while its
 * cues keep the file's own times, so the player picks them by the run's clock, not activeCues.
 */
export function cuesAt<T extends { startTime: number; endTime: number }>(cues: ArrayLike<T> | null | undefined, t: number): T[] {
  const out: T[] = []
  for (let i = 0; cues && i < cues.length; i++) if (cues[i].startTime <= t && t < cues[i].endTime) out.push(cues[i])
  return out
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
const opened = new Map<string, { at: number; p: Promise<Resolved> }>()
/** A resolve is shared for 10 minutes, as the desktop keeps it: debrid links are signed and expire. */
export const FRESH_MS = 600_000

/** The resolve of `url`, shared by a warm-up and Play; a failure, or one 10 minutes old, is made again. */
export function resolveStream(url: string, user = '', pass = '', call: Call = invoke, now: () => number = Date.now): Promise<Resolved> {
  const key = `${url}\n${user}`
  const had = opened.get(key)
  if (had && now() - had.at < FRESH_MS) return had.p
  const p = call<Resolved>('resolve_stream', { url, user, pass })
  const entry = { at: now(), p }
  p.catch(() => { if (opened.get(key) === entry) opened.delete(key) })
  opened.set(key, entry)
  return p
}

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

/** Starts the resolve and the probe early, so Play rarely waits. */
export function warmProbe(url: string | undefined, call: Call = invoke) {
  if (probes(url)) resolveStream(url, '', '', call).then((r) => probeStream(r.url, '', '', call)).catch(() => {})
}

/** Types the web view opens itself, when the probe could not say (rule 2, as stremio-video does). */
export function playsDirectly(url: string, contentType?: string | null): boolean {
  const t = (contentType ?? '').toLowerCase()
  if (/^video\/(mp4|quicktime|webm|x-m4v)\b/.test(t) || /mpegurl/.test(t)) return true
  let path = url
  try { path = new URL(url).pathname } catch { /* a bare path */ }
  return /\.(mp4|m4v|mov|webm|m3u8)$/i.test(path)
}

/** A probe for the safe profile: video to 8-bit H.264, audio to AAC stereo, length unknown. */
export const SAFE: StreamProbe = {
  duration: 0, container: '', video: null, audio: null, channels: 2, direct: false, why: null,
  convertsVideo: true, convertsAudio: true, checked: false,
}

/** What plays: the final URL as it is (with the safe remux to fall back on when the probe failed), or a remux run. */
export type Plan =
  | { direct: string; fallback: Live | null }
  | { remux: Live; probe: StreamProbe; safe: boolean }

const host = (u: string) => { try { return new URL(u).host } catch { return '' } }

/**
 * Rules 1 and 2: resolve `input` once (an http(s) one), then probe the final URL and decide. `wait` gets
 * the waiting line each second while the server is silent. Null when `signal` aborts (the player closed).
 * `remux` says the source plays only through the remux (a library file, a Kodi item).
 */
export async function planStream(input: Live, remux: boolean, wait: (line: string) => void, signal: AbortSignal, call: Call = invoke): Promise<Plan | null> {
  let src = input
  let type: string | null | undefined
  if (/^https?:\/\//i.test(input.input)) {
    const t0 = Date.now()
    wait(serverWait(0))
    const tick = setInterval(() => wait(serverWait(Date.now() - t0)), 1000)
    const aborted = new Promise<null>((ok) => signal.addEventListener('abort', () => ok(null), { once: true }))
    try {
      const r = await Promise.race([resolveStream(input.input, input.user, input.pass, call), aborted])
      if (!r || signal.aborted) return null
      // The login goes only to the host it belongs to.
      src = host(r.url) === host(input.input) ? { ...input, input: r.url } : { input: r.url, user: '', pass: '' }
      type = r.contentType
    } finally {
      clearInterval(tick)
    }
    wait(OPENING)
    if (!remux && (isHls(src.input) || /mpegurl/i.test(type ?? ''))) return { direct: src.input, fallback: null }
  }
  const p = await probeStream(src.input, src.user, src.pass, call).catch(() => null)
  if (signal.aborted) return null
  if (p) return remux || !p.direct ? { remux: src, probe: p, safe: false } : { direct: src.input, fallback: null }
  if (!remux && playsDirectly(src.input, type)) return { direct: src.input, fallback: src }
  return { remux: src, probe: SAFE, safe: true }
}

/** A server with its own fallback stream (Jellyfin, Plex) keeps it: a failed probe plays the link, and a
 *  media error goes to the server's transcode, not the local safe remux. A probe that read it stands. */
export function withServerFallback(plan: Plan): Plan {
  if ('direct' in plan) return { direct: plan.direct, fallback: null }
  return plan.safe ? { direct: plan.remux.input, fallback: null } : plan
}

/** The safe remux a media error switches to: a decode or unsupported error on a direct play that has one. */
export function onMediaError(code: number | undefined, fallback: Live | null): Live | null {
  return fallback && (code === 3 || code === 4) ? fallback : null
}

/** The error card's buttons (rule 6): a plugin stream offers another source and never its link. */
export function cardButtons(req: { url?: string; ref: { t: string } }, stuck: boolean): ('open' | 'back' | 'another')[] {
  const plugin = req.ref.t === 'plugin'
  return [...(req.url && !plugin ? ['open' as const] : []), 'back', ...(plugin || stuck ? ['another' as const] : [])]
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
  if (p.convertsAudio && p.convertsVideo) return 'Converting the file for this Mac…'
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
  /** The source's length: the probe's, or one learned after a safe run started; 0 while unknown. */
  length: number
  constructor(readonly url: string, readonly probe: StreamProbe, private user = '', private pass = '', private call: Call = invoke, readonly safe = false) {
    this.length = probe.duration
  }

  /** Whether the source's length is known: a safe run's is not until a probe reads it. */
  get known(): boolean {
    return this.length > 0
  }

  /** Starts a run at source time `at` (stopping the last). Returns its playlist URL, or null when a newer run replaced it. */
  async open(at: number): Promise<string | null> {
    const n = ++this.n
    const max = this.length > 1 ? this.length - 1 : Infinity
    const from = Number.isFinite(at) ? Math.min(Math.max(0, at), max) : this.at
    try {
      const r = await this.call<{ url: string; at: number }>('remux_start', { url: this.url, user: this.user, pass: this.pass, at: from, owner: this.owner, safe: this.safe })
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

  /** The source's length, since a growing playlist does not know it. Unknown, it is the source time the
   *  run has written to (`fallback` is the run's own length), so the clock never passes it. */
  duration(fallback: number): number {
    // A growing playlist's own length can be Infinity or NaN: then only the run's start is known.
    return this.known ? this.length : this.at + (Number.isFinite(fallback) ? fallback : 0)
  }

  /** Where a seek to `t` lands: inside a known length; anywhere ahead when the length is unknown. */
  clamp(t: number, d: number): number {
    if (!Number.isFinite(t)) return this.at
    return Math.max(0, this.known && d > 1 ? Math.min(t, d - 1) : t)
  }

  stop() {
    this.n++
    this.call('remux_stop', { owner: this.owner }).catch(() => {})
  }
}
