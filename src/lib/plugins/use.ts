// What the views need from plugins: the enabled sources, themes, routes and search across sources.

import { computed, signal } from '@preact/signals'
import { go, notify } from '../store'
import { installed, loadPlugins, checkUpdates } from './registry'
import { callPlugin, platformName, type Installed } from './runtime'
import type { CatalogDef, Meta, PluginManifest, ThemeManifest } from './validate'

export type Source = Installed & { manifest: PluginManifest }

export const sources = computed(() =>
  installed.value.filter((p): p is Source => p.kind === 'source' && p.enabled && (p.manifest as PluginManifest).platforms.includes(platformName())),
)
export const themes = computed(() => installed.value.filter((p) => p.kind === 'theme').map((p) => p.manifest as ThemeManifest))

export const sourceById = (id: string) => sources.value.find((p) => p.id === id)

export const progressKey = (p: string, videoId: string) => `pl:${p}:${videoId}`

export function titlePath(p: string, type: string, id: string, videoId?: string) {
  const v = videoId && videoId !== id ? `?v=${encodeURIComponent(videoId)}` : ''
  return `/p/${encodeURIComponent(p)}/${type}/${encodeURIComponent(id)}${v}`
}
export function openPluginRef(r: { p: string; type: string; id: string; videoId: string }) {
  go(titlePath(r.p, r.type, r.id, r.videoId))
}

export async function startPlugins() {
  await loadPlugins()
  // The daily update check waits until Flick is up, so it never slows the first screen.
  setTimeout(() => {
    checkUpdates().then((notes) => notes.forEach((n) => notify(n, 8000))).catch(() => {})
  }, 8000)
}

// library() results, kept a few minutes so Home and the plugin page share one call.
export const libraries = signal<Record<string, Meta[]>>({})
const libraryAt = new Map<string, number>()
export async function loadLibrary(rec: Source, force = false) {
  if (!rec.manifest.has.library) return
  if (!force && Date.now() - (libraryAt.get(rec.id) ?? 0) < 5 * 60_000) return
  libraryAt.set(rec.id, Date.now())
  try {
    const list = await callPlugin(rec, 'library', [])
    libraries.value = { ...libraries.value, [rec.id]: list }
  } catch { libraryAt.delete(rec.id) }
}
/** Library items with a saved position, newest first. */
export const continueOf = (list: Meta[]) => list.filter((m) => (m.progress?.pos ?? 0) > 0).sort((a, b) => (b.progress!.at ?? 0) - (a.progress!.at ?? 0))

export interface Found { rec: Source; catalog: CatalogDef; items: Meta[] }

/** Search every enabled source's search catalogs. Results come back as each one answers. */
export function searchAll(term: string, onFound: (f: Found) => void, only?: Source): Promise<void> {
  const jobs = (only ? [only] : sources.value).flatMap((rec) =>
    rec.manifest.catalogs.filter((c) => c.search).map(async (c) => {
      try {
        const r = await callPlugin(rec, 'catalog', [{ id: c.id, type: c.type, search: term, skip: 0 }])
        if (r.items.length) onFound({ rec, catalog: c, items: r.items })
      } catch { /* one source failing should not stop the rest */ }
    }),
  )
  return Promise.all(jobs).then(() => {})
}
