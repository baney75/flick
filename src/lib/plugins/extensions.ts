// Addons inside a source plugin (Stremio's addons): list, browse, read one before adding, add, remove.
// Flick calls these only when the user taps (SPEC-plugins-hub rules 9 to 12). An address is checked
// here before the plugin sees it, and settings the plugin hands back are saved through the registry.

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
  const asked = V.extensionUrl(url)
  const e = await deps.call(rec, 'inspectExtension', [{ url: asked }])
  // The confirm step shows this row; it must describe the address that addExtension will get.
  if (hostOf(e.url) !== hostOf(asked)) throw new Error(`${e.name} answered for ${hostOf(e.url)}, not ${hostOf(asked)}.`)
  return e
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

export { maskUrl } from './debrid-keys'
