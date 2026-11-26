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
 * One entry per title: a plugin title, a show from a folder or server (`showOf` names an item's
 * show), or anything else on its own. A title's newest record decides: in progress, it shows from
 * that record; finished, the title is left out, even if an older episode was left partway. A plugin's
 * own record of a title (a Stremio account's progress) counts only when Flick has none.
 */
export function continueEntries(prog: Record<string, Progress>, libs: { p: string; list: Meta[] }[], showOf: (id: string) => string | undefined = () => undefined): ContinueEntry[] {
  const newest = new Map<string, { k: string; p: Progress }>()
  for (const [k, p] of Object.entries(prog)) {
    if (p.ref.t === 'url' && !p.ref.url) continue
    const show = p.ref.t === 'item' ? showOf(p.ref.id) : undefined
    const key = p.ref.t === 'plugin' ? `pl|${p.ref.p}|${p.ref.id}` : show ? `show|${show.toLowerCase()}` : `k|${k}`
    const had = newest.get(key)
    if (!had || had.p.at < p.at) newest.set(key, { k, p })
  }
  const out: ContinueEntry[] = [...newest.values()].filter(({ p }) => inProgress(p)).map(({ k, p }) => ({ t: 'local', k, p, at: p.at }))
  for (const { p, list } of libs) for (const m of list) {
    const g = m.progress
    if (!g || !(g.pos > 0) || (g.dur && g.pos >= g.dur * 0.93) || newest.has(`pl|${p}|${m.id}`)) continue
    out.push({ t: 'plugin', p, m, at: g.at ?? 0 })
  }
  return out.sort((a, b) => b.at - a.at)
}
