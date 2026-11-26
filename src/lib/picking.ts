// What the views hand the ranker: the user's preferences, this device and the moment's context.
import { effect, signal } from '@preact/signals'
import { settings, progress, nowPlaying, notify } from './store'
import { deviceNow, readDevice } from './device'
import type { Device, PickCtx, Prefs } from './pick'
import type { RankBy } from './titles'
import { progressKey } from './plugins/use'
import type { Src } from './titles'
import { installed } from './plugins/registry'
import type { PluginManifest } from './plugins/validate'
import type { Debrid } from './candidates'
import { invoke, isDesktop, isMobileApp, onDesktopEvent } from './platform'
import { DESKTOP_ONLY, type Gate } from '../views/Vpn'

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

/**
 * The VPN gate (SPEC-torrent rules 25 to 30). It fails closed: null until the desktop app answers,
 * and never ok on the website or a phone. Pages start it with watchGate only when a stream needs
 * it, so a title with no torrent or gated debrid stream runs no exit check.
 */
export const gate = signal<Gate | null>(null)
export const VPN_DROPPED = "Your VPN dropped or isn't hiding you, so playback stopped. Reconnect it and press Play."
let watching = false
/** What plays through the gate now (a PlayRequest key), so a failure stops it. */
let held: string | null = null

/** Failures the change event has reported, so a hold in flight knows one came meanwhile. */
let drops = 0

function onGate(g: Gate) {
  gate.value = g
  if (!g.ok) drops++
  if (!g.ok && held) {
    held = null
    nowPlaying.value = null
    notify(VPN_DROPPED, 6000)
  }
}

export function watchGate() {
  if (watching || !isDesktop || isMobileApp) return
  watching = true
  let heard = false
  onDesktopEvent<Gate>('vpn-gate', (g) => { heard = true; onGate(g) }).catch(() => {})
  // The first answer, unless a change event already came with a newer one.
  invoke<Gate>('vpn_gate', { force: false }).then(
    (g) => { if (!heard) gate.value = g },
    (e) => { if (!heard) gate.value = { ok: false, message: String(e) } },
  )
  // Leaving the held stream lets it go, so the next one must pass the gate again.
  effect(() => {
    const now = nowPlaying.value
    if (held && now?.key !== held) {
      invoke('vpn_gate_release', { id: held }).catch(() => {})
      held = null
    }
  })
}

/**
 * Right before a gated stream plays: the gate passes now and watches `key` until it stops, or it
 * fails and nothing plays. On the website and phones there is no gate, so it always fails.
 */
export async function holdGate(key: string): Promise<Gate> {
  if (!isDesktop || isMobileApp) return { ok: false, message: DESKTOP_ONLY }
  watchGate()
  const seen = drops
  let g = await invoke<Gate>('vpn_gate_hold', { id: key }).catch((e): Gate => ({ ok: false, message: String(e) }))
  // A failure reported while the hold was on its way is newer than its answer.
  if (drops !== seen) {
    if (g.ok) invoke('vpn_gate_release', { id: key }).catch(() => {})
    g = gate.value ?? { ok: false }
  } else gate.value = g
  if (held && held !== key) invoke('vpn_gate_release', { id: held }).catch(() => {})
  held = g.ok ? key : null
  return g
}

export const WINDOWS_NO_ENGINE = 'Torrents play on Windows through a debrid service for now'
export const NO_ENGINE_YET = 'Torrents play through a debrid service for now'
/** SPEC-torrent's built-in engine sets this once it plays on macOS and Linux. */
const ENGINE = false

/** Why this platform cannot play a torrent from peers; undefined when it can. */
export function noEngineFor(p: { desktop: boolean; mobile: boolean; windows: boolean }): string | undefined {
  if (!p.desktop || p.mobile) return DESKTOP_ONLY
  if (p.windows) return WINDOWS_NO_ENGINE
  return ENGINE ? undefined : NO_ENGINE_YET
}

/** Settings > Streaming services' "Require a VPN for debrid services too" (SPEC-debrid rule 10), off by default. */
const debridNeedsVpn = () => (settings.value as { debridNeedsVpn?: unknown }).debridNeedsVpn === true

export function ctxNow(): Omit<PickCtx, 'picked'> {
  const windows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
  const c: Omit<PickCtx, 'picked'> = {
    gate: gate.value?.ok === true,
    vpnForDebrid: debridNeedsVpn(),
    online: typeof navigator === 'undefined' || navigator.onLine,
  }
  const why = noEngineFor({ desktop: isDesktop, mobile: isMobileApp, windows })
  if (why) c.noEngine = why
  const m = lastMbps()
  if (m) c.mbps = m
  return c
}

const services = () => installed.value.filter((p) => p.kind === 'service')

/**
 * The debrid services the ranker knows. Every installed one marks its download hosts (SPEC-debrid
 * rule 6), enabled or not. Resolving torrents through them is SPEC-debrid's playback, so until
 * that lands no service is set up to resolve one here and a torrent stream ranks as peer to peer.
 */
export function debridNow(): Debrid {
  const known = services().map((p) => {
    const m = p.manifest as PluginManifest
    return { id: p.id, vpnOptional: m.vpnOptional === true, debridHosts: m.debridHosts ?? [] }
  })
  return { known, order: [] }
}

/** A service's name for the pick line ("TorBox instant"). */
export const serviceName = (id: string) => services().find((p) => p.id === id)?.manifest.name ?? id

const srcProgress = (s: Src): number | undefined => {
  const p = progress.value
  if (s.t === 'item') return p[s.it.id]?.at
  if (s.t === 'plugin') return p[progressKey(s.p, s.m.id)]?.at ?? s.m.progress?.at
  return undefined
}

export function rankBy(): RankBy {
  return { prefs: prefsNow(), dev: deviceFor(), ctx: ctxNow(), progressAt: srcProgress }
}
