// The plugin self-tests: install every plugin in Flick's own list and time each step, or YouTube end to
// end. Started by src/lib/selftest.ts, only in the self-test build run with FLICK_SELFTEST=plugins or
// youtube (see src-tauri/src/selftest.rs and scripts/desktop-selftest.mjs), never in the user's Flick.

import { note } from '../selftest'
import { install, officialList, prepare, remove } from './registry'
import { callPlugin, openToolStream, startPlugin, type Installed } from './runtime'
import { mark, traceTo } from './trace'

export interface StepRow { step: string; ms: number }
export interface PluginResult { url: string; name: string; totalMs: number; steps: StepRow[]; error?: string; failedAfter?: string }
export interface Report { userAgent: string; origin: string; startedAt: string; plugins: PluginResult[] }

const LIMIT_MS = 30_000

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Install one plugin the way Settings does, timing each step. Exported for tests. */
export async function timeOne(entry: { url: string; name: string }, now: () => number = () => performance.now()): Promise<PluginResult> {
  const steps: StepRow[] = []
  const t0 = now()
  let last = t0
  traceTo((step) => { const n = now(); steps.push({ step, ms: Math.round(n - last) }); last = n; note(`${entry.name} ${step} ${Math.round(n - t0)} ms`) })
  let id: string | null = null
  try {
    await within((async () => {
      const c = await prepare({ url: entry.url })
      const rec = await install(c)
      id = rec.id
      if (rec.kind !== 'theme') { await startPlugin(rec); mark('ping') }
    })(), LIMIT_MS)
    return { url: entry.url, name: entry.name, totalMs: Math.round(now() - t0), steps }
  } catch (e) {
    return { url: entry.url, name: entry.name, totalMs: Math.round(now() - t0), steps, error: (e as Error).message, failedAfter: steps.at(-1)?.step ?? 'start' }
  } finally {
    traceTo(null)
    if (id) await remove(id).catch(() => {})
  }
}

export async function runPluginSelftest(): Promise<Report> {
  const plugins: PluginResult[] = []
  const list = await officialList()
  note(`${list.length} plugins in ${location.origin}`)
  for (const e of list) {
    const r = await timeOne(e)
    note(`${e.name}: ${r.error ? `ERROR ${r.error}` : 'ok'} ${r.totalMs} ms`)
    plugins.push(r)
    // Stop at the first failure: the script reports it and nothing waits on the rest.
    if (r.error) break
  }
  return { userAgent: navigator.userAgent, origin: location.origin, startedAt: new Date().toISOString(), plugins }
}

export interface YoutubeStep { step: 'install' | 'search' | 'streams' | 'open'; ms: number; detail?: string }
export interface YoutubeReport { userAgent: string; origin: string; startedAt: string; query: string; rows?: number; host?: string; steps: YoutubeStep[]; error?: string; failedAfter?: string }

/** Where a playable address points, with no path or query (a token never leaves the app). */
export function hostOf(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}` } catch { return 'not a URL' }
}

/** How long the YouTube run may take in all; the script stops the app at 30 s. */
export const YOUTUBE_MS = 28_000

/** A short public video that stays up (YouTube's first upload), so the stream step is quick and stable. */
export const PLAY_ID = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

/**
 * YouTube end to end, the way a user's taps go: install the bundled plugin, then at once search
 * through ctx.tools.ytdlp and open a stream to the address the player plays. The two run side by side
 * so the whole run fits the 30 s the script allows; each is timed on its own.
 */
export async function runYoutubeSelftest(query = 'karpathy', now: () => number = () => performance.now()): Promise<YoutubeReport> {
  // One deadline for every step, short of the script's 30 s, so a hang is reported with its step.
  const end = now() + YOUTUBE_MS
  const r: YoutubeReport = { userAgent: navigator.userAgent, origin: location.origin, startedAt: new Date().toISOString(), query, steps: [] }
  const step = async <T>(name: YoutubeStep['step'], f: () => Promise<T>, detail?: (v: T) => string): Promise<T> => {
    const t0 = now()
    note(`YouTube ${name} started at ${Math.round(now())} ms`)
    try {
      const v = await within(f(), Math.max(0, end - now()))
      r.steps.push({ step: name, ms: Math.round(now() - t0), ...(detail ? { detail: detail(v) } : {}) })
      note(`YouTube ${name} ok ${Math.round(now() - t0)} ms`)
      return v
    } catch (e) {
      r.failedAfter ??= name
      note(`YouTube ${name}: ERROR ${(e as Error).message}`)
      throw e
    }
  }
  let rec: Installed | null = null
  // Off Home, so its YouTube rows do not run searches beside the one measured here, and without a
  // copy a stopped run left behind.
  location.hash = '#/settings'
  await remove('com.youtube').catch(() => {})
  try {
    rec = await step('install', async () => { const x = await install(await prepare({ url: '/plugins/youtube.js' })); await startPlugin(x); return x })
    const src = rec
    const search = step('search', () => callPlugin(src, 'catalog', [{ id: 'search', type: 'video', search: query }]), (v) => `${v.items.length} rows`)
      .then((found) => { r.rows = found.items.length })
    const play = step('streams', () => callPlugin(src, 'streams', [{ type: 'video', id: PLAY_ID }]), (v) => `${v.length} stream`)
      .then((list) => { if (!list[0]?.url) throw new Error('no stream'); return step('open', () => openToolStream(list[0].url!)) })
      .then((playable) => { r.host = hostOf(playable) })
    const [a, b] = await Promise.allSettled([search, play])
    for (const x of [a, b]) if (x.status === 'rejected') throw x.reason
  } catch (e) {
    r.error = (e as Error).message
    r.failedAfter ??= 'start'
  } finally {
    if (rec) await remove(rec.id).catch(() => {})
  }
  return r
}
