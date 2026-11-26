// The Internet Archive: public domain films, classic TV, audiobooks, old-time radio and books.
// Uses archive.org's public, CORS-enabled APIs (advancedsearch.php, /metadata, /download), so it
// works on every platform. Contract: docs/PLUGINS.md.

const API = 'https://archive.org'
const ROWS = 40
const VIDEO = 'format:(h.264 OR MPEG4 OR "512Kb MPEG4" OR "h.264 IA")'
const ROWS_BY_ID = {
  films: { q: `collection:feature_films AND mediatype:movies AND ${VIDEO}`, type: 'movie' },
  tv: { q: `collection:classic_tv AND mediatype:movies AND ${VIDEO}`, type: 'series' },
  audiobooks: { q: 'collection:librivoxaudio AND mediatype:audio', type: 'audiobook' },
  radio: { q: 'collection:oldtimeradio AND mediatype:audio AND format:MP3', type: 'audio' },
  books: { q: 'collection:americana AND mediatype:texts AND format:"Text PDF"', type: 'book' },
}
const SEARCHED = 'collection:(feature_films OR classic_tv OR librivoxaudio OR oldtimeradio OR americana)'

const first = (x) => (Array.isArray(x) ? x[0] : x)
const text = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const fileUrl = (id, name) => `${API}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`
const shape = { book: 'poster', audiobook: 'square', audio: 'square' }

/** The type of an item from its mediatype and collections, for search results. */
function typeOf(mediatype, collections) {
  const c = [].concat(collections ?? [])
  if (mediatype === 'texts') return 'book'
  if (mediatype === 'audio') return c.includes('librivoxaudio') ? 'audiobook' : 'audio'
  return c.includes('classic_tv') ? 'series' : 'movie'
}

/** What a file is to Flick, and how much to prefer it (lower first). Others are skipped. */
function kindOf(f) {
  const n = f.name.toLowerCase(), fmt = String(f.format ?? '')
  if (/\.(mp4|m4v|webm)$/.test(n)) return { kind: 'video', rank: /h\.264/i.test(fmt) ? 0 : /512Kb/i.test(fmt) ? 1 : 2 }
  if (/\.(ogv|mkv|avi|mpe?g)$/.test(n)) return { kind: 'video', rank: 3, needsDesktop: true }
  if (/\.(mp3|m4b|m4a)$/.test(n)) return { kind: 'audio', rank: /VBR/i.test(fmt) ? 0 : /128/.test(fmt) ? 1 : 2 }
  if (/\.pdf$/.test(n)) return { kind: 'book', rank: /^Text PDF$/i.test(fmt) ? 0 : 1 }
  if (/\.epub$/.test(n)) return { kind: 'book', rank: 2 }
  return null
}

/**
 * The parts of an item (episodes, chapters, a film), each with its playable files. A derivative joins
 * the part of the file it was made from; a book is one part. Exported for tests.
 */
export function parts(id, files) {
  const groups = new Map()
  for (const f of files ?? []) {
    const k = kindOf(f)
    if (!k || f.private === 'true') continue
    const key = k.kind === 'book' ? id : f.source === 'derivative' && f.original ? f.original : f.name
    const g = groups.get(key) ?? { key, files: [] }
    g.files.push({ ...f, ...k })
    groups.set(key, g)
  }
  // Every part is the item's main kind: a film's MP3 derivative or an audiobook's PDF is not a part.
  const all = [...groups.values()].flatMap((g) => g.files)
  const main = ['video', 'audio', 'book'].find((k) => all.some((f) => f.kind === k))
  const out = [...groups.values()].filter((g) => (g.files = g.files.filter((f) => f.kind === main)).length).map((g) => {
    g.files.sort((a, b) => a.rank - b.rank || Number(b.height ?? 0) - Number(a.height ?? 0))
    const named = g.files.find((f) => f.title)
    g.title = named?.title ?? (/\.m4b$/i.test(g.key) ? 'Whole book' : g.key.replace(/\.[^.]+$/, '').replace(/[_.]+/g, ' ').trim())
    g.track = Number.parseInt(first(named?.track ?? g.files[0].track), 10)
    return g
  })
  // Track numbers order the parts only when every part has one; otherwise the file names do.
  const tracked = out.every((g) => g.track > 0)
  return out.sort((a, b) => (tracked ? a.track - b.track : 0) || a.key.localeCompare(b.key, 'en', { numeric: true }))
}

const cache = new Map()
async function item(ctx, id) {
  if (!cache.has(id)) {
    const r = await ctx.fetch(`${API}/metadata/${encodeURIComponent(id)}`)
    const j = await r.json()
    if (!j.metadata) throw new Error(`archive.org has no item ${id}.`)
    if (cache.size > 20) cache.delete(cache.keys().next().value)
    cache.set(id, j)
  }
  return cache.get(id)
}

/** @type {import('../flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'org.archive',
  name: 'Internet Archive',
  version: '1.0.0',
  author: 'Flick',
  description: 'Public domain films, classic TV, audiobooks, old-time radio and books from archive.org.',
  icon: 'https://archive.org/images/glogo.jpg',
  hosts: ['archive.org', '*.archive.org', '*.us.archive.org'],
  tools: [],
  catalogs: [
    { id: 'films', name: 'Feature films', type: 'movie' },
    { id: 'tv', name: 'Classic TV', type: 'series' },
    { id: 'audiobooks', name: 'Audiobooks', type: 'audiobook' },
    { id: 'radio', name: 'Old-time radio', type: 'audio' },
    { id: 'books', name: 'Books', type: 'book' },
    { id: 'search', name: 'Search', type: 'movie', search: true },
  ],

  async catalog(ctx, { id, search, skip = 0 }) {
    const row = ROWS_BY_ID[id]
    // Search words only: Solr syntax from the box would break the query.
    const words = String(search ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim()
    if (!row && !words) return { items: [], more: false }
    const q = row ? row.q : `(title:(${words}) OR creator:(${words})) AND ${SEARCHED}`
    const page = Math.floor(skip / ROWS) + 1
    const sort = row ? '&sort%5B%5D=downloads%20desc' : ''
    const fl = ['identifier', 'title', 'year', 'mediatype', 'collection'].map((f) => `&fl%5B%5D=${f}`).join('')
    const j = await (await ctx.fetch(`${API}/advancedsearch.php?q=${encodeURIComponent(q)}${fl}${sort}&rows=${ROWS}&page=${page}&output=json`)).json()
    return {
      items: (j.response?.docs ?? []).map((d) => {
        const type = row?.type ?? typeOf(d.mediatype, d.collection)
        return { id: d.identifier, type, name: first(d.title) ?? d.identifier, year: d.year ? String(d.year) : undefined, poster: `${API}/services/img/${d.identifier}`, posterShape: shape[type] }
      }),
      more: (j.response?.numFound ?? 0) > page * ROWS,
    }
  },

  async meta(ctx, { id, type }) {
    const j = await item(ctx, id)
    const m = j.metadata
    const t = type ?? typeOf(m.mediatype, m.collection)
    const list = parts(id, j.files)
    return {
      id,
      type: t,
      name: text(first(m.title)) || id,
      description: text([].concat(m.description ?? []).join(' ')).slice(0, 2000) || undefined,
      year: m.year ? String(first(m.year)) : String(first(m.date) ?? '').slice(0, 4) || undefined,
      runtime: first(m.runtime),
      genres: [].concat(m.creator ?? []).slice(0, 3),
      poster: `${API}/services/img/${id}`,
      posterShape: shape[t],
      background: `${API}/services/img/${id}`,
      videos: list.length > 1 ? list.map((g, i) => {
        const se = /S(\d{1,2})E(\d{1,3})/i.exec(g.key)
        return { id: g.key, title: g.title, season: se ? Number(se[1]) : undefined, episode: se ? Number(se[2]) : i + 1 }
      }) : undefined,
    }
  },

  async streams(ctx, { id, videoId }) {
    const list = parts(id, (await item(ctx, id)).files)
    const g = list.find((p) => p.key === videoId) ?? list[0]
    if (!g) return []
    return g.files.slice(0, 6).map((f) => ({
      url: fileUrl(id, f.name),
      title: f.format || f.name,
      quality: f.kind === 'video' && Number(f.height) > 0 ? `${f.height}p` : undefined,
      kind: f.kind,
      needsDesktop: f.needsDesktop || undefined,
    }))
  },
}
