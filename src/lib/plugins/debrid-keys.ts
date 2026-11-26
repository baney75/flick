// Debrid keys inside the user's Stremio addon URLs (SPEC-debrid rule 4). Torrentio-style addons put
// options in the path ("providers=yts|torbox=<key>"); Comet, MediaFusion and others put a JSON config
// there, often base64. This only reads the URLs: nothing here saves a key or sends anything.

/** The bundled service plugin for each name an addon may use. */
const SERVICES: Record<string, { id: string; name: string }> = {
  torbox: { id: 'app.torbox', name: 'TorBox' },
  realdebrid: { id: 'com.real-debrid', name: 'Real-Debrid' },
  alldebrid: { id: 'com.alldebrid', name: 'AllDebrid' },
  premiumize: { id: 'me.premiumize', name: 'Premiumize' },
}
const ALIASES: Record<string, string> = { tb: 'torbox', rd: 'realdebrid', ad: 'alldebrid', pm: 'premiumize' }
const SERVICE_FIELDS = ['debridservice', 'debrid_service', 'service', 'provider', 'streamingprovider']
const KEY_FIELDS = ['debridapikey', 'debrid_api_key', 'debridkey', 'apikey', 'api_key', 'token', 'key']
const KEY_RE = /^[\w.:-]{1,200}$/
const ADDONS: Record<string, string> = { torrentio: 'Torrentio', comet: 'Comet', mediafusion: 'MediaFusion', jackettio: 'Jackettio', knightcrawler: 'KnightCrawler', stremthru: 'StremThru' }

export interface FoundKey { serviceId: string; service: string; key: string; addon: string }

/** "real-debrid", "RealDebrid", "rd" -> "realdebrid"; null when it is no service Flick has. */
function serviceOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const n = v.toLowerCase().replace(/[^a-z]/g, '')
  const s = ALIASES[n] ?? n
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
    const s = serviceOf(k)
    if (s && typeof v === 'string') out.push([s, v])
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
    for (const seg of u.pathname.split('/').filter(Boolean)) {
      if (seg === 'manifest.json') continue
      const json = decodeSegment(seg)
      if (json) fromJson(json, pairs)
      else fromOptions(seg, pairs)
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
