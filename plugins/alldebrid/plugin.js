// AllDebrid for Flick: plays a torrent from AllDebrid's servers as an https link.
// API docs: https://docs.alldebrid.com/ (API v4 and v4.1, read 2026-11-26).
// No cache check: the docs no longer list /magnet/instant, so cached() returns []; a cached torrent
// still comes back ready at once. The docs do not say a magnet's files follow the torrent's file order,
// so the file is picked by name first, then by Stremio's fileIdx, then the largest video.
// Download hosts (*.debrid.it) are not in the docs; they come from AllDebrid links seen by StremThru
// (github.com/MunifTanjim/stremthru).

const API = 'https://api.alldebrid.com'
const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const KEEP_IDS = 200
const WAITING = { 0: 'AllDebrid has it in line', 1: 'AllDebrid is downloading it', 2: 'AllDebrid is packing it', 3: 'AllDebrid is storing it' }

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.settings.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' })
const form = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

/** One call; AllDebrid answers { status: 'success', data } or { status: 'error', error: { code, message } }. */
async function api(ctx, path, pairs) {
  const r = await ctx.fetch(`${API}${path}`, { method: 'POST', headers: auth(ctx), body: form(pairs) })
  let j = null
  try { j = await r.json() } catch { /* not JSON */ }
  if (j?.status !== 'success') { const e = new Error(`AllDebrid: ${j?.error?.message ?? `answered ${r.status}`}`); e.code = j?.error?.code; throw e }
  return j.data
}

/** The files of a magnet as one list, in the order AllDebrid gives them. Folders have `e`, files `l`. */
export function flatten(nodes, dir = '') {
  const out = []
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const path = dir ? `${dir}/${n.n}` : String(n.n ?? '')
    if (Array.isArray(n.e)) out.push(...flatten(n.e, path))
    else if (n.l) out.push({ path, size: Number(n.s) || 0, link: n.l })
  }
  return out
}

export function pickFile(files, fileIdx, name) {
  if (!files.length) return null
  if (name) { const f = files.find((x) => x.path.endsWith(name)); if (f) return f }
  if (Number.isInteger(fileIdx) && files[fileIdx]) return files[fileIdx]
  const videos = files.filter((x) => VIDEO.test(x.path))
  return (videos.length ? videos : files).reduce((a, b) => (b.size > a.size ? b : a))
}

async function ids(ctx) { return (await ctx.store.get('ids')) ?? {} }
async function remember(ctx, hash, id) {
  const all = await ids(ctx)
  delete all[hash]
  if (id != null) all[hash] = id
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_IDS))) delete all[k]
  await ctx.store.set('ids', all)
}

export default {
  api: 1,
  kind: 'service',
  provides: ['debrid'],
  id: 'com.alldebrid',
  name: 'AllDebrid',
  version: '1.0.0',
  author: 'Flick',
  description: 'Plays torrents from AllDebrid\'s servers, so nothing is shared from this computer.',
  icon: 'https://alldebrid.com/favicon.ico',
  hosts: ['api.alldebrid.com', '*.debrid.it'],
  debridHosts: ['*.debrid.it'],
  // Playback is an https download from AllDebrid's servers: no peer sees this computer's address.
  vpnOptional: true,
  platforms: ['desktop'],
  settings: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'Make one at https://alldebrid.com/apikeys.' },
  ],

  async account(ctx) {
    if (!ctx.settings.apiKey) return { ok: false, message: 'Paste your AllDebrid API key.' }
    let d
    try { d = await api(ctx, '/v4/user', []) } catch (e) { if (e.code) return { ok: false, message: e.message }; throw e }
    const u = d?.user ?? {}
    const out = { ok: true, name: 'AllDebrid', plan: u.isPremium ? 'Premium' : 'Free' }
    const until = Number(u.premiumUntil)
    if (u.isPremium && until > 0) out.expires = new Date(until * 1000).toISOString().slice(0, 10)
    return out
  },

  // AllDebrid has no cache check any more (see the top of this file).
  async cached() { return [] },

  async resolve(ctx, { infoHash, fileIdx, name }) {
    const hash = String(infoHash).toLowerCase()
    let id = (await ids(ctx))[hash]
    if (id == null) {
      const up = (await api(ctx, '/v4/magnet/upload', [['magnets[]', hash]]))?.magnets?.[0]
      if (!up || up.error || up.id == null) return { error: `AllDebrid: ${up?.error?.message ?? 'it did not take the torrent.'}` }
      id = up.id
      await remember(ctx, hash, id)
    }
    let s
    try { s = (await api(ctx, '/v4.1/magnet/status', [['id', String(id)]]))?.magnets } catch (e) {
      if (e.code === 'MAGNET_INVALID_ID') { await remember(ctx, hash, null); return { wait: { message: 'AllDebrid is adding it again' } } }
      throw e
    }
    const m = Array.isArray(s) ? s[0] : s
    const code = Number(m?.statusCode)
    if (code === 4) {
      const node = (await api(ctx, '/v4/magnet/files', [['id[]', String(id)]]))?.magnets?.[0]
      const f = pickFile(flatten(node?.files), fileIdx, name)
      if (!f) return { error: 'This torrent has no file to play.' }
      const d = await api(ctx, '/v4/link/unlock', [['link', f.link]])
      if (typeof d?.link === 'string' && d.link) return { url: d.link }
      return { wait: { message: 'AllDebrid is preparing the link' } }
    }
    if (code >= 5 || !Number.isFinite(code)) { await remember(ctx, hash, null); return { error: `AllDebrid could not fetch this torrent${m?.status ? ` (${m.status})` : ''}.` } }
    const wait = { message: WAITING[code] }
    if (Number(m.size) > 0) wait.pct = (Number(m.downloaded) / Number(m.size)) * 100
    return { wait }
  },
}
