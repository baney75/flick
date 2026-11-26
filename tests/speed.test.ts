import { describe, it, expect } from 'vitest'
import { mbps, formatMbps, median, shouldStop, speedLabel, download, speedTest, RateMeter, readoutLabel, LIMIT_MS, type SpeedDeps } from '../src/lib/speed'

/** A fetch whose body yields `chunks` bytes each, moving a fake clock `step` ms per chunk. */
function fake(chunk: number, step: number, opts: { stall?: boolean; ping?: number[] } = {}) {
  let t = 0
  const pings = [...(opts.ping ?? [])]
  const urls: string[] = []
  const d: SpeedDeps = {
    now: () => t,
    after: (ms, fn) => {
      if (opts.stall) queueMicrotask(() => { t += ms; fn() })
      return () => {}
    },
    fetch: async (url, init) => {
      urls.push(url)
      if (url.endsWith('bytes=0')) { t += pings.shift() ?? 0; return new Response('') }
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (opts.stall) {
            init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
            return new Promise(() => {})
          }
          t += step
          c.enqueue(new Uint8Array(chunk))
        },
      }, { highWaterMark: 0 }) // pull only on read, so the clock moves as the reader reads
      return new Response(body)
    },
  }
  return { d, urls, clock: () => t }
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
  it('stops a stalled download at 10 seconds', async () => {
    const { d } = fake(0, 0, { stall: true })
    expect(await download(d)).toEqual({ bytes: 0, ms: LIMIT_MS })
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
  it('reports a server error', async () => {
    const d: SpeedDeps = { now: () => 0, after: () => () => {}, fetch: async () => new Response('', { status: 503 }) }
    await expect(download(d)).rejects.toThrow('503')
  })
})

describe('the live readout', () => {
  it('counts the bytes of the last 5 seconds', () => {
    const m = new RateMeter()
    m.add(5_000_000, 0)
    m.add(2_500_000, 3_000)
    m.add(2_500_000, 4_000)
    expect(formatMbps(m.mbps(4_000))).toBe('16 Mbps')
    expect(formatMbps(m.mbps(6_000))).toBe('8 Mbps')
    expect(m.mbps(20_000)).toBe(0)
  })
  it('says whether the stream goes through the VPN', () => {
    expect(readoutLabel(12.4, true)).toBe('12 Mbps via VPN')
    expect(readoutLabel(3.25, false)).toBe('3.3 Mbps, no VPN')
  })
})
