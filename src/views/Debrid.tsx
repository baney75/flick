// Debrid services on a title page's stream list: the `cached` lookups and each torrent row's tag
// (SPEC-debrid rules 5b and 7). The lookups run only for services Flick may ask now.

import { useEffect, useState } from 'preact/hooks'
import { askable, mayAskNow } from '../lib/picking'
import { lookupCached, torrentHashes, type CachedMap } from '../lib/debrid-play'
import type { Stream } from '../lib/plugins/validate'

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
