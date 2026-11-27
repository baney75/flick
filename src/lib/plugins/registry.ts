// Installed plugins and themes: install from a URL, file or text, keep code and its SHA-256 in
// IndexedDB, turn on and off, remove, and check each plugin URL for updates once a day.

import { signal } from '@preact/signals'
import * as db from '../db'
import { announce } from '../sync/bus'
import * as V from './validate'
import { inspect as sandboxInspect, registerHosts, sha256, stopPlugin, pushSettings, type Installed } from './runtime'
import { mark } from './trace'

export type { Installed }
export const OFFICIAL_INDEX = '/plugins/index.json'
const DAY = 24 * 60 * 60 * 1000
const MAX_CODE = 2 * 1024 * 1024

export const installed = signal<Installed[]>([])
/** True once loadPlugins has read the installed list, so a page can tell "not installed" from "not read yet". */
export const pluginsLoaded = signal(false)

export interface Candidate {
  kind: 'source' | 'service' | 'theme'
  url: string | null
  code: string
  sha256: string
  manifest: V.PluginManifest | V.ThemeManifest
  official: boolean
  /** The installed copy this would replace, if any. */
  replaces?: Installed
}

export interface Deps {
  fetchText: (url: string) => Promise<string>
  inspect: (code: string) => Promise<{ manifest: unknown; fns: string[] }>
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { cache: 'no-store', credentials: 'omit' })
  if (!r.ok) throw new Error(`${url} answered ${r.status}.`)
  return r.text()
}
const live: Deps = { fetchText, inspect: sandboxInspect }

export function isSecret(rec: Pick<Installed, 'kind' | 'manifest'>, key: string): boolean {
  if (rec.kind === 'theme') return false
  return (rec.manifest as V.PluginManifest).settings.some((f) => f.key === key && f.secret)
}

/** Settings that may leave the device: everything but secret fields. */
export function publicSettings(rec: Installed): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rec.settings).filter(([k]) => !isSecret(rec, k)))
}

function defaults(m: V.PluginManifest | V.ThemeManifest): Record<string, unknown> {
  if (!('settings' in m)) return {}
  return Object.fromEntries(m.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]))
}

// ---------- the official list ----------
export interface OfficialEntry { url: string; name: string; description?: string; kind?: 'source' | 'service' | 'theme'; hosts?: string[] }
let official: Promise<OfficialEntry[]> | null = null
/** True while the last read of the official list failed. */
let listFailed = false
export function officialList(): Promise<OfficialEntry[]> {
  official ??= fetch(OFFICIAL_INDEX).then((r) => r.json()).then((j) => { listFailed = false; return Array.isArray(j?.plugins) ? j.plugins : [] }).catch(() => { official = null; listFailed = true; return [] })
  return official
}
/**
 * A plugin address as it travels to another device, by sync or a setup link: a bundled plugin by its
 * /plugins/ path (each device serves its own copy), anything else only as https. Null when another
 * device could not use it (a localhost or app-only address).
 */
export function portable(url: string): string | null {
  const bundled = /^\/plugins\/[\w.-]+$/
  if (bundled.test(url)) return url
  const a = absolute(url)
  try {
    const u = new URL(a)
    if (typeof location !== 'undefined' && u.origin === location.origin && bundled.test(u.pathname)) return u.pathname
  } catch { return null }
  return /^https:\/\//i.test(a) ? a : null
}

export function absolute(url: string): string {
  try { return new URL(url, typeof location === 'undefined' ? 'https://flick-player.pages.dev' : location.href).href } catch { return url }
}
/** Whether a URL is on Flick's own list; null when the list could not be read. */
async function isOfficial(url: string | null): Promise<boolean | null> {
  if (!url) return false
  const list = await officialList()
  if (listFailed) return null
  return list.some((e) => absolute(e.url) === absolute(url))
}

// ---------- install ----------
/** Runs one install step; a failure says which step it was, and the Add sheet shows that as given. */
async function step<T>(name: string, f: () => T | Promise<T>): Promise<T> {
  try { return await f() } catch (e) { throw new Error(`${name} failed: ${e instanceof Error ? e.message : String(e)}`) }
}

/** Read code from a URL or text and check it. Nothing is saved until install(). */
export async function prepare(src: { url?: string; text?: string }, deps: Deps = live): Promise<Candidate> {
  const url = src.url?.trim() || null
  if (url && !/^(https:\/\/|\/)/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url)) throw new Error('A plugin address must start with https://.')
  const code = src.text ?? (await step('Downloading the plugin', () => deps.fetchText(url!)))
  mark('fetch')
  if (code.length > MAX_CODE) throw new Error('That file is over 2 MB, too big for a plugin.')
  let kind: Candidate['kind'] = 'source'
  let manifest: Candidate['manifest']
  let json: unknown
  try { json = JSON.parse(code) } catch { json = undefined }
  if (json !== undefined) {
    kind = 'theme'
    manifest = await step('Checking the theme', () => V.validateTheme(json))
  } else {
    const r = await step('Starting the plugin', () => deps.inspect(code))
    const m = await step('Checking the plugin', () => V.validateManifest(r.manifest, r.fns))
    kind = m.kind
    manifest = m
  }
  const replaces = installed.value.find((p) => p.id === manifest.id)
  const sum = await sha256(code)
  mark('sha')
  // An unreadable list never makes an update from the same address look like a takeover.
  const same = replaces?.url != null && url != null && absolute(replaces.url) === absolute(url)
  const isOff = (await isOfficial(url)) ?? (same ? replaces!.official : false)
  mark('official')
  return { kind, url, code, sha256: sum, manifest, official: isOff, replaces }
}

async function save(rec: Installed) {
  await db.put('plugins', rec.id, rec)
  installed.value = [...installed.value.filter((p) => p.id !== rec.id), rec].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  announce('plugins')
}

/**
 * Whether a candidate takes over an installed plugin's id rather than updating it: it comes from another
 * address (a chosen file never proves it is the same one), it is or stops being Flick's own, or it is a
 * different kind. A takeover keeps none of the old plugin's secret settings or saved data.
 */
export function takesOver(c: Pick<Candidate, 'url' | 'official' | 'kind'>, old: Pick<Installed, 'url' | 'official' | 'kind'> | undefined): boolean {
  if (!old) return false
  const same = old.url != null && c.url != null && absolute(old.url) === absolute(c.url)
  return !same || old.official !== c.official || old.kind !== c.kind
}

/** The installed plugin's settings that carry over to a candidate: all of them on an update, none secret in either version on a takeover. */
export function carried(c: Candidate, old = c.replaces ?? installed.value.find((p) => p.id === c.manifest.id)): Record<string, unknown> {
  if (!old) return {}
  if (!takesOver(c, old)) return old.settings
  const next = { kind: c.kind, manifest: c.manifest }
  return Object.fromEntries(Object.entries(old.settings).filter(([k]) => !isSecret(old, k) && !isSecret(next, k)))
}

/** Where a plugin came from, as the review sheet says it: Flick, a file, or the address's host. */
export function origin(p: Pick<Candidate, 'url' | 'official'>): string {
  if (p.official) return 'Flick'
  if (!p.url) return 'a file'
  try { return new URL(absolute(p.url)).host || p.url } catch { return p.url }
}

/** The review sheet's warning for a takeover, or null for an install or an update. */
export function replaceLine(c: Candidate): string | null {
  const old = c.replaces
  if (!old || !takesOver(c, old)) return null
  return `This replaces ${old.manifest.name} from ${origin(old)} with a plugin from ${origin(c)}. Its saved keys and data are cleared.`
}

export async function install(c: Candidate, settings?: Record<string, unknown>): Promise<Installed> {
  const old = c.replaces ?? installed.value.find((p) => p.id === c.manifest.id)
  if (old) stopPlugin(old.id)
  const takeover = takesOver(c, old)
  const rec: Installed = {
    id: c.manifest.id,
    kind: c.kind,
    url: c.url,
    code: c.code,
    sha256: c.sha256,
    manifest: c.manifest,
    enabled: old?.enabled ?? true,
    official: c.official,
    settings: { ...defaults(c.manifest), ...carried(c, old), ...settings },
    installedAt: old?.installedAt ?? Date.now(),
    checkedAt: Date.now(),
  }
  await step('Saving the plugin', () => save(rec))
  // Only once the new plugin is saved, so a failed save leaves the old one whole.
  if (takeover) await step('Clearing the old plugin', () => db.del('pluginData', rec.id))
  mark('save')
  await registerHosts(rec).catch(() => {})
  mark('registerHosts')
  return rec
}

/** Flick's own YouTube plugin, bundled with the app. */
export const YOUTUBE_PLUGIN = { id: 'com.youtube', url: '/plugins/youtube.js' }

/** SPEC-plugins-hub rule 13: Home search offers YouTube on the desktop until it is installed, on or off. */
export function offersYouTube(desktop: boolean, list: Pick<Installed, 'id'>[]): boolean {
  return desktop && !list.some((p) => p.id === YOUTUBE_PLUGIN.id)
}

/** Installs Flick's own YouTube plugin. Home calls it only from a tap. */
export async function addYouTube(deps: Deps = live): Promise<Installed> {
  return install(await prepare({ url: YOUTUBE_PLUGIN.url }, deps))
}

/** A record an older Flick stored, brought up to today's manifest shape. */
function upgrade(r: Installed): Installed {
  if (r.kind === 'theme') return r
  const m = r.manifest as V.PluginManifest
  // A service installed while prepare() still called every plugin a source gets its kind back.
  const kind = r.kind === 'source' && m.kind === 'service' ? 'service' : r.kind
  const fill = (x: V.PluginManifest) => ({ ...x, titleActions: x.titleActions ?? [] })
  const pending = r.pending && { ...r.pending, manifest: fill(r.pending.manifest as V.PluginManifest) }
  return { ...r, kind, manifest: fill(m), ...(pending ? { pending } : {}) }
}

export async function loadPlugins() {
  let rows: Installed[]
  try {
    rows = (await db.all<Installed>('plugins')).map(upgrade)
    installed.value = rows.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  } finally {
    pluginsLoaded.value = true
  }
  for (const r of rows) await registerHosts(r).catch(() => {})
}

export async function setEnabled(id: string, enabled: boolean) {
  const rec = installed.value.find((p) => p.id === id)
  if (!rec) return
  stopPlugin(id)
  const next = { ...rec, enabled }
  await save(next)
  await registerHosts(next).catch(() => {})
}

export async function setPluginSettings(id: string, patch: Record<string, unknown>) {
  const rec = installed.value.find((p) => p.id === id)
  if (!rec) return
  const next = { ...rec, settings: { ...rec.settings, ...patch } }
  await save(next)
  pushSettings(next)
}

export async function remove(id: string) {
  const rec = installed.value.find((p) => p.id === id)
  stopPlugin(id)
  await db.del('plugins', id)
  await db.del('pluginData', id)
  installed.value = installed.value.filter((p) => p.id !== id)
  announce('plugins')
  if (rec) await registerHosts({ ...rec, enabled: false }).catch(() => {})
}

// ---------- updates ----------
/**
 * Check each plugin URL once a day. New code with no new hosts or tools replaces the old quietly;
 * new permissions wait in `pending` until the user accepts them.
 */
export async function checkUpdates(now = Date.now(), deps: Deps = live, force = false): Promise<string[]> {
  const notes: string[] = []
  for (const rec of installed.value) {
    if (!rec.url || (!force && now - rec.checkedAt < DAY)) continue
    try {
      const code = await deps.fetchText(absolute(rec.url))
      const sum = await sha256(code)
      if (sum === rec.sha256 || sum === rec.pending?.sha256) { await save({ ...rec, checkedAt: now }); continue }
      const c = await prepare({ url: rec.url, text: code }, deps)
      if (c.manifest.id !== rec.id) throw new Error('the new code has a different id')
      if (c.kind !== rec.kind) throw new Error('the new code is a different kind of plugin')
      const added = c.kind !== 'theme' ? V.addedPermissions(rec.manifest as V.PluginManifest, c.manifest as V.PluginManifest) : []
      if (added.length) {
        await save({ ...rec, checkedAt: now, pending: { code, sha256: sum, manifest: c.manifest, added } })
        notes.push(`${rec.manifest.name} has an update that asks to ${added.join(', ')}.`)
      } else {
        stopPlugin(rec.id)
        const { pending: _, ...rest } = rec
        await save({ ...rest, code, sha256: sum, manifest: c.manifest, checkedAt: now })
      }
    } catch (e) {
      await save({ ...rec, checkedAt: now })
      notes.push(`${rec.manifest.name}: update check failed, ${(e as Error).message}`)
    }
  }
  return notes
}

/** The user tapped to accept an update's new permissions. */
export async function acceptUpdate(id: string) {
  const rec = installed.value.find((p) => p.id === id)
  if (!rec?.pending) return
  stopPlugin(id)
  const { pending, ...rest } = rec
  const next = { ...rest, code: pending.code, sha256: pending.sha256, manifest: pending.manifest }
  await save(next)
  await registerHosts(next).catch(() => {})
}
