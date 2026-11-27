// Library's Continue chip: every movie, episode, song or book left partway, wherever it plays from.

import { useEffect, useMemo } from 'preact/hooks'
import { progress, items, loaded, go } from '../lib/store'
import { Card } from '../components/Card'
import { Icon } from '../components/icons'
import { sources, libraries, loadLibrary, titlePath } from '../lib/plugins/use'

import { continueEntries } from '../lib/continue'
import { ResumeCard } from './Home'

/** Everything left partway, one entry per title, newest first. Home and Library both show this. */
export function useContinue() {
  const srcs = sources.value
  useEffect(() => { for (const rec of srcs) loadLibrary(rec) }, [srcs.map((r) => r.id).join()])
  const libs = useMemo(() => srcs.map((r) => ({ p: r.id, list: libraries.value[r.id]?.items ?? [] })), [srcs, libraries.value])
  const lib = useMemo(() => {
    const m = new Map(items.value.map((i) => [i.id, i.show]))
    return { showOf: (id: string) => m.get(id), known: loaded.value ? (id: string) => m.has(id) : undefined }
  }, [items.value, loaded.value])
  return useMemo(() => continueEntries(progress.value, libs, lib.showOf, lib.known), [progress.value, libs, lib])
}

export function ContinueGrid({ list }: { list: ReturnType<typeof continueEntries> }) {
  const srcs = sources.value
  const nameOf = (p: string) => srcs.find((r) => r.id === p)?.manifest.name
  if (list.length === 0) return (
    <div class="empty">
      <Icon name="clock" size={40} />
      <h2>Nothing to pick back up</h2>
      <p>Start a movie, an episode or a book and stop partway. It waits here, from any server or plugin.</p>
    </div>
  )
  return (
    <div class="continue-grid">
      {list.map((e) => e.t === 'local'
        ? <ResumeCard key={e.k} k={e.k} p={e.p} />
        : <Card key={`${e.p}|${e.m.id}`} image={e.m.background ?? e.m.poster} title={e.m.name}
            sub={[nameOf(e.p), e.m.year].filter(Boolean).join(' · ') || undefined} shape="wide"
            pct={e.m.progress?.dur ? e.m.progress.pos / e.m.progress.dur : undefined}
            onClick={() => go(titlePath(e.p, e.m.type, e.m.id, e.m.type === 'series' ? e.m.progress?.videoId : undefined))} />)}
    </div>
  )
}
