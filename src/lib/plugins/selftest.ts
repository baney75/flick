// The plugin self-test: install every plugin in Flick's own list and time each step. Started by
// src/lib/selftest.ts, only in the self-test build run with FLICK_SELFTEST=plugins (see
// src-tauri/src/selftest.rs and scripts/desktop-selftest.mjs), never in the user's Flick.

import { note } from '../selftest'
import { install, officialList, prepare, remove } from './registry'
import { startPlugin } from './runtime'
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
