// TorBox for Flick: plays a torrent from TorBox's servers as an https link.
// API docs: https://api-docs.torbox.app and https://api.torbox.app/openapi.json (read 2026-11-26).
// Download hosts (tb-cdn.*) are not in the docs; they come from TorBox links seen by StremThru
// (github.com/MunifTanjim/stremthru, internal/config/http.go).
// Flick sends TorBox only the infoHash and the file to play. A torrent TorBox does not have yet is
// added to the user's TorBox list, which is how TorBox fetches it.

const API = 'https://api.torbox.app/v1/api'
const PLANS = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' }
const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const KEEP_IDS = 200

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.settings.apiKey}` })

/** One API call; TorBox wraps every answer in { success, error, detail, data }. */
async function api(ctx, path, init = {}) {
  const r = await ctx.fetch(`${API}${path}`, { ...init, headers: { ...auth(ctx), ...init.headers } })
  let j = null
  try { j = await r.json() } catch { /* not JSON: reported below */ }
  if (!j || j.success !== true) throw new Error(j?.detail || j?.error || `TorBox answered ${r.status}.`)
  return j.data
}

/** The file to play: Stremio's fileIdx is the torrent's file order, which TorBox uses as the file id. */
export function pickFile(files, fileIdx, name) {
  if (!Array.isArray(files) || !files.length) return null
  if (Number.isInteger(fileIdx)) { const f = files.find((x) => x.id === fileIdx); if (f) return f }
  if (name) { const f = files.find((x) => (x.short_name || x.name || '').endsWith(name)); if (f) return f }
  const videos = files.filter((x) => VIDEO.test(x.short_name || x.name || ''))
  return (videos.length ? videos : files).reduce((a, b) => ((b.size ?? 0) > (a.size ?? 0) ? b : a))
}

async function torrentIds(ctx) { return (await ctx.store.get('ids')) ?? {} }
async function rememberId(ctx, hash, id) {
  const ids = await torrentIds(ctx)
  delete ids[hash]
  if (id != null) ids[hash] = id
  const keys = Object.keys(ids)
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_IDS))) delete ids[k]
  await ctx.store.set('ids', ids)
}

async function addTorrent(ctx, hash) {
  const body = `magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${hash}`)}`
  const d = await api(ctx, '/torrents/createtorrent', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (d?.torrent_id == null) throw new Error('TorBox did not add the torrent.')
  await rememberId(ctx, hash, d.torrent_id)
  return d.torrent_id
}

const STATES = {
  metaDL: 'TorBox is reading the torrent',
  queued: 'TorBox has it in line',
  downloading: 'TorBox is downloading it',
  stalled: 'TorBox is waiting for someone sharing it',
  checkingResumeData: 'TorBox is checking it',
}

export default {
  api: 1,
  kind: 'service',
  provides: ['debrid'],
  id: 'app.torbox',
  name: 'TorBox',
  version: '1.0.0',
  author: 'Flick',
  description: 'Plays torrents from TorBox\'s servers, so nothing is shared from this computer.',
  icon: 'https://torbox.app/favicon.ico',
  hosts: ['api.torbox.app', '*.tb-cdn.st', '*.tb-cdn.io', '*.tb-cdn.cx', '*.tb-cdn.earth', '*.tb-cdn.pw'],
  debridHosts: ['*.tb-cdn.st', '*.tb-cdn.io', '*.tb-cdn.cx', '*.tb-cdn.earth', '*.tb-cdn.pw'],
  // Playback is an https download from TorBox's servers: no peer sees this computer's address.
  vpnOptional: true,
  platforms: ['desktop'],
  settings: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'Find it at https://torbox.app/settings, under API Key.' },
  ],

  async account(ctx) {
    if (!ctx.settings.apiKey) return { ok: false, message: 'Paste your TorBox API key.' }
    const r = await ctx.fetch(`${API}/user/me`, { headers: auth(ctx) })
    let j = null
    try { j = await r.json() } catch { /* reported below */ }
    if (!j || j.success !== true || !j.data) return { ok: false, message: j?.detail || `TorBox answered ${r.status}.` }
    const out = { ok: true, name: 'TorBox' }
    if (PLANS[j.data.plan]) out.plan = PLANS[j.data.plan]
    if (typeof j.data.premium_expires_at === 'string') out.expires = j.data.premium_expires_at.slice(0, 10)
    return out
  },

  async cached(ctx, hashes) {
    if (!hashes.length) return []
    const d = await api(ctx, `/torrents/checkcached?hash=${hashes.map(encodeURIComponent).join(',')}&format=list&list_files=false`)
    return (Array.isArray(d) ? d : []).map((x) => String(x?.hash ?? '').toLowerCase()).filter(Boolean)
  },

  async resolve(ctx, { infoHash, fileIdx, name }) {
    const hash = String(infoHash).toLowerCase()
    let id = (await torrentIds(ctx))[hash]
    if (id == null) id = await addTorrent(ctx, hash)
    let t = null
    try { t = await api(ctx, `/torrents/mylist?id=${encodeURIComponent(id)}&bypass_cache=true`) } catch { t = null }
    // Removed from the TorBox list since: forget it, and the next call adds it again.
    if (!t) { await rememberId(ctx, hash, null); return { wait: { message: 'TorBox is adding it' } } }
    const state = String(t.download_state ?? '')
    if (/^(error|failed|missingFiles)/i.test(state)) { await rememberId(ctx, hash, null); return { error: `TorBox could not fetch this torrent (${state}).` } }
    if (t.download_finished && t.download_present) {
      const f = pickFile(t.files, fileIdx, name)
      if (!f) return { error: 'TorBox has this torrent but no file in it to play.' }
      const url = await api(ctx, `/torrents/requestdl?token=${encodeURIComponent(ctx.settings.apiKey)}&torrent_id=${encodeURIComponent(id)}&file_id=${encodeURIComponent(f.id)}&redirect=false`)
      if (typeof url !== 'string') throw new Error('TorBox gave no link.')
      return { url }
    }
    const p = Number(t.progress)
    const wait = { message: STATES[state.split(' ')[0]] ?? 'TorBox is fetching it' }
    if (Number.isFinite(p)) wait.pct = p <= 1 ? p * 100 : p
    return { wait }
  },
}
