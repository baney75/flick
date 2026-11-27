// Debrid services (plugins of kind `service`): the user's order, checking a key before it is saved,
// the account line Settings shows, and the resolve loop that waits while a service fetches a torrent.

import { computed } from '@preact/signals'
import { settings, setSettings } from '../store'
import { carried, installed, install, officialList, prepare, remove, setPluginSettings, type Candidate } from './registry'
import { findDebridKeys, type FoundKey } from './debrid-keys'
import { callPlugin, platformName, registerHosts, stopPlugin, type Installed } from './runtime'
import { PluginError, validateResolve, type AccountResult, type PluginManifest, type ResolveResult } from './validate'

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
  // A new service that takes over another plugin's id never runs with that plugin's other keys.
  const kept = isRec ? from.settings : carried(from)
  // The trial runs in its own sandbox under its own id, so a running copy of the service is left alone;
  // the desktop app checks its fetches against this manifest's hosts, registered when it starts.
  const trial: Installed = {
    id: `${m.id}#trial`, kind: 'service', url: from.url, code: from.code, sha256: from.sha256, manifest: m, enabled: true,
    official: from.official, settings: { ...kept, [field]: key }, installedAt: 0, checkedAt: 0,
  }
  let r: AccountResult
  try { r = await call(trial, 'account', []) } catch (e) { r = { ok: false, message: (e as Error).message } } finally {
    stopPlugin(trial.id)
    await registerHosts({ ...trial, enabled: false }).catch(() => {})
  }
  if (!r.ok) return { ok: false, line: accountLine(name, r) }
  if (isRec) await setPluginSettings(from.id, { [field]: key })
  else await install(from, { [field]: key })
  if (!settings.value.serviceOrder.includes(m.id)) setSettings({ serviceOrder: [...settings.value.serviceOrder, m.id] })
  return { ok: true, line: accountLine(name, r) }
}

// ---------- keys from the user's Stremio addons ----------
export const STREMIO_ID = 'dev.flick.stremio'

/**
 * Keys found in these addon URLs for services that have no key yet. A saved key is never replaced
 * from here (that is the row's Change key), and a plugin not from Flick never gets a found key.
 */
export function keyOffers(urls: string[], list: Service[] = allServices.value): FoundKey[] {
  return findDebridKeys(urls).filter((f) => {
    const s = list.find((x) => x.id === f.serviceId)
    return !s || (s.official && !hasKey(s))
  })
}

/** The bundled Stremio plugin's addon URLs, when it is installed and on; [] otherwise. */
export async function stremioAddonUrls(call: Call = callPlugin): Promise<string[]> {
  const rec = installed.value.find((p) => p.id === STREMIO_ID && p.official && p.enabled && p.kind === 'source')
  if (!rec || !(rec.manifest as PluginManifest).has.addonUrls) return []
  try { return await call(rec, 'addonUrls', []) } catch { return [] }
}

/** The user pressed "Use the TorBox key from your Torrentio setup": check it and save it like a pasted key. */
export async function takeFoundKey(f: FoundKey, call: Call = callPlugin, find: (f: FoundKey) => Promise<Candidate> = officialCandidate): Promise<{ ok: boolean; line: string }> {
  const have = allServices.value.find((s) => s.id === f.serviceId)
  if (have && !have.official) throw new Error(`${have.manifest.name} is not from Flick, so Flick will not give it your ${f.service} key.`)
  if (have && hasKey(have)) throw new Error(`${have.manifest.name} already has a key. Use Change key in its row to replace it.`)
  return checkAndSave(have ?? (await find(f)), f.key, call)
}
async function officialCandidate(f: FoundKey): Promise<Candidate> {
  const e = (await officialList()).find((o) => o.kind === 'service' && o.name === f.service)
  if (!e) throw new Error(`Flick has no ${f.service} service to add.`)
  const c = await prepare({ url: e.url })
  if (c.manifest.id !== f.serviceId) throw new Error(`Flick's ${f.service} plugin is not the one this key is for.`)
  return c
}

export interface PollOptions {
  onWait?: (w: { pct?: number; message: string }) => void
  signal?: AbortSignal
  call?: Call
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  every?: number
  limit?: number
}

/**
 * Ask the service for a playable link, every 3 seconds while it answers `wait`, for at most
 * 10 minutes. Resolves to the https URL; rejects with the service's error, on timeout, or on abort.
 */
/** A service's link for a torrent, and the played file's size when it says. */
export interface Resolved { url: string; bytes?: number }

export async function resolveTorrent(s: Service, torrent: { infoHash: string; fileIdx?: number; name?: string; episode?: { season: number; episode: number } }, o: PollOptions = {}): Promise<Resolved> {
  const call = o.call ?? callPlugin
  const sleep = o.sleep ?? ((ms, signal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) }))
  const now = o.now ?? Date.now
  const every = o.every ?? 3000
  const limit = o.limit ?? 10 * 60_000
  const start = now()
  const stopped = () => { if (o.signal?.aborted) throw new Error('Stopped.') }
  for (;;) {
    stopped()
    let r: ResolveResult | null = null
    let failed: Error | null = null
    // One failed call (a dropped connection, a slow answer) is asked again at the next step; a bad
    // answer (a link off the plugin's hosts) is not.
    try { r = validateResolve(await call(s, 'resolve', [torrent]), s.manifest.hosts) } catch (e) {
      if (e instanceof PluginError) throw e
      failed = e as Error
    }
    stopped()
    if (r && 'url' in r) return r.bytes ? { url: r.url, bytes: r.bytes } : { url: r.url }
    if (r && 'error' in r) throw new Error(r.error)
    if (r) o.onWait?.(r.wait)
    if (now() - start + every > limit) throw failed && !r ? failed : new Error(`${s.manifest.name} could not fetch this torrent in time.`)
    await sleep(every, o.signal)
    stopped()
  }
}
