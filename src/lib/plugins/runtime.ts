// Runs source plugins: one sandboxed iframe per enabled plugin, started on first use.
// The plugin reaches Flick only through the ctx requests handled here, each bound to the plugin's own id.

import { signal } from '@preact/signals'
import * as db from '../db'
import { isDesktop, isMobileApp, invoke } from '../platform'
import { connect, type Handler, type Rpc } from './rpc'
import * as V from './validate'

/** No allow-same-origin, ever: the opaque origin is what keeps a plugin out of Flick's storage. */
export const SANDBOX = 'allow-scripts'
export const HOST_PAGE = '/plugin-host.html'

export type SourceManifest = V.PluginManifest
export interface Installed {
  id: string
  kind: 'source' | 'theme'
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
export function logLine(id: string, text: string) {
  const line = `${new Date().toLocaleTimeString()} ${text.slice(0, 2000)}`
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
export function ctxHandler(id: string, desktop = isDesktop, call: Invoke = invoke): Handler {
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
        throw new Error(`This version of Flick has no desktop tool "${String(a[0])}" yet.`)
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

/** Tell the desktop app which hosts this plugin may fetch. The list comes from the installed record. */
export async function registerHosts(rec: Installed) {
  if (!isDesktop || rec.kind !== 'source') return
  await invoke('plugin_hosts', { id: rec.id, hosts: rec.enabled ? (rec.manifest as V.PluginManifest).hosts : [] })
}

function frameFor(rec: Installed): Promise<Frame> {
  let f = frames.get(rec.id)
  if (!f) {
    f = (async () => {
      if (rec.kind !== 'source' || !rec.enabled) throw new Error(`${rec.manifest.name} is turned off.`)
      if ((await sha256(rec.code)) !== rec.sha256) throw new Error(`${rec.manifest.name} changed on this device since it was installed. Remove it and install it again.`)
      await registerHosts(rec)
      const fr = await openFrame(ctxHandler(rec.id))
      await fr.rpc.call('load', [rec.code, platformName(), rec.settings])
      return fr
    })()
    frames.set(rec.id, f)
    f.catch((e) => { frames.delete(rec.id); logLine(rec.id, `Could not start: ${(e as Error).message}`) })
  }
  return f
}

const CHECKS: Record<string, (x: unknown) => unknown> = {
  catalog: V.validateCatalog,
  meta: V.validateMeta,
  streams: V.validateStreams,
  subtitles: V.validateSubs,
  library: V.validateLibrary,
  action: V.validateAction,
  progress: () => null,
}

export interface Results { catalog: V.CatalogResult; meta: V.Meta; streams: V.Stream[]; subtitles: V.Sub[]; library: V.Meta[]; action: V.ActionResult; progress: null }

/** Call one plugin function and check what it returns. A bad result is dropped with a log line. */
export async function callPlugin<K extends keyof Results>(rec: Installed, fn: K, args: unknown[]): Promise<Results[K]> {
  const fr = await frameFor(rec)
  const raw = await fr.rpc.call('call', [fn, args]).catch((e: Error) => { logLine(rec.id, `${fn}() failed: ${e.message}`); throw e })
  try {
    return CHECKS[fn](raw) as Results[K]
  } catch (e) {
    logLine(rec.id, `Dropped a bad ${fn}() result: ${(e as Error).message}`)
    throw e
  }
}

export function stopPlugin(id: string) {
  const f = frames.get(id)
  if (f) close(f)
  frames.delete(id)
}

/** Push new setting values to a running plugin. */
export function pushSettings(rec: Installed) {
  frames.get(rec.id)?.then((f) => f.rpc.call('settings', [rec.settings])).catch(() => {})
}

/** Load code in a throwaway sandbox with no ctx access and read its exported object. */
export async function inspect(code: string): Promise<{ manifest: unknown; fns: string[] }> {
  const fr = await openFrame(async () => { throw new Error('Plugins cannot use ctx while Flick reads them.') })
  try {
    return await fr.rpc.call<{ manifest: unknown; fns: string[] }>('load', [code, platformName(), {}])
  } finally {
    fr.rpc.close()
    fr.iframe.remove()
  }
}
