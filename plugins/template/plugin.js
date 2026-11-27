// A working Flick source plugin: feature films from the Internet Archive.
// Copy this file, change id, name, hosts and the three functions, then run:
//   npm run plugin:check -- path/to/plugin.js
// Contract: docs/PLUGINS.md. Types: plugins/flick-plugin.d.ts.

const API = 'https://archive.org'
const ROWS = 40

const text = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const first = (x) => (Array.isArray(x) ? x[0] : x)

/** @type {import('../flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'org.archive.films',
  name: 'Internet Archive films',
  version: '1.0.0',
  author: 'Flick',
  description: 'Public domain feature films from archive.org. A starting point for your own plugin.',
  icon: 'https://archive.org/images/glogo.jpg',
  hosts: ['archive.org', '*.archive.org'],
  tools: [],
  catalogs: [
    { id: 'feature_films', name: 'Feature films', type: 'movie' },
    { id: 'Film_Noir', name: 'Film noir', type: 'movie' },
    { id: 'search', name: 'Search', type: 'movie', search: true },
  ],

  async catalog(ctx, { id, search, skip = 0 }) {
    // Only items with a playable MP4, so every title opens to a stream.
    const has = 'mediatype:movies AND format:(MPEG4 OR "h.264")'
    const q = search ? `(${search}) AND collection:feature_films AND ${has}` : `collection:${id} AND ${has}`
    const page = Math.floor(skip / ROWS) + 1
    const url = `${API}/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year` +
      `&sort%5B%5D=downloads%20desc&rows=${ROWS}&page=${page}&output=json`
    const j = await (await ctx.fetch(url)).json()
    const docs = j.response?.docs ?? []
    return {
      items: docs.map((d) => ({
        id: d.identifier,
        type: 'movie',
        name: first(d.title) ?? d.identifier,
        year: d.year ? String(d.year) : undefined,
        poster: `${API}/services/img/${d.identifier}`,
      })),
      more: (j.response?.numFound ?? 0) > page * ROWS,
    }
  },

  async meta(ctx, { id }) {
    const j = await (await ctx.fetch(`${API}/metadata/${encodeURIComponent(id)}`)).json()
    const m = j.metadata ?? {}
    return {
      id,
      type: 'movie',
      name: first(m.title) ?? id,
      description: text(first(m.description)).slice(0, 1500),
      year: m.year ? String(first(m.year)) : (first(m.date) ?? '').slice(0, 4) || undefined,
      runtime: first(m.runtime),
      poster: `${API}/services/img/${id}`,
      background: `${API}/services/img/${id}`,
    }
  },

  // Optional: the user's own things, shown in Flick's Library. Return a Meta list, or shelves (chips in
  // Library) and items that name them. `type` may be a kind of your own ('podcast', 'recipe'); `added`
  // is when it was added (ms) and `facts` are labeled details for the title page. See "Library" in
  // docs/PLUGINS.md.
  //   async library(ctx) {
  //     const saved = (await ctx.store.get('saved')) ?? []
  //     return { shelves: [{ id: 'saved', name: 'Saved films' }], items: saved.map((m) => ({ ...m, shelves: ['saved'] })) }
  //   },

  async streams(ctx, { id }) {
    const j = await (await ctx.fetch(`${API}/metadata/${encodeURIComponent(id)}`)).json()
    const files = (j.files ?? []).filter((f) => /\.(mp4|m4v|webm|ogv)$/i.test(f.name))
    files.sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))
    return files.slice(0, 6).map((f) => ({
      url: `${API}/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      title: f.name,
      quality: f.height ? `${f.height}p` : f.format,
      kind: 'video',
      needsDesktop: /\.ogv$/i.test(f.name) || undefined,
    }))
  },
}
