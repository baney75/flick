// Debrid services on a title page's stream list: the `cached` lookups and each torrent row's tag
// (SPEC-debrid rules 5b and 7), and the wait while one fetches a torrent for Play. Nothing goes to a
// service Flick may not ask now.

import { useEffect, useState } from 'preact/hooks'
import { askable, gate, mayAskNow } from '../lib/picking'
import { cancelFetch, fetching, lookupCached, torrentHashes, torrentUrl, type CachedMap } from '../lib/debrid-play'
import { services as playable } from '../lib/plugins/services'
import type { Stream } from '../lib/plugins/validate'
import type { Ranked } from '../lib/pick'

/**
 * Which services have these streams' torrents ready; asks again when the list or the askable
 * services change. Null while that lookup is on its way, so no row claims what it does not know.
 */
export function useCached(list: Stream[] | null): CachedMap | null {
  const [got, setGot] = useState<{ key: string; map: CachedMap } | null>(null)
  const hashes = torrentHashes(list ?? [])
  const open = hashes.length ? askable() : []
  const key = `${hashes.join(',')}|${open.map((s) => s.id).join(',')}`
  useEffect(() => {
    if (!hashes.length || !open.length) { setGot({ key, map: {} }); return }
    let live = true
    // Leaving the page stops the batches still to go.
    lookupCached(open, hashes, (s) => live && mayAskNow(s)).then((map) => { if (live) setGot({ key, map }) })
    return () => { live = false }
  }, [key])
  return got?.key === key ? got.map : null
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
