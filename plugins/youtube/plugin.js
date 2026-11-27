// YouTube in the Flick desktop app. yt-dlp (Flick's ytdlp desktop tool) searches and streams; this
// plugin only shapes rows and title pages. Contract: docs/PLUGINS.md.

const TOPICS = {
  science: 'science explained documentary',
  nature: 'nature documentary full',
  films: 'public domain classic full movie',
  music: 'live concert full',
  programming: 'programming tutorial',
  ai: 'artificial intelligence explained',
  math: 'mathematics lecture',
  history: 'history documentary',
  lectures: 'university lecture full course',
}
// What the user keeps, newest first, all on this device in the plugin's store.
const LISTS = {
  liked: { name: 'Liked', action: 'like', on: 'Liked', off: 'Removed from Liked' },
  later: { name: 'Watch later', action: 'later', on: 'Added to Watch later', off: 'Removed from Watch later' },
  history: { name: 'History' },
}
const KEEP = 500
const STOP = new Set('the and for with from that this what your you are how why into about full video official part live new over best more than when its was will can our not but all one two'.split(' '))
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

async function list(ctx, key) { return (await ctx.store.get(key)) ?? [] }

/** What a list keeps of a video: enough to draw its card with no search. */
function slim(m, at) {
  return { id: m.id, type: 'video', name: m.name, poster: m.poster, channel: m.channel, runtime: m.runtime, views: m.views, uploaded: m.uploaded, at }
}

/** A video's card fields from a search here, or from oEmbed for a link shared from elsewhere. */
async function find(ctx, url) {
  const m = await lookup(ctx, url)
  if (m) return m
  const o = await (await ctx.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`)).json()
  return { id: url, name: o.title, channel: o.author_name, poster: o.thumbnail_url, description: '' }
}

/**
 * The For You search, built from what was watched and liked: a channel seen at least twice (the most
 * often, then the latest), else the words at least two titles share. Null with nothing to go on.
 */
export function forYouQuery(history, liked) {
  // Each video once: liking a video you watched is not a second video from that channel.
  const all = [...new Map([...history, ...liked].map((m) => [m.id, m])).values()]
  const count = (keys) => {
    const n = new Map()
    for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1)
    return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
  }
  const chans = count(all.map((m) => m.channel).filter(Boolean))
  if (chans.length) return chans[0][0]
  const words = count(all.flatMap((m) => [...new Set(String(m.name ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w))))
  return words.length ? words.slice(0, 3).map(([w]) => w).join(' ') : null
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
  layout: 'grid',
  catalogs: [
    { id: 'search', name: 'Search', type: 'video', search: true },
    { id: 'foryou', name: 'For You', type: 'video' },
    { id: 'science', name: 'Science', type: 'video' },
    { id: 'nature', name: 'Nature', type: 'video' },
    { id: 'films', name: 'Classic films', type: 'video' },
    { id: 'music', name: 'Concerts', type: 'video' },
    { id: 'programming', name: 'Programming', type: 'video' },
    { id: 'ai', name: 'AI', type: 'video' },
    { id: 'math', name: 'Math', type: 'video' },
    { id: 'history', name: 'World history', type: 'video' },
    { id: 'lectures', name: 'Lectures', type: 'video' },
  ],
  titleActions: [
    { id: 'like', label: 'Like', key: 'l' },
    { id: 'later', label: 'Watch later', key: 'w' },
  ],

  /** Liked, Watch later and History, each only once it has something in it. */
  async userCatalogs(ctx) {
    const out = []
    for (const [key, l] of Object.entries(LISTS)) if ((await list(ctx, key)).length) out.push({ id: `my-${key}`, name: l.name, type: 'video' })
    return out
  },

  async catalog(ctx, { id, search, skip = 0 }) {
    const mine = /^my-(liked|later|history)$/.exec(id ?? '')
    if (mine && !search) {
      const all = await list(ctx, mine[1])
      return { items: all.slice(skip, skip + PAGE).map((m) => card(m)), more: skip + PAGE < all.length }
    }
    const q = search ?? (id === 'foryou' ? forYouQuery(await list(ctx, 'history'), await list(ctx, 'liked')) ?? TOPICS.science : TOPICS[id])
    if (!q) return { items: [], more: false }
    const want = Math.min(MAX, skip + PAGE)
    const all = await ctx.tools.ytdlp.search(q, want)
    remember(ctx, all)
    return { items: all.slice(skip).map((m) => card(m)), more: want < MAX && all.length >= want }
  },

  async meta(ctx, { id }) {
    const url = watchUrl(id)
    const m = await find(ctx, url)
    const marks = []
    for (const [key, l] of Object.entries(LISTS)) if (l.action && (await list(ctx, key)).some((x) => x.id === url)) marks.push(l.action)
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
      marks,
    }
  },

  /** Like and Watch later: toggle the video on that list. */
  async titleAction(ctx, { id, action }) {
    const key = Object.keys(LISTS).find((k) => LISTS[k].action === action)
    if (!key) return { ok: false, message: `No such action: ${action}` }
    const url = watchUrl(id)
    const l = await list(ctx, key)
    if (l.some((x) => x.id === url)) {
      await ctx.store.set(key, l.filter((x) => x.id !== url))
      return { ok: true, on: false, message: LISTS[key].off }
    }
    await ctx.store.set(key, [slim(await find(ctx, url), Date.now()), ...l].slice(0, KEEP))
    return { ok: true, on: true, message: LISTS[key].on }
  },

  /** History: what played, newest first, once per video. */
  async progress(ctx, { id }) {
    const url = watchUrl(id)
    const l = await list(ctx, 'history')
    if (l[0]?.id === url) return
    const m = l.find((x) => x.id === url) ?? (await find(ctx, url))
    await ctx.store.set('history', [slim(m, Date.now()), ...l.filter((x) => x.id !== url)].slice(0, KEEP))
  },

  /**
   * Liked, Watch later and History as Library shelves. Each video is one item, on every list it is on,
   * so All shows it once. History leads, newest first; then what was only liked or saved, newest first.
   * `added` is when it last played, else when it joined a list.
   */
  async library(ctx) {
    const lists = {}
    for (const key of Object.keys(LISTS)) lists[key] = await list(ctx, key)
    const rest = [...lists.liked, ...lists.later].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    const items = new Map()
    for (const m of [...lists.history, ...rest]) {
      if (!items.has(m.id)) items.set(m.id, { ...card(m), type: 'video', posterShape: 'landscape', added: m.at, shelves: [] })
    }
    for (const [key, l] of Object.entries(lists)) for (const m of l) items.get(m.id).shelves.push(key)
    return {
      shelves: Object.entries(LISTS).map(([id, l]) => ({ id, name: l.name, layout: 'landscape' })),
      items: [...items.values()],
    }
  },

  async streams(ctx, { id }) {
    return [{ url: await ctx.tools.ytdlp.resolve(watchUrl(id)), title: 'YouTube', kind: 'video' }]
  },
}
