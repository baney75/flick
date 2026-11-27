// The built-in torrent engine from the views (SPEC-torrent): a torrent stream gets its URL from the
// desktop app's engine, with a wait line and Cancel while it starts; its torrent stops when playback
// leaves it, and the player's readout shows the engine's speed and peers while it plays.
import { effect, signal } from '@preact/signals'
import { notify, nowPlaying } from './store'
import { current, tap } from './picking'
import { invoke } from './platform'
import { mbps } from './speed'
import { engineNow } from './readout'
import type { Torrent } from './plugins/validate'

export const STARTING = 'Finding people sharing this torrent'
/** No answer within START_LIMIT_MS, or the engine found no one (its own text is the same). */
export const NO_ONE = 'No one is sharing this torrent right now. Try another source.'
/** How long a tap waits for the engine to start a torrent, in ms. */
export const START_LIMIT_MS = 60_000
/** The engine stopped the torrent that plays (the VPN changed tunnels or dropped). */
export const TORRENT_LOST = 'Your VPN changed or dropped, so the torrent stopped. Press Play to start it again.'
/** How often the readout asks the engine, in ms. */
export const POLL_MS = 1000
/** How long a torrent keeps running after its player closes, so a replay or the next episode reuses it. */
export const GRACE_MS = 5000

interface Stats { downBps: number; peers: number }

/** The torrent playing now, by the PlayRequest key that plays it. */
let playing: { key: string; hash: string; poll: ReturnType<typeof setInterval> } | null = null
/** A torrent whose player closed, still running until its grace ends. */
let closing: { hash: string; timer: ReturnType<typeof setTimeout> } | null = null
/** Engine starts on their way, by hash and file: a second tap on one waits on the first. */
const starts = new Map<string, Promise<string>>()
/** The torrent the newest tap wants, so an older tap that lost never stops it, and its file. */
let wanted: string | null = null
let wantedFile: string | null = null
/** The engine's answers while the torrent's last start or session still ends: the tap asks again. */
const BUSY = ['This torrent is still stopping. Press Play again in a moment.', 'This torrent is still starting.']
/** How often a start asks the engine again while it answers BUSY, in ms. */
export const RETRY_MS = 1000
const fileOf = (t: Torrent) => `${t.infoHash.toLowerCase()}/${t.fileIdx ?? ''}`

/** The title page's line while the engine starts a torrent: Cancel until it ends, then NO_ONE if no one shared it. */
export interface EngineWait { key: string; hash: string; file: string; line: string; cancel?: () => void }
export const engineWait = signal<EngineWait | null>(null)

/** Ends the engine wait for `key` (or any): a start on its way stops and never plays; a NO_ONE line goes. */
export function cancelStart(key?: string) {
  const w = engineWait.value
  if (!w || (key !== undefined && w.key !== key)) return
  if (w.cancel) w.cancel()
  else engineWait.value = null
}

/** Starts the torrent (or finds it running) and returns the URL the player opens. */
export function playTorrent(torrent: Torrent): Promise<string> {
  const k = fileOf(torrent)
  let p = starts.get(k)
  if (!p) {
    const run: Promise<string> = invoke<string>('torrent_play', { torrent }).finally(() => { if (starts.get(k) === run) starts.delete(k) })
    starts.set(k, p = run)
  }
  return p
}

export function stopTorrent(hash: string) {
  // A start on its way ends with the stop, so a tap after it asks the engine again.
  for (const k of starts.keys()) if (k.startsWith(`${hash.toLowerCase()}/`)) starts.delete(k)
  invoke('torrent_stop', { infoHash: hash }).catch(() => {})
}

/**
 * Every tap on a stream says which engine torrent it wants, if any. Wanting one still in its grace
 * keeps it running from the tap on, through the start, the subtitles and the VPN hold.
 */
export function wantTorrent(torrent: Torrent | undefined) {
  wanted = torrent?.infoHash.toLowerCase() ?? null
  wantedFile = torrent ? fileOf(torrent) : null
  if (closing && closing.hash === wanted) { clearTimeout(closing.timer); closing = null }
  // A tap on another stream (another file of the same torrent too) ends the start on its way; one
  // on the same file shares it.
  if (engineWait.value && engineWait.value.file !== wantedFile) cancelStart()
}

/**
 * The title page `key` goes (Back, another episode): its engine wait ends, and its last tap `t`, if
 * still the newest, never plays and wants no torrent, so a start that answered meanwhile stops.
 */
export function leavePage(key: string, t: number) {
  cancelStart(key)
  if (!current(t)) return
  tap()
  wantTorrent(undefined)
}

/**
 * Starts the torrent for tap `t`, with its wait line and Cancel, and returns the URL to play. Null
 * when it won't play: canceled, replaced by another tap, its page left, or no one shared it within
 * START_LIMIT_MS (the line then says NO_ONE). Other engine errors throw.
 */
export async function startTorrent(key: string, torrent: Torrent, t: number): Promise<string | null> {
  const hash = torrent.infoHash.toLowerCase()
  const file = fileOf(torrent)
  let ended = false
  const end = (none: boolean) => {
    if (ended) return
    ended = true
    clearTimeout(limit)
    // Its answer may still come: a stale tap never plays it.
    if (current(t)) tap()
    // Its torrent stops unless the player plays it, even when the newer tap wants another of its
    // files: the engine starts that one once this start has ended.
    if (wantedFile === file) wanted = wantedFile = null
    if (playing?.hash !== hash) stopTorrent(hash)
    if (own()) engineWait.value = none ? { key, hash, file, line: NO_ONE } : null
  }
  const mine: EngineWait = { key, hash, file, line: STARTING, cancel: () => end(false) }
  const own = () => engineWait.value === mine
  engineWait.value = mine
  const limit = setTimeout(() => { if (own()) end(true) }, START_LIMIT_MS)
  try {
    let url: string
    for (;;) {
      try { url = await playTorrent(torrent); break } catch (e) {
        // A start or session of this torrent still ending (a Cancel, another file) ends soon.
        if (ended || !current(t) || !BUSY.includes(String(e))) throw e
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    }
    // A stop sent while the engine was still getting ready may have found nothing to stop.
    if (ended) { letGo(hash, false); return null }
    if (!current(t)) { letGo(hash, false); return null }
    return url
  } catch (e) {
    if (ended || !current(t)) return null
    if (String(e) !== NO_ONE) throw e
    if (own()) engineWait.value = { key, hash, file, line: NO_ONE }
    return null
  } finally {
    clearTimeout(limit)
    if (own()) engineWait.value = null
  }
}

/**
 * A started torrent its tap won't play: a newer tap replaced it (`newest` false), or its VPN hold
 * failed. It stops, unless it plays already or a newer tap wants it too.
 */
export function letGo(hash: string, newest: boolean) {
  const h = hash.toLowerCase()
  if (playing?.hash === h || (!newest && wanted === h)) return
  stopTorrent(h)
}

function endGrace() {
  if (!closing) return
  clearTimeout(closing.timer)
  stopTorrent(closing.hash)
  closing = null
}

function leave() {
  if (!playing) return
  clearInterval(playing.poll)
  const hash = playing.hash
  playing = null
  engineNow.value = null
  endGrace()
  closing = { hash, timer: setTimeout(() => { closing = null; stopTorrent(hash) }, GRACE_MS) }
}

/**
 * Right before play(): the readout follows this torrent, and leaving it stops it. A torrent that
 * plays already, or still runs from a player that just closed, keeps running.
 */
export function playingTorrent(key: string, infoHash: string) {
  const hash = infoHash.toLowerCase()
  if (playing?.hash === hash) { playing.key = key; return }
  leave()
  if (closing?.hash === hash) { clearTimeout(closing.timer); closing = null }
  else endGrace()
  const tick = () => invoke<Stats | null>('torrent_stats', { infoHash: hash }).then((s) => {
    if (playing?.hash !== hash) return
    if (s) { engineNow.value = { mbps: mbps(s.downBps, 1000), peers: s.peers }; return }
    // The engine no longer runs it: it stopped the torrent for a VPN change, so the player closes.
    if (nowPlaying.value?.key === playing.key) { nowPlaying.value = null; notify(TORRENT_LOST, 6000) }
  }, () => {})
  playing = { key, hash, poll: setInterval(tick, POLL_MS) }
  tick()
}

// Playback moved on (closed, another stream, or the gate stopped the player): the torrent stops
// once its grace ends.
effect(() => {
  const now = nowPlaying.value
  if (playing && now?.key !== playing.key) leave()
})
