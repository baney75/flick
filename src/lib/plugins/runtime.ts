// Runs source plugins: one sandboxed iframe per enabled plugin, started on first use.
// The plugin reaches Flick only through the ctx requests handled here, each bound to the plugin's own id.

import { signal } from '@preact/signals'
import * as db from '../db'
import { isDesktop, isMobileApp, invoke, fileUrl } from '../platform'
import { connect, type Handler, type Rpc } from './rpc'
import * as V from './validate'
import { asHttps, findDebridKeys, maskUrls } from './debrid-keys'
import { mark } from './trace'

/** No allow-same-origin, ever: the opaque origin is what keeps a plugin out of Flick's storage. */
export const SANDBOX = 'allow-scripts'
// In the apps the plugin's page allows no network, so ctx.fetch (checked against the hosts listed at
// install) is its only way out. On the website the browser's CORS and private network rules apply.
export const HOST_PAGE = isDesktop ? '/plugin-host-app.html' : '/plugin-host.html'

export type SourceManifest = V.PluginManifest
export interface Installed {
  id: string
  kind: 'source' | 'service' | 'theme'
  /** Where it came from; updates are checked here. Null for a file or pasted text. */
  url: string | null
  code: string
  sha256: string
  manifest: V.PluginManifest | V.ThemeManifest
  enabled: boolean
  official: boolean
  settings: Record<string, unknown>
  installedAt: number
  checkedAt: number
  /** An update that asks for new permissions waits here for a tap. */
  pending?: { code: string; sha256: string; manifest: V.PluginManifest | V.ThemeManifest; added: string[] }
}

export const platformName = (): V.Platform => (isMobileApp ? 'mobile' : isDesktop ? 'desktop' : 'web')

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- log ----------
export const logs = signal<Record<string, string[]>>({})
/** Secret setting values (API keys, tokens) per plugin, blanked out of every log line. */
const secretValues = new Map<string, string[]>()
export function setSecrets(id: string, rec: Pick<Installed, 'kind' | 'manifest' | 'settings'>) {
  const fields = rec.kind === 'theme' ? [] : (rec.manifest as V.PluginManifest).settings.filter((f) => f.secret)
  // A secret list (Stremio's addon addresses) is blanked entry by entry, and so is any debrid key inside
  // one, so the key stays hidden even in a line that quotes the address without its scheme.
  const values = fields.flatMap((f) => rec.settings[f.key]).filter((v): v is string => typeof v === 'string' && v.length >= 4)
  const keys = findDebridKeys(values.map(asHttps)).map((k) => k.key)
  secretValues.set(id, [...new Set([...values, ...keys])].sort((a, b) => b.length - a.length))
}
export function redact(id: string, text: string): string {
  // A debrid key inside an addon address (Torrentio's torbox=...) shows only by its last 4.
  let out = maskUrls(text)
  for (const v of secretValues.get(id) ?? []) out = out.split(v).join('[key]')
  return out
}
export function logLine(id: string, text: string) {
  const line = `${new Date().toLocaleTimeString()} ${redact(id, text).slice(0, 2000)}`
  logs.value = { ...logs.value, [id]: [...(logs.value[id] ?? []), line].slice(-200) }
}

// ---------- ctx requests from a plugin ----------
async function readStore(id: string): Promise<Record<string, unknown>> {
  return (await db.get<Record<string, unknown>>('pluginData', id)) ?? {}
}

export interface FetchReply { status: number; headers: Record<string, string>; body: string }
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * The handler for one plugin's ctx requests. `id` comes from the installed record, never from the
 * message, so a plugin can only reach its own store and its own host allowlist.
 */
export function ctxHandler(id: string, desktop = isDesktop, call: Invoke = invoke, httpsOnly = false): Handler {
  return async (m, a) => {
    switch (m) {
      case 'store.get':
        return (await readStore(id))[String(a[0])] ?? null
      case 'store.set': {
        const s = await readStore(id)
        const key = String(a[0])
        if (a[1] === null || a[1] === undefined) delete s[key]
        else s[key] = a[1]
        if (new TextEncoder().encode(JSON.stringify(s)).length > V.STORE_LIMIT) throw new Error('This plugin\'s saved data would pass 1 MB.')
        await db.put('pluginData', id, s)
        return null
      }
      case 'log':
        logLine(id, String(a[0] ?? ''))
        return null
      case 'fetch': {
        if (!desktop) throw new Error('On the web, ctx.fetch runs inside the sandbox.')
        // A service plugin carries the user's key, so it reaches its hosts over https only.
        if (httpsOnly && !/^https:\/\//i.test(String(a[0]))) throw new Error('A service plugin may fetch only https addresses.')
        const init = (a[1] && typeof a[1] === 'object' ? a[1] : {}) as { method?: unknown; headers?: unknown; body?: unknown }
        const headers: Record<string, string> = {}
        if (init.headers && typeof init.headers === 'object') for (const [k, v] of Object.entries(init.headers)) headers[String(k)] = String(v)
        // The Rust side checks the URL against the hosts Flick registered for this id at install.
        return call<FetchReply>('plugin_fetch', {
          id,
          url: String(a[0]),
          method: typeof init.method === 'string' ? init.method.toUpperCase() : 'GET',
          headers,
          body: typeof init.body === 'string' ? init.body : null,
        })
      }
      case 'tool':
        if (!desktop) throw new Error(`The ${String(a[0])} tool needs the Flick desktop app.`)
        // The Rust side checks the tool against the tools Flick registered for this id at install.
        return call('plugin_tool', { id, tool: String(a[0]), op: String(a[1]), args: Array.isArray(a[2]) ? a[2] : [] })
      default:
        throw new Error(`Flick does not know the request "${m}".`)
    }
  }
}

// ---------- frames ----------
interface Frame { rpc: Rpc; iframe: HTMLIFrameElement }
const frames = new Map<string, Promise<Frame>>()

export function openFrame(handle: Handler, doc: Document = document): Promise<Frame> {
  const iframe = doc.createElement('iframe')
  iframe.setAttribute('sandbox', SANDBOX)
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.hidden = true
  iframe.src = HOST_PAGE
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { iframe.remove(); reject(new Error('The plugin sandbox did not start.')) }, V.CALL_TIMEOUT_MS)
    iframe.addEventListener('load', () => {
      clearTimeout(t)
      const ch = new MessageChannel()
      // The sandboxed page has an opaque origin, so '*' is the only target that reaches it.
      iframe.contentWindow!.postMessage({ flick: 'port' }, '*', [ch.port2])
      resolve({ iframe, rpc: connect(ch.port1, handle) })
    }, { once: true })
    doc.body.appendChild(iframe)
  })
}

function close(f: Promise<Frame>) {
  f.then((x) => { x.rpc.close(); x.iframe.remove() }).catch(() => {})
}

/** Tell the desktop app which hosts and tools this plugin may use. The lists come from the installed record. */
export async function registerHosts(rec: Installed) {
  if (!isDesktop || rec.kind === 'theme') return
  const m = rec.manifest as V.PluginManifest
  await invoke('plugin_hosts', { id: rec.id, hosts: rec.enabled ? m.hosts : [] })
  await invoke('plugin_tools', { id: rec.id, tools: rec.enabled ? m.tools : [] })
}

/** A `flick-tool:` stream from a plugin, started on the desktop app; returns a URL the player plays. */
export async function openToolStream(url: string): Promise<string> {
  if (!isDesktop) throw new Error('This stream needs the Flick desktop app.')
  return fileUrl(await invoke<string>('tool_open', { url }))
}

/** Why a plugin may not start on this platform, or null. A service runs on the desktop only,
 *  whatever platforms an older stored manifest lists: elsewhere ctx.fetch skips the host and https checks. */
export function startRefusal(rec: Installed, platform: V.Platform): string | null {
  if (rec.kind === 'service' && platform !== 'desktop') return `${rec.manifest.name} works only in the Flick desktop app.`
  return null
}

function frameFor(rec: Installed): Promise<Frame> {
  let f = frames.get(rec.id)
  if (!f) {
    f = (async () => {
      if (rec.kind === 'theme' || !rec.enabled) throw new Error(`${rec.manifest.name} is turned off.`)
      const service = rec.kind === 'service'
      const refused = startRefusal(rec, platformName())
      if (refused) throw new Error(refused)
      if ((await sha256(rec.code)) !== rec.sha256) throw new Error(`${rec.manifest.name} changed on this device since it was installed. Remove it and install it again.`)
      setSecrets(rec.id, rec)
      await registerHosts(rec)
      mark('start.hosts')
      const fr = await openFrame(ctxHandler(rec.id, isDesktop, invoke, service))
      mark('start.sandbox')
      await fr.rpc.call('load', [rec.code, platformName(), rec.settings])
      mark('start.load')
      return fr
    })()
    frames.set(rec.id, f)
    f.catch((e) => { frames.delete(rec.id); logLine(rec.id, `Could not start: ${(e as Error).message}`) })
  }
  return f
}

const CHECKS: Record<string, (x: unknown, m: V.PluginManifest, args: unknown[], note: V.Note) => unknown> = {
  catalog: (x, _m, _a, note) => V.validateCatalog(x, note),
  userCatalogs: V.validateCatalogDefs,
  meta: (x) => V.validateMeta(x),
  streams: V.validateStreams,
  subtitles: V.validateSubs,
  library: (x, _m, _a, note) => V.validateLibrary(x, note),
  addonUrls: V.validateAddonUrls,
  action: V.validateAction,
  extensions: (x) => V.validateExtensions(x),
  extensionCatalog: (x) => V.validateExtensions(x, true),
  inspectExtension: V.validateInspect,
  addExtension: (x, m) => V.validateExtensionResult(x, m.settings),
  removeExtension: (x, m) => V.validateExtensionResult(x, m.settings),
  titleAction: V.validateTitleAction,
  progress: () => null,
  account: V.validateAccount,
  cached: (x, _m, args) => V.validateCached(x, Array.isArray(args[0]) ? (args[0] as string[]) : []),
  resolve: (x, m) => V.validateResolve(x, m.hosts),
}

export interface Results {
  userCatalogs: V.CatalogDef[]; catalog: V.CatalogResult; meta: V.Meta; streams: V.Stream[]; subtitles: V.Sub[]; library: V.Library; action: V.ActionResult; titleAction: V.TitleActionResult; progress: null; addonUrls: string[]
  extensions: V.Extension[]; extensionCatalog: V.Extension[]; inspectExtension: V.Extension; addExtension: V.ExtensionResult; removeExtension: V.ExtensionResult
  account: V.AccountResult; cached: string[]; resolve: V.ResolveResult
}

/** Call one plugin function and check what it returns. A bad result is dropped with a log line. */
export async function callPlugin<K extends keyof Results>(rec: Installed, fn: K, args: unknown[]): Promise<Results[K]> {
  const fr = await frameFor(rec)
  const raw = await fr.rpc.call('call', [fn, args]).catch((e: Error) => { logLine(rec.id, `${fn}() failed: ${e.message}`); throw e })
  try {
    return CHECKS[fn](raw, rec.manifest as V.PluginManifest, args, (t) => logLine(rec.id, `${fn}(): ${t}`)) as Results[K]
  } catch (e) {
    logLine(rec.id, `Dropped a bad ${fn}() result: ${(e as Error).message}`)
    throw e
  }
}

/** Start a plugin's sandbox and wait for one round trip; the self-test times this as the first call. */
export async function startPlugin(rec: Installed): Promise<void> {
  const fr = await frameFor(rec)
  await fr.rpc.call('ping')
}

export function stopPlugin(id: string) {
  const f = frames.get(id)
  if (f) close(f)
  frames.delete(id)
}

/** Push new setting values to a running plugin. */
export function pushSettings(rec: Installed) {
  setSecrets(rec.id, rec)
  frames.get(rec.id)?.then((f) => f.rpc.call('settings', [rec.settings])).catch(() => {})
}

/** Load code in a throwaway sandbox with no ctx access and read its exported object. */
export async function inspect(code: string): Promise<{ manifest: unknown; fns: string[] }> {
  const fr = await openFrame(async () => { throw new Error('Plugins cannot use ctx while Flick reads them.') })
  mark('sandbox')
  try {
    const r = await fr.rpc.call<{ manifest: unknown; fns: string[] }>('load', [code, platformName(), {}])
    mark('inspect')
    return r
  } finally {
    fr.rpc.close()
    fr.iframe.remove()
  }
}
