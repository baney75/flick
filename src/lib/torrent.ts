// The built-in torrent engine from the views (SPEC-torrent): a torrent stream gets its URL from the
// desktop app's engine, its torrent stops when playback leaves it, and the player's readout shows
// the engine's speed and peers while it plays.
import { effect } from '@preact/signals'
import { notify, nowPlaying } from './store'
import { invoke } from './platform'
import { mbps } from './speed'
import { engineNow } from './readout'
import type { Torrent } from './plugins/validate'

export const STARTING = 'Finding people sharing this torrent'
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
/** The torrent the newest tap wants, so an older tap that lost never stops it. */
let wanted: string | null = null

/** Starts the torrent (or finds it running) and returns the URL the player opens. */
export function playTorrent(torrent: Torrent): Promise<string> {
  const k = `${torrent.infoHash.toLowerCase()}/${torrent.fileIdx ?? ''}`
  let p = starts.get(k)
  if (!p) {
    p = invoke<string>('torrent_play', { torrent }).finally(() => starts.delete(k))
    starts.set(k, p)
  }
  return p
}

export function stopTorrent(hash: string) {
  invoke('torrent_stop', { infoHash: hash }).catch(() => {})
}

/**
 * Every tap on a stream says which engine torrent it wants, if any. Wanting one still in its grace
 * keeps it running from the tap on, through the start, the subtitles and the VPN hold.
 */
export function wantTorrent(infoHash: string | undefined) {
  wanted = infoHash?.toLowerCase() ?? null
  if (closing && closing.hash === wanted) { clearTimeout(closing.timer); closing = null }
}

/**
 * A started torrent its tap won't play: a newer tap replaced it (`newest` false), or its VPN hold
 * failed. It stops, unless it plays already or a newer tap wants it too.
 */
export function letGo(hash: string, newest: boolean) {
  const h = hash.toLowerCase()
  if (playing?.hash === h || (!newest && wanted === h)) return
  stopTorrent(hash)
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
