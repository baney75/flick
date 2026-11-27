// SPEC-playback case 13: the real app, hidden, plays fixture media from scripts/desktop-selftest.mjs's
// server on this Mac through the real player (cases 1, 2, 3 and 4), and times each step from the
// invoke log. A hidden window never advances an HLS playhead, so "ready" is the element holding data
// to play (readyState 3 or more), not a frame on screen.

import { invokeLog } from './platform'
import { nowPlaying, play } from './store'
import { hook, note } from './selftest'

export interface PlayCase { name: string; file: string; remux: boolean; seek?: number }
export const CASES: PlayCase[] = [
  { name: '1 MKV h264 + ac3', file: 'a.mkv', remux: true },
  { name: '2 MP4 hevc + dts', file: 'b.mp4', remux: true },
  { name: '3 MP4 h264 + aac', file: 'c.mp4', remux: false },
  { name: '4 MKV, seek to 1:30:00', file: 'long.mkv', remux: true, seek: 5400 },
]

export interface PlayRow {
  name: string
  probeMs?: number
  firstSegmentMs?: number
  readyMs?: number
  seekMs?: number
  /** The player's time line after the seek, "1:30:00 / 1:35:00". */
  shown?: string
  remuxRuns: number
  src: string
  stalls: string
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const video = () => document.querySelector<HTMLVideoElement>('.player video')

async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = f()
    if (v) return v
    const err = document.querySelector('.player .error-card p')?.textContent
    if (err) throw new Error(err)
    if (performance.now() - t0 > ms) throw new Error(`no ${what} within ${ms / 1000} s`)
    await sleep(20)
  }
}

const rows = (from: number, cmd: string) => invokeLog.slice(from).filter((r) => r.cmd === cmd && r.end >= 0)
const ms = (r?: { start: number; end: number }) => (r ? Math.round(r.end - r.start) : undefined)
const ready = (v: HTMLVideoElement | null) => !!v && v.readyState >= 3 && v.buffered.length > 0

async function one(base: string, c: PlayCase): Promise<PlayRow> {
  const url = `${base}/${c.file}`
  const mark = invokeLog.length
  const t0 = performance.now()
  const row: PlayRow = { name: c.name, remuxRuns: 0, src: '', stalls: '' }
  try {
    play({ key: `selftest:${c.file}`, title: c.name, kind: 'video', url, ref: { t: 'url', url } })
    const v = await until(() => (ready(video()) ? video() : null), 15_000, 'data to play')
    row.readyMs = Math.round(performance.now() - t0)
    row.src = v.currentSrc.split(':')[0]
    if (c.seek != null) {
      const seekto = (hook() as { actions?: Record<string, (d: { seekTime: number }) => void> } | undefined)?.actions?.seekto
      if (!seekto) throw new Error('the player set no seekto handler')
      const before = v.currentSrc
      const t1 = performance.now()
      seekto({ seekTime: c.seek })
      await until(() => { const w = video(); return w && w.currentSrc !== before && ready(w) }, 15_000, 'data after the seek')
      row.seekMs = Math.round(performance.now() - t1)
      await sleep(300)
      row.shown = document.querySelector('.player .time')?.textContent?.replace(/\s+/g, ' ').trim()
    }
    // A moment for any waiting event, then the readout's count.
    await sleep(1500)
  } catch (e) {
    row.error = String((e as Error)?.message ?? e)
  }
  row.probeMs = ms(rows(mark, 'probe_stream')[0])
  const runs = rows(mark, 'remux_start')
  row.remuxRuns = runs.length
  row.firstSegmentMs = ms(runs[0])
  row.stalls = document.querySelector('.player .readout')?.textContent?.match(/Stalls: .*/)?.[0] ?? 'Stalls: 0'
  nowPlaying.value = null
  await until(() => !document.querySelector('.player'), 5000, 'player close').catch(() => {})
  return row
}

export async function runPlayback(base: string | null | undefined): Promise<{ cases: PlayRow[] } | { error: string }> {
  if (!base) return { error: 'No fixture server (FLICK_SELFTEST_MEDIA).' }
  const cases: PlayRow[] = []
  for (const c of CASES) {
    note(`playback ${c.name}`)
    const r = await one(base, c)
    note(`playback ${c.name}: ${r.error ?? `ready ${r.readyMs} ms`}`)
    cases.push(r)
  }
  return { cases }
}
