// Installs every plugin in plugins/index.json inside the real desktop app and times each step.
// Builds "Flick Self-test" with this worktree's own identifier (dev.flick.selftest.<8 hex of the path>, so
// its data is separate from the user's Flick and from other worktrees) and no visible window, starts it
// hidden with `open -g -j -n`, waits up to 30 s for its report, stops the copy it started, prints a table
// and removes that identifier's profile folders. Perf and youtube runs take yt-dlp from a read-only cache. Fails when any plugin errors or takes over 2 s. macOS only.
//
//   node scripts/desktop-selftest.mjs            build, then run
//   node scripts/desktop-selftest.mjs --no-build run the last self-test build
//   node scripts/desktop-selftest.mjs --json     also print the raw report
//   node scripts/desktop-selftest.mjs --mode perf [--runs 5] [--out file.json] [--no-browser]
//       seed a library (first launch), then time a cold start, the bar taps and a Library chip in the
//       real app (each later launch) and the same steps in Playwright WebKit over http; prints medians
//   node scripts/desktop-selftest.mjs --mode youtube (or --youtube)  YouTube end to end: install, search, resolve, open
//   node scripts/desktop-selftest.mjs --mode playback  SPEC-playback case 13: fixture MKV, HEVC+DTS and MP4 made
//       with ffmpeg and served on 127.0.0.1, played through the real player, with probe, first segment,
//       ready and seek times

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PREFIX = 'dev.flick.selftest.'
const ID_RE = /^dev\.flick\.selftest\.[0-9a-f]{8}$/

/** This worktree's self-test identifier: the prefix and 8 hex of its real path's SHA-256. */
export function identifierFor(root) {
  return PREFIX + createHash('sha256').update(root).digest('hex').slice(0, 8)
}

/** The folders macOS and WebKit make for an app identifier, under ~/Library. */
export function profileDirs(id, home = homedir()) {
  if (!ID_RE.test(id)) throw new Error(`${id} is not a self-test identifier.`)
  const lib = join(home, 'Library')
  return [
    ...['Application Support', 'Caches', 'WebKit', 'HTTPStorages'].map((d) => join(lib, d, id)),
    join(lib, 'Saved Application State', `${id}.savedState`),
  ]
}

/** Removes these folders, after looking: every name must start with the self-test prefix (none is
 *  removed otherwise), and a link or a file is left alone. Returns what it removed. */
export function removeDirs(paths, fs = { lstatSync, rmSync }) {
  const bad = paths.filter((p) => !basename(p).startsWith(PREFIX))
  if (bad.length) throw new Error(`Refusing to remove ${bad.join(', ')}: not a ${PREFIX}* folder.`)
  const removed = []
  for (const p of paths) {
    let st
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    fs.rmSync(p, { recursive: true, force: true })
    removed.push(p)
  }
  return removed
}

/** yt-dlp for perf and youtube runs, shared read-only: fetched once (again after 7 days), checked against the
 *  release's SHA2-256SUMS, unpacked like the app does and run once so macOS scans it now, not during a
 *  measured run. A lock beside the folder keeps two worktrees from filling it at once. */
export const TOOLS = join(homedir(), 'Library/Caches/flick-selftest-tools')
/** The app's own layout for the unpacked build (MAC_DIR and SUM_FILE in src-tauri/src/ytdlp.rs). */
export const TOOLS_LAYOUT = { dir: 'yt-dlp_macos', bin: 'yt-dlp_macos', sum: 'release.sha256' }
const TOOLS_DAYS = 7
export async function ensureTools(dir = TOOLS) {
  const live = join(dir, TOOLS_LAYOUT.dir)
  const bin = join(live, TOOLS_LAYOUT.bin)
  const fresh = () => existsSync(bin) && Date.now() - statSync(join(live, TOOLS_LAYOUT.sum)).mtimeMs < TOOLS_DAYS * 86_400_000
  if (fresh()) return dir
  const lock = `${dir}.lock`
  for (;;) {
    try { mkdirSync(lock); break } catch {
      // A lock older than 10 minutes was left by a run that stopped.
      try { if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true }) } catch { /* gone already */ }
      await sleep(500)
    }
  }
  const writable = (p) => { if (existsSync(p)) execFileSync('chmod', ['-R', 'u+w', p]) }
  try {
    if (fresh()) return dir
    const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
    console.log(`Fetching yt-dlp into ${dir}.`)
    const sums = await (await fetch(`${base}/SHA2-256SUMS`)).text()
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === 'yt-dlp_macos.zip')?.[0]
    if (!want) throw new Error('The yt-dlp release lists no yt-dlp_macos.zip.')
    const zip = Buffer.from(await (await fetch(`${base}/yt-dlp_macos.zip`)).arrayBuffer())
    if (createHash('sha256').update(zip).digest('hex') !== want) throw new Error('yt-dlp_macos.zip does not match its release checksum.')
    mkdirSync(dir, { recursive: true })
    writable(dir)
    const tmp = mkdtempSync(join(dir, 'new-'))
    const zp = join(tmp, 'build.zip')
    const out = join(tmp, TOOLS_LAYOUT.dir)
    writeFileSync(zp, zip)
    execFileSync('/usr/bin/ditto', ['-x', '-k', zp, out])
    writeFileSync(join(out, TOOLS_LAYOUT.sum), want)
    if (existsSync(live)) renameSync(live, join(tmp, 'old'))
    renameSync(out, live)
    rmSync(tmp, { recursive: true, force: true })
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
  } finally {
    if (existsSync(dir)) {
      writable(dir)
      for (const n of readdirSync(dir)) if (n.startsWith('new-')) rmSync(join(dir, n), { recursive: true, force: true })
      execFileSync('chmod', ['-R', 'a-w', dir])
    }
    rmSync(lock, { recursive: true, force: true })
  }
  return dir
}
export const LIMIT_MS = 2000
const WAIT_MS = 30_000

/** The lines that make the run fail: an error, a slow plugin, or no plugins at all. */
export function failures(report) {
  if (!report || report.error) return [`the self-test itself failed: ${report?.error ?? 'no report'}`]
  if (!Array.isArray(report.plugins) || !report.plugins.length) return ['the report lists no plugins']
  const out = []
  for (const p of report.plugins) {
    if (p.error) out.push(`${p.name}: ${p.error} (after ${p.failedAfter})`)
    else if (p.totalMs > LIMIT_MS) out.push(`${p.name}: ${p.totalMs} ms, over ${LIMIT_MS} ms`)
  }
  return out
}

/** The YouTube run's failures: an error at a step, or a step that gave nothing. */
export function youtubeFailures(report) {
  if (!report || !Array.isArray(report.steps)) return [`the self-test itself failed: ${report?.error ?? 'no report'}`]
  if (report.error) return [`YouTube: ${report.error} (at ${report.failedAfter})`]
  const out = []
  if (!(report.rows > 0)) out.push(`YouTube: search "${report.query}" returned no rows`)
  // SPEC-youtube-play case 11: YouTube's own master, played past 15 s with no stall, and a seek to 2:00:00 within 3 s.
  if (report.host !== 'https://manifest.googlevideo.com') out.push(`YouTube: the stream opened to ${report.host}, not YouTube's HLS master`)
  const w = report.watch
  if (!w) out.push('YouTube: the master was never played')
  else {
    if (!(w.reached >= 15)) out.push(`YouTube: played to ${w.reached} s, not past 15 s`)
    if (w.stalls) out.push(`YouTube: ${w.stalls} stalls after the first frame`)
    if (w.seekMs == null || w.seekMs > 3000) out.push(`YouTube: the seek to 2:00:00 played after ${w.seekMs ?? 'never'} ms, over 3000 ms`)
  }
  return out
}

export function youtubeTable(report) {
  const rows = report.steps.map((s) => `| ${s.step.padEnd(7)} | ${String(s.ms).padStart(6)} | ${s.detail ?? ''}`)
  return ['| Step    |     ms | Detail', '| ------- | ------ | ------', ...rows, '', `Search "${report.query}": ${report.rows ?? 0} rows. Plays from ${report.host ?? 'nothing'}.`,
    ...(report.watch ? [`Played to ${report.watch.reached} s: first frame ${report.watch.firstFrameMs} ms, ${report.watch.stalls} stalls, seek to 2:00:00 in ${report.watch.seekMs ?? 'never'} ms.`] : [])].join('\n')
}

export function table(report) {
  const rows = report.plugins.map((p) => [p.name, String(p.totalMs), p.steps.map((s) => `${s.step} ${s.ms}`).join(', '), p.error ? `${p.error} (after ${p.failedAfter})` : 'ok'])
  const head = ['Plugin', 'Total ms', 'Steps (ms each)', 'Result']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r) => `| ${r.map((c, i) => c.padEnd(w[i])).join(' | ')} |`
  return [line(head), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...rows.map(line)].join('\n')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export const PRODUCT = 'Flick Self-test'
/** The build override: its own identifier and name, and no window ever shown. WebKit suspends a hidden
 *  window's page after a few seconds, which stopped every answer that took longer, so throttling is off. */
export function override(conf, identifier) {
  return { identifier, productName: PRODUCT, app: { windows: conf.app.windows.map((w) => ({ ...w, visible: false, focus: false, backgroundThrottling: 'disabled' })) } }
}

/** PIDs of processes running from this bundle only. */
function appPids(app) {
  const r = spawnSync('pgrep', ['-f', `${app}/Contents/MacOS/`], { encoding: 'utf8' })
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** Every process under these, children first: yt-dlp and ffmpeg run in their own process groups. */
function descendants(pids) {
  const out = []
  for (const p of pids) {
    const kids = spawnSync('pgrep', ['-P', p], { encoding: 'utf8' }).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    out.push(...descendants(kids), ...kids)
  }
  return out
}

/** Stop the app and whatever it started (`kids`, gathered while it ran), so a stream or search never
 *  outlives the run, even when the app exits by itself and its children are left to launchd. */
function stop(app, kids) {
  for (const p of descendants(appPids(app))) kids.add(p)
  for (let i = 0; i < 3; i++) {
    const pids = appPids(app)
    if (!pids.length) break
    spawnSync('kill', [i < 2 ? '-TERM' : '-KILL', ...pids])
    spawnSync('sleep', ['1'])
  }
  const left = [...kids].filter((p) => spawnSync('kill', ['-0', p]).status === 0)
  if (left.length) spawnSync('kill', ['-KILL', ...left])
}

/** Startup invokes (those starting before Home was interactive): per command, and how many ran one after another. */
export function invokeSummary(invokes, untilMs) {
  const rows = invokes.filter((r) => r.start <= untilMs).sort((a, b) => a.start - b.start)
  const by = {}
  for (const r of rows) {
    const d = r.end - r.start
    const b = (by[r.cmd] ??= { count: 0, totalMs: 0, maxMs: 0, failed: 0 })
    b.count++; b.totalMs += d; b.maxMs = Math.max(b.maxMs, d); if (!r.ok) b.failed++
  }
  let maxConcurrent = 0
  let serial = 0
  for (const r of rows) {
    maxConcurrent = Math.max(maxConcurrent, rows.filter((o) => o.start <= r.start && o.end > r.start).length)
    // Started within 2 ms of another one ending, with nothing else running: it waited for that one.
    if (rows.some((o) => o !== r && o.end <= r.start && r.start - o.end <= 2) && !rows.some((o) => o !== r && o.start < r.start && o.end > r.start)) serial++
  }
  const sumMs = rows.reduce((n, r) => n + r.end - r.start, 0)
  const span = rows.length ? Math.max(...rows.map((r) => r.end)) - rows[0].start : 0
  return { count: rows.length, sumMs: Math.round(sumMs), spanMs: Math.round(span), maxConcurrent, serial, by }
}

export function perfMarkdown(app, browser) {
  const cell = (r, f) => (r?.phase === 'measured' ? f(r) : 'n/a')
  const tapMs = (r, label) => {
    const t = r.taps.find((x) => x.label === label)
    if (!t) return 'n/a'
    const inv = t.invokes ? ` (${t.invokes} invokes, slowest ${t.slowestInvokeMs ?? 'over 15000'})` : ''
    return `${t.settledMs}${t.capped ? ' (capped)' : ''}${inv}`
  }
  const rows = [
    ['Launch to window and webview built', cell(app, (r) => r.start.launchToSetupMs ?? 'n/a'), 'n/a'],
    ['Webview built to page start', cell(app, (r) => r.start.setupToPageMs ?? 'n/a'), 'n/a'],
    ['Launch to page start', cell(app, (r) => r.start.launchToPageMs ?? 'n/a'), 'n/a'],
    ['index.html received', cell(app, (r) => r.start.responseEndMs), cell(browser, (r) => r.start.responseEndMs)],
    ['DOM interactive', cell(app, (r) => r.start.domInteractiveMs), cell(browser, (r) => r.start.domInteractiveMs)],
    ['DOMContentLoaded', cell(app, (r) => r.start.domContentLoadedMs), cell(browser, (r) => r.start.domContentLoadedMs)],
    ['Home settled (from page start)', cell(app, (r) => r.start.homeSettledMs), cell(browser, (r) => r.start.homeSettledMs)],
    ['Home interactive (from page start)', cell(app, (r) => r.start.homeInteractiveMs), cell(browser, (r) => r.start.homeInteractiveMs)],
    ['Launch to Home interactive', cell(app, (r) => r.start.launchToHomeInteractiveMs ?? 'n/a'), 'n/a'],
    ["Home's start-up invokes all answered (plugin rows)", cell(app, (r) => r.start.homeRowsMs ?? 'over 15000'), cell(browser, (r) => r.start.homeRowsMs ?? 'over 15000')],
    ['Main script fetched again', cell(app, (r) => (r.scriptFetch ? `${r.scriptFetch.ms} (${r.scriptFetch.kb} KB)` : 'n/a')), cell(browser, (r) => (r.scriptFetch ? `${r.scriptFetch.ms} (${r.scriptFetch.kb} KB)` : 'n/a'))],
    ...(app?.taps ?? browser?.taps ?? []).map((t) => [t.label, cell(app, (r) => tapMs(r, t.label)), cell(browser, (r) => tapMs(r, t.label))]),
  ]
  return ['| Step (ms) | Real app (tauri://) | Browser (WebKit, http) |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, `src-tauri/target/release/bundle/macos/${PRODUCT}.app`)

/** One hidden run of the self-test app in `mode`. Stops the copy by PID when done, on an error, or at 30 s. */
let toolsDir = null
async function launch(mode, env = {}) {
  if (appPids(APP).length) throw new Error('A self-test app is already running.')
  const dir = mkdtempSync(join(tmpdir(), 'flick-selftest-'))
  const out = join(dir, 'report.json')
  const log = join(dir, 'report.log')
  // -g: not brought forward, -j: launched hidden, -n: a new copy.
  const tools = toolsDir ? ['--env', `FLICK_SELFTEST_TOOLS=${toolsDir}`] : []
  const extra = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])
  execFileSync('open', ['-g', '-j', '-n', '--env', `FLICK_SELFTEST=${mode}`, '--env', `FLICK_SELFTEST_OUT=${out}`, ...tools, ...extra, APP])
  const t0 = Date.now()
  let why = ''
  const kids = new Set()
  const look = () => { for (const p of descendants(appPids(APP))) kids.add(p) }
  while (!existsSync(out)) {
    look()
    if (Date.now() - t0 > WAIT_MS) { why = `No report after ${WAIT_MS / 1000} s.`; break }
    if (existsSync(log) && /\bERROR\b/.test(readFileSync(log, 'utf8'))) { why = 'A step failed.'; break }
    await sleep(200)
  }
  for (let i = 0; i < 10 && appPids(APP).length; i++) { look(); await sleep(200) }
  stop(APP, kids)
  const left = appPids(APP).join(' ')
  const progress = existsSync(log) ? readFileSync(log, 'utf8') : ''
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  rmSync(dir, { recursive: true, force: true })
  if (left) throw new Error(`a self-test copy is still running: ${left}`)
  return { report, progress, why }
}

/** Playwright's own WebKit, or the newest one already in its cache (this script installs nothing). */
export function webkitPath(webkit, cache = join(homedir(), 'Library/Caches/ms-playwright'), fs = { existsSync, readdirSync }) {
  if (fs.existsSync(webkit.executablePath())) return undefined
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^webkit-\d+$/.test(d) && fs.existsSync(join(cache, d, 'pw_run.sh'))) : []
  const pick = dirs.sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))[0]
  if (!pick) throw new Error('No Playwright WebKit in the cache. Run with --no-browser.')
  return join(cache, pick, 'pw_run.sh')
}

/** The same perf run in Playwright WebKit against the build the app was made from. */
async function browserPerf(runs) {
  const { webkit } = await import('playwright')
  const { freePort } = await import('./free-port.mjs')
  const { spawn } = await import('node:child_process')
  const port = await freePort()
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  const base = `http://localhost:${port}/`
  let profile = ''
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base); break } catch { await sleep(250) } }
    // A persistent profile, like the app's: WebKit's default (private) context will not keep Blobs in IndexedDB.
    profile = mkdtempSync(join(tmpdir(), 'flick-perf-webkit-'))
    // Each run starts the browser again, so its WebKit process is cold like the app's on every launch.
    const run = async () => {
      const ctx = await webkit.launchPersistentContext(profile, { executablePath: webkitPath(webkit), viewport: { width: 1280, height: 800 } })
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage())
        const launchedAt = Date.now()
        await page.addInitScript(({ at }) => {
          window.__FLICK_SELFTEST__ = { mode: 'perf', launchedAt: at, lastMutation: 0, browser: true }
          new MutationObserver(() => { window.__FLICK_SELFTEST__.lastMutation = performance.now() }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
        }, { at: launchedAt })
        await page.goto(base)
        await page.waitForFunction(() => window.__FLICK_SELFTEST__.report, null, { timeout: WAIT_MS })
        const r = await page.evaluate(() => window.__FLICK_SELFTEST__.report)
        if (r.error) throw new Error(`browser run: ${r.error}`)
        return r
      } finally { await ctx.close() }
    }
    const out = []
    for (let i = 0; out.length < runs && i < runs + 1; i++) { const r = await run(); if (r.phase === 'measured') out.push(r) }
    return out
  } finally {
    server.kill()
    if (profile) rmSync(profile, { recursive: true, force: true })
  }
}

const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
/** The median where null means "never answered": it counts as the slowest, and a median that is one is null. */
const medSlow = (xs) => { const m = med(xs.map((x) => (typeof x === 'number' ? x : Infinity))); return m === Infinity ? null : m }

/** One report whose numbers are the median of the measured runs (lower median for an even count). */
export function medianReport(reports) {
  const ok = reports.filter((r) => r?.phase === 'measured')
  if (!ok.length) return null
  const start = {}
  for (const k of Object.keys(ok[0].start)) start[k] = k === 'capped' ? ok.some((r) => r.start.capped) : k === 'homeRowsMs' ? medSlow(ok.map((r) => r.start[k])) : med(ok.map((r) => r.start[k]))
  const taps = ok[0].taps.map((t, i) => ({
    label: t.label,
    settledMs: med(ok.map((r) => r.taps[i]?.settledMs)),
    capped: ok.some((r) => r.taps[i]?.capped),
    invokes: med(ok.map((r) => r.taps[i]?.invokes)),
    // A tap with no invokes waited on nothing (0); a missing tap never answered, so it counts as slowest.
    slowestInvokeMs: medSlow(ok.map((r) => (!r.taps[i] ? null : r.taps[i].invokes ? r.taps[i].slowestInvokeMs : 0))),
  }))
  const fetched = ok.map((r) => r.scriptFetch).filter(Boolean)
  const scriptFetch = fetched.length ? { kb: fetched[0].kb, ms: med(fetched.map((f) => f.ms)) } : null
  return { phase: 'measured', runs: ok.length, start, scriptFetch, taps }
}

async function main() {
  if (process.platform !== 'darwin') { console.error('The desktop self-test runs on macOS.'); process.exit(2) }
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const mode = arg('--mode') ?? (process.argv.includes('--youtube') ? 'youtube' : 'plugins')
  if (!['plugins', 'perf', 'youtube', 'playback'].includes(mode)) { console.error('--mode is plugins, perf, youtube or playback.'); process.exit(2) }
  const id = identifierFor(realpathSync(ROOT))
  if (!process.argv.includes('--no-build')) {
    const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'))
    const r = spawnSync('npx', ['tauri', 'build', '--bundles', 'app', '--config', JSON.stringify(override(conf, id))], { cwd: ROOT, stdio: 'inherit' })
    if (r.status !== 0) { console.error('The self-test build failed.'); process.exit(1) }
  }
  if (!existsSync(APP)) { console.error(`No app at ${APP}. Run without --no-build.`); process.exit(1) }
  // Never start a build that would open the user's own Flick data or show a window.
  const built = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  if (built !== id) { console.error(`${APP} is ${built}, not this worktree's ${id}. Build it with this script.`); process.exit(1) }
  // Each run starts from an empty profile (one a stopped run left is cleared first) and leaves none
  // behind, never while a copy still runs.
  const clear = () => {
    if (appPids(APP).length) { console.error(`Kept ${id}'s profile: a self-test copy is still running.`); return }
    for (const p of removeDirs(profileDirs(id))) console.log(`Removed ${p}`)
  }
  clear()
  process.on('exit', clear)
  // Perf and youtube (not plugins or playback) run yt-dlp inside a deadline a 54 MB first download would miss, so they share one
  // warmed copy; ytdlp.rs's own tests and `cargo test ytdlp_live` cover the app's install.
  if (mode === 'perf' || mode === 'youtube') toolsDir = await ensureTools().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1) })

  if (mode === 'perf') return perfMain(arg('--out'))
  if (mode === 'playback') return playbackMain(process.argv.includes('--json'))
  const { report, progress, why } = await launch(mode).catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1) })
  if (progress) console.log(`Progress:\n${progress}`)
  if (!report) { console.error(`FAIL: ${why} The app was stopped.`); process.exit(1) }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  if (mode === 'youtube') {
    console.log(youtubeTable(report))
    const bad = youtubeFailures(report)
    if (bad.length) { console.error(`\nFAIL\n${bad.join('\n')}`); process.exit(1) }
    console.log('\nPASS: YouTube installed, searched, and played its HLS master with no stall and a quick seek.')
    return
  }
  if (report.plugins) console.log(table(report))
  if (report.userAgent) console.log(`\n${report.origin} ${report.userAgent}`)
  const bad = failures(report)
  if (bad.length) { console.error(`\nFAIL\n${bad.join('\n')}`); process.exit(1) }
  console.log(`\nPASS: every plugin installed and answered in under ${LIMIT_MS} ms.`)
}

async function perfMain(outPath) {
  const runs = Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1]) || 5)
  const apps = []
  // The first launch in a fresh profile seeds the library; every later one is a measured cold start.
  for (let i = 0; apps.length < runs && i < runs + 1; i++) {
    const r = await launch('perf').catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1) })
    if (r.progress) console.log(r.progress.trim())
    if (!r.report) { console.error(`FAIL: ${r.why} The app was stopped.`); process.exit(1) }
    if (r.report.error) { console.error(`FAIL: ${r.report.error}`); process.exit(1) }
    if (r.report.phase === 'measured') apps.push(r.report)
  }
  if (!apps.length) { console.error('FAIL: the app never reached a measured run.'); process.exit(1) }
  // A browser failure keeps the app numbers: the browser column then reads n/a.
  const browsers = process.argv.includes('--no-browser') ? [] : await browserPerf(runs).catch((e) => { console.error(`browser: ${e.message}`); return [] })
  const app = medianReport(apps)
  const browser = medianReport(browsers)
  const startupInvokes = apps.map((r) => invokeSummary(r.invokes, r.start.homeInteractiveMs))
  const result = { at: new Date().toISOString(), runs, median: { app, browser }, startupInvokes, app: apps, browser: browsers }
  console.log(`\nMedian of ${apps.length} app and ${browsers.length} browser runs:\n${perfMarkdown(app, browser)}`)
  console.log(`\nStartup invokes, first run: ${JSON.stringify(startupInvokes[0])}`)
  if (outPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(`\nWrote ${outPath}`)
  }
}


/** The case 13 media, made here with ffmpeg (never downloaded): testsrc picture and a sine tone. */
export const FIXTURES = {
  'a.mkv': [60, 24, ['-c:v', 'libx264', '-g', '48', '-c:a', 'ac3', '-ac', '6']],
  'b.mp4': [20, 24, ['-c:v', 'libx265', '-tag:v', 'hev1', '-x265-params', 'log-level=error', '-c:a', 'dca', '-strict', '-2', '-ac', '2']],
  'c.mp4': [10, 24, ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart']],
  // 1 h 35 m at one frame a second with a keyframe every 4: sparse, so it is quick to make.
  'long.mkv': [5700, 1, ['-c:v', 'libx264', '-g', '4', '-preset', 'ultrafast', '-c:a', 'ac3', '-b:a', '64k']],
}

function makeFixtures(dir) {
  for (const [name, [secs, fps, codecs]] of Object.entries(FIXTURES)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=${fps}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(secs), '-pix_fmt', 'yuv420p', ...codecs, join(dir, name)])
  }
}

/** Serves `dir` on 127.0.0.1 with byte ranges, as a stream host would. */
function serveDir(dir) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
    const file = join(dir, name)
    if (!name || name.includes('/') || !existsSync(file)) { res.writeHead(404).end(); return }
    const size = statSync(file).size
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    const type = name.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4'
    if (!m) {
      res.writeHead(200, { 'content-length': size, 'content-type': type, 'accept-ranges': 'bytes' })
      return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res)
    }
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'content-type': type, 'accept-ranges': 'bytes' })
    return req.method === 'HEAD' ? res.end() : createReadStream(file, { start, end }).pipe(res)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

/** Case 13's rule: no case fails, cases 1 and 4 are ready and seek within 3 s, case 3 plays with no ffmpeg. */
export function playbackFailures(report) {
  if (!report || !Array.isArray(report.cases)) return [`the self-test itself failed: ${report?.error ?? 'no report'}`]
  const out = []
  for (const c of report.cases) {
    if (c.error) { out.push(`${c.name}: ${c.error}`); continue }
    const n = c.name[0]
    if (n === '3' && c.remuxRuns) out.push(`${c.name}: started ffmpeg for a stream that plays directly`)
    if (n !== '3' && !c.remuxRuns) out.push(`${c.name}: played without a remux run`)
    if ((n === '1' || n === '4') && c.readyMs > 3000) out.push(`${c.name}: ready in ${c.readyMs} ms, over 3000`)
    if (n === '4' && !(c.seekMs <= 3000)) out.push(`${c.name}: seek ready in ${c.seekMs} ms, over 3000`)
    if (n === '4' && !/^1:30:0\d/.test(c.shown ?? '')) out.push(`${c.name}: the player shows ${c.shown} after the seek`)
    // Case 13: no stall once the first frame plays (the opening wait and seek waits are not stalls).
    if (/^Stalls: [1-9]/.test(c.stalls ?? '')) out.push(`${c.name}: ${c.stalls} after the first frame`)
  }
  return out
}

export function playbackTable(report) {
  const head = ['Case', 'Probe ms', 'First segment ms', 'Ready ms', 'Seek ms', 'Runs', 'Plays from', 'Shown', 'Stalls']
  const rows = report.cases.map((c) => [c.name, c.probeMs, c.firstSegmentMs, c.readyMs, c.seekMs, c.remuxRuns, c.src, c.shown, c.error ? `ERROR ${c.error}` : c.stalls].map((x) => (x == null || x === '' ? '-' : String(x))))
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r) => `| ${r.map((c, i) => c.padEnd(w[i])).join(' | ')} |`
  return [line(head), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...rows.map(line)].join('\n')
}

async function playbackMain(json) {
  const dir = mkdtempSync(join(tmpdir(), 'flick-playback-'))
  try {
    makeFixtures(dir)
    const { server, base } = await serveDir(dir)
    const { report, progress, why } = await launch('playback', { FLICK_SELFTEST_MEDIA: base }).finally(() => server.close())
    if (progress) console.log(`Progress:\n${progress}`)
    if (!report) { console.error(`FAIL: ${why} The app was stopped.`); process.exit(1) }
    if (json) console.log(JSON.stringify(report, null, 2))
    if (report.cases) console.log(playbackTable(report))
    const bad = playbackFailures(report)
    if (bad.length) { console.error(`\nFAIL\n${bad.join('\n')}`); process.exit(1) }
    console.log('\nPASS: cases 1 to 4 played in the hidden app within their limits.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
