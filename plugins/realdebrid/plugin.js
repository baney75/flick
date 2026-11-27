// Real-Debrid for Flick: plays a torrent from Real-Debrid's servers as an https link.
// API docs: https://api.real-debrid.com/ (REST API 1.0, read 2026-11-26).
// No cache check: Real-Debrid turned off /torrents/instantAvailability in November 2024, so cached()
// returns [] and every torrent goes through addMagnet. Download hosts (*.download.real-debrid.com) are
// not in the docs; they come from Real-Debrid links seen by StremThru (github.com/MunifTanjim/stremthru).

const API = 'https://api.real-debrid.com/rest/1.0'
const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const KEEP_IDS = 200
const FAILED = ['magnet_error', 'error', 'virus', 'dead']
const STATES = {
  magnet_conversion: 'Real-Debrid is reading the torrent',
  waiting_files_selection: 'Real-Debrid is starting it',
  queued: 'Real-Debrid has it in line',
  downloading: 'Real-Debrid is downloading it',
  compressing: 'Real-Debrid is packing it',
  uploading: 'Real-Debrid is storing it',
}

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.settings.apiKey}` })
const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

/** One call. Errors come back as { error, error_code }; a 204 has no body. */
async function api(ctx, path, init = {}) {
  const headers = { ...auth(ctx), ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }
  const r = await ctx.fetch(`${API}${path}`, { ...init, headers })
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!r.ok) { const e = new Error(`Real-Debrid: ${j?.error ?? `answered ${r.status}`}`); e.status = r.status; throw e }
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

/** The file to play from `want` ({ fileIdx, name, episode }): by fileIdx (Real-Debrid numbers files
 *  from 1 in torrent order, so Stremio's fileIdx is id - 1), then the exact name, then the largest
 *  video holding the episode tag. A series with no tagged file plays only a torrent's one video,
 *  never a pack's first or largest file. */
export function pickFile(files, want = {}) {
  if (!Array.isArray(files) || !files.length) return null
  const path = (x) => String(x.path ?? '')
  const size = (x) => Number(x.bytes) || 0
  if (Number.isInteger(want.fileIdx)) { const f = files.find((x) => x.id === want.fileIdx + 1); if (f) return f }
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
async function remember(ctx, key, id) {
  const all = await ids(ctx)
  delete all[key]
  if (id != null) all[key] = id
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_IDS))) delete all[k]
  await ctx.store.set('ids', all)
}

export default {
  api: 1,
  kind: 'service',
  provides: ['debrid'],
  id: 'com.real-debrid',
  name: 'Real-Debrid',
  version: '1.0.0',
  author: 'Flick',
  description: 'Plays torrents from Real-Debrid\'s servers, so nothing is shared from this computer.',
  icon: 'https://real-debrid.com/favicon.ico',
  hosts: ['api.real-debrid.com', '*.download.real-debrid.com'],
  debridHosts: ['*.download.real-debrid.com'],
  // Playback is an https download from Real-Debrid's servers: no peer sees this computer's address.
  vpnOptional: true,
  platforms: ['desktop'],
  settings: [
    { key: 'apiKey', label: 'API token', type: 'password', help: 'Find it at https://real-debrid.com/apitoken.' },
  ],

  async account(ctx) {
    if (!ctx.settings.apiKey) return { ok: false, message: 'Paste your Real-Debrid API token.' }
    let u
    try { u = await api(ctx, '/user') } catch (e) { if (e.status) return { ok: false, message: e.message }; throw e }
    const out = { ok: true, name: 'Real-Debrid', plan: u?.type === 'premium' ? 'Premium' : 'Free' }
    if (u?.type === 'premium' && typeof u.expiration === 'string') out.expires = u.expiration.slice(0, 10)
    return out
  },

  // Real-Debrid has no cache check any more (see the top of this file).
  async cached() { return [] },

  async resolve(ctx, want) {
    const { infoHash, fileIdx, name, episode } = want
    const hash = String(infoHash).toLowerCase()
    // One Real-Debrid torrent per file: its file selection cannot change once made.
    const key = `${hash}:${Number.isInteger(fileIdx) ? fileIdx : name ?? (isEp(episode) ? `s${episode.season}e${episode.episode}` : '')}`
    let id = (await ids(ctx))[key]
    if (id == null) {
      const add = await api(ctx, '/torrents/addMagnet', { method: 'POST', body: form({ magnet: `magnet:?xt=urn:btih:${hash}` }) })
      if (!add?.id) throw new Error('Real-Debrid did not add the torrent.')
      id = add.id
      await remember(ctx, key, id)
    }
    let t
    try { t = await api(ctx, `/torrents/info/${encodeURIComponent(id)}`) } catch (e) {
      if (e.status === 404) { await remember(ctx, key, null); return { wait: { message: 'Real-Debrid is adding it again' } } }
      throw e
    }
    if (FAILED.includes(t.status)) { await remember(ctx, key, null); return { error: `Real-Debrid could not fetch this torrent (${t.status}).` } }
    if (t.status === 'waiting_files_selection') {
      const f = pickFile(t.files, want)
      if (!f) return { error: isEp(episode) ? `No file for ${tag(episode)} in this torrent.` : 'This torrent has no file to play.' }
      await api(ctx, `/torrents/selectFiles/${encodeURIComponent(id)}`, { method: 'POST', body: form({ files: String(f.id) }) })
      return { wait: { pct: 0, message: STATES.waiting_files_selection } }
    }
    if (t.status === 'downloaded') {
      // links[] follow the selected files in order; this torrent has one selected file.
      const link = Array.isArray(t.links) ? t.links[0] : null
      if (!link) return { error: 'Real-Debrid has this torrent but gave no link.' }
      const d = await api(ctx, '/unrestrict/link', { method: 'POST', body: form({ link }) })
      if (typeof d?.download !== 'string') throw new Error('Real-Debrid gave no download link.')
      const picked = Array.isArray(t.files) ? t.files.find((x) => x.selected === 1) : null
      return sized(d.download, Number(picked?.bytes ?? d.filesize))
    }
    const wait = { message: STATES[t.status] ?? 'Real-Debrid is fetching it' }
    if (Number.isFinite(Number(t.progress))) wait.pct = Number(t.progress)
    return { wait }
  },
}
