// The real-app perf check (SPEC-perf rule 4, scripts/desktop-selftest.mjs --mode perf). The first run in a
// profile seeds a library and stops; the next, a cold start, times start-up to Home, the three bar taps,
// one more tap to Library and one chip switch, with every invoke the app made. The same code runs in
// Playwright WebKit over http, so the two sets of numbers differ only by the shell.

import { invokeLog, isDesktop, type InvokeRow } from '../platform'
import { hook, note } from '../selftest'
import { COUNTS, seed, seeded } from './seed'

export interface Tap { label: string; settledMs: number; frameMs: number | null; capped: boolean; invokes: number; slowestInvokeMs: number | null; from: number; to: number }
export interface PerfReport {
  phase: 'seeded' | 'measured'
  where: 'app' | 'browser'
  origin: string
  userAgent: string
  visibility?: string
  rafFires?: boolean | null
  /** True in the hidden app: frames came from a 16 ms timer, so tap frame times are left out. */
  rafEmulated?: boolean
  /** How late timers ran here: a hidden window may slow them, which slows any work queued on a timer. */
  timers?: { zeroMs: number; twentyMs: number; taskMs: number }
  /** The main script fetched again: size and mean time, so transport is measured apart from parsing. */
  scriptFetch?: { kb: number; ms: number } | null
  start?: { launchToSetupMs: number | null; responseEndMs: number; domInteractiveMs: number; setupToPageMs: number | null; launchToPageMs: number | null; domContentLoadedMs: number; firstPaintMs: number | null; homeSettledMs: number; homeInteractiveMs: number; launchToHomeInteractiveMs: number | null; homeRowsMs: number | null; capped: boolean }
  taps?: Tap[]
  invokes?: InvokeRow[]
  /** Every file the page loaded before Home was interactive, slowest first. */
  resources?: { name: string; ms: number; kb: number }[]
  seed: typeof COUNTS
}

const now = () => performance.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const round = (n: number) => Math.round(n)

/** Time after n animation frames, or null when frames do not run (a page that is never shown). */
function frames(n = 2, capMs = 300): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), capMs)
    const step = (left: number) => requestAnimationFrame(() => { if (left > 1) step(left - 1); else { clearTimeout(t); resolve(now()) } })
    step(n)
  })
}

/** Waits until the DOM has not changed for quietMs; returns the last change at or after `since`. */
async function settle(since: number, quietMs: number, capMs: number): Promise<{ last: number; capped: boolean }> {
  for (;;) {
    await sleep(20)
    const last = Math.max(hook()?.lastMutation ?? 0, since)
    if (now() - last >= quietMs) return { last, capped: false }
    if (now() - since >= capMs) return { last, capped: true }
  }
}

/** How long a task posted now waits for the main thread. */
function taskDelay(): Promise<number> {
  return new Promise((resolve) => {
    const c = new MessageChannel()
    const t = now()
    c.port1.onmessage = () => resolve(now() - t)
    c.port2.postMessage(0)
  })
}

/** Mean real delay of setTimeout(0), setTimeout(20) and a posted task, five of each. */
async function timerProbe() {
  const mean = async (f: () => Promise<number>) => { let n = 0; for (let i = 0; i < 5; i++) n += await f(); return Math.round((n / 5) * 10) / 10 }
  const timeout = (ms: number) => () => { const t = now(); return sleep(ms).then(() => now() - t) }
  return { zeroMs: await mean(timeout(0)), twentyMs: await mean(timeout(20)), taskMs: await mean(taskDelay) }
}

/** Mean time to fetch the page's main script again, five times: what the app's scheme costs per file. */
async function scriptFetch() {
  const src = document.querySelector<HTMLScriptElement>('script[type=module][src]')?.src
  if (!src) return null
  let ms = 0
  let kb = 0
  for (let i = 0; i < 5; i++) {
    const t = now()
    const b = await (await fetch(src, { cache: 'no-store' })).arrayBuffer()
    ms += now() - t
    kb = Math.round(b.byteLength / 1024)
  }
  return { kb, ms: Math.round((ms / 5) * 10) / 10 }
}

function find(selector: string, text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim().startsWith(text))
  if (!el) throw new Error(`no ${selector} "${text}" on screen`)
  return el
}

/** The app's own invokes that started in [from, to]; the self-test's progress notes are not the app's. */
const appRows = (from: number, to: number) => invokeLog.filter((r) => r.start >= from && r.start <= to && !r.cmd.startsWith('selftest_'))
/** The slowest of them, or null while one has not answered. */
const slowest = (rows: InvokeRow[]) => (rows.some((r) => r.end < 0) ? null : rows.reduce((m, r) => Math.max(m, round(r.end - r.start)), 0))

async function tap(label: string, el: HTMLElement): Promise<Tap> {
  const t0 = now()
  const frame = frames()
  el.click()
  const f = hook()?.rafEmulated ? null : await frame
  const s = await settle(t0, 100, 5000)
  note(`${label} ${round(s.last - t0)} ms`)
  return { label, settledMs: round(s.last - t0), frameMs: f === null ? null : round(f - t0), capped: s.capped, invokes: 0, slowestInvokeMs: null, from: t0, to: now() }
}

export async function runPerf(launchedAt: number, setupAt?: number): Promise<PerfReport> {
  const where = isDesktop ? 'app' : 'browser'
  const base = { where, origin: location.origin, userAgent: navigator.userAgent, seed: COUNTS } as const
  if (!(await seeded())) {
    await seed()
    note('seeded; start again to measure')
    return { ...base, phase: 'seeded' }
  }
  // Start-up: the DOM settles once Home has its rows.
  const s = await settle(0, 300, 10_000)
  const homeInteractiveMs = s.last + (await taskDelay())
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')
  const launchToPageMs = launchedAt ? round(performance.timeOrigin - launchedAt) : null
  const start = {
    launchToSetupMs: launchedAt && setupAt ? setupAt - launchedAt : null,
    responseEndMs: round(nav?.responseEnd ?? 0),
    domInteractiveMs: round(nav?.domInteractive ?? 0),
    setupToPageMs: setupAt ? round(performance.timeOrigin - setupAt) : null,
    launchToPageMs,
    domContentLoadedMs: round(nav?.domContentLoadedEventEnd ?? 0),
    firstPaintMs: paint ? round(paint.startTime) : null,
    homeSettledMs: round(s.last),
    homeInteractiveMs: round(homeInteractiveMs),
    launchToHomeInteractiveMs: launchToPageMs === null ? null : round(launchToPageMs + homeInteractiveMs),
    homeRowsMs: null as number | null,
    capped: s.capped,
  }
  const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter((e) => e.startTime <= homeInteractiveMs)
    .map((e) => ({ name: e.name.replace(location.origin, ''), ms: round(e.duration), kb: round((e.encodedBodySize || e.decodedBodySize) / 1024) }))
    .sort((a, b) => b.ms - a.ms)
  note(`home interactive ${start.homeInteractiveMs} ms after the page started`)
  // With emulated frames the probe would always pass, so it says nothing there.
  const rafFires = hook()?.rafEmulated ? null : (await frames(1, 500)) !== null
  const timers = await timerProbe()
  const fetched = await scriptFetch()
  note(`timers: setTimeout(0) ${timers.zeroMs} ms, setTimeout(20) ${timers.twentyMs} ms, task ${timers.taskMs} ms`)
  const taps: Tap[] = []
  taps.push(await tap('Home to Library', find('.nav-item', 'Library')))
  taps.push(await tap('Library to Settings', find('.nav-item', 'Settings')))
  taps.push(await tap('Settings to Home', find('.nav-item', 'Home')))
  taps.push(await tap('Home to Library again', find('.nav-item', 'Library')))
  taps.push(await tap('Library chip All to Movies', find('.chips .chip', 'Movies')))
  // Invokes still running (a plugin's yt-dlp search, say): wait up to 15 s so their times are in the report.
  const pendingSince = now()
  while (invokeLog.some((r) => r.end < 0 && !r.cmd.startsWith('selftest_')) && now() - pendingSince < 15_000) await sleep(100)
  for (const t of taps) { const rows = appRows(t.from, t.to); t.invokes = rows.length; t.slowestInvokeMs = slowest(rows) }
  // When everything Home asked for before the first tap had answered: its plugin rows, say. Null if one never did.
  const startRows = appRows(0, taps[0].from)
  start.homeRowsMs = startRows.some((r) => r.end < 0) ? null : round(Math.max(homeInteractiveMs, ...startRows.map((r) => r.end)))
  return { ...base, phase: 'measured', visibility: document.visibilityState, rafFires, rafEmulated: !!hook()?.rafEmulated, timers, scriptFetch: fetched, start, resources, taps, invokes: invokeLog.map((r) => ({ ...r, start: round(r.start), end: round(r.end) })) }
}
