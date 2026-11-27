// Installs every plugin in plugins/index.json inside the real desktop app and times each step.
// Builds "Flick Self-test" with its own identifier (dev.flick.selftest, so its data is separate from the
// user's Flick) and no visible window, starts it hidden with `open -g -j -n`, waits up to 30 s for its
// report, stops the copy it started and prints a table. Fails when any plugin errors or takes over 2 s. macOS only.
//
//   node scripts/desktop-selftest.mjs            build, then run
//   node scripts/desktop-selftest.mjs --no-build run the last self-test build
//   node scripts/desktop-selftest.mjs --json     also print the raw report

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

async function main() {
  if (process.platform !== 'darwin') { console.error('The desktop self-test runs on macOS.'); process.exit(2) }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const app = join(root, `src-tauri/target/release/bundle/macos/${PRODUCT}.app`)
  if (!process.argv.includes('--no-build')) {
    const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    const r = spawnSync('npx', ['tauri', 'build', '--bundles', 'app', '--config', JSON.stringify(override(conf))], { cwd: root, stdio: 'inherit' })
    if (r.status !== 0) { console.error('The self-test build failed.'); process.exit(1) }
  }
  if (!existsSync(app)) { console.error(`No app at ${app}. Run without --no-build.`); process.exit(1) }
  // Never start a build that would open the user's own Flick data or show a window.
  const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  if (plist('CFBundleIdentifier') !== IDENTIFIER) { console.error(`${app} is not ${IDENTIFIER}. Build it with this script.`); process.exit(1) }
  if (appPids(app).length) { console.error('A self-test app is already running.'); process.exit(1) }

  const dir = mkdtempSync(join(tmpdir(), 'flick-selftest-'))
  const out = join(dir, 'report.json')
  const log = join(dir, 'report.log')
  // -g: not brought forward, -j: launched hidden, -n: a new copy.
  execFileSync('open', ['-g', '-j', '-n', '--env', 'FLICK_SELFTEST=plugins', '--env', `FLICK_SELFTEST_OUT=${out}`, app])
  const t0 = Date.now()
  let why = ''
  while (!existsSync(out)) {
    if (Date.now() - t0 > WAIT_MS) { why = `No report after ${WAIT_MS / 1000} s.`; break }
    if (existsSync(log) && /\bERROR\b/.test(readFileSync(log, 'utf8'))) { why = 'A plugin failed.'; break }
    await sleep(200)
  }
  for (let i = 0; i < 10 && appPids(app).length; i++) await sleep(200)
  stop(app)
  const left = appPids(app).join(' ')
  if (existsSync(log)) console.log(`Progress:\n${readFileSync(log, 'utf8')}`)
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  rmSync(dir, { recursive: true, force: true })
  if (left) { console.error(`FAIL: a self-test copy is still running:\n${left}`); process.exit(1) }
  if (!report) { console.error(`FAIL: ${why} The app was stopped.`); process.exit(1) }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  if (report.plugins) console.log(table(report))
  if (report.userAgent) console.log(`\n${report.origin} ${report.userAgent}`)
  const bad = failures(report)
  if (bad.length) { console.error(`\nFAIL\n${bad.join('\n')}`); process.exit(1) }
  console.log(`\nPASS: every plugin installed and answered in under ${LIMIT_MS} ms.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
