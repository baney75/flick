// A small line under the player's title while a debrid stream plays: the service, the download
// speed over the last 5 seconds, and whether the VPN gate passes now. It shows with the controls
// and hides with them, so it never covers the picture.

import { useEffect, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { RateMeter } from '../lib/speed'
import { gate } from '../lib/picking'
import { bufferedSeconds, fetchedBytes, viaLine, type Via } from '../lib/readout'

export function Readout({ video, via }: { video: RefObject<HTMLVideoElement | null>; via: Via }) {
  const [mbps, setMbps] = useState<number | null>(null)
  useEffect(() => {
    const v = video.current
    if (!v || !via.bytes) return
    const meter = new RateMeter(performance.now())
    let held = bufferedSeconds(v.buffered)
    const onProgress = () => {
      const now = bufferedSeconds(v.buffered)
      meter.add(fetchedBytes(held, now, via.bytes, v.duration), performance.now())
      held = now
    }
    v.addEventListener('progress', onProgress)
    const t = setInterval(() => setMbps(meter.mbps(performance.now())), 1000)
    return () => { v.removeEventListener('progress', onProgress); clearInterval(t) }
  }, [])
  return <div class="t2 readout">{viaLine(via, mbps, gate.value?.ok === true)}</div>
}
