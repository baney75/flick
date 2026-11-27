// SPEC-playback cases 4, 5 and 6: where a seek goes, the remux run's clock, and the probe cache.
import { describe, expect, it, vi } from 'vitest'
import { cardButtons, onMediaError, convertLine, cuesAt, messageOf, DWELL_MS, intent, NO_ANSWER, planSeek, planStream, playsDirectly, playsHere, probeStream, Remux, RESOLVE_LIMIT_S, SAFE, serverWait, warmProbe, writtenOf, type Resolved, type StreamProbe } from '../src/lib/playback'

const mkv: StreamProbe = {
  duration: 5700, container: 'matroska,webm', video: 'h264', audio: 'ac3', channels: 6,
  direct: false, why: 'MKV', convertsVideo: false, convertsAudio: false, checked: true,
}

/** A fake invoke that records remux_start calls and answers each when told to. */
function fake() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = []
  const pending: { at: number; ok: (v: unknown) => void; fail: (e: Error) => void }[] = []
  const call = <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args })
    if (cmd !== 'remux_start') return Promise.resolve(undefined as T)
    return new Promise<T>((ok, fail) => pending.push({ at: args!.at as number, ok: ok as (v: unknown) => void, fail }))
  }
  const answer = (i: number) => pending[i].ok({ url: `asset://localhost/%2Frun${i}/index.m3u8`, at: pending[i].at })
  return { call, calls, pending, answer }
}

const ranges = (end: number) => ({ length: 1, end: () => end })

describe('planSeek (cases 4 and 5)', () => {
  it('seeks in place inside what the run has written', () => {
    expect(planSeek(30, 0, 40)).toEqual({ local: 30 })
    expect(planSeek(5420, 5400, 40)).toEqual({ local: 20 })
  })
  it('case 4: a seek from 0:10 to 1:30:00 starts a new run at 5400', () => {
    expect(planSeek(5400, 0, 10)).toEqual({ restart: 5400 })
  })
  it('case 5: a seek back to 0:20 from a run at 5400 starts a new run at 20', () => {
    expect(planSeek(20, 5400, 120)).toEqual({ restart: 20 })
  })
  it('a seek before zero is zero', () => {
    expect(planSeek(-5, 0, 10)).toEqual({ local: 0 })
  })
  it('writtenOf reads the end of the last seekable range', () => {
    expect(writtenOf({ length: 0, end: () => 0 })).toBe(0)
    expect(writtenOf(ranges(36))).toBe(36)
  })
})

describe('Remux (cases 4, 5 and 6)', () => {
  it('case 6: progress saved at run 5400 plus clock 30 is 5430', async () => {
    const f = fake()
    const r = new Remux('https://x/movie.mkv', mkv, '', '', f.call)
    const opened = r.open(5400)
    f.answer(0)
    expect(await opened).toBe('asset://localhost/%2Frun0/index.m3u8')
    expect(r.time(30)).toBe(5430)
    expect(r.duration(NaN)).toBe(5700)
  })
  it('a run asked past the end starts one second before it', async () => {
    const f = fake()
    const r = new Remux('https://x/movie.mkv', mkv, '', '', f.call)
    const opened = r.open(9999)
    expect(f.pending[0].at).toBe(5699)
    f.answer(0)
    await opened
    expect(r.at).toBe(5699)
  })
  it('a run replaced before it answers returns null and keeps the newer start', async () => {
    const f = fake()
    const r = new Remux('https://x/movie.mkv', mkv, '', '', f.call)
    const first = r.open(5400)
    const second = r.open(20)
    f.pending[0].fail(new Error('Another stream started.'))
    f.answer(1)
    expect(await first).toBeNull()
    expect(await second).toBe('asset://localhost/%2Frun1/index.m3u8')
    expect(r.at).toBe(20)
  })
  it('stop ends the run and drops an answer still on its way', async () => {
    const f = fake()
    const r = new Remux('https://x/movie.mkv', mkv, '', '', f.call)
    const opened = r.open(0)
    r.stop()
    f.answer(0)
    expect(await opened).toBeNull()
    expect(f.calls.map((c) => c.cmd)).toEqual(['remux_start', 'remux_stop'])
    expect(f.calls[1].args).toEqual({ owner: r.owner })
    expect(f.calls[0].args!.owner).toBe(r.owner)
  })
  it('two players have different owners', () => {
    const f = fake()
    expect(new Remux('a', mkv, '', '', f.call).owner).not.toBe(new Remux('a', mkv, '', '', f.call).owner)
  })
  it('a run that fails says why', async () => {
    const f = fake()
    const r = new Remux('https://x/movie.mkv', mkv, '', '', f.call)
    const opened = r.open(0)
    f.pending[0].fail(new Error('ffmpeg could not convert this stream: Invalid data'))
    await expect(opened).rejects.toThrow('Invalid data')
  })
})

describe('probeStream', () => {
  it('asks once per stream and tries a failed probe again', async () => {
    let n = 0
    const call = <T,>() => { n++; return (n === 1 ? Promise.reject(new Error('timed out')) : Promise.resolve(mkv)) as Promise<T> }
    await expect(probeStream('https://x/once.mkv', '', '', call)).rejects.toThrow('timed out')
    expect(await probeStream('https://x/once.mkv', '', '', call)).toEqual(mkv)
    expect(await probeStream('https://x/once.mkv', '', '', call)).toEqual(mkv)
    expect(n).toBe(2)
  })
  it('case 11: names what ffmpeg converts', () => {
    expect(convertLine({ convertsAudio: true, convertsVideo: false })).toBe('Converting audio for this Mac…')
    expect(convertLine({ convertsAudio: false, convertsVideo: true })).toBe('Converting video for this Mac…')
    expect(convertLine({ convertsAudio: false, convertsVideo: false })).toBe('Converting the file for this Mac…')
    expect(convertLine(SAFE)).toBe('Converting the file for this Mac…')
  })
})

describe('intent (rule 1: probe early, never on sight)', () => {
  it('probes after the pointer rests 300 ms, not on a pass over the row', () => {
    vi.useFakeTimers()
    let n = 0
    const h = intent(() => n++)
    h.onPointerEnter(); vi.advanceTimersByTime(DWELL_MS - 50); h.onPointerLeave(); vi.advanceTimersByTime(1000)
    expect(n).toBe(0)
    h.onPointerEnter(); vi.advanceTimersByTime(DWELL_MS)
    expect(n).toBe(1)
    vi.useRealTimers()
  })
  it('a focus the page moves by itself (no key pressed) does not probe', () => {
    let n = 0
    const h = intent(() => n++, () => 10_000)
    h.onFocus()
    expect(n).toBe(0)
  })
})

describe('playsHere (rule 8, case 12)', () => {
  const safari = (t: string) => (t === 'video/mp4' || t === 'video/quicktime' ? 'maybe' : '')
  it('an MKV link on a browser that cannot open MKV does not play here', () => {
    expect(playsHere('https://x/a/Movie.2024.mkv?token=1', safari)).toBe(false)
    expect(playsHere('/films/a.AVI', safari)).toBe(false)
  })
  it('what the browser can open, or a link with no known extension, plays', () => {
    expect(playsHere('https://x/a.mp4', safari)).toBe(true)
    expect(playsHere('https://x/resolve/abc/123', safari)).toBe(true)
    expect(playsHere('https://x/a.mkv', () => 'maybe')).toBe(true)
  })
})

describe('a remux run of a library file (rule 5)', () => {
  it('shows the subtitle line for the source time, not the element clock', async () => {
    const f = fake()
    const r = new Remux('/Movies/Big.mkv', mkv, '', '', f.call)
    const opened = r.open(300)
    f.answer(0)
    await opened
    const cues = [{ startTime: 0, endTime: 2, text: 'first line' }, { startTime: 300, endTime: 302, text: 'line at 5:00' }]
    expect(cuesAt(cues, r.time(0.5)).map((c) => c.text)).toEqual(['line at 5:00'])
    expect(cuesAt(cues, 0.5).map((c) => c.text)).toEqual(['first line'])
    expect(cuesAt(cues, 302)).toEqual([])
    expect(cuesAt(null, 1)).toEqual([])
  })
  it('a failure from the shell (a plain string) still has words', () => {
    expect(messageOf('ffprobe could not read /Movies/Big.mkv')).toBe('ffprobe could not read /Movies/Big.mkv')
    expect(messageOf(new Error(NO_ANSWER))).toBe(NO_ANSWER)
  })
})

// SPEC-playback-2 (P14a): one resolve, a probe that never fails the play, and the error card.
describe('planStream (rules 1 and 2)', () => {
  const mp4: StreamProbe = { ...mkv, container: 'mov,mp4', audio: 'aac', direct: true, why: null }
  const got = (over: Partial<Resolved> = {}): Resolved => ({ url: 'https://cdn.example/f/a.mkv', status: 206, ranges: true, redirects: 1, ms: 20_000, ...over })
  /** A fake shell: resolve_stream and probe_stream answer from these, and every call is counted. */
  function shell(res: () => Promise<Resolved>, probe: (url: string) => Promise<StreamProbe>) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = []
    const call = <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args })
      return (cmd === 'resolve_stream' ? res() : probe(String(args!.url))) as Promise<T>
    }
    return { call, calls, n: (cmd: string) => calls.filter((c) => c.cmd === cmd).length }
  }
  const src = (u: string) => ({ input: u, user: '', pass: '' })
  const go = (u: string, f: ReturnType<typeof shell>, remux = false, signal = new AbortController().signal, lines: string[] = []) =>
    planStream(src(u), remux, (l) => lines.push(l), signal, f.call)

  it('case 1: a slow redirect to an MKV remuxes from the final URL; a warm-up and Play share one resolve', async () => {
    const f = shell(() => new Promise((ok) => setTimeout(() => ok(got()), 30)), async () => mkv)
    const u = 'https://addon.example/resolve/1/a'
    warmProbe(u, f.call)
    const plan = await go(u, f)
    expect(plan).toEqual({ remux: src('https://cdn.example/f/a.mkv'), probe: mkv, safe: false })
    expect(f.n('resolve_stream')).toBe(1)
    expect(f.calls.filter((c) => c.cmd === 'probe_stream').every((c) => c.args!.url === 'https://cdn.example/f/a.mkv')).toBe(true)
  })
  it('case 2: a redirect to an MP4 plays directly from the final URL', async () => {
    const f = shell(async () => got({ url: 'https://cdn.example/f/c.mp4', contentType: 'video/mp4' }), async () => mp4)
    expect(await go('https://addon.example/resolve/2/c', f)).toEqual({ direct: 'https://cdn.example/f/c.mp4', fallback: null })
  })
  it('case 3: a 404 after the redirect is the error, with no probe', async () => {
    const f = shell(() => Promise.reject('The server answered 404 Not Found.'), async () => mkv)
    await expect(go('https://addon.example/resolve/3/x', f)).rejects.toBe('The server answered 404 Not Found.')
    expect(f.n('probe_stream')).toBe(0)
  })
  it('case 4: a silent server counts the seconds from 5 s; closing at 10 s ends the wait; 90 s is the limit', async () => {
    vi.useFakeTimers()
    try {
      const f = shell(() => new Promise(() => {}), async () => mkv)
      const closed = new AbortController()
      const lines: string[] = []
      const plan = go('https://addon.example/resolve/4/never', f, false, closed.signal, lines)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(lines[0]).toBe('Waiting for the server…')
      expect(lines.at(-1)).toBe('Waiting for the server… 10 s')
      expect(lines).not.toContain('Waiting for the server… 4 s')
      closed.abort()
      expect(await plan).toBeNull()
      const n = lines.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(lines.length).toBe(n)
      expect(f.n('probe_stream')).toBe(0)
    } finally { vi.useRealTimers() }
    expect(RESOLVE_LIMIT_S).toBe(90)
    expect(NO_ANSWER).toBe('The server did not answer within 90 seconds.')
    expect([serverWait(900), serverWait(4999), serverWait(12_400)]).toEqual(['Waiting for the server…', 'Waiting for the server…', 'Waiting for the server… 12 s'])
  })
  it('case 5: a probe that fails on a video/mp4 answer plays directly, with the safe remux to fall back on', async () => {
    const f = shell(async () => got({ url: 'https://cdn.example/dl/5', contentType: 'video/mp4' }), () => Promise.reject('This stream could not be read: Invalid data'))
    expect(await go('https://addon.example/resolve/5/x', f)).toEqual({ direct: 'https://cdn.example/dl/5', fallback: src('https://cdn.example/dl/5') })
  })
  it('case 5, then: a decode or unsupported error on that direct play switches to the safe remux', () => {
    const fb = src('https://cdn.example/dl/5')
    expect(onMediaError(4, fb)).toBe(fb)
    expect(onMediaError(3, fb)).toBe(fb)
    expect(onMediaError(2, fb)).toBeNull()
    expect(onMediaError(4, null)).toBeNull()
  })
  it('case 6: a probe that times out on an MKV takes the safe-profile remux, and no line says the server did not answer', async () => {
    const f = shell(async () => got({ url: 'https://cdn.example/f/x.mkv', contentType: 'video/x-matroska' }), () => Promise.reject('timed out'))
    const lines: string[] = []
    expect(await go('https://addon.example/resolve/6/x', f, false, undefined, lines)).toEqual({ remux: src('https://cdn.example/f/x.mkv'), probe: SAFE, safe: true })
    expect(lines.some((l) => /did not answer/.test(l))).toBe(false)
  })
  it('a source that only plays through the remux takes the safe profile when its probe fails', async () => {
    const f = shell(async () => got({ url: 'http://kodi.lan/vfs/a.mp4', contentType: 'video/mp4' }), () => Promise.reject('no'))
    expect(await go('http://kodi.lan/vfs/a.mp4', f, true)).toEqual({ remux: src('http://kodi.lan/vfs/a.mp4'), probe: SAFE, safe: true })
  })
  it('a login stays with its own host after a redirect', async () => {
    const f = shell(async () => got({ url: 'https://elsewhere.example/a.mkv' }), async () => mkv)
    const plan = await planStream({ input: 'https://nas.example/a.mkv', user: 'u', pass: 'p' }, true, () => {}, new AbortController().signal, f.call)
    expect(plan).toEqual({ remux: { input: 'https://elsewhere.example/a.mkv', user: '', pass: '' }, probe: mkv, safe: false })
  })
  it('a safe run asks the desktop for the safe profile', async () => {
    const f = fake()
    const r = new Remux('https://cdn.example/x.mkv', SAFE, '', '', f.call, true)
    const opened = r.open(42)
    expect(f.pending[0].at).toBe(42)
    expect(f.calls[0].args!.safe).toBe(true)
    f.answer(0)
    await opened
    expect(r.duration(120)).toBe(120)
  })
  it('playsDirectly reads the type or the extension', () => {
    expect(playsDirectly('https://x/dl/1', 'video/mp4')).toBe(true)
    expect(playsDirectly('https://x/dl/1', 'application/vnd.apple.mpegurl')).toBe(true)
    expect(playsDirectly('https://x/a.webm?t=1', null)).toBe(true)
    expect(playsDirectly('https://x/a.mkv', 'video/x-matroska')).toBe(false)
    expect(playsDirectly('https://x/dl/1', 'application/octet-stream')).toBe(false)
  })
})

describe('the error card (rule 6, case 14)', () => {
  const plugin = { url: 'https://addon.example/resolve/realdebrid/KEY/x', ref: { t: 'plugin' } }
  it('a plugin stream offers another source and Back, never its link', () => {
    expect(cardButtons(plugin, false)).toEqual(['back', 'another'])
    expect(cardButtons(plugin, true)).toEqual(['back', 'another'])
  })
  it('a pasted link keeps Open stream URL; a stalled one also offers another source', () => {
    const pasted = { url: 'https://x/a.mp4', ref: { t: 'url' } }
    expect(cardButtons(pasted, false)).toEqual(['open', 'back'])
    expect(cardButtons(pasted, true)).toEqual(['open', 'back', 'another'])
    expect(cardButtons({ ref: { t: 'item' } }, false)).toEqual(['back'])
  })
})
