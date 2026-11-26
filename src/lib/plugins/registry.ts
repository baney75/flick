// Installed plugins and themes: install from a URL, file or text, keep code and its SHA-256 in
// IndexedDB, turn on and off, remove, and check each plugin URL for updates once a day.

import { signal } from '@preact/signals'
import * as db from '../db'
import { announce } from '../sync/bus'
import * as V from './validate'
import { inspect as sandboxInspect, registerHosts, sha256, stopPlugin, pushSettings, type Installed } from './runtime'

export type { Installed }
export const OFFICIAL_INDEX = '/plugins/index.json'
const DAY = 24 * 60 * 60 * 1000
const MAX_CODE = 2 * 1024 * 1024

export const installed = signal<Installed[]>([])

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
export interface OfficialEntry { url: string; name: string; description?: string; kind?: 'source' | 'service' | 'theme' }
let official: Promise<OfficialEntry[]> | null = null
export function officialList(): Promise<OfficialEntry[]> {
  official ??= fetch(OFFICIAL_INDEX).then((r) => r.json()).then((j) => (Array.isArray(j?.plugins) ? j.plugins : [])).catch(() => { official = null; return [] })
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
async function isOfficial(url: string | null): Promise<boolean> {
  if (!url) return false
  return (await officialList()).some((e) => absolute(e.url) === absolute(url))
}

// ---------- install ----------
/** Read code from a URL or text and check it. Nothing is saved until install(). */
export async function prepare(src: { url?: string; text?: string }, deps: Deps = live): Promise<Candidate> {
  const url = src.url?.trim() || null
  if (url && !/^(https:\/\/|\/)/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url)) throw new Error('A plugin address must start with https://.')
  const code = src.text ?? (await deps.fetchText(url!))
  if (code.length > MAX_CODE) throw new Error('That file is over 2 MB, too big for a plugin.')
  let kind: Candidate['kind'] = 'source'
  let manifest: Candidate['manifest']
  let json: unknown
  try { json = JSON.parse(code) } catch { json = undefined }
  if (json !== undefined) {
    kind = 'theme'
    manifest = V.validateTheme(json)
  } else {
    const r = await deps.inspect(code)
    const m = V.validateManifest(r.manifest, r.fns)
    kind = m.kind
    manifest = m
  }
  const replaces = installed.value.find((p) => p.id === manifest.id)
  return { kind, url, code, sha256: await sha256(code), manifest, official: await isOfficial(url), replaces }
}

async function save(rec: Installed) {
  await db.put('plugins', rec.id, rec)
  installed.value = [...installed.value.filter((p) => p.id !== rec.id), rec].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  announce('plugins')
}

export async function install(c: Candidate, settings?: Record<string, unknown>): Promise<Installed> {
  const old = c.replaces ?? installed.value.find((p) => p.id === c.manifest.id)
  if (old) stopPlugin(old.id)
  const rec: Installed = {
    id: c.manifest.id,
    kind: c.kind,
    url: c.url,
    code: c.code,
    sha256: c.sha256,
    manifest: c.manifest,
    enabled: old?.enabled ?? true,
    official: c.official,
    settings: { ...defaults(c.manifest), ...old?.settings, ...settings },
    installedAt: old?.installedAt ?? Date.now(),
    checkedAt: Date.now(),
  }
  await save(rec)
  await registerHosts(rec).catch(() => {})
  return rec
}

export async function loadPlugins() {
  const rows = await db.all<Installed>('plugins')
  installed.value = rows.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
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
