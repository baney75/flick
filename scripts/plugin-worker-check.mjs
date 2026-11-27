// Checks that plugin code runs in a Worker inside the sandboxed plugin frame (public/plugin-host.js),
// in a real browser: the Worker starts in the opaque-origin frame, the app page's CSP still refuses the
// Worker's own fetch, XHR and WebSocket, a page that refuses the Worker answers with an error, a 6 s busy loop in catalog() leaves the parent's 250 ms timer on
// time, and removing the frame (what Flick does when a call passes its time limit) ends a loop that never stops.
//   node scripts/plugin-worker-check.mjs                   Chromium (SMOKE_CHANNEL, default chrome)
//   node scripts/plugin-worker-check.mjs --engine webkit   Playwright's WebKit
// It plays no media; Chromium still launches with --mute-audio.
import http from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const engine = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : 'chromium'
const pub = new URL('../public/', import.meta.url).pathname
let hits = 0
const harness = '<!doctype html><meta charset="utf-8"><title>harness</title><body></body>'
const server = http.createServer((q, r) => {
  if (q.url === '/ping') { hits++; r.setHeader('access-control-allow-origin', '*'); r.end('pong'); return }
  if (q.url === '/') { r.setHeader('content-type', 'text/html'); r.end(harness); return }
  // The app page with Workers refused: stands for a web view whose CSP or engine won't start the Worker.
  if (q.url === '/plugin-host-noworker.html') {
    r.setHeader('content-type', 'text/html')
    r.end(readFileSync(pub + 'plugin-host-app.html', 'utf8').replace('worker-src blob:', "worker-src 'none'"))
    return
  }
  if (!/^\/plugin-host(-app)?\.(html|js)$/.test(q.url)) { r.statusCode = 404; r.end(); return }
  r.setHeader('content-type', q.url.endsWith('.js') ? 'text/javascript' : 'text/html')
  r.end(readFileSync(pub + q.url.slice(1)))
})
server.on('upgrade', (_q, s) => { hits++; s.destroy() })
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const BASE = `http://127.0.0.1:${server.address().port}`

const fails = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails.push(what) }

const browser = engine === 'webkit'
  ? await webkit.launch()
  : await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'chrome', args: ['--mute-audio'] })
const page = await browser.newPage()
await page.goto(`${BASE}/`)
console.log(`${engine} ${browser.version()}`)

// The parent side of the port protocol (src/lib/plugins/rpc.ts), in the page: open a frame, load code.
await page.evaluate(() => {
  window.openPlugin = async (host, code, platform, limit = 10000) => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.hidden = true
    f.src = host
    await new Promise((r) => { f.onload = r; document.body.appendChild(f) })
    const ch = new MessageChannel()
    f.contentWindow.postMessage({ flick: 'port' }, '*', [ch.port2])
    let seq = 0
    const waiting = new Map()
    const asks = []
    ch.port1.onmessage = (e) => {
      const d = e.data
      if (typeof d.re === 'number') { waiting.get(d.re)?.(d); waiting.delete(d.re); return }
      if (typeof d.id === 'number') { asks.push({ m: d.m, at: performance.now() }); ch.port1.postMessage({ re: d.id, ok: true, v: null }) }
    }
    const call = (m, a, ms = 10000) => new Promise((resolve) => {
      const id = ++seq
      waiting.set(id, resolve)
      ch.port1.postMessage({ id, m, a })
      setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, e: 'time limit' }) }, ms)
    })
    const loaded = await call('load', [code, platform, {}], limit)
    return { frame: f, call, asks, loaded }
  }
})

const plugin = (catalog) => `export default { api: 1, id: 'org.check.worker', name: 'Worker check', version: '1', catalogs: [], meta() {}, streams() {}, catalog: ${catalog} }`

// 1. The plugin runs in a Worker in the opaque-origin frame, and on the app page it has no network.
const probeTop = `
const probe = { document: typeof document, window: typeof window, worker: typeof WorkerGlobalScope, origin: String(self.origin) }
const t = (p) => p.then(() => 'reached', () => 'blocked')
probe.fetch = await t(fetch(${JSON.stringify(`${BASE}/ping`)}))
probe.xhr = await t(new Promise((ok, no) => { try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(`${BASE}/ping`)}); x.onload = ok; x.onerror = no; x.send() } catch (e) { no(e) } }))
probe.ws = await t(new Promise((ok, no) => { try { const w = new WebSocket(${JSON.stringify(`${BASE.replace('http', 'ws')}/ws`)}); w.onopen = ok; w.onerror = no } catch (e) { no(e) } }))`
const probeCode = `${probeTop}
export default { api: 1, id: 'org.check.probe', name: 'Probe', version: '1', probe, catalogs: [], catalog() {}, meta() {}, streams() {} }`
for (const [host, platform] of [['/plugin-host-app.html', 'desktop'], ['/plugin-host.html', 'web']]) {
  hits = 0
  const r = await page.evaluate(async ([h, c, p]) => (await window.openPlugin(h, c, p)).loaded, [host, probeCode, platform])
  const p = r.ok ? r.v.manifest.probe : {}
  check(r.ok && p.document === 'undefined' && p.window === 'undefined' && p.worker !== 'undefined' && p.origin === 'null',
    `${host}: plugin code runs in a Worker in the opaque-origin frame (${JSON.stringify(r.ok ? { document: p.document, window: p.window, worker: p.worker, origin: p.origin } : r.e)})`)
  if (host === '/plugin-host-app.html') {
    check(p.fetch === 'blocked' && p.xhr === 'blocked' && p.ws === 'blocked' && hits === 0,
      `${host}: the Worker's own fetch, XHR and WebSocket are refused (fetch ${p.fetch}, xhr ${p.xhr}, ws ${p.ws}, server hits ${hits})`)
  } else {
    // The control: the website page allows the plugin's own fetch, so the same probe reaches the server.
    check(p.fetch === 'reached' && hits > 0, `${host}: the control, the website page's Worker reaches the server (fetch ${p.fetch}, server hits ${hits})`)
  }
}

// A page that refuses the Worker answers Flick's asks with an error at once, instead of a dead port.
const refused = await page.evaluate(async (c) => {
  const t0 = performance.now()
  const pl = await window.openPlugin('/plugin-host-noworker.html', c, 'desktop', 20000)
  pl.frame.remove()
  return { ok: pl.loaded.ok, e: pl.loaded.e, took: Math.round(performance.now() - t0) }
}, probeCode)
check(!refused.ok && /could not start a worker/.test(refused.e) && refused.took < 6000,
  `a page that refuses the Worker answers load with an error after ${refused.took} ms (${refused.e})`)

// Every plugin Flick ships loads in the Worker: its top-level code runs there, with no DOM.
for (const name of readdirSync(new URL('../plugins/', import.meta.url)).filter((n) => !n.includes('.'))) {
  const code = readFileSync(new URL(`../plugins/${name}/plugin.js`, import.meta.url), 'utf8')
  const r = await page.evaluate(async (c) => { const pl = await window.openPlugin('/plugin-host-app.html', c, 'desktop'); pl.frame.remove(); return pl.loaded }, code)
  check(r.ok && r.v.manifest.id && r.v.fns.length > 0, `plugins/${name} loads in the Worker${r.ok ? ` (${r.v.manifest.id}, ${r.v.fns.length} functions)` : `: ${r.e}`}`)
}

// 2. A 6 s busy loop in catalog() leaves the parent's 250 ms timer on time, and catalog() still answers.
const busy = await page.evaluate(async (code) => {
  const pl = await window.openPlugin('/plugin-host-app.html', code, 'desktop')
  let last = performance.now(), worst = 0
  const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t }, 250)
  const t0 = performance.now()
  const r = await pl.call('call', ['catalog', [{ id: 'x' }]], 15000)
  const took = performance.now() - t0
  clearInterval(tick)
  pl.frame.remove()
  return { ok: r.ok, worst: Math.round(worst), took: Math.round(took) }
}, plugin('function () { const end = Date.now() + 6000; while (Date.now() < end) {} return { items: [], more: false } }'))
check(busy.ok && busy.took >= 5900 && busy.worst < 450, `a 6 s loop in catalog() leaves the parent's 250 ms timer on time (worst gap ${busy.worst} ms, catalog answered after ${busy.took} ms)`)

// 3. A loop that never ends: past the time limit the parent removes the frame, and the Worker stops.
const stuck = await page.evaluate(async (code) => {
  const pl = await window.openPlugin('/plugin-host-app.html', code, 'desktop')
  const r = await pl.call('call', ['catalog', [{ id: 'x' }]], 1500)
  const before = pl.asks.filter((a) => a.m === 'log').length
  // What Flick does past the time limit (openFrame in src/lib/plugins/runtime.ts).
  pl.frame.remove()
  const gone = performance.now()
  await new Promise((ok) => setTimeout(ok, 3500))
  const lines = pl.asks.filter((a) => a.m === 'log' && a.at > gone)
  return { limit: r.e, before, after: lines.length, lastMs: Math.round((lines.at(-1)?.at ?? gone) - gone) }
}, plugin('function (ctx) { let last = 0; for (;;) { if (Date.now() - last > 100) { ctx.log("alive"); last = Date.now() } } }'))
// WebKit ends the Worker at once; Chromium forces it to stop about 2 s after its frame is gone.
check(stuck.limit === 'time limit' && stuck.before >= 5 && stuck.lastMs < 2500,
  `a loop that never ends hits the time limit, and removing the frame stops its Worker (${stuck.before} log lines before, ${stuck.after} after, the last ${stuck.lastMs} ms after)`)

await browser.close()
server.close()
console.log(fails.length ? `\n${fails.length} check(s) failed` : `\nplugin-worker-check (${engine}): all checks passed`)
process.exit(fails.length ? 1 : 0)
