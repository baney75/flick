// SPEC-playback cases 4, 5 and 6: where a seek goes, the remux run's clock, and the probe cache.
import { describe, expect, it, vi } from 'vitest'
import { convertLine, DWELL_MS, intent, planSeek, probeStream, Remux, SLOW_SERVER, writtenOf, type StreamProbe } from '../src/lib/playback'

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
    const call = <T,>() => { n++; return (n === 1 ? Promise.reject(new Error(SLOW_SERVER)) : Promise.resolve(mkv)) as Promise<T> }
    await expect(probeStream('https://x/once.mkv', '', '', call)).rejects.toThrow(SLOW_SERVER)
    expect(await probeStream('https://x/once.mkv', '', '', call)).toEqual(mkv)
    expect(await probeStream('https://x/once.mkv', '', '', call)).toEqual(mkv)
    expect(n).toBe(2)
  })
  it('case 11: names what ffmpeg converts', () => {
    expect(convertLine({ convertsAudio: true, convertsVideo: false })).toBe('Converting audio for this Mac…')
    expect(convertLine({ convertsAudio: false, convertsVideo: true })).toBe('Converting video for this Mac…')
    expect(convertLine({ convertsAudio: false, convertsVideo: false })).toBe('Converting the file for this Mac…')
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
