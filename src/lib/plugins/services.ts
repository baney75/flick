// Debrid services (plugins of kind `service`): the user's order, checking a key before it is saved,
// the account line Settings shows, and the resolve loop that waits while a service fetches a torrent.

import { computed } from '@preact/signals'
import { settings, setSettings } from '../store'
import { installed, install, remove, setPluginSettings, type Candidate } from './registry'
import { callPlugin, platformName, stopPlugin, type Installed } from './runtime'
import type { AccountResult, PluginManifest, ResolveResult } from './validate'

export type Service = Installed & { kind: 'service'; manifest: PluginManifest }
type Call = typeof callPlugin

/** The setting that holds a service's API key: its first password field. */
export const keyField = (m: PluginManifest): string | undefined => m.settings.find((f) => f.type === 'password')?.key
export const hasKey = (s: Service) => { const k = keyField(s.manifest); return !!k && typeof s.settings[k] === 'string' && s.settings[k] !== '' }

/** Ids in `order` first, in that order; the rest by name. */
export function ordered<T extends { id: string; manifest: { name: string } }>(list: T[], order: string[]): T[] {
  const at = (id: string) => { const i = order.indexOf(id); return i < 0 ? Infinity : i }
  return [...list].sort((a, b) => at(a.id) - at(b.id) || a.manifest.name.localeCompare(b.manifest.name))
}

/** Every installed service, in the user's order. */
export const allServices = computed(() => ordered(installed.value.filter((p): p is Service => p.kind === 'service'), settings.value.serviceOrder))
/** The services playback may use: on, with a key, in the desktop app. */
export const services = computed(() => (platformName() === 'desktop' ? allServices.value.filter((s) => s.enabled && hasKey(s)) : []))

export function moveService(id: string, by: -1 | 1) {
  const ids = allServices.value.map((s) => s.id)
  const i = ids.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  setSettings({ serviceOrder: ids })
}

export async function removeService(id: string) {
  await remove(id)
  setSettings({ serviceOrder: settings.value.serviceOrder.filter((x) => x !== id) })
}

/** "TorBox: Pro until 2027-03-01", or the service's own error. */
export function accountLine(name: string, r: AccountResult): string {
  if (!r.ok) return `${name}: ${r.message}`
  if (!r.plan && !r.expires) return `${name}: the key works`
  return `${name}: ${r.plan ?? 'premium'}${r.expires ? ` until ${r.expires}` : ''}`
}

/**
 * Check a key with the service before anything is saved: the plugin runs once with the key in a
 * record that is never stored. A good key is then saved (installing the service if it is new); a
 * bad one is dropped and the service's error comes back.
 */
export async function checkAndSave(from: Candidate | Service, key: string, call: Call = callPlugin): Promise<{ ok: boolean; line: string }> {
  const m = from.manifest as PluginManifest
  const field = keyField(m)
  const name = m.name
  if (!field) return { ok: false, line: `${name} has no key to set.` }
  key = key.trim()
  if (!key) return { ok: false, line: `Paste your ${name} API key.` }
  const isRec = 'installedAt' in from
  const old = isRec ? from : from.replaces
  const trial: Installed = {
    id: m.id, kind: 'service', url: from.url, code: from.code, sha256: from.sha256, manifest: m, enabled: true,
    official: from.official, settings: { ...old?.settings, [field]: key }, installedAt: 0, checkedAt: 0,
  }
  let r: AccountResult
  stopPlugin(m.id)
  try { r = await call(trial, 'account', []) } catch (e) { r = { ok: false, message: (e as Error).message } } finally { stopPlugin(m.id) }
  if (!r.ok) return { ok: false, line: accountLine(name, r) }
  if (isRec) await setPluginSettings(from.id, { [field]: key })
  else await install(from, { [field]: key })
  if (!settings.value.serviceOrder.includes(m.id)) setSettings({ serviceOrder: [...settings.value.serviceOrder, m.id] })
  return { ok: true, line: accountLine(name, r) }
}

export interface PollOptions {
  onWait?: (w: { pct?: number; message: string }) => void
  signal?: AbortSignal
  call?: Call
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  every?: number
  limit?: number
}

/**
 * Ask the service for a playable link, every 3 seconds while it answers `wait`, for at most
 * 10 minutes. Resolves to the https URL; rejects with the service's error, on timeout, or on abort.
 */
export async function resolveTorrent(s: Service, torrent: { infoHash: string; fileIdx?: number; name?: string }, o: PollOptions = {}): Promise<string> {
  const call = o.call ?? callPlugin
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const every = o.every ?? 3000
  const limit = o.limit ?? 10 * 60_000
  const start = now()
  for (;;) {
    if (o.signal?.aborted) throw new Error('Stopped.')
    const r: ResolveResult = await call(s, 'resolve', [torrent])
    if ('url' in r) return r.url
    if ('error' in r) throw new Error(r.error)
    o.onWait?.(r.wait)
    if (now() - start + every > limit) throw new Error(`${s.manifest.name} could not fetch this torrent in time.`)
    await sleep(every)
  }
}
