// A small line under the player's title while a debrid stream plays: the service, the download
// speed over the last 5 seconds, and whether the VPN gate passes now. It shows with the controls
// and hides with them, so it never covers the picture.

import { useEffect, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { RateMeter } from '../lib/speed'
import { gate } from '../lib/picking'
import { bufferedSeconds, counts, fetchedBytes, viaLine, type Via } from '../lib/readout'

export function Readout({ video, via, url }: { video: RefObject<HTMLVideoElement | null>; via: Via; url?: string }) {
  const [mbps, setMbps] = useState<number | null>(null)
  useEffect(() => {
    const v = video.current
    if (!v || !via.bytes) return
    const meter = new RateMeter(performance.now())
    let held = bufferedSeconds(v.buffered)
    let seen = false
    const onProgress = () => {
      const now = bufferedSeconds(v.buffered)
      // Only the service's own link measures its download; a converted MKV shows no speed.
      const got = counts(v.currentSrc, url, v.duration) ? fetchedBytes(held, now, via.bytes, v.duration) : 0
      if (got > 0) { seen = true; meter.add(got, performance.now()) }
      held = now
    }
    v.addEventListener('progress', onProgress)
    const t = setInterval(() => { if (seen && counts(v.currentSrc, url, v.duration)) setMbps(meter.mbps(performance.now())); else setMbps(null) }, 1000)
    return () => { v.removeEventListener('progress', onProgress); clearInterval(t) }
  }, [])
  const g = gate.value
  return <div class="t2 readout">{viaLine(via, mbps, g ? g.ok === true : null)}</div>
}
