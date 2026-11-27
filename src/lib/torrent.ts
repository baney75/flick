// The built-in torrent engine from the views (SPEC-torrent): a torrent stream gets its URL from the
// desktop app's engine, its torrent stops when playback leaves it, and the player's readout shows
// the engine's speed and peers while it plays.
import { effect } from '@preact/signals'
import { nowPlaying } from './store'
import { invoke } from './platform'
import { mbps } from './speed'
import { engineNow } from './readout'
import type { Torrent } from './plugins/validate'

export const STARTING = 'Finding people sharing this torrent'
/** How often the readout asks the engine, in ms. */
export const POLL_MS = 1000

interface Stats { downBps: number; peers: number }

/** The torrent playing now, by the PlayRequest key that plays it. */
let playing: { key: string; hash: string; poll: ReturnType<typeof setInterval> } | null = null

/** Starts the torrent (or finds it running) and returns the URL the player opens. */
export const playTorrent = (torrent: Torrent) => invoke<string>('torrent_play', { torrent })

export function stopTorrent(hash: string) {
  invoke('torrent_stop', { infoHash: hash }).catch(() => {})
}

/** A started torrent that won't play after all (a newer tap, the gate): it stops, unless it plays already. */
export function dropTorrent(hash: string) {
  if (playing?.hash !== hash.toLowerCase()) stopTorrent(hash)
}

function leave() {
  if (!playing) return
  clearInterval(playing.poll)
  stopTorrent(playing.hash)
  playing = null
  engineNow.value = null
}

/**
 * Right before play(): the readout follows this torrent, and leaving it stops it. A torrent that
 * plays already (the same title again, or another file of it) keeps running.
 */
export function playingTorrent(key: string, infoHash: string) {
  const hash = infoHash.toLowerCase()
  if (playing?.hash === hash) { playing.key = key; return }
  leave()
  const tick = () => invoke<Stats | null>('torrent_stats', { infoHash: hash }).then((s) => {
    if (s && playing?.hash === hash) engineNow.value = { mbps: mbps(s.downBps, 1000), peers: s.peers }
  }, () => {})
  playing = { key, hash, poll: setInterval(tick, POLL_MS) }
  tick()
}

// Playback moved on (closed, another stream, or the gate stopped the player): the torrent stops.
effect(() => {
  const now = nowPlaying.value
  if (playing && now?.key !== playing.key) leave()
})
