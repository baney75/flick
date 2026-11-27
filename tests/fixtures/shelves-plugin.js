// A Library fixture for scripts/smoke.mjs (SPEC-library-format P10b): 20 shelves, a kind of its own
// (recipe) with 10 facts, a video and a song with no shelf, a Like action that fills the Liked shelf,
// and a Watch later list of 301 rows.
// Check it with: npm run plugin:check -- tests/fixtures/shelves-plugin.js

const facts = [{ label: 'Servings', value: '4' }, { label: 'Platform', value: 'Switch' },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `Fact ${i + 3}`, value: `Value ${i + 3}` }))]
const recipe = { id: 'pancakes', type: 'recipe', name: 'Smoke Pancakes', subtitle: 'Breakfast', description: 'A test recipe.', facts }
const fillers = Array.from({ length: 17 }, (_, i) => ({ id: `paper-${i + 1}`, type: 'paper', name: `Smoke Paper ${i + 1}`, shelves: [`p${i + 1}`] }))
// Watch later is long enough that the list must window its rows (smoke: every row shows, few at once).
const saved = Array.from({ length: 300 }, (_, i) => ({ id: `saved-${i + 1}`, type: 'paper', name: `Saved paper ${i + 1}`, subtitle: 'Smoke Channel', shelves: ['later'] }))

/** @type {import('../../plugins/flick-plugin').Plugin} */
export default {
  api: 1,
  id: 'org.smoke.shelves',
  name: 'Smoke Shelves',
  version: '1.0.0',
  hosts: [],
  actions: [{ id: 'like', label: 'Like Smoke Pancakes' }],
  catalogs: [{ id: 'recipes', name: 'Recipes', type: 'recipe' }],

  async catalog() { return { items: [recipe] } },
  async meta(ctx, { id }) { return id === recipe.id ? recipe : { id, type: 'paper', name: id } },
  async streams() { return [] },
  async action(ctx, id) {
    await ctx.store.set('liked', true)
    return { ok: true, message: 'Liked' }
  },
  async library(ctx) {
    const liked = (await ctx.store.get('liked')) === true
    return {
      shelves: [
        { id: 'later', name: 'Watch later', layout: 'list' },
        { id: 'box', name: 'Recipe box', order: 'name' },
        { id: 'liked', name: 'Liked' },
        ...fillers.map((_, i) => ({ id: `p${i + 1}`, name: `Shelf ${i + 1}` })),
      ],
      items: [
        { ...recipe, shelves: ['box', ...(liked ? ['liked'] : [])], added: 1732600000 },
        { id: 'talk', type: 'video', name: 'Smoke Talk', subtitle: 'Smoke Channel', badges: ['12 min'], shelves: ['later'] },
        { id: 'song', type: 'audio', name: 'Smoke Song', posterShape: 'square' },
        ...fillers,
        ...saved,
      ],
    }
  },
}
