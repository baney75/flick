// YouTube in the Flick desktop app. yt-dlp (Flick's ytdlp desktop tool) searches and streams; this
// plugin only shapes rows and title pages. Contract: docs/PLUGINS.md.

const TOPICS = {
  science: 'science explained documentary',
  nature: 'nature documentary full',
  films: 'public domain classic full movie',
  music: 'live concert full',
}
const PAGE = 20
const MAX = 50 // the most one yt-dlp search returns
const seen = new Map() // watch URL to the search result it came from, for meta()

/** A view count as YouTube writes it: "1.2M views", "12K views", "1 view". Null when unknown. */
export function views(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  if (n === 0) return 'No views'
  if (n === 1) return '1 view'
  const [div, unit] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'K'] : [1, '']
  const x = n / div
  // One decimal under 10 (1.2M), none above (12M), never rounded up past the next unit.
  const shown = x < 10 && div > 1 ? Math.floor(x * 10) / 10 : Math.floor(x)
  return `${shown}${unit} views`
}

/** How long ago, from Unix seconds: "3 years ago", "5 days ago". Null when unknown. */
export function age(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !(ts > 0)) return null
  const s = Math.max(0, now / 1000 - ts)
  const steps = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [len, word] of steps) {
    const k = Math.floor(s / len)
    if (word === 'month' && k >= 12) return '1 year ago'
    if (k >= 1) return `${k} ${word}${k > 1 ? 's' : ''} ago`
  }
  return 'Just now'
}

/** A search result as a card: the channel under the name, then views and age. */
export function card(m, now = Date.now()) {
  const badges = [views(m.views), age(m.uploaded, now)].filter(Boolean)
  return { ...m, subtitle: m.channel || undefined, badges }
}

function remember(ctx, items) {
  for (const m of items) seen.set(m.id, m)
  const keep = [...seen.values()].slice(-100)
  ctx.store.set('seen', keep).catch(() => {})
}

async function lookup(ctx, id) {
  if (!seen.has(id)) for (const m of (await ctx.store.get('seen')) ?? []) seen.set(m.id, m)
  return seen.get(id)
}

function watchUrl(id) {
  const u = new URL(id)
  if (!/^(www\.|m\.)?youtube\.com$|^youtu\.be$/.test(u.hostname)) throw new Error(`Not a YouTube address: ${id}`)
  return u.href
}

/** @type {import('../flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'com.youtube',
  name: 'YouTube',
  version: '1.0.0',
  author: 'Flick',
  description: 'Search and watch YouTube in the desktop app. Flick fetches and updates yt-dlp for you.',
  icon: 'https://www.youtube.com/favicon.ico',
  hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'],
  tools: ['ytdlp'],
  platforms: ['desktop'],
  catalogs: [
    { id: 'search', name: 'Search', type: 'video', search: true },
    { id: 'science', name: 'Science', type: 'video' },
    { id: 'nature', name: 'Nature', type: 'video' },
    { id: 'films', name: 'Classic films', type: 'video' },
    { id: 'music', name: 'Concerts', type: 'video' },
  ],

  async catalog(ctx, { id, search, skip = 0 }) {
    const q = search ?? TOPICS[id]
    if (!q) return { items: [], more: false }
    const want = Math.min(MAX, skip + PAGE)
    const all = await ctx.tools.ytdlp.search(q, want)
    remember(ctx, all)
    return { items: all.slice(skip).map((m) => card(m)), more: want < MAX && all.length >= want }
  },

  async meta(ctx, { id }) {
    const url = watchUrl(id)
    let m = await lookup(ctx, url)
    if (!m) {
      // Not from a search here (a shared link): oEmbed has the title, channel and thumbnail.
      const o = await (await ctx.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`)).json()
      m = { id: url, name: o.title, channel: o.author_name, poster: o.thumbnail_url, description: '' }
    }
    const by = m.channel ? `${m.channel}. ` : ''
    return {
      id: url,
      type: 'video',
      name: m.name,
      poster: m.poster,
      background: m.poster,
      posterShape: 'landscape',
      subtitle: m.channel || undefined,
      badges: card(m).badges,
      description: `${by}${m.description ?? ''}`.trim(),
      runtime: m.runtime || undefined,
    }
  },

  async streams(ctx, { id }) {
    return [{ url: await ctx.tools.ytdlp.resolve(watchUrl(id)), title: 'YouTube', kind: 'video' }]
  },
}
