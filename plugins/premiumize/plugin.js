// Premiumize for Flick: plays a torrent from Premiumize's servers as an https link.
// API docs: https://www.premiumize.me/api (read 2026-11-26).
// The docs do not say directdl's files follow the torrent's file order, so the file is picked by name
// first, then the largest video. Download hosts (*.energycdn.com) are not in the docs; they come from
// Premiumize links seen by StremThru (github.com/MunifTanjim/stremthru).

const API = 'https://www.premiumize.me/api'
const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const KEEP_IDS = 200

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.settings.apiKey}` })
const magnet = (hash) => `magnet:?xt=urn:btih:${hash}`

/** One call; Premiumize answers { status: 'success', ... } or { status: 'error', message }, mostly with HTTP 200. */
async function api(ctx, path, body) {
  const init = body ? { method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body } : { headers: auth(ctx) }
  const r = await ctx.fetch(`${API}${path}`, init)
  let j = null
  try { j = await r.json() } catch { /* not JSON */ }
  if (j?.status !== 'success') { const e = new Error(`Premiumize: ${j?.message ?? `answered ${r.status}`}`); e.refused = !!j; throw e }
  return j
}

export function pickFile(files, name) {
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f?.link === 'string')
  if (!list.length) return null
  if (name) { const f = list.find((x) => String(x.path ?? '').endsWith(name)); if (f) return f }
  const videos = list.filter((x) => VIDEO.test(String(x.path ?? '')))
  return (videos.length ? videos : list).reduce((a, b) => ((Number(b.size) || 0) > (Number(a.size) || 0) ? b : a))
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

/** A link for a torrent Premiumize has, or null when it does not have it. */
async function direct(ctx, hash, name) {
  let j
  try { j = await api(ctx, '/transfer/directdl', `src=${encodeURIComponent(magnet(hash))}`) } catch (e) { if (e.refused) return null; throw e }
  const f = pickFile(j.content, name)
  return f ? f.link : null
}

export default {
  api: 1,
  kind: 'service',
  provides: ['debrid'],
  id: 'me.premiumize',
  name: 'Premiumize',
  version: '1.0.0',
  author: 'Flick',
  description: 'Plays torrents from Premiumize\'s servers, so nothing is shared from this computer.',
  icon: 'https://www.premiumize.me/favicon.ico',
  hosts: ['www.premiumize.me', '*.energycdn.com'],
  debridHosts: ['*.energycdn.com'],
  // Playback is an https download from Premiumize's servers: no peer sees this computer's address.
  vpnOptional: true,
  platforms: ['desktop'],
  settings: [
    { key: 'apiKey', label: 'API key', type: 'password', help: 'Find it at https://www.premiumize.me/account.' },
  ],

  async account(ctx) {
    if (!ctx.settings.apiKey) return { ok: false, message: 'Paste your Premiumize API key.' }
    let j
    try { j = await api(ctx, '/account/info') } catch (e) { if (e.refused) return { ok: false, message: e.message }; throw e }
    const until = Number(j.premium_until)
    const out = { ok: true, name: 'Premiumize', plan: until > 0 ? 'Premium' : 'Free' }
    if (until > 0) out.expires = new Date(until * 1000).toISOString().slice(0, 10)
    return out
  },

  async cached(ctx, hashes) {
    if (!hashes.length) return []
    const j = await api(ctx, `/cache/check?${hashes.map((h) => `items[]=${encodeURIComponent(h)}`).join('&')}`)
    const yes = Array.isArray(j.response) ? j.response : []
    return hashes.filter((_, i) => yes[i] === true)
  },

  async resolve(ctx, { infoHash, name }) {
    const hash = String(infoHash).toLowerCase()
    const now = await direct(ctx, hash, name)
    if (now) { await remember(ctx, hash, null); return { url: now } }
    let id = (await ids(ctx))[hash]
    if (id == null) {
      const t = await api(ctx, '/transfer/create', `src=${encodeURIComponent(magnet(hash))}`)
      if (t.id == null) throw new Error('Premiumize did not add the torrent.')
      id = t.id
      await remember(ctx, hash, id)
    }
    const t = ((await api(ctx, '/transfer/list')).transfers ?? []).find((x) => String(x.id) === String(id))
    if (!t) { await remember(ctx, hash, null); return { wait: { message: 'Premiumize is adding it again' } } }
    if (t.status === 'error') { await remember(ctx, hash, null); return { error: `Premiumize could not fetch this torrent${t.message ? `: ${t.message}` : '.'}` } }
    const wait = { message: t.status === 'queued' ? 'Premiumize has it in line' : t.status === 'finished' || t.status === 'seeding' ? 'Premiumize is getting the link' : 'Premiumize is downloading it' }
    if (Number.isFinite(Number(t.progress))) wait.pct = Number(t.progress) * 100
    return { wait }
  },
}
