import { describe, it, expect } from 'vitest'
import { mbps, formatMbps, median, shouldStop, speedLabel, download, speedTest, RateMeter, readoutLabel, LIMIT_MS, type SpeedDeps } from '../src/lib/speed'

/** A fetch whose body yields `chunks` bytes each, moving a fake clock `step` ms per chunk. */
function fake(chunk: number, step: number, opts: { stall?: number; ping?: number[]; ttfb?: number; hang?: boolean } = {}) {
  let t = 0
  const pings = [...(opts.ping ?? [])]
  const urls: string[] = []
  const timers: [number, () => void][] = []
  const state = { pulls: 0 }
  const fire = () => { const [ms, fn] = timers.shift()!; t += ms; fn() }
  const d: SpeedDeps = {
    now: () => t,
    after: (ms, fn) => {
      const timer: [number, () => void] = [ms, fn]
      timers.push(timer)
      return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) }
    },
    fetch: async (url, init) => {
      urls.push(url)
      if (opts.hang) {
        queueMicrotask(fire)
        return new Promise((_, no) => init.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))))
      }
      if (url.endsWith('bytes=0')) { t += pings.shift() ?? 0; return new Response('') }
      t += opts.ttfb ?? 0
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          state.pulls++
          if (opts.stall !== undefined && sent >= opts.stall) {
            // The body stalls: a read is pending when the 10-second timer fires.
            init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
            queueMicrotask(fire)
            return new Promise(() => {})
          }
          sent += chunk
          t += step
          c.enqueue(new Uint8Array(chunk))
        },
      }, { highWaterMark: 0 }) // pull only on read, so the clock moves as the reader reads
      return new Response(body)
    },
  }
  return { d, urls, state }
}

describe('speed math', () => {
  it('turns bytes and time into Mbps', () => {
    expect(formatMbps(mbps(25_000_000, 1100))).toBe('182 Mbps')
    expect(mbps(25_000_000, 1100)).toBeCloseTo(181.8, 1)
    expect(formatMbps(mbps(8_000_000, 10_000))).toBe('6.4 Mbps')
    expect(mbps(100, 0)).toBe(0)
  })
  it('takes the median latency', () => {
    expect(median([30, 22, 25, 90, 24])).toBe(25)
    expect(median([10, 20])).toBe(15)
    expect(median([])).toBe(0)
  })
  it('stops at 25 MB or 10 seconds', () => {
    expect(shouldStop(24_999_999, 9_999)).toBe(false)
    expect(shouldStop(25_000_000, 1_100)).toBe(true)
    expect(shouldStop(8_000_000, 10_000)).toBe(true)
  })
  it('labels the result by the gate', () => {
    expect(speedLabel({ vpn: true, mbps: 181.8, ms: 24 })).toBe('VPN: 182 Mbps, 24 ms')
    expect(speedLabel({ vpn: false, mbps: 410, ms: 9 })).toBe('No VPN: 410 Mbps, 9 ms')
  })
})

describe('the speed test', () => {
  it('stops at 25 MB', async () => {
    const { d } = fake(1_000_000, 44) // 25 chunks in 1,100 ms
    const r = await download(d)
    expect(r).toEqual({ bytes: 25_000_000, ms: 1100 })
  })
  it('stops at 10 seconds with what it has', async () => {
    const { d } = fake(1_000_000, 1250) // 8 MB by 10 s
    const r = await download(d)
    expect(r).toEqual({ bytes: 8_000_000, ms: LIMIT_MS })
    expect(formatMbps(mbps(r.bytes, r.ms))).toBe('6.4 Mbps')
  })
  it('stops a stalled download at 10 seconds with what it has', async () => {
    const { d, state } = fake(1_000_000, 100, { stall: 3_000_000 })
    expect(await download(d)).toEqual({ bytes: 3_000_000, ms: LIMIT_MS })
    expect(state.pulls).toBe(4) // the fourth read was pending when the timer fired
  })
  it('fails when nothing arrives in 10 seconds', async () => {
    await expect(download(fake(1, 1, { stall: 0 }).d)).rejects.toThrow("didn't answer")
    await expect(download(fake(1, 1, { hang: true }).d)).rejects.toThrow("didn't answer")
  })
  it('times throughput from the first response, not the request', async () => {
    const { d } = fake(1_000_000, 44, { ttfb: 120 })
    expect(await download(d)).toEqual({ bytes: 25_000_000, ms: 1100 })
  })
  it('pings 5 times, then downloads, and labels by the gate', async () => {
    const { d, urls } = fake(1_000_000, 44, { ping: [30, 22, 25, 90, 24] })
    const pass = await speedTest(true, d)
    expect(urls.filter((u) => u.endsWith('bytes=0'))).toHaveLength(5)
    expect(urls.at(-1)).toBe('https://speed.cloudflare.com/__down?bytes=25000000')
    expect(speedLabel(pass)).toBe('VPN: 182 Mbps, 25 ms')
    const fail = await speedTest(false, fake(1_000_000, 44, { ping: [9, 9, 9, 9, 9] }).d)
    expect(speedLabel(fail).startsWith('No VPN:')).toBe(true)
  })
  it('gives up on pings that never answer, and on an error page', async () => {
    await expect(speedTest(true, fake(1, 1, { hang: true }).d)).rejects.toThrow("didn't answer")
    const d: SpeedDeps = { now: () => 0, after: () => () => {}, fetch: async () => new Response('', { status: 429 }) }
    await expect(speedTest(true, d)).rejects.toThrow('429')
  })
  it('reports a server error', async () => {
    const d: SpeedDeps = { now: () => 0, after: () => () => {}, fetch: async () => new Response('', { status: 503 }) }
    await expect(download(d)).rejects.toThrow('503')
  })
})

describe('the live readout', () => {
  it('counts the bytes of the last 5 seconds', () => {
    const m = new RateMeter(-1_000)
    m.add(5_000_000, 0)
    m.add(2_500_000, 3_000)
    m.add(2_500_000, 4_000)
    expect(formatMbps(m.mbps(4_000))).toBe('16 Mbps')
    expect(formatMbps(m.mbps(6_000))).toBe('8 Mbps')
    expect(m.mbps(20_000)).toBe(0)
  })
  it('divides by its age while younger than 5 seconds', () => {
    const m = new RateMeter(0)
    m.add(1_000_000, 1_000)
    expect(formatMbps(m.mbps(1_000))).toBe('8 Mbps')
    expect(formatMbps(m.mbps(2_000))).toBe('4 Mbps')
  })
  it('says whether the stream goes through the VPN', () => {
    expect(readoutLabel(12.4, true)).toBe('12 Mbps via VPN')
    expect(readoutLabel(3.25, false)).toBe('3.3 Mbps, no VPN')
  })
})
