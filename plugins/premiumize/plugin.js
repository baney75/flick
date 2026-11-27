// Premiumize for Flick: plays a torrent from Premiumize's servers as an https link.
// API docs: https://www.premiumize.me/api (read 2026-11-26).
// The docs do not say directdl's files follow the torrent's file order, so the file is picked by name,
// then by the episode tag (see pickFile), never by fileIdx. Download hosts (*.energycdn.com) are not
// in the docs; they come from Premiumize links seen by StremThru (github.com/MunifTanjim/stremthru).

const API = 'https://www.premiumize.me/api'
const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const KEEP_IDS = 200
// Transfer states that are still on their way; any other (error, deleted, banned, timeout) has failed.
const LIVE = new Set(['waiting', 'queued', 'running', 'finished', 'seeding'])

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

const base = (p) => String(p ?? '').split('/').pop()
const isEp = (e) => Number.isSafeInteger(e?.season) && e.season > 0 && Number.isSafeInteger(e?.episode) && e.episode > 0
const tag = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`
/** Whether a file name holds this episode's tag: S01E02 (any padding, any case, an optional . _ - or
 *  space between) or 1x02, with no digit after it. */
export function holdsEpisode(fileName, e) {
  const n = base(fileName)
  return new RegExp(`(?:^|[^a-z0-9])s0*${e.season}[ ._-]?e0*${e.episode}(?![0-9])`, 'i').test(n) || new RegExp(`(?:^|[^0-9])0*${e.season}x0*${e.episode}(?![0-9])`, 'i').test(n)
}
const sized = (url, n) => (Number.isSafeInteger(n) && n > 0 ? { url, bytes: n } : { url })

/** The file to play from `want` ({ fileIdx, name, episode }): the exact name, then the largest video
 *  holding the episode tag. Premiumize's docs do not say directdl keeps torrent order, so fileIdx is not
 *  used. A series with no tagged file plays only a torrent's one video, never a pack's first or
 *  largest file. */
export function pickFile(files, want = {}) {
  files = (Array.isArray(files) ? files : []).filter((f) => typeof f?.link === 'string')
  if (!files.length) return null
  const path = (x) => String(x.path ?? '')
  const size = (x) => Number(x.size) || 0
  if (want.name) { const f = files.find((x) => path(x) === want.name || base(path(x)) === want.name); if (f) return f }
  const videos = files.filter((x) => VIDEO.test(path(x)))
  const largest = (l) => l.reduce((a, b) => (size(b) > size(a) ? b : a))
  if (isEp(want.episode)) {
    const tagged = videos.filter((x) => holdsEpisode(path(x), want.episode))
    if (tagged.length) return largest(tagged)
    return videos.length === 1 ? videos[0] : null
  }
  return largest(videos.length ? videos : files)
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

/** The result for a torrent Premiumize has: its file's link, or an error when no file fits. Null when
 *  Premiumize does not have it. */
async function direct(ctx, hash, want) {
  let j
  try { j = await api(ctx, '/transfer/directdl', `src=${encodeURIComponent(magnet(hash))}`) } catch (e) { if (e.refused) return null; throw e }
  const f = pickFile(j.content, want)
  if (f) return sized(f.link, Number(f.size))
  return isEp(want.episode) && Array.isArray(j.content) && j.content.length ? { error: `No file for ${tag(want.episode)} in this torrent.` } : null
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
    const premium = until * 1000 > Date.now()
    const out = { ok: true, name: 'Premiumize', plan: premium ? 'Premium' : 'Free' }
    if (premium) out.expires = new Date(until * 1000).toISOString().slice(0, 10)
    return out
  },

  async cached(ctx, hashes) {
    if (!hashes.length) return []
    const j = await api(ctx, `/cache/check?${hashes.map((h) => `items[]=${encodeURIComponent(h)}`).join('&')}`)
    const yes = Array.isArray(j.response) ? j.response : []
    return hashes.filter((_, i) => yes[i] === true)
  },

  async resolve(ctx, want) {
    const hash = String(want.infoHash).toLowerCase()
    const now = await direct(ctx, hash, want)
    if (now) { await remember(ctx, hash, null); return now }
    let id = (await ids(ctx))[hash]
    let list = null
    if (id == null) {
      try {
        const t = await api(ctx, '/transfer/create', `src=${encodeURIComponent(magnet(hash))}`)
        if (t.id == null) throw new Error('Premiumize did not add the torrent.')
        id = t.id
      } catch (e) {
        // Already a transfer ("You already added this job."): find it by its magnet and keep going.
        if (!e.refused) throw e
        list = (await api(ctx, '/transfer/list')).transfers ?? []
        const had = list.find((x) => String(x.src ?? '').toLowerCase().includes(hash))
        if (!had) throw e
        id = had.id
      }
      await remember(ctx, hash, id)
    }
    list ??= (await api(ctx, '/transfer/list')).transfers ?? []
    const t = list.find((x) => String(x.id) === String(id))
    if (!t) { await remember(ctx, hash, null); return { wait: { message: 'Premiumize is adding it again' } } }
    if (!LIVE.has(t.status)) { await remember(ctx, hash, null); return { error: `Premiumize could not fetch this torrent${t.message ? `: ${t.message}` : '.'}` } }
    const wait = { message: t.status === 'queued' ? 'Premiumize has it in line' : t.status === 'finished' || t.status === 'seeding' ? 'Premiumize is getting the link' : 'Premiumize is downloading it' }
    if (Number.isFinite(Number(t.progress))) wait.pct = Number(t.progress) * 100
    return { wait }
  },
}
