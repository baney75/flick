// How app state maps onto synced keys.
//   p:i:<content key>  watch progress for a library item
//   p:k:<key>          watch progress for anything else (plugins, URLs), keyed as on every device
//   a:<addon url>      retired: Stremio addons before the Stremio plugin; read once by the migration
//   x:<plugin url>     an installed plugin or theme: { on, settings } with secret settings left out, or null once removed
//   v:<server id>      a Plex or Jellyfin server connection
//   s:settings         player settings
//
// A file in a local folder has a different path, and so a different item id, on each device.
// Progress for it syncs under a content key built from the parsed name instead, so
// "Show S01E02" on the Mac and the same episode on the phone share one position.

import type { Item } from '../library'
import type { Progress } from '../store'
import { portable, publicSettings, type Installed, type Candidate } from '../plugins/registry'
import { addedPermissions, type PluginManifest } from '../plugins/validate'

const LOCAL = new Set(['local', 'stored'])

// Keeps letters and digits of every script, so 進撃の巨人 and Брат get real keys.
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function contentKey(i: Pick<Item, 'id' | 'origin' | 'kind' | 'title' | 'show' | 'season' | 'episode' | 'year' | 'size'>): string {
  // Server items have the same id on every device that connects to the same server.
  if (!LOCAL.has(i.origin)) return `id:${i.id}`
  // A special with no episode number keeps its own title so specials do not share a key.
  if (i.show) return `ep:${norm(i.show)}:${i.season ?? 1}:${i.episode ?? `x ${norm(i.title)}`}`
  // Song titles repeat across albums ("Intro"); the same file copied between devices keeps its size.
  if (i.kind === 'audio') return `au:${norm(i.title)}:${i.size}`
  return `mv:${norm(i.title)}:${i.year ?? ''}`
}

// The synced key for a progress row here, or null when the item is gone from this library.
export function progressDocKey(key: string, p: Pick<Progress, 'ref'>, byId: Map<string, Item>): string | null {
  if (p.ref.t !== 'item') return `p:k:${key}`
  const it = byId.get(p.ref.id)
  return it ? `p:i:${contentKey(it)}` : null
}

// The local progress keys a synced progress key lands on. An item key can match several
// copies of the same episode; one with no match here is kept in the doc until it shows up.
export function localProgressKeys(docKey: string, byContent: Map<string, string[]>): string[] {
  if (docKey.startsWith('p:k:')) return [docKey.slice(4)]
  if (docKey.startsWith('p:i:')) return byContent.get(docKey.slice(4)) ?? []
  return []
}

/**
 * What syncs for each installed plugin: by URL, on or off, non-secret settings. File installs stay local,
 * and so do service plugins: one is no use without its key, and the key never leaves the device.
 */
export function pluginSnapshot(list: Installed[]): Map<string, string> {
  return new Map(list.flatMap((p) => {
    const url = p.url && p.kind !== 'service' ? portable(p.url) : null
    if (!url) return []
    const m = p.manifest as Partial<PluginManifest>
    const v: SyncedPlugin = { on: p.enabled, settings: publicSettings(p), sha256: p.sha256, hosts: m.hosts ?? [], tools: m.tools ?? [] }
    return [[`x:${url}`, JSON.stringify(v)] as [string, string]]
  }))
}

/** A plugin as it syncs: on or off, non-secret settings, and the code and permissions its owner reviewed. */
export interface SyncedPlugin { on: boolean; settings: Record<string, unknown>; sha256?: string; hosts?: string[]; tools?: string[] }

/**
 * Whether code fetched for a plugin synced from another device may install with no review here: the same
 * code that was reviewed there, or new code that asks for no host or tool beyond what was reviewed.
 */
export function mayInstallSynced(v: SyncedPlugin, c: Candidate): boolean {
  if (c.kind === 'service') return false
  if (v.sha256 && c.sha256 === v.sha256) return true
  if (c.kind === 'theme') return true
  return addedPermissions({ hosts: v.hosts ?? [], tools: v.tools ?? [] }, c.manifest as PluginManifest).length === 0
}

export function contentIndex(items: Item[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const it of items) {
    const k = contentKey(it)
    const l = m.get(k)
    if (l) l.push(it.id)
    else m.set(k, [it.id])
  }
  return m
}
