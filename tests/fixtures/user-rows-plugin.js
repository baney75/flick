// A plugin whose userCatalogs() has no rows until the user signs in, and makes no network calls.
// tests/plugin-check.test.ts runs plugin:check on it (#157).
const film = { id: 'f1', type: 'movie', name: 'A Film' }
export default {
  api: 1, id: 'org.example.userrows', name: 'User rows', version: '1.0.0', hosts: ['example.org'],
  catalogs: [{ id: 'top', name: 'Top', type: 'movie' }],
  async userCatalogs(ctx) { return (await ctx.store.get('signedIn')) ? [{ id: 'mine', name: 'Mine', type: 'movie' }] : [] },
  async catalog() { return { items: [film] } },
  async meta() { return film },
  async streams() { return [] },
}
