import { describe, expect, it } from 'vitest'
import { planStream, type Resolved, type StreamProbe } from '../src/lib/playback'
import { sourceOf, type Fields } from '../src/lib/playlog'

// SPEC-playback-2 rule 7: what the player hands the playback log. The desktop scrubs every string as
// well (src-tauri/src/playlog.rs); these check the player sends the steps and no more than it must.
describe('the playback log (rule 7)', () => {
  it('case 13: a debrid source is named by its host and type only', () => {
    const s = sourceOf('https://x.example/resolve/realdebrid/SECRETKEY/abc/file.mkv?token=T0K')
    expect(s).toEqual({ host: 'x.example', ext: 'mkv' })
    const line = JSON.stringify(s)
    for (const no of ['SECRETKEY', 'abc', 'T0K', 'token']) expect(line).not.toContain(no)
    expect(sourceOf('https://u:p@nas.example:8096/Videos/1/stream.MP4')).toEqual({ host: 'nas.example:8096', ext: 'mp4' })
    expect(sourceOf('file:///Users/someone/Movies/A.mkv')).toEqual({ host: '', ext: 'mkv' })
    expect(sourceOf('/Users/someone/Movies/A.webm')).toEqual({ host: '', ext: 'webm' })
  })

  const mkv: StreamProbe = { duration: 7200, container: 'matroska,webm', video: 'h264', audio: 'ac3', channels: 6, direct: false, why: 'MKV', convertsVideo: false, convertsAudio: true, checked: true }
  const got = (n: string): Resolved => ({ url: `https://cdn.example/log/${n}.mkv`, status: 206, contentType: 'video/x-matroska', ranges: true, redirects: 1, ms: 20_000 })
  const run = async (probe: () => Promise<StreamProbe>, u: string) => {
    const log: [string, Fields | undefined][] = []
    const call = <T,>(cmd: string) => (cmd === 'resolve_stream' ? Promise.resolve(got(u.slice(-1))) : probe()) as Promise<T>
    await planStream({ input: u, user: '', pass: '' }, false, () => {}, new AbortController().signal, call, (e, f) => log.push([e, f]))
    return log
  }

  it('a play notes its resolve, probe and decision, in order', async () => {
    const log = await run(async () => mkv, 'https://addon.example/log/1')
    expect(log.map(([e]) => e)).toEqual(['resolve', 'probe', 'decision'])
    expect(log[0][1]).toMatchObject({ ms: 20_000, status: 206, contentType: 'video/x-matroska', redirects: 1 })
    expect(log[1][1]).toMatchObject({ verdict: 'remux', why: 'MKV', video: 'h264', audio: 'ac3' })
    expect(log[2][1]).toEqual({ plan: 'remux', fallback: false })
  })
  it('a probe that fails notes its error, then the safe profile', async () => {
    const log = await run(() => Promise.reject('timed out'), 'https://addon.example/log/2')
    expect(log[1][1]).toMatchObject({ error: 'timed out' })
    expect(log[2][1]).toEqual({ plan: 'safe profile', fallback: false })
  })
  it('a resolve that fails notes its error', async () => {
    const log: [string, Fields | undefined][] = []
    const call = <T,>() => Promise.reject('The server answered 404 Not Found.') as Promise<T>
    await planStream({ input: 'https://addon.example/log/3', user: '', pass: '' }, false, () => {}, new AbortController().signal, call, (e, f) => log.push([e, f])).catch(() => {})
    expect(log).toHaveLength(1)
    expect(log[0][0]).toBe('resolve')
    expect(log[0][1]).toMatchObject({ error: 'The server answered 404 Not Found.' })
  })
})
