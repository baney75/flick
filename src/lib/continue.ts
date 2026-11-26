// Everything left partway, from this device, servers and source plugins, newest first: the Continue tab.

import type { Progress } from './store'
import type { Meta } from './plugins/validate'

export type ContinueEntry =
  | { t: 'local'; k: string; p: Progress; at: number }
  | { t: 'plugin'; p: string; m: Meta; at: number }

/**
 * Started and not finished: at least 10 seconds in and short of 93% (the same line a title page's
 * Resume uses, plugins/resume.ts), or a book between its first and last page.
 */
export const inProgress = (p: Progress) => p.book ? p.pos > 1 && p.pos < p.dur : p.pos >= 10 && (!p.dur || p.pos < p.dur * 0.93)

/**
 * One entry per title. A plugin title watched in Flick shows once, from its latest episode, and the
 * plugin's own record of it (a Stremio account's progress) is dropped in favor of Flick's.
 */
export function continueEntries(prog: Record<string, Progress>, libs: { p: string; list: Meta[] }[]): ContinueEntry[] {
  const local = new Map<string, ContinueEntry>()
  for (const [k, p] of Object.entries(prog)) {
    if (!inProgress(p) || (p.ref.t === 'url' && !p.ref.url)) continue
    const key = p.ref.t === 'plugin' ? `pl|${p.ref.p}|${p.ref.id}` : `k|${k}`
    const had = local.get(key)
    if (!had || had.at < p.at) local.set(key, { t: 'local', k, p, at: p.at })
  }
  const out = [...local.values()]
  for (const { p, list } of libs) for (const m of list) {
    const g = m.progress
    if (!g || !(g.pos > 0) || (g.dur && g.pos >= g.dur * 0.93) || local.has(`pl|${p}|${m.id}`)) continue
    out.push({ t: 'plugin', p, m, at: g.at ?? 0 })
  }
  return out.sort((a, b) => b.at - a.at)
}
