// Addons inside a source plugin (Stremio's addons): list, browse, read one before adding, add, remove.
// Flick calls these only when the user taps (SPEC-plugins-hub rules 9 to 12). An address is checked
// here before the plugin sees it, and settings the plugin hands back are saved through the registry.

import { findDebridKeys, keyEnd } from './debrid-keys'
import { setPluginSettings } from './registry'
import { callPlugin, type Installed } from './runtime'
import * as V from './validate'

export interface Deps {
  call: typeof callPlugin
  saveSettings: (id: string, patch: Record<string, unknown>) => Promise<void>
}
const live: Deps = { call: callPlugin, saveSettings: setPluginSettings }

export const hasExtensions = (rec: Installed) => rec.kind === 'source' && (rec.manifest as V.PluginManifest).has.extensions === true

export const listExtensions = (rec: Installed, deps: Deps = live) => deps.call(rec, 'extensions', [])

export const browseExtensions = (rec: Installed, search = '', deps: Deps = live) =>
  deps.call(rec, 'extensionCatalog', [search.trim() ? { search: search.trim() } : {}])

/** Read the addon at an address so the user sees its name, types and host before adding it. Nothing is saved. */
export async function inspectExtension(rec: Installed, url: string, deps: Deps = live): Promise<V.Extension> {
  return deps.call(rec, 'inspectExtension', [{ url: V.extensionUrl(url) }])
}

async function apply(rec: Installed, r: V.ExtensionResult, deps: Deps): Promise<V.ExtensionResult> {
  if (r.ok && r.settings) await deps.saveSettings(rec.id, r.settings)
  return r
}

/** The user confirmed adding this addon. An address that is not https:// or stremio:// never reaches the plugin. */
export async function addExtension(rec: Installed, url: string, deps: Deps = live): Promise<V.ExtensionResult> {
  return apply(rec, await deps.call(rec, 'addExtension', [{ url: V.extensionUrl(url) }]), deps)
}

export async function removeExtension(rec: Installed, id: string, deps: Deps = live): Promise<V.ExtensionResult> {
  return apply(rec, await deps.call(rec, 'removeExtension', [{ id }]), deps)
}

export function hostOf(url: string): string {
  try { return new URL(url.replace(/^stremio:/i, 'https:')).hostname } catch { return '' }
}

const DOTS = '•••'

/**
 * An addon address as Flick shows it: any debrid key in it cut to its last 4 characters
 * (`torbox=abc123XYZ9` shows as `torbox=•••XYZ9`). A key inside an encoded config hides that whole part.
 */
export function maskUrl(url: string): string {
  const keys = findDebridKeys([url.replace(/^stremio:/i, 'https:')]).map((f) => f.key)
  let out = url
  for (const k of keys) {
    const shown = DOTS + keyEnd(k)
    if (out.includes(k)) out = out.split(k).join(shown)
    else if (out.includes(encodeURIComponent(k))) out = out.split(encodeURIComponent(k)).join(shown)
    else out = out.replace(/\/([^/]{16,})(?=\/)/g, (_, seg: string) => `/${DOTS}${seg.slice(-4)}`)
  }
  return out
}
