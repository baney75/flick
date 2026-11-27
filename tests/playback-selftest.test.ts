// SPEC-playback case 13's pass rule for the hidden app's playback run (scripts/desktop-selftest.mjs --mode playback).
import { describe, expect, it } from 'vitest'
import { playbackFailures, playbackTable } from '../scripts/desktop-selftest.mjs'

type Row = { name: string; remuxRuns: number; readyMs?: number; seekMs?: number; shown?: string; error?: string; [k: string]: unknown }
const good: { cases: Row[] } = {
  cases: [
    { name: '1 MKV h264 + ac3', probeMs: 120, firstSegmentMs: 400, readyMs: 900, remuxRuns: 1, src: 'asset', stalls: 'Stalls: 0' },
    { name: '2 MP4 hevc + dts', probeMs: 110, firstSegmentMs: 700, readyMs: 1300, remuxRuns: 1, src: 'asset', stalls: 'Stalls: 0' },
    { name: '3 MP4 h264 + aac', probeMs: 90, readyMs: 300, remuxRuns: 0, src: 'http', stalls: 'Stalls: 0' },
    { name: '4 MKV, seek to 1:30:00', probeMs: 150, firstSegmentMs: 500, readyMs: 1000, seekMs: 1200, shown: '1:30:00 / 1:35:00', remuxRuns: 2, src: 'asset', stalls: 'Stalls: 0' },
  ],
}

describe('playbackFailures', () => {
  it('passes runs inside the limits', () => {
    expect(playbackFailures(good)).toEqual([])
    expect(playbackTable(good)).toContain('| 4 MKV, seek to 1:30:00 |')
  })
  it('fails a slow start, a slow seek, the wrong time shown, ffmpeg for a direct stream, and errors', () => {
    const bad = structuredClone(good)
    bad.cases[0].readyMs = 3400
    bad.cases[2].remuxRuns = 1
    bad.cases[3].seekMs = 3100
    bad.cases[3].shown = '0:00:01 / 1:35:00'
    bad.cases[1] = { ...bad.cases[1], error: 'no data to play within 15 s' }
    bad.cases[2].stalls = 'Stalls: 1, longest 0.3 s'
    expect(playbackFailures(bad)).toEqual([
      '1 MKV h264 + ac3: ready in 3400 ms, over 3000',
      '2 MP4 hevc + dts: no data to play within 15 s',
      '3 MP4 h264 + aac: started ffmpeg for a stream that plays directly',
      '3 MP4 h264 + aac: Stalls: 1, longest 0.3 s after the first frame',
      '4 MKV, seek to 1:30:00: seek ready in 3100 ms, over 3000',
      '4 MKV, seek to 1:30:00: the player shows 0:00:01 / 1:35:00 after the seek',
    ])
  })
  it('a run with no report fails', () => {
    expect(playbackFailures({ error: 'No fixture server (FLICK_SELFTEST_MEDIA).' })[0]).toMatch(/No fixture server/)
  })
})
