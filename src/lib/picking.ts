// What the views hand the ranker: the user's preferences, this device and the moment's context.
import { signal } from '@preact/signals'
import { settings, progress } from './store'
import { deviceNow, readDevice } from './device'
import type { Device, PickCtx, Prefs } from './pick'
import type { RankBy } from './titles'
import { progressKey } from './plugins/use'
import type { Src } from './titles'

/** This device; the browser's answer first, then the desktop shell's display list once it comes. */
export const device = signal<Device | null>(null)
let reading = false
export function deviceFor(): Device {
  if (!device.value) device.value = deviceNow()
  if (!reading) { reading = true; readDevice().then((d) => { device.value = d }, () => {}) }
  return device.value
}

/** The newest speed test from Settings > Privacy (SPEC-torrent rule 32); Flick never runs one to pick. */
function lastMbps(): number | undefined {
  try { return (JSON.parse(localStorage.getItem('flick.speedTest') || 'null') as { mbps?: number } | null)?.mbps } catch { return undefined }
}

export function prefsNow(): Prefs {
  const s = settings.value
  return { audio: s.audio, subs: s.subs, maxQuality: s.maxQuality }
}

export function ctxNow(): Omit<PickCtx, 'picked'> {
  // Only direct sources reach the ranker so far, so the VPN gate does not decide anything yet.
  const c: Omit<PickCtx, 'picked'> = { gate: false, vpnForDebrid: true, online: typeof navigator === 'undefined' || navigator.onLine }
  const m = lastMbps()
  if (m) c.mbps = m
  return c
}

const srcProgress = (s: Src): number | undefined => {
  const p = progress.value
  if (s.t === 'item') return p[s.it.id]?.at
  if (s.t === 'plugin') return p[progressKey(s.p, s.m.id)]?.at ?? s.m.progress?.at
  return undefined
}

export function rankBy(): RankBy {
  return { prefs: prefsNow(), dev: deviceFor(), ctx: ctxNow(), progressAt: srcProgress }
}
