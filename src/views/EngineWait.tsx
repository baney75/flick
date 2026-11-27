// The built-in engine's wait under Streams (SPEC-torrent): "Finding people sharing this torrent"
// with Cancel while a torrent starts, then "No one is sharing..." beside the streams to pick another.
import { useEffect, useRef } from 'preact/hooks'
import { engineWait } from '../lib/torrent'

export function EngineWait({ streamKey }: { streamKey: string }) {
  const at = useRef<HTMLParagraphElement>(null)
  const w = engineWait.value
  const mine = !!w && w.key === streamKey
  const none = mine && !w.cancel
  // When no one shared it, the line and the streams under it come into view to pick another source.
  useEffect(() => { if (none) at.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [none])
  if (!mine) return null
  return (
    <p ref={at} class="dl-status small engine-wait" role="status">
      {w.cancel && <span class="spinner sm" />} {w.line}
      {w.cancel && <button class="btn ghost sm" onClick={w.cancel}>Cancel</button>}
    </p>
  )
}
