// The seeded library for the real-app perf check (src/lib/perf/realapp.ts): tests/fixtures/perf-seed.ts,
// the one scripts/perf.mjs measures (SPEC-perf rule 2), written the way the app stores its own. No file
// or server it names exists, so nothing plays. The images are drawn here, since the app has no preview
// server to fetch them from. On the desktop it also installs Flick's own YouTube plugin, whose Home rows
// search YouTube through yt-dlp as they do for a user.

import * as db from '../db'
import { isDesktop } from '../platform'
import { install, installed, prepare, YOUTUBE_PLUGIN } from '../plugins/registry'
import { note } from '../selftest'
import { buildSeed, COUNTS, PLUGIN_ID, SHELF_PLUGIN_ID, pluginCode, shelvesPluginCode } from '../../../tests/fixtures/perf-seed'

export { COUNTS }
export const SEED_KEY = 'perf.seed'
export const SEED_VERSION = 3
/** The desktop seed also installs Flick's own YouTube plugin, whose Home rows run yt-dlp in the app. */
export const SEED_PLUGIN = YOUTUBE_PLUGIN
/** The plugins a seeded profile holds; another self-test may have removed one. */
export const seedPlugins = (desktop = isDesktop) => [PLUGIN_ID, SHELF_PLUGIN_ID, ...(desktop ? [SEED_PLUGIN.id] : [])]
const pluginsOk = () => seedPlugins().every((id) => installed.value.some((p) => p.id === id))
/** How many distinct images each kind uses, as in scripts/perf.mjs. */
export const IMAGES = { thumbs: 48, posters: 16, rowArt: 8 }
const ROWS = 500
/** How long one launch spends seeding before it stops and lets the next launch go on. */
export const BUDGET_MS = 15_000
const ITEMS_KEY = 'perf.seed.items'
const THUMBS_KEY = 'perf.seed.thumbs'

/** A JPEG with a gradient, stripes and one bit of noise a channel, so decoding it is real work. */
function image(w: number, h: number, variant: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const px = g.createImageData(w, h)
  const hue = (variant * 47) % 360
  const [r0, g0, b0] = [Math.cos(hue) * 60 + 120, Math.sin(hue) * 60 + 110, 140 - Math.cos(hue) * 50]
  let rnd = variant + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const stripe = ((x + y + variant * 7) >> 3) & 1 ? 18 : 0
      rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0
      const n = (rnd >>> 16) & 1
      const i = (y * w + x) * 4
      px.data[i] = r0 + (x / w) * 80 + stripe + n
      px.data[i + 1] = g0 + (y / h) * 70 + n
      px.data[i + 2] = b0 + stripe + n
      px.data[i + 3] = 255
    }
  }
  g.putImageData(px, 0, 0)
  return c
}
const blob = (c: HTMLCanvasElement) => new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.8))
const dataUrl = (c: HTMLCanvasElement) => c.toDataURL('image/jpeg', 0.8)

/** True when this profile already holds the current seed and its plugins. */
export async function seeded(): Promise<boolean> {
  return (await db.get<number>('kv', SEED_KEY)) === SEED_VERSION && pluginsOk()
}

/**
 * Seeds the profile, as much as fits in BUDGET_MS, and says whether it finished. WebKit stores each
 * thumbnail Blob as a file, and 8,700 of them can outlast one self-test launch (30 s) on a busy Mac,
 * so the thumbnails resume where the last launch stopped.
 */
export async function seed(budgetMs = BUDGET_MS): Promise<boolean> {
  const t0 = performance.now()
  const step = (what: string) => note(`seed: ${what} at ${Math.round(performance.now() - t0)} ms`)
  const s = buildSeed()
  if ((await db.get<number>('kv', ITEMS_KEY)) !== SEED_VERSION) {
    await db.putMany('items', s.items.map((i) => [i.id, i]))
    await db.putMany('progress', Object.entries(s.progress))
    await db.put('kv', 'folders', s.folders)
    await db.put('kv', 'servers', s.servers)
    await db.put('kv', THUMBS_KEY, 0)
    await db.put('kv', ITEMS_KEY, SEED_VERSION)
    step(`${s.items.length} items`)
  }
  let next = (await db.get<number>('kv', THUMBS_KEY)) ?? 0
  if (next < s.thumbs.length) {
    const thumbs = await Promise.all(Array.from({ length: IMAGES.thumbs }, (_, i) => blob(image(320, 180, i))))
    while (next < s.thumbs.length && performance.now() - t0 < budgetMs) {
      await db.putMany('thumbs', s.thumbs.slice(next, next + ROWS).map(([id, v]) => [id, thumbs[v]]))
      next = Math.min(next + ROWS, s.thumbs.length)
      await db.put('kv', THUMBS_KEY, next)
    }
    step(`${next} of ${s.thumbs.length} thumbnails`)
    if (next < s.thumbs.length) return false
  }
  // Posters are data URLs: there is no server here, and an http one would leave this machine.
  const posters = Array.from({ length: IMAGES.posters }, (_, i) => dataUrl(image(120, 180, i + 100)))
  const rowArt = Array.from({ length: IMAGES.rowArt }, (_, i) => dataUrl(image(320, 180, i + 200)))
  const has = (id: string) => installed.value.some((p) => p.id === id)
  if (!has(PLUGIN_ID)) await install(await prepare({ text: pluginCode(s.library, posters) }))
  if (!has(SHELF_PLUGIN_ID)) await install(await prepare({ text: shelvesPluginCode(rowArt) }))
  if (isDesktop && !has(SEED_PLUGIN.id)) await install(await prepare({ url: SEED_PLUGIN.url }))
  step('plugins')
  await db.put('kv', SEED_KEY, SEED_VERSION)
  return true
}
