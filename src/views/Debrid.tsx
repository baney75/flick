// Debrid services on a title page's stream list: the `cached` lookups and each torrent row's tag
// (SPEC-debrid rules 5b and 7), and the wait while one fetches a torrent for Play. Nothing goes to a
// service Flick may not ask now.

import { useEffect, useState } from 'preact/hooks'
import { askable, gate, mayAskNow } from '../lib/picking'
import { CachedLookups, cancelFetch, fetching, torrentHashes, torrentUrl, type CachedMap } from '../lib/debrid-play'
import { services as playable } from '../lib/plugins/services'
import type { Stream } from '../lib/plugins/validate'
import type { Ranked } from '../lib/pick'

/**
 * Which services have these streams' torrents ready. Null while an askable service's answer is
 * still to come, so no row claims what Flick does not know yet. Leaving the page stops the rest.
 */
export function useCached(list: Stream[] | null): CachedMap | null {
  const [, bump] = useState(0)
  const [lookups] = useState(() => new CachedLookups(() => bump((n) => n + 1), mayAskNow))
  useEffect(() => () => lookups.dispose(), [])
  const hashes = torrentHashes(list ?? [])
  const open = hashes.length ? askable() : []
  // Every render: it asks only what is missing, and asks again after a lookup the VPN cut short.
  useEffect(() => { lookups.fill(hashes, open) })
  return lookups.view(hashes, open)
}

/** "TorBox is fetching: 40%" with Cancel, while a service fetches this title's torrent. Leaving the page cancels it. */
export function DebridWait({ streamKey }: { streamKey: string }) {
  useEffect(() => () => cancelFetch(streamKey), [streamKey])
  const f = fetching.value
  if (!f || f.key !== streamKey) return null
  return (
    <p class="dl-status small debrid-wait" role="status">
      <span class="spinner sm" /> {f.line}
      <button class="btn ghost sm" onClick={f.cancel}>Cancel</button>
    </p>
  )
}

/** Resolves a torrent row through its service, with the VPN rules read live. */
export const playTorrent = (key: string, s: Stream, r: Ranked) =>
  torrentUrl(key, s, r, { list: playable.value, may: mayAskNow, watch: (fn) => gate.subscribe(fn) })
