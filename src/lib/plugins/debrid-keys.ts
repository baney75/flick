// Debrid keys inside the user's Stremio addon URLs (SPEC-debrid rule 4). Torrentio-style addons put
// options in the path ("providers=yts|torbox=<key>"); Comet, MediaFusion and others put a JSON config
// there, often base64. This only reads the URLs: nothing here saves a key or sends anything.

/** The bundled service plugin for each name an addon may use. */
export const DEBRID_SERVICES: Record<string, { id: string; name: string }> = {
  torbox: { id: 'app.torbox', name: 'TorBox' },
  realdebrid: { id: 'com.real-debrid', name: 'Real-Debrid' },
  alldebrid: { id: 'com.alldebrid', name: 'AllDebrid' },
  premiumize: { id: 'me.premiumize', name: 'Premiumize' },
}
const ALIASES: Record<string, string> = { tb: 'torbox', rd: 'realdebrid', ad: 'alldebrid', pm: 'premiumize' }
const SERVICE_FIELDS = ['debridservice', 'debrid_service', 'service', 'provider', 'streamingprovider']
const KEY_FIELDS = ['debridapikey', 'debrid_api_key', 'debridkey', 'apikey', 'api_key', 'token', 'key']
const KEY_RE = /^[\w.:-]{1,200}$/
/** A JSON property named after a service holds a key only when its value looks like one, not "true" or "enabled". */
const looksLikeKey = (v: string) => v.length >= 8 && KEY_RE.test(v) && !/^(true|false|yes|no|on|off|enabled|disabled|null|none)$/i.test(v)
const SERVICES = DEBRID_SERVICES
const ADDONS: Record<string, string> = { torrentio: 'Torrentio', comet: 'Comet', mediafusion: 'MediaFusion', jackettio: 'Jackettio', knightcrawler: 'KnightCrawler', stremthru: 'StremThru' }

export interface FoundKey { serviceId: string; service: string; key: string; addon: string }

/** "real-debrid", "RealDebrid", "rd" -> "realdebrid"; null when it is no service Flick has. Short names only with `short`. */
function serviceOf(v: unknown, short = true): string | null {
  if (typeof v !== 'string') return null
  const n = v.toLowerCase().replace(/[^a-z]/g, '')
  const s = (short && ALIASES[n]) || n
  return SERVICES[s] ? s : null
}

/** "Torrentio" for torrentio.strem.fun; the host for an addon Flick does not know. */
export function addonName(host: string): string {
  const h = host.toLowerCase()
  for (const [k, v] of Object.entries(ADDONS)) if (h.split('.').some((part) => part.includes(k))) return v
  return h
}

function decodeSegment(seg: string): unknown {
  let s = seg
  try { s = decodeURIComponent(seg) } catch { /* keep it raw */ }
  if (s.startsWith('{')) { try { return JSON.parse(s) } catch { return null } }
  if (!/^[A-Za-z0-9+/_=-]{8,}$/.test(s)) return null
  try {
    const text = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
    return text.trimStart().startsWith('{') ? JSON.parse(text) : null
  } catch { return null }
}

/** Service and key pairs in a decoded JSON config, a few levels deep. */
function fromJson(x: unknown, out: [string, string][], depth = 0) {
  if (!x || typeof x !== 'object' || depth > 3) return
  if (Array.isArray(x)) { for (const v of x) fromJson(v, out, depth + 1); return }
  const o = x as Record<string, unknown>
  const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]))
  const svc = SERVICE_FIELDS.map((f) => serviceOf(lower[f])).find(Boolean)
  const key = KEY_FIELDS.map((f) => lower[f]).find((v) => typeof v === 'string')
  if (svc && typeof key === 'string') out.push([svc, key])
  for (const [k, v] of Object.entries(o)) {
    const s = serviceOf(k, false)
    if (s && typeof v === 'string' && looksLikeKey(v.trim())) out.push([s, v])
    else fromJson(v, out, depth + 1)
  }
}

/** Torrentio-style options: "a=1|torbox=KEY" or "a=1,torbox=KEY". */
function fromOptions(seg: string, out: [string, string][]) {
  let s = seg
  try { s = decodeURIComponent(seg) } catch { /* keep it raw */ }
  for (const part of s.split(/[|,&]/)) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const svc = serviceOf(part.slice(0, i))
    if (svc) out.push([svc, part.slice(i + 1)])
  }
}

/** Every debrid key in these addon URLs, once each, for services Flick bundles. */
export function findDebridKeys(urls: string[]): FoundKey[] {
  const found: FoundKey[] = []
  for (const raw of urls) {
    let u: URL
    try { u = new URL(raw.replace(/^stremio:\/\//i, 'https://')) } catch { continue }
    if (u.protocol !== 'https:') continue
    const pairs: [string, string][] = []
    // Standard base64 can hold "/", so first read the whole path before manifest.json as one config.
    const whole = decodeSegment(u.pathname.replace(/^\/+/, '').replace(/\/?manifest\.json$/, '').replace(/\/+$/, ''))
    if (whole) fromJson(whole, pairs)
    else {
      for (const seg of u.pathname.split('/').filter(Boolean)) {
        if (seg === 'manifest.json') continue
        const json = decodeSegment(seg)
        if (json) fromJson(json, pairs)
        else fromOptions(seg, pairs)
      }
    }
    for (const [svc, key] of pairs) {
      const k = key.trim()
      if (!KEY_RE.test(k) || found.some((f) => f.serviceId === SERVICES[svc].id && f.key === k)) continue
      found.push({ serviceId: SERVICES[svc].id, service: SERVICES[svc].name, key: k, addon: addonName(u.hostname) })
    }
  }
  return found
}

/** What the panel shows of a key: its last 4 characters. */
export const keyEnd = (key: string) => key.slice(-4)

const DOTS = '\u2022\u2022\u2022'

/** An address read as https, so findDebridKeys sees it: stremio and http schemes, and none at all. */
export function asHttps(text: string): string {
  const t = text.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t.replace(/^(stremio|http):/i, 'https:') : `https://${t}`
}

/**
 * A stored addon address as Flick shows it, typed any way the old text box allowed (stray spaces, no
 * scheme): masked like maskUrl, any debrid key cut to its last 4.
 */
export function maskAddress(text: string): string {
  const t = text.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return maskUrl(t)
  return maskUrl(`https://${t}`).slice('https://'.length)
}

/**
 * An addon address as Flick shows it: any debrid key in it cut to its last 4 characters
 * (`torbox=abc123XYZ9` shows as `torbox=•••XYZ9`). A key inside an encoded config hides the whole
 * path before manifest.json, since standard base64 can hold "/". The scheme and host always stay.
 */
export function maskUrl(url: string): string {
  // findDebridKeys reads https only; an http or stremio address can carry the same key.
  const keys = findDebridKeys([url.replace(/^(stremio|http):/i, 'https:')]).map((f) => f.key)
  if (!keys.length) return url
  const m = /^([a-z]+:\/\/[^/?#]*)(.*)$/i.exec(url)
  if (!m) return url
  let rest = m[2]
  for (const k of keys) {
    const shown = DOTS + keyEnd(k)
    if (rest.includes(k)) rest = rest.split(k).join(shown)
    else if (rest.includes(encodeURIComponent(k))) rest = rest.split(encodeURIComponent(k)).join(shown)
    else {
      const q = rest.search(/[?#]/)
      const path = q < 0 ? rest : rest.slice(0, q)
      const mf = /\/manifest\.json$/i.test(path) ? '/manifest.json' : ''
      const body = path.slice(0, path.length - mf.length).replace(/^\/+/, '')
      if (body) rest = `/${DOTS}${body.slice(-4)}${mf}${q < 0 ? '' : rest.slice(q)}`
    }
  }
  return m[1] + rest
}

/** Every addon address in a line of text, masked the same way (for plugin logs). */
export const maskUrls = (text: string) => text.replace(/\b(https?|stremio):\/\/[^\s"'<>]+/gi, maskUrl)
