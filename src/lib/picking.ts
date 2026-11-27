// What the views hand the ranker: the user's preferences, this device and the moment's context.
import { effect, signal } from '@preact/signals'
import { settings, progress, nowPlaying, notify } from './store'
import { deviceNow, readDevice } from './device'
import { needsGate, type Device, type PickCtx, type Prefs, type Ranked } from './pick'
import type { RankBy } from './titles'
import { progressKey } from './plugins/use'
import type { Src } from './titles'
import { installed } from './plugins/registry'
import type { PluginManifest } from './plugins/validate'
import type { Debrid, ServiceInfo } from './candidates'
import { services as playable } from './plugins/services'
import { mayAsk, resolveOrder, type CachedMap } from './debrid-play'
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
 * and never ok on the website or a phone. Pages start it with watchGate only for a torrent or
 * debrid stream (wantsGate), so a title with only direct links runs no exit check.
 */
export const gate = signal<Gate | null>(null)
export const VPN_DROPPED = "Your VPN dropped or isn't hiding you, so playback stopped. Reconnect it and press Play."
export const OUTSIDE_GATE = "Opens outside Flick, where the VPN gate can't cover it"
export const NO_WATCH = "Flick can't watch the VPN right now, so it won't play this. Restart Flick and try again."
/** Resolves true once the change event is heard, false if it cannot be; null before watchGate. */
let listening: Promise<boolean> | null = null
/** What plays through the gate now: the shell's hold id and the PlayRequest key, so a failure stops it. */
let held: { id: string; key: string } | null = null
/** Taps on streams so far; a newer tap supersedes one still on its way to play. */
let taps = 0
/** A tap on a stream starts here, and carries its number to holdGate and play. */
export const tap = () => ++taps
/** Whether tap `t` is still the newest, so it may play. */
export const current = (t: number) => t === taps
/** Failures the change event has reported, so a hold in flight knows one came meanwhile. */
let drops = 0

const release = (id: string) => { invoke('vpn_gate_release', { id }).catch(() => {}) }

/** Lets the held stream go: it stopped, or a stream that needs no gate replaced it. */
export function releaseGate() {
  if (held) release(held.id)
  held = null
}

function onGate(g: Gate) {
  gate.value = g
  if (g.ok) return
  drops++
  if (held) {
    releaseGate()
    nowPlaying.value = null
    notify(VPN_DROPPED, 6000)
  }
}

export function watchGate() {
  if (listening || !isDesktop || isMobileApp) return
  let heard = false, deaf = false
  listening = onDesktopEvent<Gate>('vpn-gate', (g) => { heard = true; onGate(g) }).then(() => true, () => {
    // No drop can reach a player, so nothing gated may play; the next page tries again.
    deaf = true
    listening = null
    gate.value = { ok: false, message: NO_WATCH }
    return false
  })
  // The first answer, unless a change event already came with a newer one.
  invoke<Gate>('vpn_gate', { force: false }).then(
    (g) => { if (!heard && !deaf) gate.value = g },
    (e) => { if (!heard && !deaf) gate.value = { ok: false, message: String(e) } },
  )
}

// Leaving the held stream lets it go, so the next one must pass the gate again.
effect(() => {
  const now = nowPlaying.value
  if (held && now?.key !== held.key) releaseGate()
})

/**
 * Right before a gated stream plays: the gate passes now and watches `key` until it stops, or it
 * fails and nothing plays. On the website and phones there is no gate, so it always fails. A drop
 * reported while the hold is on its way fails it too; the user presses Play again.
 */
export async function holdGate(key: string, t = tap()): Promise<Gate> {
  if (!isDesktop || isMobileApp) return { ok: false, message: DESKTOP_ONLY }
  watchGate()
  if (!(await listening)) return { ok: false, message: NO_WATCH }
  // Each tap holds under its own id, so a stale tap letting go never frees a newer one's hold.
  const id = `${key}#${t}`
  const seen = drops
  const g = await invoke<Gate>('vpn_gate_hold', { id }).catch((e): Gate => ({ ok: false, message: String(e) }))
  // A newer tap won while this hold was on its way: it plays nothing and holds nothing.
  if (!current(t)) {
    if (g.ok) release(id)
    return { ok: false, message: null }
  }
  if (drops !== seen) {
    if (g.ok) release(id)
    return { ok: false, message: VPN_DROPPED }
  }
  gate.value = g
  if (!g.ok) return g
  // The old hold goes only once the new one holds; a failed tap leaves what plays alone.
  if (held) release(held.id)
  held = { id, key }
  return g
}

/**
 * Why a stream behind the gate stays shut on a tap: the gate fails, or it would open outside the
 * gate's hold (a book in the reader, a link in the browser). Undefined when it may play.
 */
export function shutFor(r: Ranked | undefined, vpnForDebrid: boolean): string | undefined {
  if (!r || !needsGate(r.c, vpnForDebrid)) return undefined
  return r.c.external || r.c.media === 'book' ? OUTSIDE_GATE : r.blocked
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
const debridNeedsVpn = () => settings.value.debridNeedsVpn === true

export function ctxNow(): Omit<PickCtx, 'picked'> {
  const windows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
  const c: Omit<PickCtx, 'picked'> = {
    gate: gate.value?.ok === true,
    vpnForDebrid: debridNeedsVpn(),
    online: typeof navigator === 'undefined' || navigator.onLine,
  }
  const why = noEngineFor({ desktop: isDesktop, mobile: isMobileApp, windows })
  if (why) c.noEngine = why
  if (!isDesktop || isMobileApp) c.noGate = DESKTOP_ONLY
  const m = lastMbps()
  if (m) c.mbps = m
  return c
}

const known = () => installed.value.filter((p) => p.kind === 'service')
const infoOf = (p: { id: string; manifest: object }): ServiceInfo => {
  const m = p.manifest as PluginManifest
  return { id: p.id, vpnOptional: m.vpnOptional === true, debridHosts: (m.debridHosts ?? []).map((h) => h.toLowerCase().replace(/^\.+|\.+$/g, '')) }
}

/**
 * The debrid services the ranker knows. Every installed one marks its download hosts (SPEC-debrid
 * rule 6), enabled or not. A torrent goes to the services set up to play (on, with a key, in the
 * desktop app) that Flick may ask now (`resolveOrder`); with none set up it stays peer to peer.
 * `cached` holds the title page's lookups.
 */
export function debridNow(cached: CachedMap = {}): Debrid {
  const order = resolveOrder(playable.value.map(infoOf), gate.value?.ok === true, debridNeedsVpn())
  return { known: known().map(infoOf), order, cached: (svc, hash) => cached[svc]?.includes(hash) === true }
}

/** Whether Flick may ask this service anything now (SPEC-debrid Amendment 1), read live. */
export const mayAskNow = (s: { id: string; manifest: object }) => mayAsk(infoOf(s), gate.value?.ok === true, debridNeedsVpn())
/** The services set up to play that Flick may ask now, in the user's order. */
export const askable = () => playable.value.filter(mayAskNow)

/** A service's name for the pick line ("TorBox instant"). */
export const serviceName = (id: string) => known().find((p) => p.id === id)?.manifest.name ?? id

const srcProgress = (s: Src): number | undefined => {
  const p = progress.value
  if (s.t === 'item') return p[s.it.id]?.at
  if (s.t === 'plugin') return p[progressKey(s.p, s.m.id)]?.at ?? s.m.progress?.at
  return undefined
}

export function rankBy(): RankBy {
  return { prefs: prefsNow(), dev: deviceFor(), ctx: ctxNow(), progressAt: srcProgress }
}
