// Checks every plugin manifest, theme and plugin result against the shapes in docs/PLUGINS.md.
// Self-contained on purpose: the app and scripts/plugin-check.mjs (Node) load this same file.

export const API = 1
/** Flick's own types. A plugin may also name a kind of its own ("podcast", "recipe"): see KIND_RE. */
export const TYPES = ['movie', 'series', 'video', 'channel', 'audio', 'audiobook', 'book'] as const
/** A plugin's own kind: opaque to Flick, never merged with another source's titles, passed back unchanged. */
export const KIND_RE = /^[a-z][a-z0-9-]{1,31}$/
export const TOOLS = ['ytdlp'] as const
/** `source` plugins add titles and streams; `service` plugins (debrid) turn a torrent into an https link. */
export const KINDS = ['source', 'service'] as const
export const PROVIDES = ['debrid'] as const
/** Most infoHashes Flick sends one cached() call. */
export const HASHES_PER_CALL = 100
export const PLATFORMS = ['web', 'desktop', 'mobile'] as const
export const CALL_TIMEOUT_MS = 20_000
export const STORE_LIMIT = 1024 * 1024

export type BuiltinType = (typeof TYPES)[number]
export type MetaType = BuiltinType | (string & {})
export const isBuiltinType = (t: string): t is BuiltinType => (TYPES as readonly string[]).includes(t)
export type Platform = (typeof PLATFORMS)[number]

export interface Field { key: string; label: string; type: 'text' | 'password' | 'select' | 'toggle' | 'list'; options?: string[]; default?: unknown; secret?: boolean; help?: string }
export interface ActionDef { id: string; label: string; fields: Field[] }
export interface CatalogDef { id: string; name: string; type: MetaType; search?: boolean }
/** A button on every title page of this plugin, like Like or Watch later; `key` is its one-letter shortcut. */
export interface TitleActionDef { id: string; label: string; key?: string }
export interface PluginManifest {
  api: 1
  kind: (typeof KINDS)[number]
  id: string
  name: string
  version: string
  author: string
  description: string
  icon?: string
  hosts: string[]
  tools: string[]
  platforms: Platform[]
  settings: Field[]
  actions: ActionDef[]
  catalogs: CatalogDef[]
  /** How the plugin's page shows its catalogs: `rows` (default) or `grid` (one chip per catalog, a grid of cards). */
  layout: 'rows' | 'grid'
  titleActions: TitleActionDef[]
  /** A service plugin: what it provides, and the hosts its download links come from (all also in `hosts`). */
  provides: string[]
  debridHosts: string[]
  /** A service whose downloads come over https from its own servers, so no peer sees the user: it may play with no VPN. */
  vpnOptional: boolean
  /** Optional functions the plugin has. */
  has: { library: boolean; action: boolean; progress: boolean; subtitles: boolean; userCatalogs: boolean; addonUrls: boolean; extensions: boolean }
}
export interface Video { id: string; title: string; season?: number; episode?: number; released?: string; thumbnail?: string; overview?: string }
export interface Meta {
  id: string
  type: MetaType
  name: string
  poster?: string
  posterShape?: 'poster' | 'square' | 'landscape'
  background?: string
  description?: string
  year?: string
  genres?: string[]
  runtime?: string
  /** Ids of the plugin's titleActions that are on for this title (it is liked, it is in Watch later). */
  marks?: string[]
  /** One line under the name on a card: a channel, an author. */
  subtitle?: string
  /** Up to 4 short facts on a card and the title page: "1.2M views", "3 years ago". */
  badges?: string[]
  videos?: Video[]
  progress?: { pos: number; dur: number; at: number; videoId?: string }
  /** Ids of the library shelves this item sits on (library() only). */
  shelves?: string[]
  /** When it was added, in milliseconds since epoch. */
  added?: number
  /** Up to 8 labeled facts for the title page: Servings 4, Platform Switch. */
  facts?: Fact[]
}
export interface Fact { label: string; value: string }
/** A named group in a plugin's library ("Liked", "Subscribed"); a chip in Library. */
export interface Shelf { id: string; name: string; layout?: 'poster' | 'square' | 'landscape' | 'list'; order?: 'plugin' | 'added' | 'name' | 'year' }
export interface Library { shelves: Shelf[]; items: Meta[] }
/** A validator's note about what it dropped, for the plugin's log. */
export type Note = (text: string) => void
export interface Sub { url: string; lang: string; label?: string }
/** A torrent the desktop app plays through its engine or a debrid service (SPEC-torrent rule 2). */
export interface Torrent { infoHash: string; fileIdx?: number; name?: string; trackers?: string[] }
/** A stream has a `url`, or a `torrent` in its place. */
export interface Stream { url?: string; torrent?: Torrent; title?: string; quality?: string; kind?: 'video' | 'audio' | 'book'; subs?: Sub[]; needsDesktop?: boolean; external?: boolean; group?: string }
export interface CatalogResult { items: Meta[]; more: boolean }
export interface ActionResult { ok: boolean; message?: string }
/** One addon inside a source (a Stremio addon): what extensions() and extensionCatalog() list. */
export interface Extension { id: string; name: string; description?: string; logo?: string; url: string; types?: string[]; removable: boolean; installed?: boolean }
/** addExtension() and removeExtension(): new values for the plugin's own declared settings may come back. */
export interface ExtensionResult extends ActionResult { settings?: Record<string, unknown> }
export interface TitleActionResult { ok: boolean; on: boolean; message?: string }
export type AccountResult = { ok: true; name: string; plan?: string; expires?: string } | { ok: false; message: string }
export type ResolveResult = { url: string; bytes?: number } | { wait: { pct?: number; message: string } } | { error: string }

export interface ThemeColors { bg: string; surface: string; fg: string; dim: string; line: string; accent: string }
export interface ThemeManifest { flick: 'theme'; api: 1; id: string; name: string; version: string; author: string; light: ThemeColors; dark: ThemeColors; radius?: number; font?: string }

export class PluginError extends Error {}
const fail = (msg: string): never => { throw new PluginError(msg) }

const MAX_STR = 2000
const MAX_LIST = 500
const MAX_ITEMS = 200
export const MAX_LIBRARY = 1000
export const MAX_SHELVES = 20
const MAX_ITEM_SHELVES = 8
const MAX_FACTS = 8
const SHELF_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const LAYOUTS = ['poster', 'square', 'landscape', 'list'] as const
const ORDERS = ['plugin', 'added', 'name', 'year'] as const
const kindWords = `one of ${TYPES.join(', ')} or a kind of your own (2 to 32 lowercase letters, digits and -, like "podcast")`
const metaType = (x: unknown, what: string): MetaType => (typeof x === 'string' && KIND_RE.test(x) ? x : fail(`${what} "${String(x)}" is not ${kindWords}.`))
/** Display text that never throws: a string (trimmed) or a number, else undefined. */
const shortText = (x: unknown, max: number): string | undefined =>
  typeof x === 'string' ? x.trim().slice(0, max) || undefined : typeof x === 'number' && Number.isFinite(x) ? String(x) : undefined
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/
export const HASH_RE = /^[0-9a-f]{40}$/
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function str(x: unknown, what: string, required: true, max?: number): string
function str(x: unknown, what: string, required?: false, max?: number): string | undefined
function str(x: unknown, what: string, required = false, max = MAX_STR): string | undefined {
  if (x === undefined || x === null || x === '') return required ? fail(`${what} is missing.`) : undefined
  if (typeof x === 'number') x = String(x)
  if (typeof x !== 'string') return fail(`${what} must be text.`)
  const s = x.trim().slice(0, max)
  return s || (required ? fail(`${what} is missing.`) : undefined)
}
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
function list(x: unknown, what: string, max = MAX_LIST): unknown[] {
  if (x === undefined || x === null) return []
  if (!Array.isArray(x)) return fail(`${what} must be a list.`)
  return x.slice(0, max)
}

/** An image or link: http(s) or an image data: URI. Anything else is dropped. */
function imgUrl(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined
  const u = x.trim()
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(u) && u.length < 200_000) return u
  return /^https?:\/\//i.test(u) && u.length <= MAX_STR ? u : undefined
}

/** A host pattern from `hosts`: `*`, `*.example.com`, `example.com`, `127.0.0.1` or `[::1]`. */
export function validHost(h: string): boolean {
  if (h === '*') return true
  const name = h.startsWith('*.') ? h.slice(2) : h
  return /^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/.test(name)
}

/** Whether a host name is on a list of named hosts: `x` is that host, `*.x` its subdomains. `*` matches nothing here. */
export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : p !== '*' && h === p))
}

function field(x: unknown, where: string): Field {
  if (!isObj(x)) return fail(`Each ${where} field must be an object.`)
  const key = str(x.key, `A ${where} field key`, true, 64)
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) fail(`The ${where} field key "${key}" may use only letters, digits, _ . and -.`)
  const type = x.type ?? 'text'
  if (type !== 'text' && type !== 'password' && type !== 'select' && type !== 'toggle' && type !== 'list') fail(`The field "${key}" has an unknown type.`)
  const f: Field = { key, label: str(x.label, `The label of "${key}"`) ?? key, type: type as Field['type'] }
  if (type === 'select') f.options = list(x.options, `The options of "${key}"`).map((o) => str(o, 'An option', true, 200))
  if (x.default !== undefined) f.default = type === 'toggle' ? !!x.default : type === 'list' ? list(x.default, 'A default').map((o) => str(o, 'A list item', true)) : str(x.default, 'A default')
  if (x.secret === true || type === 'password') f.secret = true
  const help = str(x.help, 'Help')
  if (help) f.help = help
  return f
}

/** Check a plugin's exported object (functions already reduced to their names). Throws a plain-words error. */
export function validateManifest(x: unknown, fns: string[]): PluginManifest {
  if (!isObj(x)) return fail('The plugin must export a default object.')
  if (x.api !== API) fail(`This plugin uses API ${String(x.api)}; this Flick reads API ${API}.`)
  const id = str(x.id, 'id', true, 128)
  if (!ID_RE.test(id)) fail(`id "${id}" must be reverse-DNS style and lowercase, like "org.example.films".`)
  const hosts = list(x.hosts, 'hosts', 100).map((h) => str(h, 'A host', true, 253).toLowerCase())
  for (const h of hosts) if (!validHost(h)) fail(`"${h}" is not a host name. Use names like "example.com" or "*.example.com".`)
  const tools = list(x.tools, 'tools', 10).map((t) => str(t, 'A tool', true))
  for (const t of tools) if (!(TOOLS as readonly string[]).includes(t)) fail(`Flick has no desktop tool called "${t}".`)
  const kind = x.kind ?? 'source'
  if (!(KINDS as readonly unknown[]).includes(kind)) fail(`Flick has no plugin kind called "${String(kind)}".`)
  // A service holds the user's key; only the desktop app holds it to its hosts and to https.
  const platforms = (x.platforms === undefined ? (kind === 'service' ? ['desktop'] : [...PLATFORMS]) : list(x.platforms, 'platforms')) as string[]
  for (const p of platforms) if (!(PLATFORMS as readonly string[]).includes(p)) fail(`Unknown platform "${p}".`)
  if (kind === 'service' && platforms.join() !== 'desktop') fail('A service plugin works only in the desktop app: platforms: ["desktop"].')
  let catalogs: CatalogDef[] = [], provides: string[] = [], debridHosts: string[] = []
  if (x.vpnOptional !== undefined && typeof x.vpnOptional !== 'boolean') fail('vpnOptional must be true or false.')
  if (x.vpnOptional !== undefined && kind !== 'service') fail('Only a service plugin can set vpnOptional.')
  if (kind === 'service') {
    provides = list(x.provides, 'provides', 10).map((p) => str(p, 'A provides entry', true, 40))
    if (!provides.length) fail('A service plugin must say what it provides, like provides: ["debrid"].')
    for (const p of provides) if (!(PROVIDES as readonly string[]).includes(p)) fail(`Flick has no service called "${p}".`)
    for (const f of ['account', 'cached', 'resolve']) if (!fns.includes(f)) fail(`The plugin needs a ${f}() function.`)
    if (!hosts.length) fail('A service plugin must list the hosts it reaches.')
    if (hosts.some((h) => h === '*')) fail('A service plugin must name its hosts; "*" is not allowed.')
    if (tools.length) fail('A service plugin cannot use desktop tools.')
    if (EXTENSION_FNS.some((f) => fns.includes(f))) fail('A service plugin cannot host addons.')
    debridHosts = list(x.debridHosts, 'debridHosts', 50).map((h) => str(h, 'A debridHosts entry', true, 253).toLowerCase())
    for (const h of debridHosts) if (!hosts.includes(h)) fail(`debridHosts entry "${h}" must also be in hosts.`)
  } else {
    for (const f of ['catalog', 'meta', 'streams']) if (!fns.includes(f)) fail(`The plugin needs a ${f}() function.`)
    catalogs = validateCatalogDefs(x.catalogs)
    if (!catalogs.length) fail('The plugin needs at least one catalog.')
  }
  const settings = list(x.settings, 'settings', 50).map((f) => field(f, 'setting'))
  const actions = list(x.actions, 'actions', 20).map((a): ActionDef => {
    if (!isObj(a)) return fail('Each action must be an object.')
    return { id: str(a.id, 'An action id', true, 64), label: str(a.label, 'An action label', true, 100), fields: list(a.fields, 'Action fields', 20).map((f) => field(f, 'action')) }
  })
  if (actions.length && !fns.includes('action')) fail('The plugin lists actions but has no action() function.')
  const extFns = EXTENSION_FNS.filter((f) => fns.includes(f))
  if (extFns.length && extFns.length < EXTENSION_FNS.length) fail(`A plugin with addons needs all of ${EXTENSION_FNS.map((f) => `${f}()`).join(', ')}.`)
  if (Array.isArray(x.titleActions) && x.titleActions.length > 6) fail(`The plugin lists ${x.titleActions.length} title actions; at most 6 are allowed.`)
  const titleActions = kind === 'service' ? [] : list(x.titleActions, 'titleActions', 6).map((a): TitleActionDef => {
    if (!isObj(a)) return fail('Each title action must be an object.')
    const t: TitleActionDef = { id: str(a.id, 'A title action id', true, 32), label: str(a.label, 'A title action label', true, 40) }
    if (!/^[a-z0-9_-]+$/.test(t.id)) fail(`The title action id "${t.id}" may use only lowercase letters, digits, _ and -.`)
    const key = str(a.key, 'A title action key', false, 1)?.toLowerCase()
    if (a.key !== undefined && (!key || !/^[a-z]$/.test(key) || String(a.key).length !== 1)) fail(`The title action "${t.id}" needs a key of one letter.`)
    if (key) t.key = key
    return t
  })
  if (new Set(titleActions.map((a) => a.id)).size < titleActions.length) fail('Two title actions share an id.')
  const keys = titleActions.flatMap((a) => a.key ?? [])
  if (new Set(keys).size < keys.length) fail('Two title actions share a key.')
  if (x.layout !== undefined && x.layout !== 'rows' && x.layout !== 'grid') fail('layout must be "rows" or "grid".')
  if (titleActions.length && !fns.includes('titleAction')) fail('The plugin lists titleActions but has no titleAction() function.')
  const m: PluginManifest = {
    api: 1,
    kind: kind as PluginManifest['kind'],
    id,
    name: str(x.name, 'name', true, 100),
    version: str(x.version, 'version', true, 50),
    author: str(x.author, 'author', false, 100) ?? 'Unknown',
    description: str(x.description, 'description', false, 500) ?? '',
    hosts: [...new Set(hosts)],
    tools: [...new Set(tools)],
    platforms: platforms as Platform[],
    settings,
    actions,
    catalogs,
    layout: kind !== 'service' && x.layout === 'grid' ? 'grid' : 'rows',
    titleActions,
    provides,
    debridHosts: [...new Set(debridHosts)],
    vpnOptional: x.vpnOptional === true,
    has: { library: fns.includes('library'), action: fns.includes('action'), progress: fns.includes('progress'), subtitles: fns.includes('subtitles'), userCatalogs: fns.includes('userCatalogs'), addonUrls: fns.includes('addonUrls'), extensions: fns.includes('extensions') },
  }
  const icon = imgUrl(x.icon)
  if (icon) m.icon = icon
  return m
}

/** The catalog list, from the manifest or from userCatalogs() for sources whose rows depend on the user. */
export function validateCatalogDefs(x: unknown): CatalogDef[] {
  return list(x, 'catalogs', 50).map((c): CatalogDef => {
    if (!isObj(c)) return fail('Each catalog must be an object.')
    const type = metaType(c.type, 'Catalog type')
    const out: CatalogDef = { id: str(c.id, 'A catalog id', true, 1000), name: str(c.name, 'A catalog name', true, 200), type }
    if (c.search === true) out.search = true
    return out
  })
}

type Perms = Pick<PluginManifest, 'hosts' | 'tools'> & { debridHosts?: string[]; vpnOptional?: boolean }
/**
 * Permissions the new manifest asks for that the installed one did not have. Empty means a quiet update.
 * A service dropping a debrid host, or newly saying it plays with no VPN, counts too.
 */
export function addedPermissions(old: Perms, next: Perms): string[] {
  return [
    ...next.hosts.filter((h) => !old.hosts.includes(h)).map((h) => `reach ${h}`),
    ...next.tools.filter((t) => !old.tools.includes(t)).map((t) => `use ${t}`),
    ...(old.debridHosts ?? []).filter((h) => !(next.debridHosts ?? []).includes(h)).map((h) => `stop treating ${h} as a debrid host`),
    ...(next.vpnOptional && !old.vpnOptional ? ['play with no VPN'] : []),
  ]
}

// ---------- results ----------

function video(x: unknown): Video | null {
  if (!isObj(x)) return null
  const id = str(x.id, 'Video id', false, 512)
  if (!id) return null
  const v: Video = { id, title: str(x.title, 'title') ?? str(x.name, 'name') ?? id }
  const season = num(x.season), episode = num(x.episode)
  if (season !== undefined) v.season = season
  if (episode !== undefined) v.episode = episode
  const released = str(x.released, 'released', false, 40), thumb = imgUrl(x.thumbnail), overview = str(x.overview, 'overview')
  if (released) v.released = released
  if (thumb) v.thumbnail = thumb
  if (overview) v.overview = overview
  return v
}

/** `fromLibrary`: keep the item's shelf ids for validateLibrary to check; elsewhere they mean nothing. */
export function validateMeta(x: unknown, fromLibrary = false): Meta {
  if (!isObj(x)) return fail('A meta must be an object.')
  const type = metaType(x.type, 'Meta type')
  const m: Meta = { id: str(x.id, 'Meta id', true, 512), type, name: str(x.name, 'Meta name', true) }
  const poster = imgUrl(x.poster), background = imgUrl(x.background)
  if (poster) m.poster = poster
  if (background) m.background = background
  if (x.posterShape === 'poster' || x.posterShape === 'square' || x.posterShape === 'landscape') m.posterShape = x.posterShape
  const description = str(x.description, 'description'), year = str(x.year, 'year', false, 20), runtime = str(x.runtime, 'runtime', false, 40)
  if (description) m.description = description
  if (year) m.year = year
  if (runtime) m.runtime = runtime
  // Display-only fields: a wrong shape is dropped, never the whole title.
  const marks = (Array.isArray(x.marks) ? x.marks.slice(0, 6) : []).filter((k): k is string => typeof k === 'string' && /^[a-z0-9_-]{1,32}$/.test(k))
  if (marks.length) m.marks = marks
  const subtitle = typeof x.subtitle === 'string' ? str(x.subtitle, 'subtitle', false, 200) : undefined
  if (subtitle) m.subtitle = subtitle
  const badges = (Array.isArray(x.badges) ? x.badges.slice(0, 20) : []).filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 4).map((b) => b.trim().slice(0, 40))
  if (badges.length) m.badges = badges
  const genres = list(x.genres, 'genres', 20).filter((g) => typeof g === 'string').map((g) => (g as string).slice(0, 60))
  if (genres.length) m.genres = genres
  if (x.videos !== undefined) m.videos = list(x.videos, 'videos', 5000).map(video).filter((v): v is Video => !!v)
  if (isObj(x.progress) && num(x.progress.pos) !== undefined) {
    const p = x.progress
    m.progress = { pos: num(p.pos)!, dur: num(p.dur) ?? 0, at: num(p.at) ?? 0 }
    const vid = str(p.videoId, 'videoId', false, 512)
    if (vid) m.progress.videoId = vid
  }
  const shelves = fromLibrary && Array.isArray(x.shelves) ? [...new Set(x.shelves.slice(0, 50).map((s) => shortText(s, 40)).filter((s): s is string => !!s))] : []
  if (shelves.length) m.shelves = shelves
  const added = num(x.added)
  if (added !== undefined && added > 0) m.added = added < 1e11 ? added * 1000 : added
  const facts = (Array.isArray(x.facts) ? x.facts.slice(0, 50) : []).flatMap((f): Fact[] => {
    if (!isObj(f)) return []
    const label = shortText(f.label, 30), value = shortText(f.value, 120)
    return label && value ? [{ label, value }] : []
  })
  if (facts.length) m.facts = facts.slice(0, MAX_FACTS)
  return m
}

/** A list of metas; one bad entry is skipped, not the whole list, with one note for the call. */
function metas(x: unknown, max: number, note: Note, fromLibrary = false): Meta[] {
  if (Array.isArray(x) && x.length > max) note(`Kept the first ${max} of ${x.length} items.`)
  const out: Meta[] = []
  let skipped = 0, why = ''
  for (const m of list(x, 'items', max)) {
    try { out.push(validateMeta(m, fromLibrary)) } catch (e) { skipped++; why ||= (e as Error).message }
  }
  if (skipped) note(`Skipped ${skipped} item${skipped > 1 ? 's' : ''}: ${why}`)
  return out
}

const quiet: Note = () => {}

export function validateCatalog(x: unknown, note: Note = quiet): CatalogResult {
  if (Array.isArray(x)) return { items: metas(x, MAX_ITEMS, note), more: false }
  if (!isObj(x)) return fail('catalog() must return { items, more }.')
  return { items: metas(x.items, MAX_ITEMS, note), more: x.more === true }
}

function shelf(x: unknown): Shelf | string {
  if (!isObj(x)) return 'a shelf is not an object'
  const id = typeof x.id === 'string' ? x.id.trim() : ''
  if (!SHELF_RE.test(id)) return `shelf id "${String(x.id)}" must be 1 to 40 lowercase letters, digits, _ and -`
  const name = shortText(x.name, 40)
  if (!name) return `shelf "${id}" has no name`
  const s: Shelf = { id, name }
  if ((LAYOUTS as readonly unknown[]).includes(x.layout)) s.layout = x.layout as Shelf['layout']
  if ((ORDERS as readonly unknown[]).includes(x.order)) s.order = x.order as Shelf['order']
  return s
}

/**
 * library(): a list of metas, or { shelves, items }. Either way Flick gets { shelves, items }.
 * A bad shelf or item is dropped with a note; only a result of neither shape is refused as a whole.
 */
export function validateLibrary(x: unknown, note: Note = quiet): Library {
  const shaped = isObj(x)
  if (!Array.isArray(x) && !(shaped && Array.isArray(x.items) && (x.shelves == null || Array.isArray(x.shelves)))) {
    return fail('library() must return a list of metas or { shelves, items }.')
  }
  const shelves: Shelf[] = []
  const bad: string[] = []
  for (const raw of shaped ? ((x.shelves as unknown[] | undefined) ?? []).slice(0, MAX_LIST) : []) {
    const s = shelf(raw)
    if (typeof s === 'string') bad.push(s)
    else if (shelves.some((o) => o.id === s.id)) bad.push(`shelf "${s.id}" is listed twice; the first is kept`)
    else shelves.push(s)
  }
  if (bad.length) note(`Dropped ${bad.length} shelf entr${bad.length > 1 ? 'ies' : 'y'}: ${bad[0]}.`)
  if (shelves.length > MAX_SHELVES) note(`Kept the first ${MAX_SHELVES} of ${shelves.length} shelves.`)
  shelves.splice(MAX_SHELVES)
  const items = metas(shaped ? x.items : x, MAX_LIBRARY, note, true)
  const ids = new Set(shelves.map((s) => s.id))
  const unknown = new Set<string>()
  for (const m of items) {
    if (!m.shelves) continue
    for (const s of m.shelves) if (!ids.has(s)) unknown.add(s)
    m.shelves = m.shelves.filter((s) => ids.has(s)).slice(0, MAX_ITEM_SHELVES)
    if (!m.shelves.length) delete m.shelves
  }
  if (unknown.size) note(`Items name shelves this library does not declare, so Flick left them off those shelves: ${[...unknown].slice(0, 5).join(', ')}.`)
  return { shelves, items }
}

const PLAY_SCHEMES = /^(https?:|flick-tool:)/i

export const MAX_TRACKERS = 50
const TRACKER = /^(udp|https?):\/\/[\x21-\x7e]+$/

/** A stream's `torrent`, checked the way the desktop engine checks it. A wrong field is a plugin bug, so it fails the list. */
/** A torrent's file name inside it, like Stremio's behaviorHints.filename. */
export const MAX_FILE_NAME = 512

function torrentOf(x: unknown): Torrent {
  if (!isObj(x)) return fail('torrent must be { infoHash, fileIdx?, name?, trackers? }.')
  const hash = typeof x.infoHash === 'string' ? x.infoHash.toLowerCase() : ''
  if (!/^[0-9a-f]{40}$/.test(hash)) return fail('torrent.infoHash must be 40 hex characters.')
  const t: Torrent = { infoHash: hash }
  if (x.fileIdx !== undefined) {
    if (!Number.isSafeInteger(x.fileIdx) || (x.fileIdx as number) < 0) return fail('torrent.fileIdx must be a whole number, 0 or more.')
    t.fileIdx = x.fileIdx as number
  }
  if (x.name !== undefined) {
    if (typeof x.name === 'string' && x.name.trim().length > MAX_FILE_NAME) return fail(`torrent.name is at most ${MAX_FILE_NAME} characters.`)
    const name = str(x.name, 'torrent.name', false, MAX_FILE_NAME)
    if (name) t.name = name
  }
  if (x.trackers !== undefined) {
    if (!Array.isArray(x.trackers)) return fail('torrent.trackers must be a list.')
    if (x.trackers.length > MAX_TRACKERS) return fail(`torrent.trackers holds at most ${MAX_TRACKERS} trackers.`)
    for (const tr of x.trackers) {
      if (typeof tr === 'string' && tr.length > 2048) return fail('torrent.trackers entries are at most 2048 bytes.')
      if (typeof tr !== 'string' || !TRACKER.test(tr)) return fail(`torrent.trackers takes udp, http and https trackers: ${JSON.stringify(tr)}`)
    }
    if (x.trackers.length) t.trackers = x.trackers as string[]
  }
  return t
}

export function validateStreams(x: unknown): Stream[] {
  if (!Array.isArray(x)) return fail('streams() must return a list.')
  const out: Stream[] = []
  for (const s of x.slice(0, MAX_LIST)) {
    if (!isObj(s)) continue
    // A url stream is never a torrent; a torrent stream plays in the player, never a browser or the reader.
    // An empty url and a null torrent count as absent.
    const hasUrl = typeof s.url === 'string' && s.url.trim() !== ''
    const torrent = !hasUrl && s.torrent != null ? torrentOf(s.torrent) : undefined
    if (!torrent && !hasUrl) continue
    const url = torrent ? '' : (s.url as string).trim()
    if (url.length > 8000) continue
    const external = !torrent && s.external === true
    if (!torrent && (external ? !/^https:\/\//i.test(url) : !PLAY_SCHEMES.test(url))) continue
    const st: Stream = torrent ? { torrent } : { url }
    const title = str(s.title, 'title'), quality = str(s.quality, 'quality', false, 40), group = str(s.group, 'group', false, 100)
    if (title) st.title = title
    if (quality) st.quality = quality
    if (group) st.group = group
    if (s.kind === 'video' || s.kind === 'audio' || (s.kind === 'book' && !torrent)) st.kind = s.kind
    if (s.needsDesktop === true && !torrent) st.needsDesktop = true
    if (external) st.external = true
    const subs = list(s.subs, 'subs', 100).filter(isObj).filter((u) => typeof u.url === 'string' && /^https?:\/\//i.test(u.url))
      .map((u) => { const o: Sub = { url: (u.url as string).trim(), lang: str(u.lang, 'lang', false, 20) ?? 'und' }; const l = str(u.label, 'label', false, 100); if (l) o.label = l; return o })
    if (subs.length) st.subs = subs
    out.push(st)
  }
  return out
}

export function validateSubs(x: unknown): Sub[] {
  return validateStreams([{ url: 'https://x', subs: x }])[0]?.subs ?? []
}

export function validateAction(x: unknown): ActionResult {
  if (!isObj(x)) return { ok: x !== false }
  const r: ActionResult = { ok: x.ok !== false }
  const m = str(x.message, 'message', false, 500)
  if (m) r.message = m
  return r
}

/** A titleAction() result: whether that action is now on for the title. */
export function validateTitleAction(x: unknown): TitleActionResult {
  if (!isObj(x)) return fail('titleAction() must return { ok, on }.')
  const ok = x.ok !== false
  if (ok && typeof x.on !== 'boolean') return fail('titleAction() must return { ok, on }.')
  const r: TitleActionResult = { ok, on: ok && x.on === true }
  const m = str(x.message, 'message', false, 200)
  if (m) r.message = m
  return r
}

/** A source's addon URLs (the Stremio plugin's), for Flick to look for debrid keys in: https only. */
export function validateAddonUrls(x: unknown): string[] {
  if (!Array.isArray(x)) throw new Error('addonUrls() must return a list of URLs.')
  return [...new Set((x as unknown[]).filter((u): u is string => typeof u === 'string' && u.length <= 4000 && /^https:\/\//i.test(u)))].slice(0, 200)
}

// ---------- extensions (addons inside a source) ----------

/** The functions a plugin with addons exports, all or none. */
export const EXTENSION_FNS = ['extensions', 'extensionCatalog', 'inspectExtension', 'addExtension', 'removeExtension'] as const
const EXT_URL = /^(https|stremio):\/\//i

/** An addon address the user typed or tapped: https:// or stremio:// with a host, else a plain-words error. */
export function extensionUrl(x: unknown): string {
  const u = typeof x === 'string' ? x.trim() : ''
  let host = ''
  try { host = EXT_URL.test(u) && u.length <= 4000 ? new URL(u.replace(/^stremio:/i, 'https:')).hostname : '' } catch { host = '' }
  if (!host) return fail('An addon address must start with https:// or stremio://.')
  return u
}

function extension(x: unknown, catalog: boolean): Extension | null {
  if (!isObj(x)) return null
  let url: string
  try { url = extensionUrl(x.url) } catch { return null }
  const id = str(x.id, 'Addon id', false, 200), name = str(x.name, 'Addon name', false, 200)
  if (!id || !name) return null
  const e: Extension = { id, name, url, removable: x.removable === true }
  const description = str(x.description, 'description', false, 500), logo = imgUrl(x.logo)
  if (description) e.description = description
  if (logo && !/^http:/i.test(logo)) e.logo = logo
  const types = list(x.types, 'types', 20).filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim().slice(0, 40))
  if (types.length) e.types = types
  if (catalog) e.installed = x.installed === true
  return e
}

/** extensions() and extensionCatalog(): at most 500 rows; a row with a bad URL or no id or name is skipped. */
export function validateExtensions(x: unknown, catalog = false): Extension[] {
  if (!Array.isArray(x)) return fail('The addon list must be a list.')
  if (x.length > MAX_LIST) return fail(`The addon list has ${x.length} rows; at most ${MAX_LIST} are allowed.`)
  const out: Extension[] = []
  for (const e of x) { try { const r = extension(e, catalog); if (r) out.push(r) } catch { /* skip one bad row */ } }
  return out
}

/** inspectExtension(): the one addon at an address, read before the user confirms adding it. */
export function validateInspect(x: unknown): Extension {
  return extension(x, true) ?? fail('inspectExtension() must return one addon with id, name and an https or stremio:// url.')
}

/** addExtension() and removeExtension(). Only the plugin's own declared settings may change, secret ones too, each in its own type. */
export function validateExtensionResult(x: unknown, fields: Field[]): ExtensionResult {
  const r: ExtensionResult = validateAction(x)
  if (!isObj(x) || x.ok !== true || !isObj(x.settings)) return r
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(x.settings)) {
    const f = fields.find((d) => d.key === k)
    if (!f) continue
    if (f.type === 'list') { if (Array.isArray(v)) patch[k] = list(v, k).filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, MAX_STR)) }
    else if (f.type === 'toggle') { if (typeof v === 'boolean') patch[k] = v }
    else if (typeof v === 'string' && (f.type !== 'select' || f.options?.includes(v))) patch[k] = v.slice(0, MAX_STR)
  }
  if (Object.keys(patch).length) r.settings = patch
  return r
}

// ---------- service results ----------

export function validateAccount(x: unknown): AccountResult {
  if (!isObj(x) || (x.ok !== true && x.ok !== false)) return fail('account() must return { ok: true, name } or { ok: false, message }.')
  if (x.ok === false) return { ok: false, message: str(x.message, 'message', false, 500) ?? 'The service did not accept this key.' }
  const r: AccountResult = { ok: true, name: str(x.name, 'The account name', true, 100) }
  const plan = str(x.plan, 'plan', false, 100), expires = str(x.expires, 'expires', false, 40)
  if (plan) r.plan = plan
  if (expires) r.expires = expires
  return r
}

/** The asked-for infoHashes the service says it has, lowercase. Anything it was not asked about is dropped. */
export function validateCached(x: unknown, asked: string[]): string[] {
  if (!Array.isArray(x)) return fail('cached() must return a list of infoHashes.')
  const want = new Set(asked.map((h) => h.toLowerCase()))
  const out = x.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter((h) => HASH_RE.test(h) && want.has(h))
  return [...new Set(out)].slice(0, HASHES_PER_CALL)
}

/** A resolve() result. A link must be https and on the plugin's own hosts. */
export function validateResolve(x: unknown, hosts: string[]): ResolveResult {
  if (!isObj(x)) return fail('resolve() must return { url }, { wait } or { error }.')
  if (x.url !== undefined) {
    let u: URL | null = null
    try { u = typeof x.url === 'string' && x.url.length <= 8000 ? new URL(x.url.trim()) : null } catch { u = null }
    if (!u || u.protocol !== 'https:' || !hostMatches(u.hostname, hosts)) return fail('resolve() returned a link that is not https on the plugin\'s hosts.')
    if (x.bytes === undefined) return { url: u.href }
    if (!Number.isSafeInteger(x.bytes) || (x.bytes as number) <= 0) return fail('resolve() bytes must be a whole number above 0.')
    return { url: u.href, bytes: x.bytes as number }
  }
  if (isObj(x.wait)) {
    const wait: { pct?: number; message: string } = { message: str(x.wait.message, 'message', false, 200) ?? 'Fetching' }
    const pct = num(x.wait.pct)
    if (pct !== undefined) wait.pct = Math.round(Math.min(100, Math.max(0, pct)))
    return { wait }
  }
  if (x.error !== undefined) return { error: str(x.error, 'error', false, 500) ?? 'The service could not play this torrent.' }
  return fail('resolve() must return { url }, { wait } or { error }.')
}

// ---------- themes ----------

function rgb(hex: string): [number, number, number, number] {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
}

/** Lay a color with alpha over an opaque one. */
function over(top: string, under: [number, number, number]): [number, number, number] {
  const [r, g, b, a] = rgb(top)
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio of fg on bg. A translucent bg sits on black in dark mode and white in light mode. */
export function contrast(fg: string, bg: string, dark = true): number {
  const base: [number, number, number] = dark ? [0, 0, 0] : [255, 255, 255]
  const b = over(bg, base)
  const f = over(fg, b)
  const [l1, l2] = [luminance(f), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

const TOKENS = ['bg', 'surface', 'fg', 'dim', 'line', 'accent'] as const

function colors(x: unknown, mode: 'light' | 'dark'): ThemeColors {
  if (!isObj(x)) return fail(`The theme needs a "${mode}" palette.`)
  const out = {} as ThemeColors
  for (const k of TOKENS) {
    const v = x[k]
    if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(`${mode}.${k} must be a color like #1d2420.`)
    out[k] = (v as string).toLowerCase()
  }
  for (const on of ['bg', 'surface'] as const) {
    const c = contrast(out.fg, out[on], mode === 'dark')
    if (c < 4.5) fail(`${mode}: fg on ${on} has contrast ${c.toFixed(2)}:1; it needs at least 4.5:1.`)
  }
  return out
}

export function validateTheme(x: unknown): ThemeManifest {
  if (!isObj(x) || x.flick !== 'theme') return fail('A theme is a JSON object with "flick": "theme".')
  if (x.api !== API) fail(`This theme uses API ${String(x.api)}; this Flick reads API ${API}.`)
  const id = str(x.id, 'id', true, 128)
  if (!ID_RE.test(id)) fail(`id "${id}" must be reverse-DNS style and lowercase.`)
  const t: ThemeManifest = {
    flick: 'theme', api: 1, id,
    name: str(x.name, 'name', true, 100),
    version: str(x.version, 'version', true, 50),
    author: str(x.author, 'author', false, 100) ?? 'Unknown',
    light: colors(x.light, 'light'),
    dark: colors(x.dark, 'dark'),
  }
  if (x.radius !== undefined) {
    const r = num(x.radius)
    if (r === undefined || r < 0 || r > 24) fail('radius must be a number from 0 to 24.')
    t.radius = r
  }
  if (x.font !== undefined) {
    const f = str(x.font, 'font', true, 60)
    if (!/^[A-Za-z0-9 _-]+$/.test(f)) fail('font must be a plain family name, like "Inter".')
    t.font = f
  }
  return t
}
