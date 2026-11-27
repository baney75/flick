// SPEC-youtube-play cases 7 to 9: the player's re-resolve after a failed stream, and a live stream's bar.
import { describe, expect, it } from 'vitest'
import { barFor, oneRetry, type ToolPlay } from '../src/lib/plugins/runtime'

const master = (n: number): ToolPlay => ({ url: `https://manifest.googlevideo.com/api/manifest/hls_variant/expire/${n}/file/index.m3u8`, live: false })

describe('a stream that fails while playing', () => {
  it('a 403 at 40:00 looks the stream up once, fresh, and resumes at 40:00', async () => {
    const calls: [string, boolean][] = []
    const retry = oneRetry(async (url, fresh) => { calls.push([url, fresh]); return master(2) })
    const again = retry('flick-tool:ytdlp/t', 2400)
    expect(again).not.toBeNull()
    expect(await again).toEqual({ play: master(2), at: 2400 })
    expect(calls).toEqual([['flick-tool:ytdlp/t', true]])
  })
  it('a second failure gets no second lookup, and a failed lookup gives yt-dlp\'s message', async () => {
    let n = 0
    const retry = oneRetry(async () => { n++; throw new Error('yt-dlp: ERROR: [youtube] x: Video unavailable') })
    await expect(retry('flick-tool:ytdlp/t', 10)!).rejects.toThrow('yt-dlp: ERROR: [youtube] x: Video unavailable')
    expect(retry('flick-tool:ytdlp/t', 10)).toBeNull()
    expect(n).toBe(1)
  })
})

describe('a live stream', () => {
  it('says LIVE and has no seek bar; a video has both the bar and its times', () => {
    expect(barFor(true)).toEqual({ seek: false, label: 'LIVE' })
    expect(barFor(false)).toEqual({ seek: true, label: null })
  })
})
