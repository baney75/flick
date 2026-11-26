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
    return { items: all.slice(skip), more: want < MAX && all.length >= want }
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
      description: `${by}${m.description ?? ''}`.trim(),
      runtime: m.runtime || undefined,
    }
  },

  async streams(ctx, { id }) {
    return [{ url: await ctx.tools.ytdlp.resolve(watchUrl(id)), title: 'YouTube', kind: 'video' }]
  },
}
