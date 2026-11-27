// Speed and smoothness on a seeded library (SPEC-perf rules 1 to 6). Builds the site, serves it on a
// free port, fills IndexedDB with tests/fixtures/perf-seed.ts, and times what a user does in
// Playwright WebKit (the desktop app's engine) at 1280x800 and 390x844. Writes perf/results.json,
// prints a table, and exits non-zero naming every metric over its budget in perf/budgets.json.
//
//   node scripts/perf.mjs [--runs 5] [--engine webkit|chromium] [--viewport 1280|390|both]
//     [--compare perf/baseline.json] [--out perf/results.json] [--no-build] [--no-gate]
//     [--throttle 4] (Chromium only) [--inject chip=200] (adds a delay, to prove the gate fails)
import { webkit, chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { freePort } from './free-port.mjs'
import { stats, gate, table, compare } from './perf-lib.mjs'
import { buildSeed, pluginCode, shelvesPluginCode, PLUGIN_ID, SHELF_PLUGIN_ID } from '../tests/fixtures/perf-seed.ts'
import * as V from '../src/lib/plugins/validate.ts'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const RUNS = Number(opt('runs', 5))
const ENGINE = opt('engine', process.env.PERF_ENGINE ?? 'webkit')
const VIEWPORTS = { 1280: { width: 1280, height: 800 }, 390: { width: 390, height: 844 } }
const which = opt('viewport', 'both')
const sizes = which === 'both' ? ['1280', '390'] : [which]
const THROTTLE = Number(opt('throttle', 1))
const OUT = opt('out', 'perf/results.json')
const INJECT = opt('inject', '')
// --only nav,chips: run just those sections (cold start always runs). For working on one screen.
const ONLY = opt('only', '').split(',').filter(Boolean)
const on = (x) => !ONLY.length || ONLY.includes(x)
const budgets = JSON.parse(readFileSync('perf/budgets.json', 'utf8'))

// Its own build in a temp directory, never dist/: smoke serves dist/, and a build there empties it
// under a running smoke (its lazy chunks, the EPUB reader's among them, vanish mid-test).
// --no-build serves the dist/ that is already there.
const VITE = ['node_modules/vite/bin/vite.js']
const BUILD = flag('no-build') ? 'dist' : mkdtempSync(join(tmpdir(), 'flick-perf-dist-'))
// Temp folders go however the run ends: a thrown step, a failed build, or no WebKit.
const temps = BUILD === 'dist' ? [] : [BUILD]
let server
process.on('exit', () => { server?.kill(); for (const d of temps) rmSync(d, { recursive: true, force: true }) })
// A stop from outside (Ctrl-C, a timeout) still runs the cleanup above.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130))
if (!flag('no-build')) execFileSync(process.execPath, [...VITE, 'build', '--logLevel', 'warn', '--outDir', BUILD, '--emptyOutDir', ...(flag('no-minify') ? ['--minify', 'false'] : [])], { stdio: 'inherit' })
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`

// ---- images: PNGs the size of real thumbnails and posters (about 23 KB and 9 KB), so decoding is
// real work and nothing leaves this machine. One bit of noise a channel, Sub filtered, keeps them from
// compressing to nothing without making them five times the size of a real JPEG thumbnail.
function png(w, h, variant) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let rnd = variant + 1
  const hue = (variant * 47) % 360
  const [r0, g0, b0] = [Math.cos(hue) * 60 + 120, Math.sin(hue) * 60 + 110, 140 - Math.cos(hue) * 50]
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    const px = []
    for (let x = 0; x < w; x++) {
      const stripe = ((x + y + variant * 7) >> 3) & 1 ? 18 : 0
      rnd = (rnd * 1103515245 + 12345) >>> 0
      const n = (rnd >>> 16) & 1
      px.push(Math.min(255, r0 + (x / w) * 80 + stripe + n) | 0, Math.min(255, g0 + (y / h) * 70 + n) | 0, Math.min(255, b0 + stripe + n) | 0)
    }
    raw[row] = 1
    for (let i = 0; i < px.length; i++) raw[row + 1 + i] = (px[i] - (i >= 3 ? px[i - 3] : 0)) & 255
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return file
}
const thumbImages = Array.from({ length: 48 }, (_, i) => `data:image/png;base64,${png(320, 180, i).toString('base64')}`)
// Plugin posters are short URLs on the preview server, as a real plugin's are: data URLs would make every
// library result carry megabytes of strings.
mkdirSync(join(BUILD, 'perf-img'), { recursive: true })
const posters = Array.from({ length: 16 }, (_, i) => { writeFileSync(join(BUILD, 'perf-img', `p${i}.png`), png(120, 180, i + 100)); return `${BASE}/perf-img/p${i}.png` })
const rowArt = Array.from({ length: 8 }, (_, i) => { writeFileSync(join(BUILD, 'perf-img', `r${i}.png`), png(320, 180, i + 200)); return `${BASE}/perf-img/r${i}.png` })

// ---- the seeded library and the fixture plugin, checked by the app's own validator ----
const seed = buildSeed()
async function pluginRecord(id, code) {
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default
  const manifest = V.validateManifest(mod, Object.keys(mod).filter((k) => typeof mod[k] === 'function'))
  return { id, kind: 'source', url: null, code, sha256: createHash('sha256').update(code).digest('hex'), manifest, enabled: true, official: false, settings: {}, installedAt: Date.now(), checkedAt: Date.now() }
}
const plugins = [await pluginRecord(PLUGIN_ID, pluginCode(seed.library, posters)), await pluginRecord(SHELF_PLUGIN_ID, shelvesPluginCode(rowArt))]

async function writeSeed({ items, progress, folders, servers, thumbs, plugins, images }) {
  const blobs = await Promise.all(images.map((u) => fetch(u).then((r) => r.blob())))
  const db = await new Promise((ok, no) => { const r = indexedDB.open('flick'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
  const put = (store, rows) => new Promise((ok, no) => {
    const tx = db.transaction(store, 'readwrite')
    const s = tx.objectStore(store)
    for (const [k, v] of rows) s.put(v, k)
    tx.oncomplete = () => ok()
    tx.onerror = () => no(new Error(`${store}: ${tx.error?.name} ${tx.error?.message}`))
    tx.onabort = () => no(new Error(`${store} aborted: ${tx.error?.name} ${tx.error?.message}`))
  })
  await put('items', items.map((i) => [i.id, i]))
  // As the app's own writes do (src/lib/db.ts), so a copy of the items saved by the first, empty load is stale.
  const rev = await new Promise((ok, no) => { const r = db.transaction('kv').objectStore('kv').get('items.rev'); r.onsuccess = () => ok(r.result ?? 0); r.onerror = () => no(r.error) })
  await put('kv', [['items.rev', rev + 1]])
  await put('progress', Object.entries(progress))
  await put('kv', [['folders', folders], ['servers', servers]])
  await put('plugins', plugins.map((p) => [p.id, p]))
  for (let i = 0; i < thumbs.length; i += 1000) await put('thumbs', thumbs.slice(i, i + 1000).map(([id, v]) => [id, blobs[v]]))
  db.close()
  return items.length
}

// ---- the browser: WebKit from this Playwright, else the newest local WebKit that still talks to it ----
// Each viewport gets a persistent profile in a temp folder: WebKit's throwaway contexts refuse to keep
// Blobs in IndexedDB, and Flick keeps its thumbnails there.
async function findWebkit() {
  try { const b = await webkit.launch(); await b.close(); return { exe: undefined, name: 'webkit' } } catch (e) {
    if (!/Executable doesn't exist/i.test(e.message)) throw e
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^webkit-\d+$/.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7))) : []
  for (const d of dirs) {
    const exe = join(root, d, process.platform === 'darwin' ? 'pw_run.sh' : 'minibrowser-wpe/MiniBrowser')
    if (!existsSync(exe)) continue
    try {
      const b = await webkit.launch({ executablePath: exe })
      const probe = await b.newPage(); await probe.setContent('<p>ok</p>'); await b.close()
      return { exe, name: `webkit (${d}, the newest installed build this Playwright drives)` }
    } catch { /* too old for this Playwright: try the next */ }
  }
  throw new Error('No WebKit this Playwright can drive. Install one with `npx playwright install webkit`.')
}
const found = ENGINE === 'chromium' ? { exe: undefined, name: 'chromium' } : await findWebkit()
// Each context gets its own throwaway profile, so perf never shares storage or a browser with smoke.
const newContext = (viewport) => {
  const dir = mkdtempSync(join(tmpdir(), 'flick-perf-'))
  temps.push(dir)
  const o = { viewport, serviceWorkers: 'block', executablePath: found.exe }
  return ENGINE === 'chromium' ? chromium.launchPersistentContext(dir, { ...o, args: ['--mute-audio'], channel: process.env.PERF_CHANNEL || undefined }) : webkit.launchPersistentContext(dir, o)
}

// Vite itself, not through npx, so kill() reaches the server and no preview outlives the run.
server = spawn(process.execPath, [...VITE, 'preview', '--outDir', BUILD, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const agent = readFileSync(new URL('./perf-agent.js', import.meta.url), 'utf8')
const samples = {}
const add = (k, v, unit = 'ms') => { if (v == null || Number.isNaN(v)) return; (samples[k] ??= { unit, s: [] }).s.push(v) }
const notes = []
const pageErrors = new Set()
let failure = null
// A step that never shows its result counts as the whole wait, so a slow run cannot drop out of the p95.
const STEP_TIMEOUT = 10000
const timedOut = (r, what) => {
  if (r.timedOut && r.painted == null) { r.painted = r.settled = STEP_TIMEOUT; notes.push(`a step timed out at ${STEP_TIMEOUT} ms waiting for ${JSON.stringify(what)}`) }
  return r
}

const sel = {
  home: { sel: '.main .row-section' },
  library: { sel: '.main .toolbar .chips' },
  settings: { sel: '.main .page.narrow .page-head h1', text: 'Settings' },
}

const engine = found.name
let ctx
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/`); break } catch { await new Promise((r) => setTimeout(r, 200)) } }
  for (const size of sizes) {
    const P = size === '1280' ? '' : `phone.`
    ctx = await newContext(VIEWPORTS[size])
    await ctx.addInitScript(agent)
    if (INJECT) {
      const [what, ms] = INJECT.split('=')
      await ctx.addInitScript(({ what, ms }) => {
        addEventListener('click', (e) => { if (e.target.closest?.(`.${what}`)) { const end = performance.now() + ms; while (performance.now() < end); } }, true)
      }, { what, ms: Number(ms) })
    }
    // Seed once: the app makes its stores on the first load, then the fixture fills them.
    const first = ctx.pages()[0] ?? await ctx.newPage()
    await first.goto(`${BASE}/`)
    await first.getByText('Drop anything here to play it.').waitFor()
    const n = await first.evaluate(writeSeed, { ...seed, plugins, images: thumbImages })
    // One open after the seed, as a person's library was opened before: the app saves its copy of the
    // items then, so the runs below time a normal start, not the first one after an update.
    await first.reload()
    const copied = () => first.evaluate(() => new Promise((ok) => {
      const r = indexedDB.open('flick')
      r.onerror = () => ok(false)
      r.onsuccess = () => {
        const db = r.result, kv = db.transaction('kv').objectStore('kv'), rev = kv.get('items.rev'), copy = kv.get('items.copy')
        // The first, empty load saved a copy too: only one at the seed's rev counts.
        copy.onsuccess = () => { db.close(); ok(!!copy.result && copy.result.rev === (rev.result ?? 0)) }
        copy.onerror = () => { db.close(); ok(false) }
      }
    }))
    for (const end = Date.now() + 30000; !(await copied());) {
      if (Date.now() > end) { notes.push(`${size}: the app saved no copy of the seeded items within 30 s, so each run starts as the first after an update`); break }
      await new Promise((r) => setTimeout(r, 250))
    }
    // Playwright's Linux WebKit quits when its last page closes, and each run below closes its page
    // before the next opens: one blank page stays open until the context closes.
    await ctx.newPage()
    await first.close()
    console.log(`${size}: seeded ${n} items, ${seed.thumbs.length} thumbnails, a plugin with ${seed.library.length} titles, and one with a 1,000 row shelf`)

    // quiet: wait for Home to paint and the DOM to settle. Otherwise return the moment Home paints,
    // so the first tap lands while startup work is still running, as a person's would.
    const open = async (quiet = true) => {
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.add(e.message))
      if (THROTTLE > 1 && ENGINE === 'chromium') await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
      await page.goto(`${BASE}/`)
      const boot = await page.evaluate((q) => (q ? window.__perf.booted() : window.__perf.homePainted()), quiet)
      return { page, boot }
    }
    // --profile: a Chromium CPU profile of each measured step, in perf/profiles/. Build with
    // --no-minify first for readable names.
    let step = 0
    const profiled = async (page, f) => {
      if (!flag('profile') || ENGINE !== 'chromium') return f()
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start')
      const r = await f()
      const { profile } = await cdp.send('Profiler.stop')
      mkdirSync('perf/profiles', { recursive: true })
      writeFileSync(`perf/profiles/${String(++step).padStart(2, '0')}.cpuprofile`, JSON.stringify(profile))
      await cdp.detach()
      return r
    }
    const measure = (page, act, opts) => profiled(page, async () => {
      await page.evaluate((o) => window.__perf.arm(o), opts)
      await act()
      const r = await page.evaluate((t) => window.__perf.result(100, t), STEP_TIMEOUT)
      timedOut(r, opts.marker ?? opts.events)
      if (process.env.PERF_DEBUG) console.log('DEBUG', JSON.stringify(opts.marker ?? opts.events), JSON.stringify(r))
      return r
    })
    const go = async (page, path, marker) => {
      await page.evaluate(([p, m]) => window.__perf.go(p, m), [path, marker])
      return timedOut(await page.evaluate((t) => window.__perf.result(100, t), STEP_TIMEOUT), path)
    }
    const tap = (page, label) => page.locator('.sidebar .nav-item', { hasText: label }).click()

    for (let run = 0; run < RUNS; run++) {
      const { page, boot } = await open(false)
      add(`${P}start.painted`, boot.painted)
      if (boot.welcome != null && boot.welcome < (boot.painted ?? Infinity)) notes.push(`${P}run ${run + 1}: Home showed the empty welcome screen before the library (${Math.round(boot.welcome)} ms, library at ${Math.round(boot.painted)} ms)`)

      // Bar taps. The first lands the moment Home paints: Home interactive (first input handled) is
      // the frame that answers it, counted from navigation.
      let first = true
      if (on('nav')) for (const [from, to, label, m] of [['home', 'library', 'Library', sel.library], ['library', 'settings', 'Settings', sel.settings], ['settings', 'home', 'Home', sel.home]]) {
        const r = await measure(page, () => tap(page, label), { events: ['click'], marker: m })
        if (first && r.at != null) add(`${P}start.interactive`, r.at)
        first = false
        add(`${P}nav.${from}-${to}`, r.painted)
        add(`${P}nav.${from}-${to}.settled`, r.settled)
      }
      add(`${P}start.items`, await page.waitForFunction(() => window.__perf.boot.marks.items, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => null))

      // Library chips, then search, then the fling.
      await go(page, '/library', sel.library)
      // All is on when Library opens, so it goes last, after another chip.
      if (on('chips')) for (const chip of ['Movies', 'Music', 'Shows', 'Photos', 'Continue', 'All']) {
        const loc = page.locator('.toolbar .chip', { hasText: new RegExp(`^${chip}\\b`) })
        if (!(await loc.count())) { notes.push(`${P}no ${chip} chip`); continue }
        const r = await measure(page, () => loc.click(), { events: ['click'], marker: { sel: '.toolbar .chip.on', text: chip } })
        add(`${P}chip.${chip.toLowerCase()}`, r.painted)
        add(`${P}chip.${chip.toLowerCase()}.settled`, r.settled)
      }
      await page.locator('.toolbar .chip', { hasText: /^All\b/ }).click()
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
      if (on('search')) {
      const box = page.getByLabel('Search library')
      await box.click()
      for (const ch of 'the office') {
        const r = await measure(page, () => page.keyboard.type(ch), { events: ['keydown'] })
        // The frame after the grid shows the filtered list, not the first frame after the key.
        add(`${P}search.keystroke`, r.settled)
      }
      await box.fill('')
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
      }
      if (on('scroll')) {
      const f = await page.evaluate(() => window.__perf.fling())
      add(`${P}scroll.longTask`, f.longest)
      add(`${P}scroll.dropped`, f.droppedPct, '%')
      if (run === 0) notes.push(`${P}fling: ${f.frames} frames over ${Math.round(f.height)} px at ${Math.round(f.step)} px a frame; long tasks from ${f.longTaskApi ? 'the Long Tasks API' : 'frame gaps'}`)
      await page.evaluate(() => { document.querySelector('.main').scrollTop = 0 })
      }

      // The shelf plugin's Watch later chip: a list shelf of 1,000 rows, then a fling down it.
      if (on('shelf')) {
        const loc = page.locator('.toolbar .chip', { hasText: /^Watch later\b/ })
        await loc.waitFor({ timeout: 10000 })
        const r = await measure(page, () => loc.click(), { events: ['click'], marker: { sel: '.toolbar .chip.on', text: 'Watch later' } })
        add(`${P}chip.shelf`, r.painted)
        add(`${P}chip.shelf.settled`, r.settled)
        await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
        const f = await page.evaluate(() => window.__perf.fling())
        add(`${P}scroll.shelf.longTask`, f.longest)
        add(`${P}scroll.shelf.dropped`, f.droppedPct, '%')
        if (run === 0) notes.push(`${P}shelf fling: ${f.frames} frames over ${Math.round(f.height)} px, ${await page.locator('.main .shelf-list > *').count()} rows in the DOM`)
        await page.evaluate(() => { document.querySelector('.main').scrollTop = 0 })
        await page.locator('.toolbar .chip', { hasText: /^All\b/ }).click()
      }

      // A title page from a card on Home, and back.
      await tap(page, 'Home')
      await page.locator(sel.home.sel).first().waitFor()
      let r
      if (on('title')) {
      const card = page.locator('.row-section', { hasText: 'Continue on Perf Films' }).locator('.card').nth(run)
      await card.scrollIntoViewIfNeeded()
      r = await measure(page, () => card.click(), { events: ['click'], marker: { sel: '.main .page.detail h1, .main .page .status' } })
      add(`${P}title.open`, r.painted)
      add(`${P}title.content`, r.settled)
      r = await measure(page, () => page.locator('.page.detail .btn', { hasText: 'Back' }).click(), { events: ['click'], marker: sel.home })
      add(`${P}title.back`, r.painted)
      }

      // Home search: the plugin answers in 50 ms.
      if (on('home')) {
      const hs = page.getByLabel('Search your plugins')
      await hs.fill('the')
      r = await measure(page, () => hs.press('Enter'), { events: ['keydown'], marker: { sel: '.home-search .row-section' } })
      add(`${P}home.search`, r.painted)
      await hs.fill('')
      }
      if (on('settings')) {

      // Settings > Plugins, the Add sheet, and the plugin's page.
      r = await go(page, '/settings/plugins', { sel: '#plugins .hub-row' })
      add(`${P}settings.plugins`, r.painted)
      add(`${P}settings.plugins.settled`, r.settled)
      r = await measure(page, () => page.locator('#plugins .hub-head .btn').click(), { events: ['click'], marker: { sel: '[role=dialog]' } })
      add(`${P}settings.add`, r.painted)
      // The backdrop, not Escape: Escape also goes back a page (src/lib/spatial.ts).
      await page.locator('.sheet-back').click({ position: { x: 4, y: 4 } })
      await page.locator('[role=dialog]').waitFor({ state: 'detached' })
      r = await measure(page, () => page.locator('#plugins .hub-row', { hasText: 'Perf Films' }).click(), { events: ['click'], marker: { sel: '.main .page.manage h1' } })
      add(`${P}settings.plugin-page`, r.painted)
      }
      await page.close()
      process.stdout.write(`${size}: run ${run + 1}/${RUNS} done\n`)
    }

    // Layout shift, in its own runs: measuring it reads layout every frame, which would slow the timings.
    for (let run = 0; on('cls') && run < Math.min(RUNS, 3); run++) {
      const { page } = await open(true)
      const shift = async (key, act, wait = 600) => {
        await page.evaluate(() => window.__perf.clsStart())
        await act()
        await page.evaluate((w) => new Promise((r) => setTimeout(r, w)), wait)
        const c = await page.evaluate(() => window.__perf.clsStop())
        add(`${P}cls.${key}`, c.score, 'score')
        if (c.score >= 0.05 || c.resizes) notes.push(`${P}cls.${key} ${c.score.toFixed(3)}, ${c.resizes} card resizes: ${c.shifts.join('; ')}`)
      }
      await shift('library', () => tap(page, 'Library'), 1200)
      await page.locator('.toolbar .chip', { hasText: /^All\b/ }).click()
      await shift('scroll', async () => {
        for (let s = 0; s < 12; s++) await page.evaluate(() => new Promise((r) => { document.querySelector('.main').scrollBy(0, innerHeight * 0.8); setTimeout(r, 120) }))
      })
      await page.evaluate(() => { document.querySelector('.main').scrollTop = 0 })
      await shift('settings', () => tap(page, 'Settings'), 1200)
      await shift('home', () => tap(page, 'Home'), 1200)
      await shift('title', () => page.locator('.row-section', { hasText: 'Continue on Perf Films' }).locator('.card').first().click(), 1200)
      await page.close()
    }
    await ctx.close()
    ctx = null
  }
} catch (e) {
  // Keep what was measured: the results say which step failed, and the run exits 1.
  failure = e
  notes.push(`the run stopped early: ${e.message.split('\n')[0]}`)
} finally {
  await ctx?.close().catch(() => {})
  server.kill()
}
for (const e of pageErrors) notes.push(`page error: ${e}`)

const metrics = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, { unit: v.unit, ...stats(v.s), samples: v.s.map((x) => Math.round(x * 1000) / 1000) }]))
const meta = { engine, runs: RUNS, throttle: THROTTLE > 1 && ENGINE === 'chromium' ? THROTTLE : 1, viewports: sizes, inject: INJECT || undefined, at: new Date().toISOString(), commit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim() } catch { return '' } })() }
mkdirSync('perf', { recursive: true })
// One metric a line, so a committed baseline diffs by metric.
const lines = Object.entries(metrics).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')
writeFileSync(OUT, `{\n  "meta": ${JSON.stringify(meta)},\n  "notes": ${JSON.stringify([...new Set(notes)], null, 2).replace(/\n/g, '\n  ')},\n  "metrics": {\n${lines}\n  }\n}\n`)
console.log(`\n${meta.engine}, ${RUNS} runs, CPU ${meta.throttle}x, commit ${meta.commit}\n`)
console.log(table(metrics, budgets.budgets))
if (notes.length) console.log(`\nNotes:\n${[...new Set(notes)].map((n) => `- ${n}`).join('\n')}`)
const base = opt('compare')
if (base) console.log(`\nAgainst ${base}:\n\n${compare(JSON.parse(readFileSync(base, 'utf8')).metrics, metrics, budgets.budgets)}`)
// Budgets are for 1280. With --only, or without the 1280 viewport, budgets for what did not run are not misses.
const partial = ONLY.length || !sizes.includes('1280')
const misses = gate(metrics, budgets.budgets).filter((m) => !(partial && m.why === 'not measured'))
const problems = [
  ...misses.map((m) => `${m.metric}: p95 ${m.p95 == null ? m.why : Math.round(m.p95 * 1000) / 1000} > ${m.budget}`),
  // A screen that threw can look fast, so an app error fails the run too.
  ...[...pageErrors].map((e) => `page error: ${e}`),
  ...(failure ? [`the run stopped early: ${failure.message.split('\n')[0]}`] : []),
]
if (problems.length) {
  console.log(`\nFailed:\n${problems.map((p) => `- ${p}`).join('\n')}`)
  if (!flag('no-gate') || failure) process.exit(1)
}
