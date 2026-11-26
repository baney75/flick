// What this device can show and decode, for the ranker in pick.ts. Detection only, never synced:
// the same account picks 4K on the TV and 1080p on the laptop.

import type { Codec } from './release'
import type { Device, MaxQuality } from './pick'
import { displaySizes, isDesktop, isMobileApp, isPhone } from './platform'

/** The quality a screen shows, from its longest side in device pixels. */
export function qualityForSide(px: number): MaxQuality {
  return px >= 3000 ? '4K' : px >= 1700 ? '1080p' : px >= 1100 ? '720p' : 'SD'
}

const PROBES: Record<Codec, string> = {
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  h264: 'video/mp4; codecs="avc1.640028"',
}

/** What detection reads; the browser gives it in device(), tests pass their own. */
export interface DeviceEnv {
  screen: { width: number; height: number }
  dpr: number
  /** Display sizes in device pixels the desktop shell reports (attached monitors included), if any. */
  displays?: { width: number; height: number }[]
  hdr: boolean
  /** MediaSource.isTypeSupported, when there is one. */
  mse?: (type: string) => boolean
  /** video.canPlayType: '', 'maybe' or 'probably'. */
  canPlay?: (type: string) => string
  desktop: boolean
  phone: boolean
}

/** Plays when either probe says so; cannot only when every probe there is says no. */
function codecSupport(env: DeviceEnv, type: string): boolean | undefined {
  const mse = env.mse?.(type)
  const tag = env.canPlay?.(type)
  if (mse || tag === 'probably') return true
  if (mse === undefined && tag === undefined) return undefined
  return (mse === undefined || mse === false) && (tag === undefined || tag === '') ? false : undefined
}

export function detect(env: DeviceEnv): Device {
  const screenSide = Math.round(Math.max(env.screen.width, env.screen.height) * env.dpr)
  const sides = (env.displays ?? []).map((d) => Math.max(d.width, d.height))
  const codecs: Device['codecs'] = {}
  for (const k of Object.keys(PROBES) as Codec[]) {
    const v = codecSupport(env, PROBES[k])
    if (v !== undefined) codecs[k] = v
  }
  return {
    maxQuality: qualityForSide(sides.length ? Math.max(...sides) : screenSide),
    hdr: env.hdr,
    codecs,
    desktop: env.desktop,
    phone: env.phone,
  }
}

/** The read-only Settings row: "This device: 1080p, SDR, plays HEVC and AV1". */
export function deviceLine(d: Device): string {
  const plays = (['hevc', 'av1'] as Codec[]).filter((k) => d.codecs[k]).map((k) => (k === 'hevc' ? 'HEVC' : 'AV1'))
  return [`This device: ${d.maxQuality}`, d.hdr ? 'HDR' : 'SDR', ...(plays.length ? [`plays ${plays.join(' and ')}`] : [])].join(', ')
}

/** This device now, read from the browser and, in the desktop app, the displays the shell reports. */
export async function readDevice(): Promise<Device> {
  const video = document.createElement('video')
  const ms = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
  const desktop = isDesktop && !isMobileApp
  return detect({
    screen: { width: screen.width, height: screen.height },
    dpr: devicePixelRatio || 1,
    displays: desktop ? await displaySizes() : undefined,
    hdr: matchMedia('(dynamic-range: high)').matches,
    mse: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined,
    canPlay: (t) => video.canPlayType(t),
    desktop,
    phone: isPhone,
  })
}
