// Debrid services on a title page's stream list: the `cached` lookups and each torrent row's tag
// (SPEC-debrid rules 5b and 7). The lookups run only for services Flick may ask now.

import { useEffect, useState } from 'preact/hooks'
import { askable, mayAskNow } from '../lib/picking'
import { lookupCached, torrentHashes, type CachedMap } from '../lib/debrid-play'
import type { Stream } from '../lib/plugins/validate'

/** Which services have these streams' torrents ready; asks again when the list or the askable services change. */
export function useCached(list: Stream[] | null): CachedMap {
  const [map, setMap] = useState<CachedMap>({})
  const hashes = torrentHashes(list ?? [])
  const open = hashes.length ? askable() : []
  const key = `${hashes.join(',')}|${open.map((s) => s.id).join(',')}`
  useEffect(() => {
    if (!hashes.length || !open.length) return
    let live = true
    lookupCached(open, hashes, mayAskNow).then((m) => { if (live) setMap(m) })
    return () => { live = false }
  }, [key])
  return map
}
