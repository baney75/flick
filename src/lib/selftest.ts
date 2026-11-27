// Starts a self-test when one was asked for: the desktop self-test build (src-tauri/src/selftest.rs) or the
// browser side of scripts/desktop-selftest.mjs, which sets window.__FLICK_SELFTEST__ with browser: true.
// Everywhere else this returns at once.

import { invoke, isDesktop } from './platform'

export interface Hook { mode: string; launchedAt: number; lastMutation: number; browser?: boolean; rafEmulated?: boolean; report?: unknown }
export const hook = (): Hook | undefined => (window as unknown as { __FLICK_SELFTEST__?: Hook }).__FLICK_SELFTEST__

export function note(line: string) {
  if (isDesktop) invoke('selftest_note', { line }).catch(() => {})
}

export async function selftestIfAsked() {
  const h = hook()
  const m = isDesktop
    ? await invoke<{ mode: string; launchedAt: number; setupAt?: number; media?: string | null } | null>('selftest_mode').catch(() => null)
    : h?.browser ? { mode: h.mode, launchedAt: h.launchedAt } : null
  if (!m) return
  note(`self-test ${m.mode} started`)
  const report = await (m.mode === 'playback'
    ? import('./playback-selftest').then((x) => x.runPlayback('media' in m ? m.media : null))
    : m.mode === 'perf'
    ? import('./perf/realapp').then((x) => x.runPerf(m.launchedAt, 'setupAt' in m ? m.setupAt : undefined))
    : import('./plugins/selftest').then((x) => (m.mode === 'youtube' ? x.runYoutubeSelftest() : x.runPluginSelftest()) as Promise<unknown>)
  ).catch((e) => ({ error: String((e as Error)?.message ?? e) }))
  if (isDesktop) await invoke('selftest_done', { report: JSON.stringify(report, null, 2) })
  else if (h) h.report = report
}
