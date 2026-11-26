// Loads a Flick plugin or theme the way Flick does, with the same validator, and tries it live.
//   npm run plugin:check -- plugins/template/plugin.js
//   npm run plugin:check -- https://gist.githubusercontent.com/.../plugin.js --search dune
//   npm run plugin:check -- theme.json
// Flags: --search <term> (default "the"), --set key=value (a setting, repeatable).
// Prints PASS or FAIL per step and exits non-zero on any FAIL.
// Note: here the plugin runs in Node, not in the browser sandbox, so check only code you trust to run.
import { readFileSync } from 'node:fs'
import * as V from '../src/lib/plugins/validate.ts'

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const target = argv.find((a, i) => !a.startsWith('--') && !['--search', '--set'].includes(argv[i - 1]))
if (!target) {
  console.error('Usage: npm run plugin:check -- <plugin.js | theme.json | https URL> [--search term] [--set key=value]')
  process.exit(2)
}

let fails = 0
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails++ }
const done = () => {
  console.log(fails ? `\n${fails} check(s) failed` : '\nplugin:check: all checks passed')
  process.exit(fails ? 1 : 0)
}

const code = /^https?:\/\//i.test(target) ? await fetch(target).then((r) => { if (!r.ok) throw new Error(`${target} answered ${r.status}`); return r.text() }) : readFileSync(target, 'utf8')

let json
try { json = JSON.parse(code) } catch { /* a plugin, not a theme */ }

if (json !== undefined) {
  try {
    const t = V.validateTheme(json)
    check(true, `theme ${t.name} ${t.version} (${t.id})`)
    for (const mode of ['light', 'dark']) {
      for (const on of ['bg', 'surface']) console.log(`     ${mode}: fg on ${on} ${V.contrast(t[mode].fg, t[mode][on], mode === 'dark').toFixed(2)}:1`)
    }
  } catch (e) {
    check(false, `theme: ${e.message}`)
  }
  done()
}

// ---------- a source plugin ----------
const withTimeout = (p, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${V.CALL_TIMEOUT_MS / 1000} seconds`)), V.CALL_TIMEOUT_MS)),
])
const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)))

let plugin
try {
  plugin = (await withTimeout(import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')), 'loading')).default
} catch (e) {
  check(false, `load: ${e.message}`)
  done()
}
const data = {}, fns = []
for (const [k, v] of Object.entries(plugin ?? {})) (typeof v === 'function' ? fns.push(k) : (data[k] = v))

let m
try {
  m = V.validateManifest(plain(data), fns)
  check(true, `manifest: ${m.name} ${m.version} (${m.id}), ${m.catalogs.length} catalogs, hosts ${m.hosts.join(', ') || 'none'}`)
} catch (e) {
  check(false, `manifest: ${e.message}`)
  done()
}

// The same host rule as the desktop app (src-tauri/src/plugins.rs), so a missing host shows up here.
const isPrivate = (h) => /^(localhost|.*\.localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(h)
const allowed = (url) => {
  const u = new URL(url)
  const h = u.hostname.toLowerCase()
  return m.hosts.some((p) => (p === '*' ? !isPrivate(h) : p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p))
}

const settings = Object.fromEntries(m.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]))
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--set') continue
  const [k, ...v] = (argv[i + 1] ?? '').split('=')
  settings[k] = v.join('=')
}
const store = new Map()
const ctx = {
  platform: m.platforms.includes('web') ? 'web' : m.platforms[0],
  settings: Object.freeze(settings),
  async fetch(url, init = {}) {
    if (!allowed(String(url))) check(false, `ctx.fetch to ${new URL(url).host} is not in hosts; the desktop app would refuse it`)
    const r = await fetch(String(url), { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? undefined })
    const text = await r.text()
    return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: async () => text, json: async () => JSON.parse(text) }
  },
  store: {
    async get(k) { return store.has(k) ? plain(store.get(k)) : null },
    async set(k, v) {
      const next = new Map(store)
      v == null ? next.delete(k) : next.set(k, plain(v))
      if (Buffer.byteLength(JSON.stringify(Object.fromEntries(next))) > V.STORE_LIMIT) throw new Error('saved data would pass 1 MB')
      store.clear(); for (const [a, b] of next) store.set(a, b)
    },
  },
  log: (...a) => console.log('     log:', ...a),
  tools: new Proxy({}, { get: (_, n) => new Proxy({}, { get: (_, op) => async (...a) => stubTool(String(n), String(op), a) }) }),
}

// Desktop tools run in the app, not in Node. This stub keeps the same rules (the manifest must list the
// tool; resolve() plays only https pages on the plugin's hosts) and answers search() with recorded output
// of the real tool (tests/fixtures/ytdlp-search.json, which src-tauri/src/ytdlp.rs checks it still makes).
let stubNoted = false
async function stubTool(name, op, a) {
  if (!m.tools.includes(name)) throw new Error(`the manifest does not list the ${name} tool`)
  if (!stubNoted) { stubNoted = true; console.log(`     note: ${name} is a stub here; the desktop app runs the real tool`) }
  if (op === 'search') {
    if (!String(a[0] ?? '').trim()) throw new Error('search needs a term')
    return JSON.parse(readFileSync(new URL('../tests/fixtures/ytdlp-search.json', import.meta.url), 'utf8')).slice(0, Number(a[1]) || 20)
  }
  if (op === 'resolve') {
    const u = String(a[0] ?? '')
    if (!/^https:\/\//i.test(u) || !allowed(u)) throw new Error(`resolve(${u}): not an https page on this plugin's hosts`)
    return 'flick-tool:ytdlp/stub'
  }
  throw new Error(`the ${name} tool has no ${op}() in this version`)
}

async function call(fn, args, validate, what) {
  try {
    const raw = plain(await withTimeout(Promise.resolve(plugin[fn](ctx, ...args)), `${fn}()`))
    const out = validate(raw)
    const rawItems = fn === 'catalog' ? (Array.isArray(raw) ? raw : raw?.items) : fn === 'streams' || fn === 'library' || fn === 'userCatalogs' ? raw : null
    const kept = fn === 'catalog' ? out.items : out
    if (Array.isArray(rawItems) && rawItems.length > kept.length) {
      check(false, `${what}: Flick dropped ${rawItems.length - kept.length} of ${rawItems.length} entries that do not match the shapes`)
    }
    return out
  } catch (e) {
    check(false, `${what}: ${e.message}`)
    return null
  }
}

let rows = m.catalogs.filter((c) => !c.search)
if (m.has.userCatalogs) {
  const dyn = await call('userCatalogs', [], V.validateCatalogDefs, 'userCatalogs()')
  if (dyn) {
    check(dyn.length > 0, `userCatalogs(): ${dyn.length} rows`)
    rows = [...rows, ...dyn.filter((c) => !c.search)]
  }
}
let sample = null
for (const c of rows) {
  const r = await call('catalog', [{ id: c.id, type: c.type, skip: 0 }], V.validateCatalog, `catalog "${c.name}"`)
  if (!r) continue
  check(r.items.length > 0, `catalog "${c.name}": ${r.items.length} items${r.more ? ', more' : ''}`)
  sample ??= r.items[0]
}
const term = flag('--search') ?? 'the'
for (const c of m.catalogs.filter((c) => c.search)) {
  const r = await call('catalog', [{ id: c.id, type: c.type, search: term, skip: 0 }], V.validateCatalog, `search "${c.name}"`)
  if (!r) continue
  check(r.items.length > 0, `search "${c.name}" for "${term}": ${r.items.length} items`)
  sample ??= r.items[0]
}

if (!sample) {
  check(false, 'no catalog returned an item to open')
  done()
}
const meta = await call('meta', [{ type: sample.type, id: sample.id }], V.validateMeta, `meta ${sample.id}`)
if (meta) {
  check(true, `meta "${meta.name}" (${meta.type})${meta.videos ? `, ${meta.videos.length} videos` : ''}`)
  const vid = meta.videos?.find((v) => (v.season ?? 1) > 0) ?? meta.videos?.[0]
  const args = { type: meta.type, id: meta.id, videoId: vid?.id ?? meta.id }
  const streams = await call('streams', [args], V.validateStreams, `streams for ${args.videoId}`)
  if (streams) check(true, `streams for ${args.videoId}: ${streams.length}${streams[0] ? `, first ${streams[0].url.slice(0, 80)}` : ' (none from this source for this title)'}`)
  if (fns.includes('subtitles')) {
    const subs = await call('subtitles', [args], V.validateSubs, `subtitles for ${args.videoId}`)
    if (subs) check(true, `subtitles for ${args.videoId}: ${subs.length}`)
  }
}
if (m.has.library) {
  const lib = await call('library', [], V.validateLibrary, 'library')
  if (lib) check(true, `library: ${lib.length} items`)
}
done()
