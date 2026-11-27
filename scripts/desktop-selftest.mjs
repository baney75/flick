// Installs every plugin in plugins/index.json inside the real desktop app and times each step.
// Builds "Flick Self-test" with its own identifier (dev.flick.selftest, so its data is separate from the
// user's Flick) and no visible window, starts it hidden with `open -g -j -n`, waits up to 30 s for its
// report, stops the copy it started and prints a table. Fails when any plugin errors or takes over 2 s. macOS only.
//
//   node scripts/desktop-selftest.mjs            build, then run
//   node scripts/desktop-selftest.mjs --no-build run the last self-test build
//   node scripts/desktop-selftest.mjs --json     also print the raw report
//   node scripts/desktop-selftest.mjs --mode perf [--runs 5] [--out file.json] [--no-browser]
//       seed a library (first launch), then time a cold start, the bar taps and a Library chip in the
//       real app (each later launch) and the same steps in Playwright WebKit over http; prints medians

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const IDENTIFIER = 'dev.flick.selftest'
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

export function table(report) {
  const rows = report.plugins.map((p) => [p.name, String(p.totalMs), p.steps.map((s) => `${s.step} ${s.ms}`).join(', '), p.error ? `${p.error} (after ${p.failedAfter})` : 'ok'])
  const head = ['Plugin', 'Total ms', 'Steps (ms each)', 'Result']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r) => `| ${r.map((c, i) => c.padEnd(w[i])).join(' | ')} |`
  return [line(head), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...rows.map(line)].join('\n')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export const PRODUCT = 'Flick Self-test'
/** The build override: its own identifier and name, and no window ever shown. */
export function override(conf) {
  return { identifier: IDENTIFIER, productName: PRODUCT, app: { windows: conf.app.windows.map((w) => ({ ...w, visible: false, focus: false })) } }
}

/** PIDs of processes running from this bundle only. */
function appPids(app) {
  const r = spawnSync('pgrep', ['-f', `${app}/Contents/MacOS/`], { encoding: 'utf8' })
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

function stop(app) {
  for (let i = 0; i < 3; i++) {
    const pids = appPids(app)
    if (!pids.length) return
    spawnSync('kill', [i < 2 ? '-TERM' : '-KILL', ...pids])
    spawnSync('sleep', ['1'])
  }
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
async function launch(mode) {
  if (appPids(APP).length) throw new Error('A self-test app is already running.')
  const dir = mkdtempSync(join(tmpdir(), 'flick-selftest-'))
  const out = join(dir, 'report.json')
  const log = join(dir, 'report.log')
  // -g: not brought forward, -j: launched hidden, -n: a new copy.
  execFileSync('open', ['-g', '-j', '-n', '--env', `FLICK_SELFTEST=${mode}`, '--env', `FLICK_SELFTEST_OUT=${out}`, APP])
  const t0 = Date.now()
  let why = ''
  while (!existsSync(out)) {
    if (Date.now() - t0 > WAIT_MS) { why = `No report after ${WAIT_MS / 1000} s.`; break }
    if (existsSync(log) && /\bERROR\b/.test(readFileSync(log, 'utf8'))) { why = 'A step failed.'; break }
    await sleep(200)
  }
  for (let i = 0; i < 10 && appPids(APP).length; i++) await sleep(200)
  stop(APP)
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
  const mode = arg('--mode') ?? 'plugins'
  if (!['plugins', 'perf'].includes(mode)) { console.error('--mode is plugins or perf.'); process.exit(2) }
  if (!process.argv.includes('--no-build')) {
    const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'))
    const r = spawnSync('npx', ['tauri', 'build', '--bundles', 'app', '--config', JSON.stringify(override(conf))], { cwd: ROOT, stdio: 'inherit' })
    if (r.status !== 0) { console.error('The self-test build failed.'); process.exit(1) }
  }
  if (!existsSync(APP)) { console.error(`No app at ${APP}. Run without --no-build.`); process.exit(1) }
  // Never start a build that would open the user's own Flick data or show a window.
  const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  if (id !== IDENTIFIER) { console.error(`${APP} is not ${IDENTIFIER}. Build it with this script.`); process.exit(1) }

  if (mode === 'perf') return perfMain(arg('--out'))
  const { report, progress, why } = await launch('plugins').catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1) })
  if (progress) console.log(`Progress:\n${progress}`)
  if (!report) { console.error(`FAIL: ${why} The app was stopped.`); process.exit(1) }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
